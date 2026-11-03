// Tests du Worker de synchro sur un vrai runtime local (wrangler dev : D1 et R2 locaux, dossier temporaire).
// npm test (dans sync-worker/) ; aussi lancé par GitHub Actions avant chaque déploiement.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
// wrangler lancé par node directement : même commande sous Linux, macOS et Windows
const WRANGLER = process.execPath, W = path.join(DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const PORT = 8800 + Math.floor(Math.random() * 500);
const U = `http://127.0.0.1:${PORT}`;
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-worker-'));
let dev;

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
async function space() {
  const key = crypto.randomBytes(16).toString('hex');
  const r = await fetch(U + '/spaces', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': crypto.randomBytes(4).join('.') }, body: JSON.stringify({ auth: sha(key) }) });
  assert.equal(r.status, 200, 'espace créé');
  const H = { authorization: 'Bearer ' + key };
  const j = async (method, p, body) => {
    const res = await fetch(U + p, { method, headers: { ...H, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const putPart = (uid, ver, n, buf) => fetch(`${U}/transcripts/${uid}/${ver}/${n}`, { method: 'PUT', headers: H, body: buf });
  const getPart = (uid, ver, n) => fetch(`${U}/transcripts/${uid}/${ver}/${n}`, { headers: H });
  return { key, H, j, putPart, getPart };
}
const sql = cmd => JSON.parse(execFileSync(WRANGLER, [W, 'd1', 'execute', 'csm-sync', '--local', '--persist-to', STATE, '--json', '--command', cmd], { cwd: DIR, encoding: 'utf8' }))[0].results;
const usage = key => sql(`SELECT bytes FROM csm_usage WHERE space = '${sha(key)}'`)[0]?.bytes || 0;
const V = c => c.repeat(32);

before(async () => {
  execFileSync(WRANGLER, [W, 'd1', 'execute', 'csm-sync', '--local', '--persist-to', STATE, '--file', 'schema.sql'], { cwd: DIR, stdio: 'ignore' });
  dev = spawn(WRANGLER, [W, 'dev', '--local', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', STATE, '--test-scheduled', '--show-interactive-dev-session=false'], { cwd: DIR, stdio: 'ignore' });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(U + '/health')).ok) return; } catch { }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('wrangler dev ne répond pas');
});
after(() => { dev?.kill(); try { fs.rmSync(STATE, { recursive: true, force: true }); } catch { } }); // Windows : fichiers encore verrouillés

test('conversation : envoi, relecture, nouvelle version, suppression de la session', async () => {
  const s = await space(), uid = 'sess-aaaaaa', blob = crypto.randomBytes(300000);
  for (const n of [0, 1]) assert.equal((await s.putPart(uid, V('a'), n, blob)).status, 200);
  assert.equal((await s.j('PUT', `/transcripts/${uid}`, { cid: 'c', ver: V('a'), chunks: 3, updatedAt: 1 })).status, 409, 'morceau manquant');
  const ok = await s.j('PUT', `/transcripts/${uid}`, { cid: 'c', ver: V('a'), chunks: 2, size: 1, updatedAt: 1 });
  assert.equal(ok.body.applied, true);
  const list = (await s.j('GET', '/transcripts')).body.items;
  assert.equal(list[0].size, 600000, 'taille comptée par le serveur, pas celle annoncée');
  assert.ok(Buffer.from(await (await s.getPart(uid, V('a'), 1)).arrayBuffer()).equals(blob), 'morceau relu identique');
  assert.equal(usage(s.key), 600000);

  await s.putPart(uid, V('b'), 0, blob);
  assert.equal((await s.j('PUT', `/transcripts/${uid}`, { cid: 'c', ver: V('b'), chunks: 1, updatedAt: 2 })).body.applied, true);
  assert.equal((await s.getPart(uid, V('a'), 0)).status, 404, 'ancienne version effacée de R2');
  assert.equal(usage(s.key), 300000, 'place libérée');

  // version plus ancienne refusée : ses morceaux sont retirés
  await s.putPart(uid, V('c'), 0, blob);
  assert.equal((await s.j('PUT', `/transcripts/${uid}`, { cid: 'c', ver: V('c'), chunks: 1, updatedAt: 1 })).body.applied, false);
  assert.equal((await s.getPart(uid, V('c'), 0)).status, 404);
  assert.equal(usage(s.key), 300000);

  assert.equal((await s.j('POST', '/sessions', { items: [{ uid, data: {}, updatedAt: 5, deleted: true }] })).status, 200);
  assert.equal((await s.j('GET', '/transcripts')).body.items.length, 0);
  assert.equal((await s.getPart(uid, V('b'), 0)).status, 404, 'morceaux supprimés');
  assert.equal(usage(s.key), 0);
});

test('accès : clé inconnue refusée, espaces isolés, ancienne création de code retirée', async () => {
  const a = await space(), b = await space(), blob = crypto.randomBytes(1000);
  await a.putPart('sess-bbbbbb', V('d'), 0, blob);
  assert.equal((await b.getPart('sess-bbbbbb', V('d'), 0)).status, 404, 'un autre espace ne lit pas');
  assert.equal((await fetch(`${U}/transcripts`, { headers: { authorization: 'Bearer ' + 'z'.repeat(32) } })).status, 401);
  assert.equal((await fetch(U + '/spaces', { method: 'POST' })).status, 410);
  assert.equal((await fetch(`${U}/transcripts/..%2Fx/${V('d')}/0`, { headers: a.H })).status, 400, 'uid invalide');
});

test('limites : morceaux en attente plafonnés, place comptée à la réception', async () => {
  const s = await space(), small = crypto.randomBytes(10);
  let last;
  for (let i = 0; i < 201; i++) last = await s.putPart('sess-' + String(i).padStart(6, '0'), V('e'), 0, small);
  assert.equal(last.status, 429, 'au-delà de 200 morceaux non validés');
  assert.equal(usage(s.key), 2000, 'les morceaux en attente comptent');
  // réécrire le même morceau ne compte pas deux fois
  await s.putPart('sess-000000', V('e'), 0, crypto.randomBytes(30));
  assert.equal(usage(s.key), 2020);
});

test('ménage nocturne : morceaux en attente depuis plus d’une heure retirés, place recalculée', async () => {
  const s = await space();
  await s.putPart('sess-cccccc', V('f'), 0, crypto.randomBytes(500));
  sql(`UPDATE csm_parts SET at = 0 WHERE space = '${sha(s.key)}'`);
  sql(`UPDATE csm_usage SET bytes = 99999 WHERE space = '${sha(s.key)}'`); // dérive simulée
  assert.equal((await fetch(U + '/__scheduled?cron=17+3+*+*+*')).status, 200);
  assert.equal((await s.getPart('sess-cccccc', V('f'), 0)).status, 404);
  assert.equal(usage(s.key), 0, 'recalculé depuis les morceaux présents');
});

test('sessions : pagination par 1000, plafond de lignes exact', async () => {
  const s = await space();
  for (let k = 0; k < 3; k++) {
    const items = Array.from({ length: 400 }, (_, i) => ({ uid: `row-${k}-${String(i).padStart(4, '0')}`, data: { i }, updatedAt: 1 }));
    assert.equal((await s.j('POST', '/sessions', { items })).status, 200);
  }
  const p1 = (await s.j('GET', '/sessions?since=0')).body;
  assert.equal(p1.items.length, 1000);
  assert.equal(p1.rev, p1.items.at(-1).rev, 'curseur = dernière ligne de la page');
  const p2 = (await s.j('GET', `/sessions?since=${p1.rev}`)).body;
  assert.equal(p2.items.length, 200, 'la suite arrive');
});

test('espace : place occupée, puis effacement complet (changement de code)', async () => {
  const s = await space(), blob = crypto.randomBytes(5000);
  await s.putPart('sess-dddddd', V('a'), 0, blob);
  await s.j('PUT', '/transcripts/sess-dddddd', { cid: 'c', ver: V('a'), chunks: 1, updatedAt: 1 });
  await s.j('POST', '/sessions', { items: [{ uid: 'sess-dddddd', data: {}, updatedAt: 1 }] });
  const u = (await s.j('GET', '/usage')).body;
  assert.deepEqual([u.bytes, u.sessions, u.transcripts], [5000, 1, 1]);
  assert.equal(u.max, 1024 * 1024 * 1024, 'limite : 1 Gio par espace');
  assert.deepEqual(u.parts, { conversations: { n: 1, bytes: 5000 } }, 'détail par catégorie');
  const other = await space();
  await other.putPart('sess-eeeeee', V('a'), 0, blob);
  assert.equal((await s.j('DELETE', '/space')).status, 200);
  assert.equal((await s.j('GET', '/usage')).status, 401, 'ancien code refusé');
  assert.equal(sql(`SELECT COUNT(*) c FROM csm_parts WHERE space = '${sha(s.key)}'`)[0].c, 0);
  assert.equal((await other.getPart('sess-eeeeee', V('a'), 0)).status, 200, 'les autres espaces ne bougent pas');
});

test('temps réel : les autres machines de l’espace sont prévenues, pas l’auteur ni les autres espaces', async () => {
  const s = await space(), other = await space();
  const cA = crypto.randomBytes(8).toString('hex'), cB = crypto.randomBytes(8).toString('hex');
  const live = (sp, c) => new Promise((res, rej) => {
    const ws = new WebSocket(U.replace('http', 'ws') + '/live', { headers: { ...sp.H, 'x-csm-client': c } });
    ws.got = 0; ws.onmessage = e => { if (e.data === 'changed') ws.got++; };
    ws.onopen = () => res(ws); ws.onerror = () => rej(new Error('connexion /live refusée'));
  });
  const a = await live(s, cA), b = await live(s, cB), o = await live(other, cA);
  const r = await fetch(U + '/sessions', { method: 'POST', headers: { ...s.H, 'content-type': 'application/json', 'x-csm-client': cA }, body: JSON.stringify({ items: [{ uid: 'live-aaaaaa', data: {}, updatedAt: 1 }] }) });
  assert.equal(r.status, 200);
  for (let i = 0; i < 50 && !b.got; i++) await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 300));
  assert.equal(b.got, 1, 'autre machine prévenue');
  assert.equal(a.got, 0, 'l’auteur ne l’est pas');
  assert.equal(o.got, 0, 'autre espace jamais prévenu');
  // rien d'appliqué (version plus ancienne) : personne n'est prévenu
  await fetch(U + '/sessions', { method: 'POST', headers: { ...s.H, 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ uid: 'live-aaaaaa', data: {}, updatedAt: 0 }] }) });
  await new Promise(r => setTimeout(r, 500));
  assert.equal(b.got, 1);
  await assert.rejects(live({ H: { authorization: 'Bearer ' + 'x'.repeat(32) } }, cB), /refusée/, 'code inconnu refusé');
  for (const w of [a, b, o]) w.close();
});

// ---- audit synchro
test('suppression refusée (plus ancienne que la ligne en vigueur) : la conversation reste', async () => {
  const s = await space(), uid = 'sess-ffffff', blob = crypto.randomBytes(1000);
  assert.equal((await s.j('POST', '/sessions', { items: [{ uid, data: {}, updatedAt: 100 }] })).body.applied, 1);
  await s.putPart(uid, V('a'), 0, blob);
  assert.equal((await s.j('PUT', `/transcripts/${uid}`, { cid: 'c', ver: V('a'), chunks: 1, updatedAt: 100 })).body.applied, true);
  assert.equal((await s.j('POST', '/sessions', { items: [{ uid, data: {}, updatedAt: 50, deleted: true }] })).body.applied, 0);
  assert.equal((await s.j('GET', '/transcripts')).body.items.length, 1, 'conversation gardée');
  assert.equal((await s.getPart(uid, V('a'), 0)).status, 200, 'morceaux gardés');
});

test('horloges : date à plus d’1 h dans le futur refusée ; une ligne déjà datée dans le futur peut être remplacée', async () => {
  const s = await space(), uid = 'sess-gggggg', far = Date.now() + 2 * 3600e3;
  assert.equal((await s.j('POST', '/sessions', { items: [{ uid, data: {}, updatedAt: far }] })).body.applied, 0, 'session refusée');
  await s.putPart(uid, V('a'), 0, crypto.randomBytes(100));
  assert.equal((await s.j('PUT', `/transcripts/${uid}`, { cid: 'c', ver: V('a'), chunks: 1, updatedAt: far })).status, 400, 'conversation refusée');
  // ligne enregistrée avant cette règle (horloge en avance) : une écriture normale la remplace
  assert.equal((await s.j('POST', '/sessions', { items: [{ uid, data: {}, updatedAt: 1 }] })).body.applied, 1);
  sql(`UPDATE csm_sessions SET updatedAt = ${far * 10} WHERE space = '${sha(s.key)}' AND uid = '${uid}'`);
  assert.equal((await s.j('POST', '/sessions', { items: [{ uid, data: { x: 1 }, updatedAt: Date.now() }] })).body.applied, 1);
  assert.equal((await s.j('PUT', `/transcripts/${uid}`, { cid: 'c', ver: V('a'), chunks: 1, updatedAt: Date.now() })).body.applied, true);
  sql(`UPDATE csm_transcripts SET updatedAt = ${far * 10} WHERE space = '${sha(s.key)}' AND uid = '${uid}'`);
  await s.putPart(uid, V('b'), 0, crypto.randomBytes(100));
  assert.equal((await s.j('PUT', `/transcripts/${uid}`, { cid: 'c', ver: V('b'), chunks: 1, updatedAt: Date.now() })).body.applied, true);
});

test('plafond de lignes : les suppressions ne comptent pas ; ménage : vieilles suppressions, versions périmées, conversations sans session', async () => {
  const s = await space(), sp = sha(s.key);
  // 5000 lignes supprimées + 2 en vigueur : passe (les suppressions ne comptent pas)
  for (let k = 0; k < 10; k++) {
    const items = Array.from({ length: 500 }, (_, i) => ({ uid: `del-${k}-${String(i).padStart(4, '0')}`, data: {}, updatedAt: 1, deleted: true }));
    assert.equal((await s.j('POST', '/sessions', { items })).status, 200);
  }
  assert.equal((await s.j('POST', '/sessions', { items: [{ uid: 'vive-aaaaaa', data: {}, updatedAt: 1 }, { uid: 'vive-bbbbbb', data: {}, updatedAt: 1 }] })).status, 200);
  // version en vigueur + morceaux d'une ancienne version restés (ok = 1, plus d'une heure)
  await s.putPart('vive-aaaaaa', V('a'), 0, crypto.randomBytes(100));
  await s.j('PUT', '/transcripts/vive-aaaaaa', { cid: 'c', ver: V('a'), chunks: 1, updatedAt: 1 });
  sql(`INSERT INTO csm_parts (space, uid, ver, n, size, at, ok) VALUES ('${sp}', 'vive-aaaaaa', '${V('9')}', 0, 10, 0, 1)`);
  // conversation sans ligne de session ; mémoires (nm-, ob- : mémoire IA) jamais rattachée à une session : gardée
  for (const u of ['orphelin-aa', 'nm-memoire1', 'ob-memoireia1', 'sec-coffre0001']) {
    await s.putPart(u, V('c'), 0, crypto.randomBytes(100));
    await s.j('PUT', `/transcripts/${u}`, { cid: 'c', ver: V('c'), chunks: 1, updatedAt: 1 });
  }
  sql(`UPDATE csm_parts SET at = 0 WHERE space = '${sp}'`);
  assert.equal((await fetch(U + '/__scheduled?cron=17+3+*+*+*')).status, 200);
  assert.equal(sql(`SELECT COUNT(*) c FROM csm_sessions WHERE space = '${sp}' AND deleted = 1`)[0].c, 0, 'suppressions de plus de 90 jours effacées');
  assert.equal(sql(`SELECT COUNT(*) c FROM csm_parts WHERE space = '${sp}' AND ver = '${V('9')}'`)[0].c, 0, 'version périmée effacée');
  assert.equal((await s.getPart('vive-aaaaaa', V('a'), 0)).status, 200, 'version en vigueur gardée');
  const left = (await s.j('GET', '/transcripts')).body.items.map(x => x.uid).sort();
  assert.deepEqual(left, ['nm-memoire1', 'ob-memoireia1', 'sec-coffre0001', 'vive-aaaaaa'], 'conversation sans session effacée, mémoire gardée');
  assert.equal((await s.getPart('orphelin-aa', V('c'), 0)).status, 404);
});

// ---------------------------------------------------------------- pilotage à distance
const wsOpen = (p, headers = {}) => new Promise((resolve, reject) => {
  const ws = new WS(U.replace('http', 'ws') + p, { headers });
  const got = [];
  const closed = new Promise(r => ws.on('close', code => r(code)));
  ws.on('message', d => got.push(String(d)));
  ws.on('open', () => resolve({ ws, got, closed }));
  ws.on('error', reject);
});
import http from 'node:http';
import WS from 'ws';
// statut d'une demande d'ouverture de WebSocket (101 si acceptée)
const upgradeStatus = (p, headers = {}) => new Promise(resolve => {
  const r = http.request(U + p, { headers: { ...headers, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': crypto.randomBytes(16).toString('base64') } });
  r.on('response', res => { res.resume(); resolve(res.statusCode); });
  r.on('upgrade', (res, sock) => { sock.destroy(); resolve(101); });
  r.on('error', () => resolve(0));
  r.end();
});
const until = async (fn, ms = 5000) => { for (let i = 0; i < ms / 50; i++) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 50)); } throw new Error('délai dépassé'); };

test('relais : trames entre pilote et hôte, hôte absent, plafond de pilotes', async () => {
  const s = await space(), dev = 'a1b2c3d4e5f6';
  const r0 = { status: await upgradeStatus(`/relay?role=pilot&to=${dev}&c=0011223344556677`, { ...s.H }) };
  assert.equal(r0.status, 404, 'hôte absent');
  assert.equal((await upgradeStatus(`/relay?role=host&dev=${dev}`, {  })), 401, 'sans clé : refusé');
  const host = await wsOpen(`/relay?role=host&dev=${dev}`, s.H);
  const pilot = await wsOpen(`/relay?role=pilot&to=${dev}&c=0011223344556677`, s.H);
  await until(() => host.got.find(x => JSON.parse(x).ev === 'open'));
  pilot.ws.send('trame-opaque-1');
  assert.equal(JSON.parse(await until(() => host.got.find(x => JSON.parse(x).d))).d, 'trame-opaque-1');
  host.ws.send(JSON.stringify({ c: '0011223344556677', d: 'réponse-opaque' }));
  assert.equal(await until(() => pilot.got[0]), 'réponse-opaque');
  // autre espace : ne voit pas cette machine
  const other = await space();
  assert.equal((await upgradeStatus(`/relay?role=pilot&to=${dev}&c=0011223344556699`, { ...other.H })), 404);
  const more = [];
  for (let i = 0; i < 3; i++) more.push(await wsOpen(`/relay?role=pilot&to=${dev}&c=00112233445566a${i}`, s.H));
  assert.equal((await upgradeStatus(`/relay?role=pilot&to=${dev}&c=00112233445566b0`, { ...s.H })), 429, '4 pilotes au plus');
  // l'hôte coupe un pilote, puis se déconnecte : les pilotes sont fermés
  host.ws.send(JSON.stringify({ c: '0011223344556677', ev: 'close' }));
  assert.equal(await pilot.closed, 4000);
  host.ws.close();
  assert.equal(await more[0].closed, 4404);
});

test('web : accès par mot de passe, limite d’essais, nouveau mot de passe déconnecte', async () => {
  const s = await space(), dev = 'b1b2c3d4e5f6', w = crypto.randomBytes(16).toString('hex');
  const proof = crypto.randomBytes(32), verifier = crypto.createHash('sha256').update(proof).digest('hex');
  assert.equal((await s.j('PUT', '/web-access', { w, dev, salt: 'c2Vs', iter: 600000, verifier, envelope: 'ZW52' })).status, 200);
  assert.deepEqual((await (await fetch(`${U}/web/info?w=${w}`)).json()), { salt: 'c2Vs', iter: 600000 });
  const unlock = p => fetch(`${U}/web/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ w, proof: p }) });
  const host = await wsOpen(`/relay?role=host&dev=${dev}`, s.H);
  const ok = await (await unlock(proof.toString('hex'))).json();
  assert.equal(ok.envelope, 'ZW52'); assert.match(ok.ticket, /^[0-9a-f]{48}$/);
  const pilot = await wsOpen(`/web/relay?w=${w}&c=00aa11bb22cc33dd&ticket=${ok.ticket}`);
  const opened = JSON.parse(await until(() => host.got.find(x => JSON.parse(x).ev === 'open')));
  assert.equal(opened.web, true);
  assert.equal((await upgradeStatus(`/web/relay?w=${w}&c=00aa11bb22cc33de&ticket=${ok.ticket}`, {  })), 401, 'ticket à usage unique');
  // nouveau mot de passe : le pilote web de l'ancienne génération est déconnecté
  await s.j('PUT', '/web-access', { w, dev, salt: 'c2Vs', iter: 600000, verifier, envelope: 'ZW52' });
  assert.equal(await pilot.closed, 4403);
  // 10 mauvais essais dans l'heure : bloqué, même avec la bonne preuve
  for (let i = 0; i < 10; i++) assert.equal((await unlock(crypto.randomBytes(32).toString('hex'))).status, 403);
  assert.equal((await unlock(proof.toString('hex'))).status, 429);
  // un autre espace ne peut pas reprendre ce lien
  assert.equal((await (await space()).j('PUT', '/web-access', { w, dev, salt: 'c2Vs', iter: 600000, verifier, envelope: 'ZW52' })).status, 409);
  host.ws.close();
});

test('web : chargeur servi avec sa politique de sécurité, chiffrement identique à celui de l’app', async () => {
  const r = await fetch(`${U}/web`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await r.text(), /csmRemoteCrypto/);
  const js = await (await fetch(`${U}/web/remote-crypto.js`)).text();
  assert.equal(js, fs.readFileSync(path.join(DIR, '..', 'public', 'remote-crypto.js'), 'utf8'), 'web/remote-crypto.txt = public/remote-crypto.js (copier après un changement)');
});
