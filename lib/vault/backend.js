'use strict';
// Coffre : où sont gardées les valeurs sur cette machine, et les cibles où les outils les lisent hors de l'app.
// - macOS : trousseau de l'utilisateur, service « csm-coffre », compte = id du secret ;
// - Windows : chiffrées par le système pour cet utilisateur (DPAPI, PowerShell), dans DATA/vault-values.json ;
// - Linux, ou tests (fileOnly) : DATA/vault-values.json (0600), valeurs encodées.
// Cibles : service du trousseau macOS (keychain) et/ou variable d'environnement de l'utilisateur (env : Windows ;
// ailleurs, fichier secrets.env des données de l'app, chargé dans l'environnement des sessions par lib/secrets.js).
// Les valeurs passent par l'entrée standard de PowerShell, jamais par sa ligne de commande.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { safeEnvName } = require('../extensions');

const SERVICE = 'csm-coffre';
const KEYCHAIN = /^[\w.@-]{1,100}$/;
const run = (cmd, args, input) => new Promise((resolve, reject) => {
  const p = execFile(cmd, args, { timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, out, err) => (e ? reject(Object.assign(new Error(String(err || e.message).trim().slice(0, 200)), { code: e.code })) : resolve(String(out))));
  if (input !== undefined) p.stdin.end(input); else p.stdin.end();
});
const ps = (script, input) => run('powershell', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::InputEncoding=[Text.Encoding]::UTF8; ' + script], input);
// `security -w` affiche en hexadécimal une valeur qui n'est pas de l'ASCII imprimable : décodée si c'est bien de l'UTF-8
function fromKeychain(out) {
  const v = out.replace(/\n$/, '');
  if (/^([0-9a-f]{2})+$/.test(v)) { const buf = Buffer.from(v, 'hex'); const t = buf.toString('utf8'); if (/[^\x00-\x7f]/.test(t) && Buffer.from(t, 'utf8').equals(buf)) return t; }
  return v;
}
const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');
const unb64 = s => Buffer.from(String(s || ''), 'base64').toString('utf8');

function checkTarget(t) {
  if (t.env && !safeEnvName(t.env)) throw new Error('cible refusée : variable ' + t.env);
  if (t.keychain && !KEYCHAIN.test(t.keychain)) throw new Error('cible refusée : trousseau ' + t.keychain);
}

function open(DATA, { fileOnly = false, isMac = process.platform === 'darwin', isWin = process.platform === 'win32' } = {}) {
  const FILE = path.join(DATA, 'vault-values.json'), ENVFILE = path.join(DATA, 'secrets.env');
  const mode = fileOnly ? 'file' : isMac ? 'keychain' : isWin ? 'dpapi' : 'file';
  const readFile = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; } };
  const writeFile = o => { fs.writeFileSync(FILE + '.tmp', JSON.stringify(o), { mode: 0o600 }); fs.renameSync(FILE + '.tmp', FILE); try { fs.chmodSync(FILE, 0o600); } catch { } };

  async function load(ids) {
    const out = new Map();
    if (mode === 'keychain') {
      for (const id of ids) { try { out.set(id, unb64((await run('security', ['find-generic-password', '-s', SERVICE, '-a', id, '-w'])).trim())); } catch { } }
      return out;
    }
    const f = readFile();
    if (mode === 'file') { for (const id of ids) if (f[id]) out.set(id, unb64(f[id])); return out; }
    const want = Object.fromEntries(ids.filter(id => f[id]).map(id => [id, f[id]]));
    if (!Object.keys(want).length) return out;
    const r = await ps('$m = [Console]::In.ReadToEnd() | ConvertFrom-Json; $o = @{}; foreach ($p in $m.PSObject.Properties) { try { $s = ConvertTo-SecureString $p.Value; '
      + '$v = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)); $o[$p.Name] = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v)) } catch { } }; $o | ConvertTo-Json -Compress', JSON.stringify(want));
    let o = {}; try { o = JSON.parse(r.trim() || '{}'); } catch { }
    for (const [id, v] of Object.entries(o)) out.set(id, unb64(v));
    return out;
  }
  async function put(id, value) {
    if (mode === 'keychain') return void await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', id, '-w', b64(value)]); // encodé : relu tel quel
    const f = readFile();
    if (mode === 'file') f[id] = b64(value);
    else f[id] = (await ps('$v = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())); ConvertTo-SecureString $v -AsPlainText -Force | ConvertFrom-SecureString', b64(value))).trim();
    writeFile(f);
  }
  async function drop(id) {
    if (mode === 'keychain') { try { await run('security', ['delete-generic-password', '-s', SERVICE, '-a', id]); } catch { } return; }
    const f = readFile(); delete f[id]; writeFile(f);
  }

  // ---------------------------------------------------------------- cibles
  const envLines = () => { try { return fs.readFileSync(ENVFILE, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  async function writeTarget(t, value) {
    checkTarget(t);
    if (t.keychain && mode === 'keychain') await run('security', ['add-generic-password', '-U', '-s', t.keychain, '-a', os.userInfo().username, '-w', value]);
    if (t.env) {
      if (mode === 'dpapi') await ps(`$v = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())); [Environment]::SetEnvironmentVariable('${t.env}', $v, 'User')`, b64(value));
      else { const l = envLines().filter(x => !x.startsWith(t.env + '=')); l.push(`${t.env}=${b64(value)}`); fs.writeFileSync(ENVFILE, l.join('\n') + '\n', { mode: 0o600 }); }
      process.env[t.env] = value;
    }
  }
  async function readTarget(t) {
    checkTarget(t);
    if (t.keychain && mode === 'keychain') { try { return fromKeychain(await run('security', ['find-generic-password', '-s', t.keychain, '-w'])); } catch { } }
    if (t.env) {
      if (mode === 'dpapi') {
        try { const r = await ps(`$v = [Environment]::GetEnvironmentVariable('${t.env}', 'User'); if ($v) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v)) }`); if (r.trim()) return unb64(r.trim()); } catch { }
        return null;
      }
      const l = envLines().find(x => x.startsWith(t.env + '='));
      if (l) return unb64(l.slice(t.env.length + 1));
      if (mode === 'keychain' && process.env[t.env]) return process.env[t.env];
    }
    return null;
  }
  async function removeTarget(t) {
    checkTarget(t);
    if (t.keychain && mode === 'keychain') { try { await run('security', ['delete-generic-password', '-s', t.keychain]); } catch { } }
    if (t.env) {
      if (mode === 'dpapi') { try { await ps(`[Environment]::SetEnvironmentVariable('${t.env}', $null, 'User')`); } catch { } }
      else fs.writeFileSync(ENVFILE, envLines().filter(x => !x.startsWith(t.env + '=')).join('\n') + '\n', { mode: 0o600 });
      delete process.env[t.env];
    }
  }
  return { mode, load, put, drop, writeTarget, readTarget, removeTarget };
}

module.exports = { open, checkTarget, KEYCHAIN };
