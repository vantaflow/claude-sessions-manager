'use strict';
// Retrait de token-optimizer (alexgreensh/token-optimizer), remplacé par RTK fourni avec CSM (lib/rtk.js).
// Au lancement de CSM (puis toutes les 6 h), s'il est là :
//  1. son service en arrière-plan (tableau de bord : launchd sur macOS, Planificateur de tâches sous Windows,
//     systemd --user sous Linux) est arrêté par son propre désinstalleur (measure.py setup-daemon --uninstall),
//     puis tout ce qui en reste est retiré par nom (com.token-optimizer.*, tâches et unités token-optimizer*) ;
//  2. le plugin est désinstallé de Claude Code (claude plugin uninstall), sa marketplace retirée ;
//  3. ses données (~/.claude/token-optimizer, ~/.claude/plugins/data/token-optimizer-*) sont supprimées.
// La synchro des plugins ne le réinstalle jamais depuis une autre machine (lib/pluginsync.js, NEVER_INSTALL).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PLUGIN = 'token-optimizer';
const NAME = /token[-_]?optimizer/i;
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const run = (file, args, opts = {}) => new Promise(res => execFile(file, args, { timeout: 120e3, windowsHide: true, encoding: 'utf8', ...opts },
  (err, out, errOut) => res({ ok: !err, out: (String(out || '') + String(errOut || '')).trim() })));

// clés « token-optimizer@<marketplace> » installées, avec leur dossier
function installs() {
  const inst = readJson(path.join(claudeDir(), 'plugins', 'installed_plugins.json'));
  const out = [];
  for (const [key, list] of Object.entries(inst?.plugins || {})) {
    if (!key.startsWith(PLUGIN + '@')) continue;
    for (const e of Array.isArray(list) ? list : [list]) out.push({ key, market: key.slice(PLUGIN.length + 1), dir: e?.installPath || '' });
    if (!Array.isArray(list) || !list.length) out.push({ key, market: key.slice(PLUGIN.length + 1), dir: '' });
  }
  return out;
}
const dataDirs = () => {
  const out = [path.join(claudeDir(), 'token-optimizer')];
  const d = path.join(claudeDir(), 'plugins', 'data');
  try { for (const n of fs.readdirSync(d)) if (n.startsWith(PLUGIN + '-')) out.push(path.join(d, n)); } catch { }
  return out.filter(p => fs.existsSync(p));
};
const launchAgents = () => {
  if (process.platform !== 'darwin') return [];
  const d = path.join(os.homedir(), 'Library', 'LaunchAgents');
  try { return fs.readdirSync(d).filter(n => /^com\.token-optimizer\..*\.plist$/.test(n)).map(n => path.join(d, n)); } catch { return []; }
};
const systemdUnits = () => {
  if (process.platform !== 'linux') return [];
  const d = path.join(os.homedir(), '.config', 'systemd', 'user');
  try { return fs.readdirSync(d).filter(n => NAME.test(n) && /\.(service|timer)$/.test(n)).map(n => path.join(d, n)); } catch { return []; }
};
async function scheduledTasks() {
  if (process.platform !== 'win32') return [];
  const r = await run('schtasks', ['/Query', '/FO', 'CSV', '/NH'], { timeout: 30e3 });
  if (!r.ok) return [];
  return [...new Set(r.out.split(/\r?\n/).map(l => (l.match(/^"([^"]+)"/) || [])[1]).filter(n => n && NAME.test(n)))];
}
// quelque chose à retirer ?
async function present() {
  return installs().length > 0 || dataDirs().length > 0 || launchAgents().length > 0 || systemdUnits().length > 0 || (await scheduledTasks()).length > 0;
}
async function python() {
  for (const p of process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python']) {
    const r = await run(p, ['--version'], { timeout: 10e3 });
    if (r.ok && /Python 3/.test(r.out)) return p;
  }
  return null;
}

module.exports = function (ctx) {
  const status = { at: 0, done: [], error: '', busy: false };

  // claude plugin … (même environnement que les sessions, sans l'identité d'une session parente)
  function claude(args) {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|ELECTRON_RUN_AS_NODE$)/.test(k)) delete env[k];
    const file = ctx.CLAUDE, win = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
    const pre = (process.env.CSM_CLAUDE_ARGS || '').match(/"[^"]*"|\S+/g)?.map(x => x.replace(/^"|"$/g, '')) || [];
    return run(win ? 'cmd.exe' : file, win ? ['/d', '/s', '/c', file, ...pre, ...args] : [...pre, ...args], { env, timeout: 300e3 });
  }

  async function remove() {
    if (status.busy || process.env.CSM_NO_TOKENOPT_REMOVE) return status;
    status.busy = true; status.error = ''; status.done = [];
    try {
      if (!(await present())) return status;
      const list = installs();
      // 1. service en arrière-plan : d'abord le désinstalleur du plugin, puis ce qui reste, par nom
      const py = await python();
      for (const { dir } of list) {
        const m = dir && path.join(dir, 'skills', 'token-optimizer', 'scripts', 'measure.py');
        if (py && m && fs.existsSync(m)) { const r = await run(py, [m, 'setup-daemon', '--uninstall']); if (r.ok) status.done.push('service (désinstalleur du plugin)'); }
      }
      for (const f of launchAgents()) {
        await run('launchctl', ['bootout', `gui/${process.getuid()}`, f], { timeout: 30e3 });
        fs.rmSync(f, { force: true }); status.done.push(path.basename(f));
      }
      for (const t of await scheduledTasks()) { const r = await run('schtasks', ['/Delete', '/TN', t, '/F'], { timeout: 30e3 }); if (r.ok) status.done.push(`tâche ${t}`); }
      for (const f of systemdUnits()) {
        await run('systemctl', ['--user', 'disable', '--now', path.basename(f)], { timeout: 30e3 });
        fs.rmSync(f, { force: true }); status.done.push(path.basename(f));
      }
      // 2. plugin et marketplace
      for (const { key } of list) {
        const r = await claude(['plugin', 'uninstall', key]);
        status.done.push(r.ok ? `plugin ${key}` : `plugin ${key} : échec (${r.out.slice(-200)})`);
      }
      const markets = readJson(path.join(claudeDir(), 'plugins', 'known_marketplaces.json')) || {};
      for (const m of Object.keys(markets)) {
        const src = JSON.stringify(markets[m]?.source || {});
        if (m === 'alexgreensh-token-optimizer' || /alexgreensh\/token-optimizer/i.test(src)) { const r = await claude(['plugin', 'marketplace', 'remove', m]); if (r.ok) status.done.push(`marketplace ${m}`); }
      }
      // 3. données
      for (const d of dataDirs()) { try { fs.rmSync(d, { recursive: true, force: true }); status.done.push(d); } catch (e) { status.done.push(`${d} : ${e.message}`); } }
      if (status.done.length) console.log(`[token-optimizer] retiré : ${status.done.join(', ')}`);
    } catch (e) {
      status.error = e.message; console.error('[token-optimizer]', e.message);
    } finally { status.busy = false; status.at = Date.now(); }
    return status;
  }

  setTimeout(() => remove().catch(() => { }), Number(process.env.CSM_TOKENOPT_DELAY) || 8e3).unref?.();
  setInterval(() => remove().catch(() => { }), 6 * 3600e3).unref?.();
  ctx.route('POST', /^\/api\/token-optimizer\/remove$/, async ({ res }) => ctx.json(res, 200, await remove()));
};
module.exports.PLUGIN = PLUGIN;
