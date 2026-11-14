'use strict';
// token-optimizer (alexgreensh/token-optimizer) à la place de RTK, sur demande (réglage tokenOptimizerAuto,
// coupé par défaut) : le plugin Claude Code est installé s'il manque, et RTK est retiré s'il est présent.
//
// RTK retiré = son hook (« rtk hook … ») enlevé de ~/.claude/settings.json, la ligne @RTK.md enlevée de
// ~/.claude/CLAUDE.md, RTK.md et le programme rtk déplacés dans <données CSM>/backups/rtk-<date> (rien n'est
// effacé). Le programme n'est touché que s'il répond comme RTK (commande « gain ») : jamais un autre « rtk ».
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PLUGIN = 'token-optimizer', MARKET = 'alexgreensh-token-optimizer', REPO = 'alexgreensh/token-optimizer';
const RTK_HOOK = /^\s*"?[^"\s]*?\brtk(\.exe)?"?\s+hook\b/i;

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function installed() {
  const inst = readJson(path.join(claudeDir(), 'plugins', 'installed_plugins.json'));
  return Object.keys(inst?.plugins || {}).some(k => k.startsWith(PLUGIN + '@'));
}

// déplace un fichier (autre disque : copie puis suppression)
function moveTo(file, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(file));
  try { fs.renameSync(file, dest); } catch { fs.copyFileSync(file, dest); fs.rmSync(file, { force: true }); }
  return dest;
}

// Hooks RTK retirés de settings.json ; renvoie true si le fichier a changé. Fichier illisible : laissé tel quel.
function cleanSettings(backup) {
  const f = path.join(claudeDir(), 'settings.json');
  const cur = readJson(f);
  if (!cur || typeof cur.hooks !== 'object' || !cur.hooks) return false;
  let changed = false;
  for (const [ev, groups] of Object.entries(cur.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) { kept.push(g); continue; }
      const hooks = g.hooks.filter(h => !(h && typeof h.command === 'string' && RTK_HOOK.test(h.command)));
      if (hooks.length !== g.hooks.length) changed = true;
      if (hooks.length) kept.push({ ...g, hooks });
    }
    if (kept.length) cur.hooks[ev] = kept; else delete cur.hooks[ev];
  }
  if (!changed) return false;
  if (!Object.keys(cur.hooks).length) delete cur.hooks;
  fs.mkdirSync(backup, { recursive: true });
  fs.copyFileSync(f, path.join(backup, 'settings.json'));
  fs.writeFileSync(f, JSON.stringify(cur, null, 2) + '\n');
  return true;
}

// Ligne @RTK.md retirée de CLAUDE.md, RTK.md mis de côté
function cleanClaudeMd(backup) {
  const done = [];
  const md = path.join(claudeDir(), 'CLAUDE.md');
  try {
    const t = fs.readFileSync(md, 'utf8');
    const next = t.split(/\r?\n/).filter(l => !/^\s*@RTK\.md\s*$/i.test(l)).join(t.includes('\r\n') ? '\r\n' : '\n').replace(/^(\r?\n)+/, '');
    if (next !== t) { fs.mkdirSync(backup, { recursive: true }); fs.copyFileSync(md, path.join(backup, 'CLAUDE.md')); fs.writeFileSync(md, next); done.push('CLAUDE.md'); }
  } catch { }
  const rtkMd = path.join(claudeDir(), 'RTK.md');
  if (fs.existsSync(rtkMd)) { moveTo(rtkMd, backup); done.push('RTK.md'); }
  return done;
}

const run = (file, args, opts = {}) => new Promise(res => execFile(file, args, { timeout: 30e3, windowsHide: true, encoding: 'utf8', ...opts },
  (err, out, errOut) => res({ ok: !err, out: (String(out || '') + String(errOut || '')).trim() })));

// RTK (Rust Token Killer) et pas un homonyme : son aide liste la commande « gain »
async function isRtk(bin) { const r = await run(bin, ['--help']); return /\bgain\b/.test(r.out); }

// Programme rtk retiré : Homebrew (brew uninstall) ou déplacé hors de ~/.local/bin, ~/.cargo/bin
async function removeBinary(backup) {
  const done = [];
  const exe = process.platform === 'win32' ? 'rtk.exe' : 'rtk';
  const home = os.homedir();
  for (const f of [path.join(home, '.local', 'bin', exe), path.join(home, '.cargo', 'bin', exe)]) {
    if (fs.existsSync(f) && await isRtk(f)) { moveTo(f, backup); done.push(f); }
  }
  if (process.platform !== 'win32') {
    for (const f of ['/opt/homebrew/bin/rtk', '/usr/local/bin/rtk']) {
      let real = ''; try { real = fs.realpathSync(f); } catch { continue; }
      if (!/\/Cellar\/rtk\//.test(real) || !await isRtk(f)) continue;
      const brew = path.join(path.dirname(f), 'brew');
      const r = await run(brew, ['uninstall', 'rtk'], { timeout: 120e3 });
      if (r.ok) done.push('brew uninstall rtk'); else done.push(`brew uninstall rtk : échec (${r.out.slice(-200)})`);
    }
  }
  return done;
}

module.exports = function (ctx) {
  const settings = () => ctx.getSettings?.() || {};
  const status = { at: 0, running: false, plugin: null, rtk: [], error: '' };

  // claude plugin … (même environnement que les sessions, sans l'identité d'une session parente)
  function claude(args) {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|ELECTRON_RUN_AS_NODE$)/.test(k)) delete env[k];
    const file = ctx.CLAUDE, win = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
    const pre = (process.env.CSM_CLAUDE_ARGS || '').match(/"[^"]*"|\S+/g)?.map(x => x.replace(/^"|"$/g, '')) || [];
    return run(win ? 'cmd.exe' : file, win ? ['/d', '/s', '/c', file, ...pre, ...args] : [...pre, ...args], { env, timeout: 300e3 });
  }

  async function apply() {
    if (status.running || settings().tokenOptimizerAuto !== true) return status;
    status.running = true; status.error = ''; status.rtk = [];
    try {
      if (installed()) status.plugin = 'déjà installé';
      else {
        const markets = readJson(path.join(claudeDir(), 'plugins', 'known_marketplaces.json')) || {};
        if (!markets[MARKET]) { const r = await claude(['plugin', 'marketplace', 'add', REPO]); if (!r.ok) throw new Error(`marketplace ${REPO} : ${r.out.slice(-300) || 'échec'}`); }
        const r = await claude(['plugin', 'install', `${PLUGIN}@${MARKET}`]);
        if (!r.ok) throw new Error(`${PLUGIN} : ${r.out.slice(-300) || 'échec de l’installation'}`);
        status.plugin = 'installé';
      }
      const backup = path.join(ctx.DATA, 'backups', 'rtk-' + stamp());
      if (cleanSettings(backup)) status.rtk.push('hook settings.json');
      status.rtk.push(...cleanClaudeMd(backup), ...await removeBinary(backup));
      if (status.rtk.length) { status.backup = backup; console.log(`[token-optimizer] RTK retiré : ${status.rtk.join(', ')} (sauvegarde : ${backup})`); }
      if (status.plugin === 'installé') console.log('[token-optimizer] plugin installé');
    } catch (e) {
      status.error = e.message; console.error('[token-optimizer]', e.message);
    } finally { status.running = false; status.at = Date.now(); }
    return status;
  }

  ctx.tokenOptimizerChanged = () => { apply().catch(() => { }); };
  // au démarrage (après la relance des sessions), puis toutes les 6 h
  setTimeout(() => apply().catch(() => { }), Number(process.env.CSM_TOKENOPT_DELAY) || 20e3).unref?.();
  setInterval(() => apply().catch(() => { }), 6 * 3600e3).unref?.();

  ctx.route('GET', /^\/api\/token-optimizer$/, async ({ res }) => ctx.json(res, 200, { ...status, installed: installed() }));
  ctx.route('POST', /^\/api\/token-optimizer$/, async ({ res }) => ctx.json(res, 200, { ...await apply(), installed: installed() }));
};
module.exports.cleanSettings = cleanSettings;
module.exports.cleanClaudeMd = cleanClaudeMd;
module.exports.RTK_HOOK = RTK_HOOK;
