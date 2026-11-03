'use strict';
// Tests unitaires du pilotage à distance : chiffrement du tunnel et accès web par mot de passe.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('crypto');
const R = require('../public/remote-crypto');

test('clé de pilotage : même dérivation que la synchro, propre à chaque machine', async () => {
  const k = await R.pilotKey('CODE-DE-SYNCHRO-TEST', 'a1b2c3d4e5f6');
  assert.equal(Buffer.from(k).toString('hex'), Buffer.from(nodeCrypto.hkdfSync('sha256', 'CODE-DE-SYNCHRO-TEST', 'csm-remote', 'a1b2c3d4e5f6', 32)).toString('hex'));
  assert.notEqual(Buffer.from(await R.pilotKey('CODE-DE-SYNCHRO-TEST', 'ffffffffffff')).toString('hex'), Buffer.from(k).toString('hex'));
});

const pair = async () => {
  const base = R.rand(32), nP = R.rand(16), nH = R.rand(16);
  return { pilot: await R.openConnection(base, nP, nH, 'pilot'), host: await R.openConnection(base, nP, nH, 'host'), base, nP, nH };
};
test('trames : aller-retour dans les deux sens', async () => {
  const { pilot, host } = await pair();
  assert.deepEqual(await host.open(await pilot.seal({ k: 'http', path: '/api/sessions' })), { k: 'http', path: '/api/sessions' });
  assert.deepEqual(await pilot.open(await host.seal({ k: 'res', status: 200 })), { k: 'res', status: 200 });
  const s = await pilot.seal({ a: 1 });
  assert.ok(!s.includes('"a"'), 'chiffré');
});
test('trames : rejeu et altération refusés', async () => {
  const { pilot, host, base, nP } = await pair();
  const f1 = await pilot.seal({ n: 1 }), f2 = await pilot.seal({ n: 2 });
  assert.deepEqual(await host.open(f1), { n: 1 });
  assert.equal(await host.open(f1), null, 'rejouée');
  const bad = JSON.parse(f2); bad.d = (bad.d[0] === 'A' ? 'B' : 'A') + bad.d.slice(1);
  assert.equal(await host.open(JSON.stringify(bad)), null, 'altérée');
  assert.deepEqual(await host.open(f2), { n: 2 }, 'la connexion continue après une trame refusée');
  assert.deepEqual(await host.open(await pilot.seal({ x: 1 })), { x: 1 }, 'trame suivante acceptée');
  const other = await R.openConnection(base, nP, R.rand(16), 'host');
  assert.equal(await other.open(await pilot.seal({ n: 9 })), null, 'trame d’une autre connexion');
  assert.equal(await pilot.open(await pilot.seal({ n: 10 })), null, 'trame de son propre sens');
  assert.equal(await host.open('pas du json'), null);
});
test('web : enveloppe par mot de passe', async () => {
  const webKey = R.rand(32);
  const env = await R.webEnvelope('mot-de-passe-long-1', webKey);
  assert.equal(env.iter, 600000);
  const ok = await R.webUnlock('mot-de-passe-long-1', env);
  assert.equal(R.hex(await ok.open(env.envelope)), R.hex(webKey));
  assert.equal(await R.sha(Uint8Array.from(Buffer.from(ok.proof, 'hex'))), env.verifier, 'preuve vérifiable par son empreinte');
  const bad = await R.webUnlock('mauvais-mot-de-passe', env);
  assert.equal(await bad.open(env.envelope), null);
  assert.notEqual(await R.sha(Uint8Array.from(Buffer.from(bad.proof, 'hex'))), env.verifier);
});

test('trames : envois simultanés gardés dans l’ordre, rejeu simultané refusé', async () => {
  const { pilot, host } = await pair();
  const wire = [];
  // une grosse trame puis des petites, lancées en même temps
  await Promise.all([pilot.push({ big: 'x'.repeat(300000) }, s => wire.push(s)), ...[1, 2, 3].map(i => pilot.push({ i }, s => wire.push(s)))]);
  const got = await Promise.all(wire.map(w => host.open(w)));
  assert.equal(got[0].big.length, 300000);
  assert.deepEqual(got.slice(1), [{ i: 1 }, { i: 2 }, { i: 3 }], 'toutes acceptées, dans l’ordre');
  const f = await pilot.seal({ z: 1 });
  const [a, b] = await Promise.all([host.open(f), host.open(f)]);
  assert.deepEqual([a, b], [{ z: 1 }, null], 'la même trame deux fois en même temps : une seule acceptée');
});

test('morceaux : gros messages découpés, réassemblage borné', () => {
  const { wsFrames, assembler, PART } = require('../lib/remote/frames');
  const big = 'r'.repeat(PART * 3 + 10);
  const frames = wsFrames(7, ['petit', big, 'fin']);
  assert.ok(frames.every(f => JSON.stringify(f).length < 1.5 * 1024 * 1024), 'aucune trame au-delà de la limite du relais');
  const a = assembler(); const got = [];
  for (const f of frames) { if (f.k === 'ws') got.push(...f.m); else { const w = a.add(f.id, f.i, f.n, f.data); if (w) got.push(w); } }
  assert.deepEqual(got, ['petit', big, 'fin'], 'ordre et contenu gardés');
  assert.equal(a.add(1, 4294967294, 4294967295, 'x'), false, 'numéro démesuré refusé sans bloquer');
  assert.equal(a.add(2, 0, 2, 'a'), null); assert.equal(a.add(2, 1, 3, 'b'), false, 'nombre de morceaux qui change refusé');
});
