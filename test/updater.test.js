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
