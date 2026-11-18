'use strict';
// RTK (Rust Token Killer, rtk-ai/rtk) fourni avec CSM : moins de tokens sur les commandes que lance Claude
// (git, tests, ls, grep…), sortie filtrée avant d'arriver dans le contexte. Réglage « rtk », actif par défaut.
//
// - Programme : l'édition rtk-oss (Apache-2.0 seule, sans le moteur sous BUSL) est téléchargée depuis les versions
//   publiées de rtk-ai/rtk, empreinte SHA-256 vérifiée contre checksums.txt, et rangée dans <données CSM>/bin.
//   Vérifiée au lancement puis chaque jour : une version plus récente remplace l'ancienne.
// - Branchement : le hook « rtk hook claude » (PreToolUse, Bash) est ajouté aux réglages que CSM passe à chaque
//   session (--settings), et le dossier du programme au PATH de la session (les commandes réécrites appellent
//   « rtk »). Rien n'est écrit dans ~/.claude : toutes les sessions de CSM l'ont, nouvelles comme anciennes, à leur
//   lancement ou à leur reprise.
// - RTK déjà branché par l'utilisateur (son hook dans ~/.claude/settings.json) : pas de second hook.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const API = () => process.env.CSM_RTK_API || 'https://api.github.com/repos/rtk-ai/rtk/releases/latest';
const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? 'rtk.exe' : 'rtk';
// Windows ARM : la version x64 tourne en émulation
const TARGETS = {
  'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl',
};
const USER_HOOK = /(^|[\s"'\\/])rtk(\.exe)?"?\s+hook\b|rtk-rewrite/i;
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const fwd = p => p.replace(/\\/g, '/');

function newer(a, b) { // a > b ?
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}
const run = (file, args) => new Promise(res => execFile(file, args, { timeout: 60e3, windowsHide: true, encoding: 'utf8', shell: IS_WIN && /\.(cmd|bat)$/i.test(file) },
  (err, out, errOut) => res({ ok: !err, out: (String(out || '') + String(errOut || '')).trim() })));
async function versionOf(bin) { const r = await run(bin, ['--version']); return (r.out.match(/\b(\d+\.\d+\.\d+)\b/) || [])[1] || ''; }

// Hook RTK déjà présent dans les réglages de l'utilisateur
function userHasHook() {
  for (const f of ['settings.json', 'settings.local.json']) {
    try {
      const hooks = JSON.parse(fs.readFileSync(path.join(claudeDir(), f), 'utf8')).hooks || {};
      for (const groups of Object.values(hooks)) for (const g of groups || []) for (const h of g?.hooks || []) if (typeof h?.command === 'string' && USER_HOOK.test(h.command)) return true;
    } catch { }
  }
  return false;
}

async function get(url, as) {
  const r = await fetch(url, { headers: { 'User-Agent': 'claude-sessions-manager', Accept: as === 'json' ? 'application/vnd.github+json' : '*/*' }, signal: AbortSignal.timeout(120e3) });
  if (!r.ok) throw new Error(`${path.basename(new URL(url).pathname)} : HTTP ${r.status}`);
  return as === 'json' ? r.json() : as === 'text' ? r.text() : Buffer.from(await r.arrayBuffer());
}
function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
  }
  return null;
}

module.exports = function (ctx) {
  const DIR = path.join(ctx.DATA, 'bin'), OWN = path.join(DIR, EXE);
  const status = { version: '', error: '', at: 0, busy: false };
  const on = () => ctx.getSettings?.().rtk !== false;
  const bin = () => process.env.CSM_RTK_BIN || (fs.existsSync(OWN) ? OWN : null);

  // pour spawnSession / sessionSettings (server.js)
  ctx.rtkHooks = () => (on() && bin() && !userHasHook())
    ? [{ matcher: 'Bash', hooks: [{ type: 'command', command: `"${fwd(bin())}" hook claude`, timeout: 10 }] }] : [];
  ctx.rtkDir = () => (on() && bin() ? path.dirname(bin()) : null);

  async function install() {
    if (status.busy || !on() || process.env.CSM_NO_RTK || process.env.CSM_RTK_BIN) return status;
    status.busy = true; status.error = '';
    try {
      const target = TARGETS[`${process.platform}-${process.arch}`];
      if (!target) throw new Error(`système non pris en charge (${process.platform}-${process.arch})`);
      const rel = await get(API(), 'json');
      const tag = String(rel.tag_name || '').replace(/^v/, '');
      if (!/^\d+\.\d+\.\d+$/.test(tag)) throw new Error('version publiée illisible');
      const cur = fs.existsSync(OWN) ? await versionOf(OWN) : '';
      if (cur && !newer(tag, cur)) { status.version = cur; return status; }
      const name = `rtk-oss-${target}.${IS_WIN ? 'zip' : 'tar.gz'}`;
      const asset = (rel.assets || []).find(a => a.name === name), sums = (rel.assets || []).find(a => a.name === 'checksums.txt');
      if (!asset || !sums) throw new Error(`${name} absent de la version ${tag}`);
      const want = (await get(sums.browser_download_url, 'text')).split(/\r?\n/).map(l => l.trim().split(/\s+/))
        .find(p => p[1] && p[1].replace(/^\*/, '') === name)?.[0]?.toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(want || '')) throw new Error(`empreinte de ${name} absente de checksums.txt`);
      const buf = await get(asset.browser_download_url);
      if (crypto.createHash('sha256').update(buf).digest('hex') !== want) throw new Error(`empreinte de ${name} invalide : rien n'est installé`);
      const tmp = path.join(ctx.DATA, 'bin.tmp');
      fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
      const arc = path.join(tmp, name);
      fs.writeFileSync(arc, buf);
      const x = await run('tar', ['-xf', arc, '-C', tmp]); // tar de Windows 10+ lit aussi les .zip
      if (!x.ok) throw new Error(`extraction : ${x.out.slice(-200)}`);
      const exe = findFile(tmp, EXE);
      if (!exe) throw new Error(`${EXE} absent de l'archive`);
      if (!IS_WIN) fs.chmodSync(exe, 0o755);
      if (!(await versionOf(exe))) throw new Error('le programme téléchargé ne démarre pas');
      fs.mkdirSync(DIR, { recursive: true });
      // Windows : un programme en cours d'utilisation (hook d'une session) se renomme mais ne s'écrase pas
      if (fs.existsSync(OWN)) { const old = OWN + '.old'; try { fs.rmSync(old, { force: true }); } catch { } try { fs.renameSync(OWN, old); } catch { } }
      fs.renameSync(exe, OWN);
      fs.rmSync(tmp, { recursive: true, force: true });
      status.version = await versionOf(OWN);
      console.log(`[rtk] ${cur ? `mis à jour ${cur} → ${status.version}` : `installé ${status.version}`}`);
      if (!cur) ctx.applySettingsOnIdle?.(); // premier hook : sessions ouvertes relancées à la fin de leur prochain tour
    } catch (e) {
      status.error = e.message; console.error('[rtk]', e.message);
    } finally { status.busy = false; status.at = Date.now(); }
    return status;
  }

  ctx.rtkChanged = () => { install().catch(() => { }); };
  setTimeout(() => install().catch(() => { }), Number(process.env.CSM_RTK_DELAY) || 5e3).unref?.();
  setInterval(() => install().catch(() => { }), 24 * 3600e3).unref?.();

  const view = async () => ({ on: on(), installed: !!bin(), path: bin(), version: status.version || (bin() ? await versionOf(bin()) : ''), userHook: userHasHook(), error: status.error, busy: status.busy, at: status.at });
  ctx.route('GET', /^\/api\/rtk$/, async ({ res }) => ctx.json(res, 200, await view()));
  ctx.route('POST', /^\/api\/rtk$/, async ({ res }) => { await install(); ctx.json(res, 200, await view()); });
};
module.exports.userHasHook = userHasHook;
module.exports.TARGETS = TARGETS;
