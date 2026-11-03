'use strict';
// Tests unitaires du coffre : valeurs protégées (mode fichier), organisation Azure DevOps d'un dossier, vérification d'un PAT.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');

test('valeurs : enregistrées hors des métadonnées, relues, retirées', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coffre-'));
  const b = require('../lib/vault/backend').open(dir, { fileOnly: true });
  await b.put('aaaa1111', 'secret-très-long-1');
  await b.put('bbbb2222', 'autre');
  const again = require('../lib/vault/backend').open(dir, { fileOnly: true });
  const m = await again.load(['aaaa1111', 'bbbb2222']);
  assert.equal(m.get('aaaa1111'), 'secret-très-long-1');
  assert.ok(!fs.readFileSync(path.join(dir, 'vault-values.json'), 'utf8').includes('secret-très-long-1'), 'pas en clair');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'vault-values.json')).mode & 0o777, 0o600);
  await again.drop('bbbb2222');
  assert.equal((await require('../lib/vault/backend').open(dir, { fileOnly: true }).load(['aaaa1111', 'bbbb2222'])).has('bbbb2222'), false);
  // cibles (mode fichier : secrets.env des données, comme lib/secrets.js)
  await again.writeTarget({ env: 'MON_JETON_TEST' }, 'valeur-cible');
  assert.equal(await again.readTarget({ env: 'MON_JETON_TEST' }), 'valeur-cible');
  await again.removeTarget({ env: 'MON_JETON_TEST' });
  assert.equal(await again.readTarget({ env: 'MON_JETON_TEST' }), null);
  await assert.rejects(again.writeTarget({ env: 'PATH' }, 'x'), /refus/);
  fs.rmSync(dir, { recursive: true, force: true });
});
