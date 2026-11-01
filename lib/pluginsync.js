'use strict';
// Plugins Claude Code partagés entre les machines synchronisées : chaque machine publie les plugins qu'elle a
// installés (depuis un marketplace GitHub) ; les autres les installent, pour que toutes aient les mêmes.
//
// - Une machine qui n'a pas un plugin ne le fait jamais retirer ailleurs : seule une vraie désinstallation, sur
//   une machine qui l'avait, est propagée — et toujours proposée, jamais appliquée seule.
// - Un plugin peut faire exécuter du code (hooks) : avec claudeSyncReview (par défaut), un plugin reçu attend
//   une validation dans Réglages › Synchronisation ; sinon il s'installe seul.
// - Marketplaces locaux (dossier sur une machine) : jamais partagés (chemin propre à la machine).
// - Machine sans code de synchro : rien n'est partagé, chacune garde ses plugins.
const fs = require('fs');
const os = require('os');
const path = require('path');

const PREFIX = 'csmplug-';
// jamais « . », « .. » ni « -… » (option de claude plugin) en premier caractère
const NAME = /^\w[\w.-]{0,63}$/;
const REPO = /^\w[\w.-]{0,99}\/\w[\w.-]{0,99}$/;

function claudeDir() { return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
// absent = vide ({}) ; présent mais illisible (en cours d'écriture par Claude Code, abîmé) = null
const readState = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch (e) { return e.code === 'ENOENT' ? {} : null; } };
const uidOf = (plugin, market) => (PREFIX + `${plugin}--${market}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')).slice(0, 64);

// Plugins installés ici, partageables : { uid → { plugin, marketplace, repo, enabled } } ; null si la liste
// n'a pas pu être lue (rien n'est alors publié ni retiré : une liste illisible n'est pas une liste vide)
function localPlugins() {
  const dir = path.join(claudeDir(), 'plugins');
  const inst = readState(path.join(dir, 'installed_plugins.json'));
  const markets = readState(path.join(dir, 'known_marketplaces.json'));
  const conf = readState(path.join(claudeDir(), 'settings.json'));
  if (!inst || !markets || !conf) return null;
  const enabled = conf.enabledPlugins || {};
  const out = new Map();
  for (const key of Object.keys(inst.plugins || inst)) {
    if (key === 'version') continue;
    const [plugin, market] = key.split('@');
    const src = markets[market]?.source;
    if (!NAME.test(plugin || '') || !NAME.test(market || '') || src?.source !== 'github' || !REPO.test(src.repo || '')) continue;
    out.set(uidOf(plugin, market), { plugin, marketplace: market, repo: src.repo, enabled: enabled[key] !== false });
  }
  return out;
}

function clean(d) {
  if (!d || !NAME.test(d.plugin || '') || !NAME.test(d.marketplace || '') || !REPO.test(d.repo || '')) return null;
  return { plugin: d.plugin, marketplace: d.marketplace, repo: d.repo, enabled: d.enabled !== false };
}

module.exports = function ({ ctx, settings, getState, saveState, broadcastStatus }) {
  const st = () => { const s = getState(); return s.plugins || (s.plugins = { mine: {}, pending: {} }); };
  const on = () => settings().syncPlugins !== false;
  const review = () => settings().claudeSyncReview !== false;

  // claude plugin … (même environnement que les sessions, sans l'identité d'une session parente)
  function run(args) {
    return new Promise(res => {
      const env = { ...process.env };
      for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|ELECTRON_RUN_AS_NODE$)/.test(k)) delete env[k];
      const file = ctx.CLAUDE, win = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
      const pre = (process.env.CSM_CLAUDE_ARGS || '').match(/"[^"]*"|\S+/g)?.map(x => x.replace(/^"|"$/g, '')) || [];
      require('child_process').execFile(win ? 'cmd.exe' : file, win ? ['/d', '/s', '/c', file, ...pre, ...args] : [...pre, ...args],
        { env, timeout: 300e3, windowsHide: true }, (err, out, errOut) => res({ ok: !err, out: (String(out || '') + String(errOut || '')).trim().slice(-400) }));
    });
  }
  async function install(d) {
    const markets = readJson(path.join(claudeDir(), 'plugins', 'known_marketplaces.json')) || {};
    if (!markets[d.marketplace]) {
      const r = await run(['plugin', 'marketplace', 'add', d.repo]);
      if (!r.ok) throw new Error(`marketplace ${d.repo} : ${r.out || 'échec'}`);
    }
    const r = await run(['plugin', 'install', `${d.plugin}@${d.marketplace}`]);
    if (!r.ok) throw new Error(`${d.plugin} : ${r.out || 'échec de l’installation'}`);
  }
  async function uninstall(d) {
    const r = await run(['plugin', 'uninstall', `${d.plugin}@${d.marketplace}`]);
    if (!r.ok) throw new Error(`${d.plugin} : ${r.out || 'échec de la désinstallation'}`);
  }

  // ---------------------------------------------------------------- publication (lib/sync.js localDocs)
  // keep : uids à ne jamais effacer (plugins reçus, installés ou pas ici)
  function docs(keep) {
    const out = new Map();
    if (!on()) return out;
    const S = st(), local = localPlugins();
    // liste illisible ce tour-ci : rien publié, rien retiré (tous gardés)
    if (!local) { for (const uid of Object.keys(getState().known || {})) if (uid.startsWith(PREFIX)) keep.add(uid); return out; }
    // publiés par cette machine et absents maintenant : désinstallés ici → effacement propagé (proposé ailleurs) ;
    // beaucoup d'un coup (dossier vidé, réinstallation de Claude Code) : rien n'est propagé, signalé dans Réglages
    let removed = new Set(Object.keys(S.mine).filter(u => !local.has(u)));
    const massive = removed.size > Math.max(5, Object.keys(S.mine).length * 0.2);
    S.warning = massive ? removed.size : 0;
    if (massive) { for (const u of removed) keep.add(u); removed = new Set(); }
    for (const u of removed) delete S.mine[u];
    for (const [uid, d] of local) { out.set(uid, d); S.mine[uid] = true; }
    // reçus mais absents d'ici (non installés, ou refusés) : jamais effacés par cette machine
    for (const uid of Object.keys(getState().known || {})) if (uid.startsWith(PREFIX) && !local.has(uid) && !removed.has(uid)) keep.add(uid);
    return out;
  }

  // ---------------------------------------------------------------- réception (lib/sync.js applyDoc)
  async function receive(uid, d, from) {
    if (!on()) return;
    const S = st(), read = localPlugins();
    // liste d'ici illisible : jamais de désinstallation à l'aveugle ; un plugin reçu est traité comme absent d'ici
    if (!read && !d) return;
    const local = read || new Map();
    if (d) {
      const p = clean(d); if (!p) return;
      if (local.has(uid)) { delete S.pending[uid]; return; }
      if (review()) { S.pending[uid] = { ...p, action: 'install', from: String(from || '').slice(0, 80), at: Date.now() }; saveState(); broadcastStatus(); return; }
      try { await install(p); delete S.pending[uid]; S.mine[uid] = true; }
      catch (e) { S.pending[uid] = { ...p, action: 'install', from: String(from || '').slice(0, 80), at: Date.now(), error: e.message }; }
      saveState(); broadcastStatus();
    } else if (local.has(uid)) {
      // désinstallé sur une autre machine : désinstallé ici aussi, ou proposé si la validation est demandée
      const p = { ...local.get(uid), action: 'uninstall', from: String(from || '').slice(0, 80), at: Date.now() };
      if (!review()) { try { await uninstall(p); delete S.pending[uid]; delete S.mine[uid]; } catch (e) { S.pending[uid] = { ...p, error: e.message }; } }
      else S.pending[uid] = p;
      saveState(); broadcastStatus();
    } else { delete S.pending[uid]; saveState(); }
  }

  // ---------------------------------------------------------------- décisions (Réglages › Synchronisation)
  async function decide(uid, apply) {
    const S = st(), p = S.pending[uid];
    if (!p) return { error: 'rien en attente' };
    if (!apply) { delete S.pending[uid]; saveState(); broadcastStatus(); return { ok: true }; }
    try {
      if (p.action === 'uninstall') { await uninstall(p); delete S.mine[uid]; }
      else { await install(p); S.mine[uid] = true; }
      delete S.pending[uid];
      saveState(); broadcastStatus();
      return { ok: true };
    } catch (e) { p.error = e.message; saveState(); broadcastStatus(); return { error: e.message }; }
  }

  const view = () => ({
    enabled: on(), review: review(),
    warning: st().warning || 0, // plugins disparus d'un coup ici : désinstallation pas propagée
    local: [...(localPlugins() || new Map()).values()].map(p => ({ plugin: p.plugin, marketplace: p.marketplace, repo: p.repo })),
    pending: Object.entries(st().pending).map(([uid, p]) => ({ uid, ...p })),
  });
  return { PREFIX, docs, receive, decide, view, isPlugin: uid => uid.startsWith(PREFIX) };
};
module.exports.localPlugins = localPlugins;
module.exports.clean = clean;
module.exports.uidOf = uidOf;
module.exports.PREFIX = PREFIX;
