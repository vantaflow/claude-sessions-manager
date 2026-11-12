'use strict';
// Module des mises à jour chargé comme dans l'app empaquetée : sans la section « build » de package.json (retirée
// par electron-builder) et avec un faux module electron. De 3.59.1 à 3.64.3, il plantait au lancement : plus
// aucune mise à jour proposée, sur Mac comme sur Windows.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs'), os = require('os'), path = require('path');

test('mises à jour : le module démarre sans la section build de package.json et vérifie la dernière version', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-maj-'));
  const asked = [];
  const electron = {
    app: { isPackaged: true, getVersion: () => '1.0.0', getPath: () => tmp, quit: () => { } },
    net: { fetch: async u => { asked.push(u); return { ok: true, json: async () => ({ tag_name: 'v1.0.0', html_url: 'https://x' }) }; } },
    shell: { openExternal: () => { } }, Notification: { isSupported: () => false },
  };
  const realLoad = Module._load, realPkg = require.resolve('../package.json');
  const pkg = JSON.parse(fs.readFileSync(realPkg, 'utf8')); delete pkg.build; // comme dans l'app empaquetée
  Module._load = function (req, parent, ...rest) {
    if (req === 'electron') return electron;
    if (req === 'electron-updater') throw new Error('absent du test');
    if (req === '../package.json' && parent && /electron[\\/]updater\.js$/.test(parent.filename)) return pkg;
    return realLoad.call(this, req, parent, ...rest);
  };
  const plat = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const logs = [];
  try {
    delete require.cache[require.resolve('../electron/updater')];
    const up = require('../electron/updater')({ enabled: async () => true, onState: () => { }, log: m => logs.push(m) });
    await up.check();
    assert.equal(up.state.status, 'uptodate', logs.join('\n'));
    assert.match(asked[0], /api\.github\.com\/repos\/vantaflow\/claude-sessions-manager\/releases\/latest/);
  } finally {
    Module._load = realLoad;
    Object.defineProperty(process, 'platform', plat);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// 3.71.3 sur macOS : installation au lancement + bouton « Redémarrer » pendant l'arrêt du serveur = deux scripts de
// remplacement en même temps, l'app a disparu du dossier Applications. Une seule installation doit partir.
test('mises à jour : deux demandes d’installation simultanées n’en lancent qu’une', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-maj-'));
  let opened = 0, quits = 0, stops = 0;
  const electron = {
    app: { isPackaged: true, getVersion: () => '1.0.0', getPath: () => tmp, quit: () => { quits++; } },
    net: { fetch: async () => ({ ok: true, json: async () => ({ tag_name: 'v1.0.0', html_url: 'https://x' }) }) },
    shell: { openExternal: () => { opened++; } }, Notification: { isSupported: () => false },
  };
  const realLoad = Module._load;
  Module._load = function (req, parent, ...rest) {
    if (req === 'electron') return electron;
    if (req === 'electron-updater') throw new Error('absent du test');
    return realLoad.call(this, req, parent, ...rest);
  };
  try {
    delete require.cache[require.resolve('../electron/updater')];
    const up = require('../electron/updater')({ enabled: async () => true, onState: () => { }, log: () => { }, beforeInstall: async () => { stops++; } });
    // pas de version prête : lien vers la page, à chaque demande (rien ne reste bloqué)
    await Promise.all([up.install(), up.install()]);
    await up.install();
    assert.equal(opened, 2, 'deux demandes simultanées = un seul lien ; une demande suivante en rouvre un');
    assert.equal(stops + quits, 0);
  } finally {
    Module._load = realLoad;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// 3.72.1 sur macOS : téléchargement coupé par le réseau (Wi-Fi, VPN), nouvel essai seulement 30 min plus tard.
test('mises à jour macOS : coupure réseau pendant le téléchargement, nouvel essai dans la foulée', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-maj-'));
  let ymlTries = 0;
  const electron = {
    app: { isPackaged: true, getVersion: () => '1.0.0', getPath: () => tmp, quit: () => { } },
    net: { fetch: async u => {
      if (/releases\/latest$/.test(u)) return { ok: true, json: async () => ({ tag_name: 'v2.0.0', html_url: 'https://x', assets: [{ name: 'x-arm64.dmg', size: 1 }, { name: 'x-x64.dmg', size: 1 }, { name: 'latest-mac.yml' }] }) };
      if (/latest-mac\.yml$/.test(u)) { ymlTries++; if (ymlTries <= 2) throw new Error('net::ERR_NETWORK_CHANGED'); return { ok: true, text: async () => 'files: []' }; }
      return { ok: false, status: 404, text: async () => '' }; // .sig absente : « version non signée », pas de nouvel essai
    } },
    shell: { openExternal: () => { } }, Notification: { isSupported: () => false },
  };
  const realLoad = Module._load;
  Module._load = function (req, parent, ...rest) {
    if (req === 'electron') return electron;
    if (req === 'electron-updater') throw new Error('absent du test');
    return realLoad.call(this, req, parent, ...rest);
  };
  const plat = Object.getOwnPropertyDescriptor(process, 'platform'), exe = process.execPath;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  process.execPath = path.join(tmp, 'Claude Sessions.app', 'Contents', 'MacOS', 'Claude Sessions');
  process.env.CSM_UPDATE_RETRY_MS = '1';
  const logs = [];
  try {
    delete require.cache[require.resolve('../electron/updater')];
    const up = require('../electron/updater')({ enabled: async () => true, onState: () => { }, log: m => logs.push(m) });
    await up.check();
    assert.equal(ymlTries, 3, logs.join('\n'));
    assert.match(up.state.error || '', /non signée/, 'erreur finale : la vraie cause, sans nouvel essai');
  } finally {
    Module._load = realLoad;
    Object.defineProperty(process, 'platform', plat); process.execPath = exe;
    delete process.env.CSM_UPDATE_RETRY_MS;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
