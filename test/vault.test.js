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

const { orgOf, verify } = require('../lib/vault/azure');
test('organisation Azure DevOps : https, ssh, visualstudio.com, worktree, sans remote', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'org-'));
  const repo = (name, url) => {
    const d = path.join(root, name); fs.mkdirSync(path.join(d, '.git'), { recursive: true });
    fs.writeFileSync(path.join(d, '.git', 'config'), `[core]\n\tbare = false\n${url ? `[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : ''}`);
    return d;
  };
  assert.equal(orgOf(repo('a', 'https://Org-Une@dev.azure.com/Org-Une/Projet/_git/Depot')), 'Org-Une');
  assert.equal(orgOf(repo('b', 'git@ssh.dev.azure.com:v3/OrgDeux/Projet/Depot')), 'OrgDeux');
  assert.equal(orgOf(repo('c', 'https://orgtrois.visualstudio.com/Projet/_git/Depot')), 'orgtrois');
  assert.equal(orgOf(repo('d', 'orgquatre@vs-ssh.visualstudio.com:v3/orgquatre/Projet/Depot')), 'orgquatre');
  assert.equal(orgOf(repo('e', 'https://github.com/x/y.git')), '');
  assert.equal(orgOf(repo('f', '')), '');
  // sous-dossier d'un dépôt, puis worktree (.git fichier vers .git/worktrees/<nom>, commondir)
  const sub = path.join(root, 'a', 'src', 'lib'); fs.mkdirSync(sub, { recursive: true });
  assert.equal(orgOf(sub), 'Org-Une');
  const wtGit = path.join(root, 'a', '.git', 'worktrees', 'wt'); fs.mkdirSync(wtGit, { recursive: true });
  fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
  const wt = path.join(root, 'wt'); fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
  assert.equal(orgOf(wt), 'Org-Une');
  assert.equal(orgOf(path.join(root, 'introuvable')), '');
  fs.rmSync(root, { recursive: true, force: true });
});

test('vérification d’un PAT : accepté, refusé (401, 203 vers la connexion), réseau coupé', async () => {
  const seen = [];
  const who = { authenticatedUser: { id: '3f2a9c1e-0000-4000-8000-000000000001', descriptor: 'Microsoft.IdentityModel.Claims.ClaimsIdentity;x' } };
  const anon = { authenticatedUser: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', descriptor: 'System:PublicAccess;aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } };
  const fake = (status, body = who) => async (url, o) => { seen.push({ url, auth: o.headers.Authorization }); if (status === 'err') throw new Error('réseau'); return { status, json: async () => body }; };
  assert.equal(await verify('MonOrg', 'pat1', { fetch: fake(200) }), 'ok');
  assert.equal(await verify('MonOrg', 'pat1', { fetch: fake(200, anon) }), 'refused', 'connexion anonyme : PAT refusé');
  assert.equal(seen[0].url, 'https://dev.azure.com/MonOrg/_apis/connectionData');
  assert.equal(seen[0].auth, 'Basic ' + Buffer.from(':pat1').toString('base64'));
  assert.equal(await verify('MonOrg', 'pat1', { fetch: fake(401) }), 'refused');
  assert.equal(await verify('MonOrg', 'pat1', { fetch: fake(203) }), 'refused');
  assert.equal(await verify('MonOrg', 'pat1', { fetch: fake('err') }), 'error');
  assert.equal(await verify('../x', 'pat1', { fetch: fake(200) }), 'error', 'organisation invalide : aucun appel');
});
