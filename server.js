'use strict';
require('./lib/tz').alignTimezone(); // avant tout usage de Date : suivre le fuseau du système
// Claude Sessions Manager — serveur local : héberge N sessions Claude Code (PTY) et les expose à une UI web.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { beforeLastCompaction } = require('./lib/history-render');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const { ROOT, PORT, IS_WIN, IS_MAC, DATA, LEGACY_DATA, which, resolveClaude, stablePath, addBinDirToPath } = require('./lib/config');

const HOST = '127.0.0.1';
const VERSION = require('./package.json').version;
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
// Fichiers déposés / images collées : le navigateur ne donne pas le chemin d'origine, on enregistre une copie
// et on colle son chemin dans Claude (qui l'attache comme dans un vrai terminal). Dossier temporaire sans espace
// (le dossier de données macOS « Application Support » en contient un, ce qui casse la détection du chemin).
const UPLOADS = path.join(os.tmpdir(), 'csm-uploads');
const UPLOAD_MAX = 30 * 1024 * 1024;
const SCROLLBACK_MAX = 2 * 1024 * 1024;

fs.mkdirSync(DATA, { recursive: true });

// Migration v1 : les données vivaient dans <code>/data. On reprend jeton + sessions une seule fois.
if (!process.env.CSM_DATA && PORT === 7890 && !fs.existsSync(path.join(DATA, 'sessions.json'))) {
  for (const f of ['token', 'sessions.json']) {
    try { fs.copyFileSync(path.join(LEGACY_DATA, f), path.join(DATA, f), fs.constants.COPYFILE_EXCL); } catch { }
  }
}

// Journal fichier : le serveur tourne sans console (tâche planifiée / conhost --headless).
const LOG = path.join(DATA, 'server.log');
// au-delà de 5 Mo au démarrage : seul le dernier Mo est gardé (écriture synchrone conservée : les dernières
// lignes avant process.exit ne doivent pas se perdre)
try { if (fs.statSync(LOG).size > 5 * 1024 * 1024) fs.writeFileSync(LOG, fs.readFileSync(LOG).subarray(-1024 * 1024)); } catch { }
for (const k of ['log', 'error']) {
  const orig = console[k];
  console[k] = (...a) => {
    try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${a.map(x => x instanceof Error ? x.stack : String(x)).join(' ')}\n`); } catch { }
    orig.apply(console, a);
  };
}
process.on('uncaughtException', e => console.error('uncaught', e));
// Lenteurs : serveur figé plus d'1 s (terminaux et saisie en retard pendant ce temps) noté dans server.log, avec la
// mémoire du moment ; au plus une ligne par minute.
{
  let last = Date.now(), noted = 0;
  setInterval(() => {
    const now = Date.now(), lag = now - last - 500;
    last = now;
    if (lag > 1000 && now - noted > 60000) {
      noted = now;
      const m = process.memoryUsage();
      console.error(`lenteur serveur figé ${lag} ms (mémoire ${Math.round(m.rss / 1048576)} Mo, hors tas ${Math.round((m.external + m.arrayBuffers) / 1048576)} Mo)`);
    }
  }, 500).unref();
}
process.on('unhandledRejection', e => console.error('unhandled', e));

// Jeton anti-CSRF : un site tiers ne peut pas lire la page, donc ne peut pas connaître le jeton.
const TOKEN_FILE = path.join(DATA, 'token');
const TOKEN = fs.existsSync(TOKEN_FILE)
  ? fs.readFileSync(TOKEN_FILE, 'utf8').trim()
  : (() => { const t = crypto.randomBytes(24).toString('hex'); fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 }); return t; })();
try { fs.chmodSync(TOKEN_FILE, 0o600); } catch { }
// Jeton donné aux sessions (hooks) : n'ouvre que /api/hook. Tout ce que Claude exécute (Bash, MCP, scripts
// d'un dépôt cloné) en hérite ; le jeton complet de l'API ne doit pas en faire partie.
const HOOK_TOKEN = crypto.randomBytes(24).toString('hex');

// Claude Code installé après le démarrage du serveur (premier lancement sur une machine neuve) : cherché de
// nouveau tant qu'il est introuvable (le serveur survit à la fermeture de l'app, relancer l'app ne suffirait pas).
let CLAUDE = resolveClaude(), claudeAt = Date.now();
addBinDirToPath(CLAUDE);
const claudeFound = p => { try { return path.isAbsolute(p) && fs.statSync(p).isFile(); } catch { return false; } };
function claudeBin() {
  if (claudeFound(CLAUDE) || Date.now() - claudeAt < 3000) return CLAUDE;
  claudeAt = Date.now();
  const found = resolveClaude();
  if (found !== CLAUDE && claudeFound(found)) { CLAUDE = found; addBinDirToPath(found); console.log(`Claude Code trouvé : ${found}`); }
  return CLAUDE;
}
// commande d'installation officielle de Claude Code (affichée quand il est introuvable)
const CLAUDE_INSTALL = IS_WIN ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash';

// Hooks injectés via --settings : remontent l'état réel (travaille / attend / idle) et le session_id Claude.
// Chemin absolu de node : le PATH d'un service (launchd, tâche planifiée) ne le contient pas forcément.
// Barres obliques : valables pour le shell des hooks sous Windows (bash ou cmd) comme sous macOS.
const fwd = p => p.replace(/\\/g, '/');
// Dans l'application (Electron lancé en mode Node), l'exécutable n'est pas « node » : il faut
// ELECTRON_RUN_AS_NODE=1, qu'on ne laisse pas fuiter dans l'environnement de claude (il casserait les
// applications Electron lancées depuis une session, ex. `code`). Un petit lanceur le pose pour le script seul.
function nodeRunner(script) {
  const js = path.join(ROOT, script);
  if (!process.versions.electron) return `"${fwd(process.execPath)}" "${fwd(js)}"`;
  // Node du système s'il est installé : démarre bien plus vite qu'Electron (un hook par action de Claude).
  const sysNode = stablePath(which(IS_WIN ? 'node.exe' : 'node'));
  if (sysNode) return `"${fwd(sysNode)}" "${fwd(js)}"`;
  const file = path.join(DATA, path.basename(script, '.js') + (IS_WIN ? '.cmd' : '.sh'));
  const body = IS_WIN
    ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${js}" %*\r\n`
    : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${js}" "$@"\n`;
  fs.writeFileSync(file, body);
  if (!IS_WIN) fs.chmodSync(file, 0o755);
  return `"${fwd(file)}"`;
}
const HOOK_RUNNER = nodeRunner('hook.js');
const hookCmd = (ev) => [{ hooks: [{ type: 'command', command: `${HOOK_RUNNER} ${ev}`, timeout: 15 }] }];
const HOOKS = {
  SessionStart: hookCmd('start'),
  UserPromptSubmit: hookCmd('working'),
  PreToolUse: hookCmd('working'),
  Notification: hookCmd('attention'),
  Stop: hookCmd('idle'),
  SessionEnd: hookCmd('end'),
};
// Réglages passés à chaque session par --settings (prioritaires sur ceux de l'utilisateur, sans les modifier) :
// hooks, barre d'état de CSM (seulement si l'utilisateur n'a pas la sienne), claude-mem activé ou non selon
// le moteur de mémoire choisi, et fenêtre du compactage automatique.
const HOOK_SETTINGS = path.join(DATA, 'hooks-settings.json');
fs.writeFileSync(HOOK_SETTINGS, JSON.stringify({ hooks: HOOKS }, null, 2)); // version minimale (diagnostic, lib/tools.js)
const STATUS_LINE = { type: 'command', command: nodeRunner('statusline.js'), padding: 0 };
// l'utilisateur a sa barre d'état : la nôtre relève seulement les quotas (barre latérale, file d'attente) et
// affiche la sienne, inchangée (statusline.js --relay)
const STATUS_RELAY = { type: 'command', command: `${nodeRunner('statusline.js')} --relay`, padding: 0 };
// « model » : Claude Code borne la valeur à la fenêtre du modèle (min), donc 1M = fenêtre complète, et cette
// valeur prime sur un CLAUDE_CODE_AUTO_COMPACT_WINDOW trop bas dans ~/.claude/settings.json (compactage en boucle).
const COMPACT_WINDOW = { model: '1000000', '200000': '200000', '400000': '400000' };
const REPLY_LANGS = { fr: 'french', en: 'english', es: 'spanish', ar: 'arabic', de: 'german', it: 'italian', pt: 'portuguese' };
// Langue du système : celle transmise par l'app (Electron), sinon les langues préférées de macOS / Windows, sinon
// LANG. Pas Intl : Node lancé hors d'un terminal répond « en-US » quelle que soit la langue du système.
let SYS_LANG = null;
function systemLanguage() {
  if (SYS_LANG !== null) return SYS_LANG;
  let l = process.env.CSM_SYS_LANG || '';
  try {
    if (!l && IS_MAC) l = (require('child_process').execFileSync('defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 3000 }).match(/[a-z]{2}/i) || [''])[0];
    if (!l && IS_WIN) l = require('child_process').execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Culture).TwoLetterISOLanguageName'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
  } catch { }
  if (!l) l = (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '').slice(0, 2);
  return (SYS_LANG = l.toLowerCase());
}
function replyLanguage(st) {
  const v = st.replyLanguage || 'app';
  if (v === 'claude') return ''; // laisser le réglage de Claude Code
  if (v !== 'app') return REPLY_LANGS[v] || '';
  // « Celle de l'interface » : même règle que l'interface (public/i18n.js : français si le système est en français,
  // anglais sinon) ; langue du système inconnue → rien imposé (réglage de Claude Code)
  const sys = systemLanguage();
  const ui = st.lang && st.lang !== 'auto' ? st.lang : sys ? (sys === 'fr' ? 'fr' : 'en') : '';
  return REPLY_LANGS[ui] || '';
}
function sessionSettings(withStatusLine) {
  const st = ctx.getSettings?.() || {};
  const engine = st.memoryEngine || 'native';
  const o = { hooks: HOOKS };
  if (withStatusLine) o.statusLine = withStatusLine === 'relay' ? STATUS_RELAY : STATUS_LINE;
  o.enabledPlugins = { 'claude-mem@thedotmack': engine === 'claude-mem' };
  // Langue des réponses de Claude (réglage « language » de Claude Code) : par défaut celle de l'app
  const lang = replyLanguage(st);
  if (lang) o.language = lang;
  // signature de Claude dans les commits et les PR (Co-Authored-By, « Generated with Claude Code », lien de
  // session) : retirée sauf si l'utilisateur la veut (Réglages › Général) ; includeCoAuthoredBy pour les anciennes versions
  if (st.commitSignature !== true) { o.attribution = { commit: '', pr: '' }; o.includeCoAuthoredBy = false; }
  const w = COMPACT_WINDOW[st.autoCompactWindow || 'model'];
  if (w) o.env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: w };
  const txt = JSON.stringify(o, null, 2);
  const file = path.join(DATA, `session-settings-${crypto.createHash('sha1').update(txt).digest('hex').slice(0, 10)}.json`);
  try { if (fs.readFileSync(file, 'utf8') === txt) return file; } catch { }
  fs.writeFileSync(file, txt);
  return file;
}
function userHasStatusLine(cwd) {
  const files = [path.join(os.homedir(), '.claude', 'settings.json'), path.join(os.homedir(), '.claude', 'settings.local.json')];
  if (cwd) files.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
  return files.some(f => { try { return !!JSON.parse(fs.readFileSync(f, 'utf8')).statusLine; } catch { return false; } });
}
const settingsFor = s => sessionSettings(userHasStatusLine(s.cwd) ? 'relay' : ctx.getSettings?.().statusLine !== false);

// ---------------------------------------------------------------- sessions gérées
const STORE = path.join(DATA, 'sessions.json');
/** @type {Map<string, any>} */
const sessions = new Map();

// Champs ajoutés par les modules (lib/*) : mémorisés et envoyés à l'interface tels quels.
const EXTRA_FIELDS = ['group', 'pinned', 'color', 'worktree', 'queue', 'quotaWait', 'alerts', 'remote', 'syncId', 'origin', 'syncCwd', 'type', 'paused', 'quotaStop'];
const extra = s => Object.fromEntries(EXTRA_FIELDS.filter(k => s[k] !== undefined).map(k => [k, s[k]]));

// Appelés après chaque écriture de sessions.json (lib/sync : repère les changements à envoyer).
const persistHooks = [];
function persist() {
  const list = [...sessions.values()].map(s => ({
    id: s.id, name: s.name, cwd: s.cwd, args: s.args, claudeSessionId: s.claudeSessionId,
    createdAt: s.createdAt, order: s.order, wantRun: s.wantRun !== false, named: !!s.named, titleFor: s.titleFor || null,
    ...extra(s), ...(s.lock ? { lock: s.lock } : {}),
  }));
  // fichier temporaire puis renommage : une extinction pendant l'écriture ne laisse pas un sessions.json tronqué
  // (renommage refusé, ex. antivirus sous Windows : écriture directe)
  const body = JSON.stringify(list, null, 2), tmp = STORE + '.tmp';
  try { fs.writeFileSync(tmp, body, { mode: 0o600 }); fs.renameSync(tmp, STORE); }
  catch { fs.writeFileSync(STORE, body, { mode: 0o600 }); try { fs.rmSync(tmp, { force: true }); } catch { } }
  for (const fn of persistHooks) { try { fn(); } catch (e) { console.error('persist hook', e); } }
}

// Conversation d'une session verrouillée visée par une création : « resume », ou --resume / -r / --continue / -c
// glissés dans les arguments (--continue reprend la dernière conversation du dossier).
function lockedResume(b) {
  const ids = b.resume ? [String(b.resume)] : [];
  const a = splitArgs(String(b.args || ''));
  let cont = false;
  a.forEach((x, i) => {
    const m = x.match(/^--resume=(.+)$/);
    if (m) ids.push(m[1]);
    else if ((x === '--resume' || x === '-r') && a[i + 1]) ids.push(a[i + 1]);
    else if (x === '--continue' || x === '-c') cont = true;
  });
  for (const id of ids) { const lk = ctx.lockedByConversation?.(id); if (lk) return lk; }
  if (cont || ids.length) {
    const cwd = b.cwd ? path.resolve(String(b.cwd).replace(/^~(?=$|[\\/])/, os.homedir())) : os.homedir();
    const norm = p => (IS_WIN ? p.toLowerCase() : p);
    return [...sessions.values()].find(s => s.lock && norm(path.resolve(s.cwd)) === norm(cwd) && (cont || ids.includes(s.claudeSessionId)));
  }
  return null;
}

function publicView(s) {
  return {
    id: s.id, name: s.name, cwd: s.cwd, args: s.args, status: s.status, message: s.message,
    claudeSessionId: s.lock ? null : s.claudeSessionId, createdAt: s.createdAt, lastActivity: s.lastActivity,
    statusSince: s.statusSince, alive: !!s.pty, order: s.order, ...extra(s),
    typeInfo: s.type ? ctx.typeInfo?.(s) || null : undefined, // type de session d'une extension (lib/extensions.js)
    // verrouillée : ni message (peut citer une commande), ni texte des prompts en attente
    ...(s.lock ? { locked: true, lockHint: s.lock.hint || '', message: '', queue: s.queue ? s.queue.map(q => ({ id: q.id, text: '' })) : undefined } : {}),
  };
}

function setStatus(s, status, message) {
  if (s.status === status && s.message === message) return;
  s.status = status;
  s.message = message || '';
  s.statusSince = Date.now();
  broadcast({ t: 'session', s: publicView(s) });
}

function splitArgs(str) {
  const out = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(str || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Claude n'écrit le transcript qu'au premier message : une session jamais utilisée n'est pas reprenable.
// Chemin retenu par conversation (un transcript ne change pas de dossier) : évite de parcourir tous les
// dossiers de projets à chaque appel ; revérifié, et recherché de nouveau s'il a disparu.
const transcriptCache = new Map();
function transcriptPath(id) {
  if (!/^[\w-]+$/.test(id || '')) return null;
  const known = transcriptCache.get(id);
  if (known && fs.existsSync(known)) return known;
  transcriptCache.delete(id);
  try {
    for (const d of fs.readdirSync(PROJECTS)) { const f = path.join(PROJECTS, d, `${id}.jsonl`); if (fs.existsSync(f)) { transcriptCache.set(id, f); return f; } }
  } catch { }
  return null;
}
const transcriptExists = id => !!transcriptPath(id);

// Ctrl+C / Échap n'appellent aucun hook (pas de Stop) : Claude écrit seulement « [Request interrupted by user…] »
// dans le transcript. On le relit peu après la touche pour repasser la session à « prêt ».
function lastTurnInterrupted(id) {
  const f = transcriptPath(id);
  if (!f) return false;
  try {
    const size = fs.statSync(f).size, len = Math.min(size, 64 * 1024), buf = Buffer.alloc(len);
    const fd = fs.openSync(f, 'r'); fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const l of lines) {
      let o; try { o = JSON.parse(l); } catch { continue; }
      if (o.type !== 'user' && o.type !== 'assistant') continue;
      if (o.type === 'assistant') return false;
      const c = o.message && o.message.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x && x.text || '').join('') : '';
      return text.startsWith('[Request interrupted by user');
    }
  } catch { }
  return false;
}
function watchInterrupt(s) {
  for (const ms of [700, 2000, 4500]) setTimeout(() => { // 4,5 s : disque lent ou machine chargée
    if ((s.status === 'working' || s.status === 'attention') && lastTurnInterrupted(s.claudeSessionId)) setStatus(s, 'idle', 'interrompu');
  }, ms);
}

// Même enregistrement que /rename de Claude Code : le nom suit la conversation (historique, claude --resume) et
// sert de nom de session aux autres sessions (agent-name : ListAgents, messages entre sessions).
function writeCustomTitle(id, title) {
  const f = transcriptPath(id);
  if (!f || !title) return false;
  try {
    fs.appendFileSync(f, JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: id }) + '\n'
      + JSON.stringify({ type: 'agent-name', agentName: title, sessionId: id }) + '\n');
    return true;
  } catch { return false; }
}
// Dernier nom donné à la conversation (/rename dans Claude Code, ou par l'app) : fin du transcript
function conversationName(id) {
  const f = transcriptPath(id);
  if (!f) return null;
  try {
    const size = fs.statSync(f).size, len = Math.min(size, 256 * 1024), buf = Buffer.alloc(len);
    const fd = fs.openSync(f, 'r'); fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
    for (const l of buf.toString('utf8').split('\n').reverse()) {
      if (!l.includes('"agent-name"') && !l.includes('"custom-title"')) continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      const n = o.type === 'agent-name' ? o.agentName : o.type === 'custom-title' ? o.customTitle : null;
      if (typeof n === 'string' && n.trim()) return n.trim();
    }
  } catch { }
  return null;
}
const cleanName = n => String(n || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);

function renameSession(s, name) {
  s.name = cleanName(name) || s.name;
  s.named = true;
  s.titleFor = s.claudeSessionId && writeCustomTitle(s.claudeSessionId, s.name) ? s.claudeSessionId : null;
  persist();
  broadcast({ t: 'session', s: publicView(s) });
  liveRename(s);
}
// Session ouverte : /rename la renomme aussitôt pour Claude Code (nom vu par les autres sessions), sans relance.
// Pas pendant une demande d'autorisation (le texte y répondrait) : dès qu'elle est réglée.
function liveRename(s) {
  delete s.renameOnIdle;
  const n = cleanName(s.name);
  if (!s.pty || !n || s.lock) return;
  if (s.status === 'attention' || s.status === 'starting') { s.renameOnIdle = true; return; } // dès qu'elle est prête
  s.pty.write(`\x1b[200~/rename ${n}\x1b[201~`);
  setTimeout(() => { if (s.pty) s.pty.write('\r'); }, 150);
}
// /rename tapé dans la session : le nom de l'app suit (et part sur les autres machines avec la synchro).
// Un nom donné dans l'app pas encore écrit dans la conversation (session neuve, nom reçu par la synchro) l'emporte.
function followName(s) {
  if (s.renameOnIdle) return liveRename(s);
  if (!s.claudeSessionId || s.lock || (s.named && s.titleFor !== s.claudeSessionId)) return;
  const n = cleanName(conversationName(s.claudeSessionId));
  if (!n || n === s.name) return;
  s.name = n; s.named = true; s.titleFor = s.claudeSessionId;
  persist(); broadcast({ t: 'session', s: publicView(s) });
}
// --name (nom de la session dès le lancement) : seulement si cette version de Claude Code le connaît
let nameFlag = { bin: '', ok: null, ready: null };
function checkNameFlag() {
  const bin = claudeBin();
  if (nameFlag.bin === bin && nameFlag.ready) return nameFlag.ready;
  nameFlag = { bin, ok: null, ready: null };
  const cur = nameFlag;
  cur.ready = new Promise(resolve => execFile(bin, [...splitArgs(process.env.CSM_CLAUDE_ARGS || ''), '--help'], { timeout: 8000, windowsHide: true, encoding: 'utf8' },
    (err, out) => { cur.ok = !err && /(^|\s)--name\b/.test(out || ''); resolve(cur.ok); }));
  return cur.ready;
}

function spawnSession(s, { resume, fork } = {}) {
  if (resume && !transcriptExists(resume)) resume = undefined;
  // CSM_CLAUDE_ARGS : arguments placés avant ceux de claude (tests : CSM_CLAUDE=node, CSM_CLAUDE_ARGS=faux-claude.js)
  s.settingsFile = settingsFor(s); // réglages de lancement (langue, mémoire, compactage…) : comparés après un changement
  const args = [...splitArgs(process.env.CSM_CLAUDE_ARGS || ''), '--settings', s.settingsFile, ...splitArgs(s.args)];
  if (resume) args.push('--resume', resume);
  if (resume && fork) args.push('--fork-session'); // ponctuel : jamais mémorisé dans s.args
  // nom de la session pour Claude Code (= nom dans l'app, /rename) : --name, sinon la conversation le porte
  const nm = cleanName(s.name);
  if (nm && !/(^|\s)(-n|--name)(\s|=|$)/.test(s.args || '')) {
    if (nameFlag.bin !== claudeBin()) checkNameFlag();
    if (nameFlag.ok) args.push('--name', nm);
    else if (resume && !fork && s.named && conversationName(resume) !== nm) writeCustomTitle(resume, nm);
  }
  args.push(...(ctx.remoteArgs?.(s) || [])); // accès depuis l'app Claude (lib/remote.js)
  args.push(...(ctx.typeArgs?.(s) || [])); // type de session d'une extension : consignes (lib/extensions.js)
  const env = { ...process.env, CSM_ID: s.id, CSM_PORT: String(PORT), CSM_TOKEN: HOOK_TOKEN, COLORTERM: 'truecolor' };
  // Si le serveur a été lancé depuis une session Claude, ne pas propager son identité (sinon session "enfant" non persistée).
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|AI_AGENT$|ELECTRON_RUN_AS_NODE$)/i.test(k)) delete env[k];
  Object.assign(env, ctx.memEnv?.() || {}); // mémoire claude-mem synchronisée, séparée de celle du terminal
  Object.assign(env, ctx.typeEnv?.(s) || {}); // type de session : fichier de la vue (CSM_VIEW_FILE)
  let p;
  try {
    p = pty.spawn(claudeBin(), args, {
      name: 'xterm-256color', cols: s.cols || 120, rows: s.rows || 32,
      cwd: fs.existsSync(s.cwd) ? s.cwd : os.homedir(), env,
    });
  } catch (e) {
    s.pty = null;
    appendOut(s, claudeFound(claudeBin())
      ? `\r\n\x1b[31m[csm] Échec du lancement : ${e.message}\x1b[0m\r\n`
      : `\r\n\x1b[31m[csm] Claude Code est introuvable sur cette machine.\x1b[0m\r\n[csm] Installe-le (${IS_WIN ? 'PowerShell' : 'Terminal'}) :  ${CLAUDE_INSTALL}\r\n[csm] puis clique « Relancer » : inutile de redémarrer l'app.\r\n`);
    setStatus(s, 'exited', 'échec du lancement');
    return;
  }
  if (s.paused) { delete s.paused; persist(); } // reprise : plus en pause
  s.pty = p;
  if (s.wantRun !== true) { s.wantRun = true; persist(); }
  setStatus(s, 'starting');
  p.onData(d => { s.lastActivity = Date.now(); appendOut(s, d); emit('data', s, d); });
  p.onExit(({ exitCode }) => {
    if (s.pty !== p || !sessions.has(s.id)) return; // relancée entre-temps, ou fermée
    s.pty = null;
    // Sortie volontaire (/exit) => ne pas la relancer au prochain démarrage. Le délai évite de marquer
    // "arrêtées" les sessions tuées par l'extinction de Windows (le serveur meurt avant l'échéance).
    setTimeout(() => {
      if (!shuttingDown && !s.pty && sessions.has(s.id)) { s.wantRun = false; persist(); }
    }, 8000);
    appendOut(s, `\r\n\x1b[90m[csm] session terminée (code ${exitCode})\x1b[0m\r\n`);
    setStatus(s, 'exited', s.paused ? 'en pause' : `code ${exitCode}`);
    emit('exit', s);
  });
}

function appendOut(s, d) {
  s.buf += d; s.bufDirty = true;
  if (s.buf.length > SCROLLBACK_MAX) {
    // coupe au prochain saut de ligne pour limiter les séquences d'échappement tronquées
    let cut = s.buf.length - SCROLLBACK_MAX;
    const nl = s.buf.indexOf('\n', cut);
    s.buf = s.buf.slice(nl > 0 ? nl + 1 : cut);
  }
  const data = JSON.stringify({ t: 'out', id: s.id, d });
  for (const c of clients) if (c.readyState === 1 && (!s.lock || ctx.wsCan?.(s, c))) c.send(data);
}

function createSession({ name, cwd, args, resume, fork, ...more }) {
  cwd = cwd ? path.resolve(cwd.replace(/^~(?=$|[\\/])/, os.homedir())) : os.homedir();
  const id = crypto.randomBytes(6).toString('hex');
  const order = Math.max(0, ...[...sessions.values()].map(x => x.order || 0)) + 1;
  const s = {
    id, name: name || path.basename(cwd || '') || 'session', cwd: cwd || os.homedir(), args: args || '',
    claudeSessionId: resume || null, createdAt: Date.now(), lastActivity: Date.now(),
    status: 'starting', message: '', statusSince: Date.now(), buf: '', pty: null, order,
    ...Object.fromEntries(EXTRA_FIELDS.filter(k => more[k] !== undefined).map(k => [k, more[k]])),
  };
  if (more.initialPrompt) s.initialPrompt = String(more.initialPrompt).slice(0, 20000); // envoyé au premier SessionStart (lib/queue)
  sessions.set(id, s);
  spawnSession(s, { resume, fork });
  persist();
  broadcast({ t: 'session', s: publicView(s) });
  return s;
}

function killSession(s) {
  if (s.pty) { try { s.pty.kill(); } catch { } }
}

// Sessions de la dernière exécution du serveur (reboot, crash, csm restart) : celles qui tournaient sont
// relancées automatiquement avec --resume ; celles arrêtées volontairement restent reprenables d'un clic.
let shuttingDown = false;
const toRestore = [];
// Contenu du terminal de chaque session, gardé sur disque (DATA/scrollback) : après un redémarrage de l'app (mise
// à jour, reboot), la discussion passée reste visible au-dessus de la conversation reprise. Sans lui, une
// conversation compactée ne montrait plus que « Conversation compacted ». Session verrouillée : rien d'écrit.
const SCROLL_DIR = path.join(DATA, 'scrollback'), SCROLL_KEEP = 1024 * 1024;
const scrollFile = id => path.join(SCROLL_DIR, `${id}.log`);
function saveScrollback(s, sync) {
  if (!s.bufDirty) return;
  s.bufDirty = false;
  const f = scrollFile(s.id);
  if (s.lock || !s.buf) { fs.rm(f, { force: true }, () => { }); return; }
  let b = s.buf;
  if (b.length > SCROLL_KEEP) { const nl = b.indexOf('\n', b.length - SCROLL_KEEP); b = b.slice(nl > 0 ? nl + 1 : b.length - SCROLL_KEEP); }
  try { fs.mkdirSync(SCROLL_DIR, { recursive: true, mode: 0o700 }); } catch { }
  if (sync) { try { fs.writeFileSync(f, b, { mode: 0o600 }); } catch { } }
  else fs.writeFile(f, b, { mode: 0o600 }, () => { });
}
function saveAllScrollback(sync) {
  for (const s of sessions.values()) saveScrollback(s, sync);
  // sessions supprimées : leur contenu ne reste pas sur le disque
  try { for (const f of fs.readdirSync(SCROLL_DIR)) if (!sessions.has(f.replace(/\.log$/, ''))) fs.rm(path.join(SCROLL_DIR, f), { force: true }, () => { }); } catch { }
}
setInterval(() => { if (!shuttingDown) saveAllScrollback(false); }, Number(process.env.CSM_SCROLL_SAVE_MS) || 60e3).unref?.();
const savedScrollback = id => { try { return fs.readFileSync(scrollFile(id), 'utf8'); } catch { return ''; } };
const restoredMark = what => `\r\n\x1b[90m[csm] ── ${what} ──\x1b[0m\r\n`;
try {
  for (const x of JSON.parse(fs.readFileSync(STORE, 'utf8'))) {
    const s = { ...x, status: 'exited', message: x.paused ? 'en pause' : 'arrêtée', statusSince: Date.now(), lastActivity: x.createdAt, buf: '', pty: null };
    sessions.set(x.id, s);
    const before = x.lock ? '' : savedScrollback(x.id);
    s.buf = before + (before ? restoredMark('avant le redémarrage de l\'app') : ''); // affiché dès l'ouverture de la fenêtre
    s.hasHistory = !!before;
    if (x.wantRun !== false) toRestore.push(s);
    else s.buf += `\x1b[90m[csm] Session arrêtée. Cliquer « Reprendre » pour la relancer.\x1b[0m\r\n`;
  }
} catch { }

function restoreSessions() {
  // --name vérifié d'abord (au plus 9 s) : les sessions restaurées gardent leur nom pour les autres sessions
  Promise.race([checkNameFlag(), new Promise(r => setTimeout(r, 9000))]).finally(() => toRestore.forEach((s, i) => setTimeout(() => {
    if (!sessions.has(s.id) || s.pty) return;
    // rien d'enregistré (première fois, ou conversation venue d'une autre machine) : discussion d'avant la compaction
    showCompacted(s).finally(() => {
      if (!sessions.has(s.id) || s.pty) return;
      appendOut(s, `\x1b[90m[csm] Session restaurée.\x1b[0m\r\n`);
      spawnSession(s, { resume: s.claudeSessionId || undefined });
    });
  }, i * 1200))); // échelonné : évite de lancer N claude + hooks en même temps
}

// ---------------------------------------------------------------- historique (~/.claude/projects)
const histCache = new Map(); // file -> { mtime, entry }

function readSlice(fd, pos, len) {
  const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return b.slice(0, n).toString('utf8');
}

function parseTranscript(file, stat) {
  const fd = fs.openSync(file, 'r');
  try {
    const HEAD = 96 * 1024, TAIL = 96 * 1024;
    const head = readSlice(fd, 0, Math.min(HEAD, stat.size));
    const tail = stat.size > HEAD ? readSlice(fd, Math.max(0, stat.size - TAIL), Math.min(TAIL, stat.size)) : '';
    let cwd = null, title = null, customTitle = null, lastPrompt = null, firstPrompt = null, branch = null;
    for (const line of (head + '\n' + tail).split('\n')) {
      if (!line.startsWith('{')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (!cwd && o.cwd) cwd = o.cwd;
      if (!branch && o.gitBranch && o.gitBranch !== 'HEAD') branch = o.gitBranch;
      if (o.type === 'ai-title' && o.aiTitle) title = o.aiTitle;
      if (o.type === 'custom-title' && o.customTitle) customTitle = o.customTitle;
      if (o.type === 'summary' && o.summary && !title) title = o.summary;
      if (o.type === 'last-prompt' && o.lastPrompt) lastPrompt = o.lastPrompt;
      if (!firstPrompt && o.type === 'user' && o.message && !o.isMeta) {
        const c = o.message.content;
        const txt = typeof c === 'string' ? c : Array.isArray(c) ? (c.find(p => p.type === 'text') || {}).text : null;
        if (txt && !txt.startsWith('<') && !txt.startsWith('Caveat:')) firstPrompt = txt;
      }
    }
    if (!cwd && !firstPrompt && !title) return null;
    return {
      id: path.basename(file, '.jsonl'), cwd, branch,
      title: customTitle || title || (firstPrompt || lastPrompt || '').slice(0, 120) || '(sans titre)',
      lastPrompt: (lastPrompt || firstPrompt || '').slice(0, 200),
      mtime: stat.mtimeMs, size: stat.size,
    };
  } finally { fs.closeSync(fd); }
}

function history() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS); } catch { return out; }
  for (const d of dirs) {
    if (/observer-sessions/i.test(d)) continue; // sessions internes de claude-mem
    const dir = path.join(PROJECTS, d);
    let files; try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (st.size < 200) continue;
      const c = histCache.get(file);
      if (c && c.mtime === st.mtimeMs) { if (c.entry) out.push(c.entry); continue; }
      let entry = null; try { entry = parseTranscript(file, st); } catch { }
      histCache.set(file, { mtime: st.mtimeMs, entry });
      if (entry) out.push(entry);
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ---------------------------------------------------------------- sélecteur de dossier natif
let picking = null;
function pickFolder(initial) {
  if (picking) return picking; // un seul dialogue à la fois
  const env = { ...process.env, CSM_INITIAL: initial || '' };
  let cmd, args;
  if (IS_WIN) {
    // pwsh 7 = dialogue moderne ; Windows PowerShell 5.1 (toujours présent) en secours.
    cmd = process.env.CSM_PWSH || which('pwsh') || 'powershell.exe';
    args = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'pick-folder.ps1')];
  } else if (IS_MAC) {
    // Le dialogue est rattaché à l'application au premier plan (la fenêtre csm) pour ne pas s'ouvrir derrière.
    cmd = 'osascript';
    args = ['-e', 'set p to system attribute "CSM_INITIAL"',
      '-e', 'tell application (path to frontmost application as text)',
      '-e', 'if p is not "" then',
      '-e', 'set f to choose folder with prompt "Dossier de travail de la session Claude" default location (POSIX file p)',
      '-e', 'else',
      '-e', 'set f to choose folder with prompt "Dossier de travail de la session Claude"',
      '-e', 'end if',
      '-e', 'end tell',
      '-e', 'POSIX path of f'];
    if (initial && !fs.existsSync(initial)) env.CSM_INITIAL = '';
  } else {
    cmd = 'zenity'; args = ['--file-selection', '--directory', ...(initial ? ['--filename', initial + '/'] : [])];
  }
  picking = new Promise(resolve => {
    execFile(cmd, args, { env, windowsHide: true, timeout: 10 * 60 * 1000, encoding: 'utf8' },
      (err, stdout) => {
        let p = err ? null : (stdout || '').trim() || null;
        if (p && p.length > 1 && !IS_WIN) p = p.replace(/\/$/, '');
        resolve(p);
      });
  }).finally(() => { picking = null; });
  return picking;
}

// ---------------------------------------------------------------- sessions ouvertes dans un terminal
// Claude Code tient un registre des sessions interactives en cours : ~/.claude/sessions/<pid>.json.
const REGISTRY = path.join(os.homedir(), '.claude', 'sessions');

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

function externalSessions() {
  const managedIds = new Set([...sessions.values()].map(s => s.claudeSessionId).filter(Boolean));
  const managedPids = new Set([...sessions.values()].filter(s => s.pty).map(s => s.pty.pid));
  let files = []; try { files = fs.readdirSync(REGISTRY).filter(f => /^\d+\.json$/.test(f)); } catch { }
  let titles = null; // historique lu seulement s'il y a une session extérieure à nommer
  const out = [];
  for (const f of files) {
    let o; try { o = JSON.parse(fs.readFileSync(path.join(REGISTRY, f), 'utf8')); } catch { continue; }
    if (o.kind !== 'interactive' || o.entrypoint !== 'cli' || !o.sessionId) continue; // exclut SDK / observateurs
    if (managedIds.has(o.sessionId) || managedPids.has(o.pid) || !pidAlive(o.pid)) continue;
    out.push({
      pid: o.pid, sessionId: o.sessionId, cwd: o.cwd, status: o.status, startedAt: o.startedAt,
      title: (titles ||= new Map(history().map(h => [h.id, h.title]))).get(o.sessionId) || path.basename(o.cwd || '') || o.sessionId.slice(0, 8),
    });
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

// Modèle réellement utilisé par la conversation (dernier message de Claude dans le transcript),
// pour que « Déplacer » / « Copier » ne change pas de modèle ; sinon le modèle par défaut des réglages.
function conversationModelArgs(id) {
  const f = transcriptPath(id);
  if (f) {
    try {
      const size = fs.statSync(f).size, len = Math.min(size, 256 * 1024), buf = Buffer.alloc(len);
      const fd = fs.openSync(f, 'r'); fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
      for (const l of buf.toString('utf8').split('\n').reverse()) {
        let o; try { o = JSON.parse(l); } catch { continue; }
        const m = o.type === 'assistant' && o.message && o.message.model;
        if (m && /^[\w.-]+$/.test(m) && m !== '<synthetic>') return `--model ${m}`;
      }
    } catch { }
  }
  const def = ctx.getSettings?.().defaultModel;
  return def ? `--model ${def}` : '';
}

// Déplace une session de terminal dans csm : arrête le processus du terminal puis reprend la conversation ici.
// mode 'copy' : le terminal continue, csm reprend une copie de la conversation (--fork-session, nouvel id).
// Dossier où la conversation a lieu (champ cwd de ses derniers messages). Claude Code n'en indique parfois pas
// le même dans ~/.claude/sessions (session passée dans un worktree, dossier changé en cours de route) ; or
// --resume ne cherche la conversation que dans le dossier courant : la reprise échouait et la session s'arrêtait.
function conversationCwd(id) {
  const f = transcriptPath(id);
  if (!f) return null;
  try {
    const size = fs.statSync(f).size, len = Math.min(size, 256 * 1024), buf = Buffer.alloc(len);
    const fd = fs.openSync(f, 'r'); fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
    for (const l of buf.toString('utf8').split('\n').reverse()) {
      let o; try { o = JSON.parse(l); } catch { continue; }
      if (typeof o.cwd === 'string' && o.cwd && fs.existsSync(o.cwd)) return o.cwd;
    }
  } catch { }
  return null;
}
async function importExternal(pid, sessionId, mode) {
  const ext = externalSessions().find(x => x.pid === pid && x.sessionId === sessionId);
  if (!ext) throw new Error('session introuvable (déjà fermée ou déjà dans csm)');
  const cwd = conversationCwd(sessionId) || ext.cwd;
  if (mode === 'copy') {
    const has = !!transcriptPath(sessionId);
    return createSession({ cwd, name: `${ext.title.slice(0, 34)} (copie)`, resume: has ? sessionId : undefined, args: conversationModelArgs(sessionId), fork: has });
  }
  try { process.kill(pid); } catch { }
  for (let i = 0; i < 50 && pidAlive(pid); i++) await new Promise(r => setTimeout(r, 100));
  if (pidAlive(pid)) throw new Error(`le processus ${pid} ne s'arrête pas`);
  await new Promise(r => setTimeout(r, 300)); // laisse le transcript se fermer
  // aucun message échangé dans le terminal : pas de conversation à reprendre (--resume échouerait), une neuve
  const has = !!transcriptPath(sessionId);
  // elle travaillait : la tâche interrompue par l'arrêt du terminal repart d'elle-même (« continue » dès que prête)
  return createSession({ cwd, name: ext.title.slice(0, 40), resume: has ? sessionId : undefined, args: conversationModelArgs(sessionId),
    initialPrompt: has && ext.status === 'busy' ? 'continue' : undefined });
}

// ---------------------------------------------------------------- HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const STATIC = {
  '/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
  '/addon-web-links.js': 'node_modules/@xterm/addon-web-links/lib/addon-web-links.js',
  '/addon-webgl.js': 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js',
};

// Aucun script inline ni ressource externe ; WebSocket limité au serveur local ; pas d'intégration dans un cadre.
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", // xterm injecte des <style>
    "img-src 'self' data: blob:", "font-src 'self' data:",
    `connect-src 'self' ws://127.0.0.1:${PORT} ws://localhost:${PORT}`,
    "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

function hostOk(req) {
  const h = (req.headers.host || '').toLowerCase();
  return h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}`;
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function saveUpload(req, rawName) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > UPLOAD_MAX) { reject(new Error('fichier trop gros (30 Mo max)')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        fs.mkdirSync(UPLOADS, { recursive: true });
        let name = decodeURIComponent(rawName || '') || 'image.png';
        name = path.basename(name).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-80) || 'fichier';
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const file = path.join(UPLOADS, `${stamp}-${crypto.randomBytes(3).toString('hex')}-${name}`);
        fs.writeFileSync(file, Buffer.concat(chunks));
        resolve(file);
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Ménage : copies de plus de 7 jours.
try {
  for (const f of fs.readdirSync(UPLOADS)) {
    const full = path.join(UPLOADS, f);
    if (Date.now() - fs.statSync(full).mtimeMs > 7 * 86400e3) fs.unlinkSync(full);
  }
} catch { }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Routes des modules (lib/*.js) : route('GET', /^/api/x$/, async ({ req, res, m, url }) => …)
const ROUTES = [];
function route(method, re, fn) { ROUTES.push({ method, re, fn }); }

const server = http.createServer(async (req, res) => {
  if (!hostOk(req)) { res.writeHead(403); return res.end('bad host'); }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8').replace('__CSM_TOKEN__', TOKEN)
      // version des fichiers sur disque (relue à chaque fois) : diffère de VERSION si le code a changé depuis le démarrage
      .replace('__CSM_VERSION__', (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return ''; } })());
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    return res.end(html);
  }
  if (req.method === 'GET' && (STATIC[p] || /^\/[\w.-]+\.(js|css|svg|png)$/.test(p) || /^\/fonts\/[\w.-]+\.woff2$/.test(p))) { // polices embarquées (public/fonts, licence OFL)
    const file = STATIC[p] ? path.join(ROOT, STATIC[p]) : path.join(ROOT, 'public', p.slice(1));
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res); // lecture impossible : réponse coupée
  }

  if (!p.startsWith('/api/')) { res.writeHead(404); return res.end(); }
  const tk = String(req.headers['x-csm-token'] || '');
  if (!(tk === TOKEN || (p === '/api/hook' && tk === HOOK_TOKEN))) return json(res, 401, { error: 'token' });

  // Session verrouillée : routes refusées sans ticket de déverrouillage de cette fenêtre (lib/lock.js).
  const lockOf = (() => {
    const sm = p.match(/^\/api\/sessions\/(\w+)(\/[\w-]+(?:\/[\w-]+)*)?$/);
    if (sm) { const ls = sessions.get(sm[1]); if (ls?.lock && !['/lock', '/unlock-remove'].includes(sm[2] || '')) return ls; }
    const hx = p.match(/^\/api\/history\/([\w-]+)\//);
    if (hx) return ctx.lockedByConversation?.(hx[1]);
    return null;
  })();
  if (lockOf && !ctx.canAccess?.(lockOf, req)) {
    // lire le corps jusqu'au bout avant de répondre : sinon la connexion (keep-alive) est coupée
    await new Promise(r => { req.on('end', r); req.on('error', r); req.resume(); });
    return json(res, 423, { error: 'session verrouillée' });
  }

  try {
    if (p === '/api/version' && req.method === 'GET') return json(res, 200, { version: VERSION, pid: process.pid, runtime: process.versions.electron ? 'electron' : 'node' });
    if (p === '/api/upload' && req.method === 'POST') {
      const file = await saveUpload(req, String(req.headers['x-filename'] || ''));
      return json(res, 200, { path: file });
    }
    if (p === '/api/hook' && req.method === 'POST') {
      const { csm, event, data } = await readBody(req);
      const s = sessions.get(csm);
      if (!s) return json(res, 404, {});
      if (data && data.session_id && s.claudeSessionId !== data.session_id) { s.claudeSessionId = data.session_id; persist(); }
      if (event === 'start') {
        setStatus(s, 'idle'); emit('start', s);
        // mémoire native (lib/memory.js) : contexte des sessions précédentes du dossier, affiché à Claude par hook.js.
        // Pas après un compactage : le résumé l'inclut déjà, le réinjecter remplirait le contexte pour rien.
        const context = data && data.source === 'compact' ? '' : ctx.memoryContext?.(s, data && data.session_id) || '';
        broadcast({ t: 'session', s: publicView(s) });
        return json(res, 200, context ? { context } : {});
      }
      else if (event === 'end') emit('end', s);
      else if (event === 'quota') { emit('quota', s, data || {}); return json(res, 200, {}); } // barre d'état : quotas (lib/queue.js)
      else if (event === 'working') { setStatus(s, 'working', data && data.tool_name ? data.tool_name : ''); emit('working', s, data || {}); }
      // « Claude is waiting for your input » : simple rappel de Claude Code après ~1 min d'inactivité (idle_prompt),
      // pas une question. La session reste prête ; seules les vraies demandes (autorisation…) la font attendre.
      else if (event === 'attention' && (data?.notification_type === 'idle_prompt' || /waiting for your input/i.test(data?.message || ''))) {
        if (s.status === 'attention' || s.status === 'working') setStatus(s, 'idle', 'terminé');
      }
      else if (event === 'attention') setStatus(s, 'attention', (data && data.message) || 'attend une réponse');
      else if (event === 'idle') {
        setStatus(s, 'idle', 'terminé');
        emit('idle', s);
        // Nom donné avant que le transcript existe (ou nouvel id après /clear) : on l'écrit maintenant.
        if (s.named && s.claudeSessionId && s.titleFor !== s.claudeSessionId && writeCustomTitle(s.claudeSessionId, s.name)) {
          s.titleFor = s.claudeSessionId; persist();
        }
      }
      broadcast({ t: 'session', s: publicView(s) });
      return json(res, 200, {});
    }
    if (p === '/api/sessions' && req.method === 'GET') return json(res, 200, [...sessions.values()].map(publicView));
    if (p === '/api/sessions' && req.method === 'POST') {
      const b = await readBody(req);
      const lk = lockedResume(b);
      if (lk && !ctx.canAccess(lk, req)) return json(res, 423, { error: 'conversation d\u2019une session verrouillée' });
      return json(res, 200, publicView(createSession(b)));
    }
    const hm = p.match(/^\/api\/history\/([\w-]+)\/rename$/);
    if (hm && req.method === 'POST') {
      const title = String((await readBody(req)).name || '').trim().slice(0, 80);
      if (!title) return json(res, 400, { error: 'nom vide' });
      const managed = [...sessions.values()].find(s => s.claudeSessionId === hm[1]);
      if (managed) renameSession(managed, title);
      else if (!writeCustomTitle(hm[1], title)) return json(res, 404, { error: 'conversation introuvable' });
      return json(res, 200, { ok: true });
    }
    if (p === '/api/history' && req.method === 'GET') {
      const managed = new Set([...sessions.values()].map(s => s.claudeSessionId).filter(Boolean));
      return json(res, 200, history().slice(0, 400).map(h => {
        const lk = ctx.lockedByConversation?.(h.id);
        return lk ? { ...h, managed: true, locked: true, title: `🔒 ${lk.name}`, lastPrompt: '' } : { ...h, managed: managed.has(h.id) };
      }));
    }
    if (p === '/api/external' && req.method === 'GET') return json(res, 200, externalSessions());
    if (p === '/api/import' && req.method === 'POST') {
      const { items, mode } = await readBody(req);
      const done = [], errors = [];
      for (const it of items || []) {
        try { done.push(publicView(await importExternal(Number(it.pid), String(it.sessionId), mode))); }
        catch (e) { errors.push(`${it.title || it.sessionId}: ${e.message}`); }
      }
      return json(res, 200, { done, errors });
    }
    if (p === '/api/pick-folder' && req.method === 'POST') {
      const { initial } = await readBody(req);
      const picked = await pickFolder(initial);
      return json(res, 200, { path: picked });
    }
    if (p === '/api/order' && req.method === 'POST') {
      const { ids } = await readBody(req);
      (ids || []).forEach((id, i) => { const s = sessions.get(id); if (s) s.order = i + 1; });
      persist(); broadcastAll();
      return json(res, 200, {});
    }
    const m = p.match(/^\/api\/sessions\/(\w+)(?:\/(\w+))?$/);
    const s = m && sessions.get(m[1]);
    if (m && !s) return json(res, 404, { error: 'session inconnue' });
    // Supprimer : retirée de la liste, et des autres machines par la synchro (la conversation reste dans
    // l'Historique). ?here=1 (Fermer) : retirée de cette machine seulement ; synchronisée, elle est d'abord mise
    // en pause (mémoire et synchro enregistrées) et reste « en pause » sur les autres machines.
    if (s && req.method === 'DELETE' && !m[2]) {
      let saved = {};
      if (url.searchParams.get('here') === '1' && s.syncId && ctx.syncDetach && ctx.syncEnabled?.()) {
        saved = await pauseAndSave(s);
        ctx.syncDetach(s.syncId);
      }
      killSession(s); sessions.delete(s.id); persist();
      broadcast({ t: 'removed', id: s.id });
      return json(res, 200, { kept: !!saved.synced, ...saved });
    }
    if (s && m[2] === 'rename' && req.method === 'POST') {
      const { name } = await readBody(req);
      renameSession(s, name);
      return json(res, 200, publicView(s));
    }
    if (s && m[2] === 'kill' && req.method === 'POST') { s.wantRun = false; persist(); killSession(s); return json(res, 200, {}); }
    // Pause : la session s'arrête mais reste dans la liste, ici et sur les autres machines (synchro) ;
    // « Reprendre » continue la même conversation, ici ou ailleurs.
    // Avant de répondre : la session est arrêtée, sa mémoire à jour et tout est synchronisé (conversation comprise),
    // pour la reprendre aussitôt sur une autre machine.
    if (s && m[2] === 'pause' && req.method === 'POST') {
      const saved = await pauseAndSave(s);
      return json(res, 200, { ...publicView(s), ...saved });
    }
    if (s && m[2] === 'restart' && req.method === 'POST') {
      await restartSession(s);
      return json(res, 200, publicView(s));
    }
    if (s && m[2] === 'seen' && req.method === 'POST') {
      // « attention » reste tant que Claude attend (permission, question) : seul le hook suivant le lève.
      if (s.status === 'idle' && s.message === 'terminé') setStatus(s, 'idle', '');
      return json(res, 200, {});
    }
    for (const r of ROUTES) {
      if (r.method !== req.method) continue;
      const mm = p.match(r.re);
      if (mm) return await r.fn({ req, res, m: mm, url });
    }
    return json(res, 404, { error: 'route' });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

// ---------------------------------------------------------------- WebSocket
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(data);
}
function broadcastAll() { broadcast({ t: 'sessions', list: [...sessions.values()].map(publicView) }); }

server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!hostOk(req) || url.pathname !== '/ws' || url.searchParams.get('token') !== TOKEN) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, ws => {
    clients.add(ws);
    ws.send(JSON.stringify({ t: 'sessions', list: [...sessions.values()].map(publicView) }));
    for (const s of sessions.values()) if (s.buf && !s.lock) ws.send(JSON.stringify({ t: 'replay', id: s.id, d: s.buf }));
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (ctx.onWsMessage?.(ws, m)) return;
      const s = sessions.get(m.id);
      if (!s) return;
      if (s.lock && !ctx.wsCan?.(s, ws)) return; // verrouillée : ni saisie ni redimensionnement
      if (m.t === 'input' && s.pty) {
        s.pty.write(m.d);
        if (m.d.includes('\r')) s.fromQueue = false; // demande tapée par l'utilisateur (tableau d'usage)
        if ((m.d === '\x03' || m.d === '\x1b') && (s.status === 'working' || s.status === 'attention')) watchInterrupt(s);
      }
      else if (m.t === 'resize' && m.cols > 10 && m.rows > 3) {
        s.cols = m.cols; s.rows = m.rows;
        if (s.pty) try { s.pty.resize(m.cols, m.rows); } catch { }
      }
    });
    ws.on('close', () => { clients.delete(ws); ctx.onWsClose?.(ws); });
  });
});

// ---------------------------------------------------------------- modules
const listeners = {};
function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }
function emit(ev, ...a) { for (const fn of listeners[ev] || []) { try { fn(...a); } catch (e) { console.error('module', ev, e); } } }
// Pause (et Fermer d'une session synchronisée) : arrêt, puis mémoire et synchro complète avant de rendre la main
async function pauseAndSave(s) {
  s.wantRun = false; s.paused = true; persist();
  if (s.pty) {
    killSession(s);
    for (let i = 0; i < 50 && s.pty; i++) await new Promise(r => setTimeout(r, 100)); // fin du processus (≤ 5 s)
  } else { setStatus(s, 'exited', 'en pause'); broadcast({ t: 'session', s: publicView(s) }); }
  const memory = s.claudeSessionId && ctx.memory?.on() ? ctx.memory.captureNow(s.claudeSessionId) : null;
  const synced = ctx.syncNow ? await ctx.syncNow() : null;
  return { memory, synced };
}
async function restartSession(s) {
  if (!s.pty) await ctx.prepareResume?.(s); // conversation modifiée sur une autre machine (lib/sync)
  delete s.applyOnIdle;
  killSession(s);
  s.buf += '\x1b[2J\x1b[H';
  broadcast({ t: 'clear', id: s.id });
  s.hasHistory = false; // écran remis à zéro : Claude Code réaffiche la conversation, sauf avant une compaction
  await showCompacted(s);
  spawnSession(s, { resume: s.claudeSessionId || undefined });
}
// Discussion d'avant la dernière compaction, affichée avant la reprise (Claude Code ne montre que la suite)
async function showCompacted(s) {
  if (s.hasHistory || s.lock || !s.claudeSessionId) return;
  s.hasHistory = true;
  try { const t = await beforeLastCompaction(transcriptPath(s.claudeSessionId)); if (t) appendOut(s, t); } catch { }
}
// Réglages de lancement changés (langue des réponses, mémoire, compactage…) : Claude Code ne les lit qu'au
// démarrage. Sessions ouvertes avec d'anciens réglages : relancées dans leur conversation, tout de suite si elles
// sont au repos, sinon dès qu'elles ont fini leur tour.
const staleSessions = () => [...sessions.values()].filter(s => s.pty && s.settingsFile && !s.lock && s.settingsFile !== settingsFor(s));
route('GET', /^\/api\/apply-settings$/, async ({ res }) => {
  const list = staleSessions();
  json(res, 200, { count: list.length, busy: list.filter(s => s.status === 'working' || s.status === 'attention').length });
});
route('POST', /^\/api\/apply-settings$/, async ({ res }) => {
  let now = 0, later = 0;
  for (const s of staleSessions()) {
    if (s.status === 'working' || s.status === 'attention') { s.applyOnIdle = true; later++; }
    else { await restartSession(s); now++; }
  }
  json(res, 200, { now, later });
});
// Modèle changé en cours de session (/model dans Claude Code) : repris dans les arguments de la session, pour qu'une
// relance, une reprise et les autres machines (synchro) utilisent le même. Un alias (« opus ») et l'identifiant
// complet du même modèle (« claude-opus-5-5 », « …[1m] ») ne changent rien.
const modelFamily = m => (String(m || '').toLowerCase().match(/opus|sonnet|haiku|fable/) || [String(m || '').toLowerCase().replace(/\[.*\]$/, '')])[0];
function followModel(s) {
  if (!s.claudeSessionId || s.lock) return;
  const used = (conversationModelArgs(s.claudeSessionId).match(/^--model (\S+)$/) || [])[1];
  if (!used || used === ctx.getSettings?.().defaultModel) return; // rien lu dans la conversation (modèle par défaut)
  const parts = splitArgs(s.args || ''), i = parts.indexOf('--model');
  const cur = i >= 0 ? parts[i + 1] : '';
  if (cur && modelFamily(cur) === modelFamily(used)) return;
  if (i >= 0) parts[i + 1] = used; else parts.unshift('--model', used);
  s.args = parts.map(x => (/\s/.test(x) ? `"${x}"` : x)).join(' ');
  persist(); broadcast({ t: 'session', s: publicView(s) });
}
on('idle', s => { try { followModel(s); } catch { } try { followName(s); } catch { } });
on('start', s => { if (s.renameOnIdle) setTimeout(() => liveRename(s), 1500); }); // renommée pendant le démarrage
// /rename tapé dans une session ouverte ne finit pas de tour : conversation relue quand son fichier change (5 s)
const nameSeen = new Map();
setInterval(() => {
  for (const s of sessions.values()) {
    if (!s.pty || !s.claudeSessionId || s.renameOnIdle) continue;
    let m = 0; try { m = fs.statSync(transcriptPath(s.claudeSessionId) || '').mtimeMs; } catch { continue; }
    if (nameSeen.get(s.id) === m) continue;
    nameSeen.set(s.id, m);
    try { followName(s); } catch { }
  }
}, Number(process.env.CSM_NAME_POLL) || 5000).unref?.();
on('idle', s => { if (s.applyOnIdle && s.settingsFile !== settingsFor(s)) setTimeout(() => restartSession(s).catch(() => { }), 800); else delete s.applyOnIdle; });

const ctx = {
  route, on, emit, json, readBody, sessions, publicView, persist, persistHooks, broadcast, createSession, killSession, spawnSession,
  renameSession, history, transcriptPath, setStatus, pauseAndSave, restartSession, liveRename, lockedResume, splitArgs, DATA, ROOT, PORT, VERSION, IS_WIN, IS_MAC, TOKEN_FILE, CLAUDE_INSTALL,
};
Object.defineProperty(ctx, 'CLAUDE', { get: claudeBin, enumerable: true }); // chemin toujours à jour (installé après coup)
for (const mod of ['lock', 'git', 'settings', 'auth', 'extensions', 'secrets', 'usage', 'tools', 'queue', 'quotastop', 'remote', 'memory', 'sync', 'schedule', 'transfer']) {
  try { require(`./lib/${mod}`)(ctx); } catch (e) { console.error(`module ${mod} :`, e); }
}

server.on('error', e => { console.error('écoute impossible', e.message); process.exit(1); }); // ex. déjà lancé
server.listen(PORT, HOST, () => {
  fs.writeFileSync(path.join(DATA, 'server.pid'), String(process.pid));
  console.log(`Claude Sessions Manager -> http://${HOST}:${PORT}  (claude: ${CLAUDE})`);
  restoreSessions();
});

// Arrêt (mise à jour, Quitter et arrêter, Redémarrer le serveur, extinction) : dernière synchro avant de sortir,
// sinon ce qui n'était pas encore parti (renommage, mise en pause, fin de conversation) attendait le prochain
// démarrage de cette machine. Au plus SHUTDOWN_SYNC_MS : hors ligne, l'arrêt ne traîne pas.
const SHUTDOWN_SYNC_MS = Number(process.env.CSM_SHUTDOWN_SYNC_MS) || 12000;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  persist(); // avant de tuer : les sessions ouvertes seront restaurées au prochain démarrage
  for (const s of sessions.values()) killSession(s);
  // fin des processus : la conversation est entièrement écrite avant l'envoi (≤ 3 s)
  for (let i = 0; i < 30 && [...sessions.values()].some(s => s.pty); i++) await new Promise(r => setTimeout(r, 100));
  for (const s of sessions.values()) s.pty = null; // ne pas relancer ni écrire pendant la synchro
  persist();
  saveAllScrollback(true); // contenu des terminaux, réaffiché au prochain démarrage
  if (ctx.syncEnabled?.()) await Promise.race([ctx.syncNow().catch(() => { }), new Promise(r => setTimeout(r, SHUTDOWN_SYNC_MS))]);
  process.exit(0);
}
// Electron sous Windows : pas de SIGTERM (process.kill y termine le processus net), il passe par cette route.
route('POST', /^\/api\/shutdown$/, async ({ res }) => { json(res, 200, {}); setImmediate(shutdown); });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
