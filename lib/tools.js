'use strict';
// « Ouvrir dans… » (#4), Diagnostic (#7), Journaux (#23).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { which } = require('./config');

const EDITORS = [
  { id: 'code', label: 'VS Code', cmd: 'code' },
  { id: 'cursor', label: 'Cursor', cmd: 'cursor' },
  { id: 'windsurf', label: 'Windsurf', cmd: 'windsurf' },
  { id: 'zed', label: 'Zed', cmd: 'zed' },
  { id: 'idea', label: 'IntelliJ IDEA', cmd: 'idea' },
  { id: 'subl', label: 'Sublime Text', cmd: 'subl' },
];
const MAC_APPS = { code: 'Visual Studio Code', cursor: 'Cursor', windsurf: 'Windsurf', zed: 'Zed', idea: 'IntelliJ IDEA', subl: 'Sublime Text' };

function run(cmd, args, opts = {}) {
  return new Promise(resolve => execFile(cmd, args, { timeout: 6000, windowsHide: true, encoding: 'utf8', ...opts },
    (err, out, errOut) => resolve(err ? { ok: false, out: (errOut || err.message || '').trim() } : { ok: true, out: (out || '').trim() })));
}
function detached(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, ...opts });
  p.on('error', () => { });
  p.unref();
}
function macAppExists(name) { return fs.existsSync(`/Applications/${name}.app`) || fs.existsSync(path.join(os.homedir(), 'Applications', `${name}.app`)); }

function availableEditors() {
  return EDITORS.filter(e => which(e.cmd) || (process.platform === 'darwin' && macAppExists(MAC_APPS[e.id])));
}

module.exports = function (ctx) {
  const { route, json, readBody, sessions, DATA, ROOT, VERSION, IS_WIN, IS_MAC } = ctx;
  // Connexion de Claude Code à un compte (claude auth status : code 1 et loggedIn false si pas connecté) ;
  // null si inconnue (version de Claude Code sans cette commande).
  const authStatus = prefix => new Promise(resolve => execFile(ctx.CLAUDE, [...prefix, 'auth', 'status', '--json'], { timeout: 8000, windowsHide: true, encoding: 'utf8' },
    (err, out) => { try { const j = JSON.parse(out); resolve({ loggedIn: !!j.loggedIn, method: String(j.authMethod || '') }); } catch { resolve(null); } }));

  route('GET', /^\/api\/editors$/, async ({ res }) => json(res, 200, availableEditors().map(({ id, label }) => ({ id, label }))));

  route('POST', /^\/api\/sessions\/(\w+)\/open$/, async ({ req, res, m }) => {
    const s = sessions.get(m[1]); if (!s) return json(res, 404, { error: 'session inconnue' });
    const { target } = await readBody(req);
    const dir = s.cwd;
    if (!fs.existsSync(dir)) return json(res, 400, { error: 'dossier introuvable' });
    if (target === 'folder') {
      if (IS_WIN) detached('explorer.exe', [dir]); else if (IS_MAC) detached('open', [dir]); else detached('xdg-open', [dir]);
    } else if (target === 'terminal') {
      if (IS_WIN) {
        if (which('wt')) detached('wt.exe', ['-d', dir]);
        else detached('cmd.exe', ['/c', 'start', '', 'cmd.exe'], { windowsHide: true, cwd: dir }); // ouvert dans le dossier (cwd hérité)
      } else if (IS_MAC) detached('open', ['-a', 'Terminal', dir]);
      else detached('x-terminal-emulator', ['--working-directory', dir]);
    } else if (target === 'editor') {
      const st = ctx.getSettings ? ctx.getSettings() : {};
      if (st.editor === 'custom' && String(st.editorCommand || '').trim()) { // commande vide : éditeur automatique
        // commande personnalisée : {path} remplacé par le dossier (réglage local, protégé par le jeton)
        const parts = (String(st.editorCommand || '').match(/"[^"]*"|\S+/g) || []).map(x => x.replace(/^"|"$/g, '').split('{path}').join(dir));
        if (!parts.some(x => x.includes(dir))) parts.push(dir);
        // Windows (lancé via cmd) : chaque morceau avec espaces entre guillemets, exécutable compris (C:\Program Files\…)
        const q = x => (IS_WIN && /\s/.test(x) ? `"${x}"` : x);
        detached(q(parts[0]), parts.slice(1).map(q), { shell: IS_WIN });
      } else {
        const list = availableEditors();
        const ed = (st.editor && st.editor !== 'auto' && list.find(e => e.id === st.editor)) || list[0];
        if (!ed) return json(res, 400, { error: 'aucun éditeur trouvé (VS Code, Cursor…) — à régler dans Réglages' });
        if (IS_MAC && !which(ed.cmd)) detached('open', ['-a', MAC_APPS[ed.id], dir]);
        else detached(ed.cmd, [IS_WIN ? `"${dir}"` : dir], { shell: IS_WIN }); // Windows : code.cmd, cursor.cmd… (via cmd, d'où les guillemets)
      }
    } else return json(res, 400, { error: 'cible inconnue' });
    json(res, 200, { ok: true });
  });

  route('GET', /^\/api\/diag$/, async ({ res }) => {
    const prefix = (process.env.CSM_CLAUDE_ARGS || '').match(/"[^"]*"|\S+/g)?.map(x => x.replace(/^"|"$/g, '')) || [];
    const CLAUDE = ctx.CLAUDE; // cherché de nouveau s'il a été installé depuis le démarrage
    const [cv, gv] = await Promise.all([run(CLAUDE, [...prefix, '--version']), run('git', ['--version'])]);
    const auth = cv.ok ? await authStatus(prefix) : null;
    const hooks = path.join(DATA, 'hooks-settings.json');
    const logFile = path.join(DATA, 'server.log');
    let logTail = '';
    try { logTail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n'); } catch { }
    json(res, 200, {
      app: VERSION, runtime: process.versions.electron ? `Electron ${process.versions.electron}` : `Node ${process.version}`,
      node: process.version, platform: `${os.type()} ${os.release()} (${process.arch})`,
      claude: { path: CLAUDE, ok: cv.ok, version: cv.out.split('\n')[0] || '', install: ctx.CLAUDE_INSTALL, auth },
      git: { ok: gv.ok, version: gv.out },
      data: DATA, code: ROOT, hooks: { file: hooks, ok: fs.existsSync(hooks) },
      sessions: { total: sessions.size, alive: [...sessions.values()].filter(s => s.pty).length },
      uptime: Math.round(process.uptime()), memory: Math.round(process.memoryUsage().rss / 1048576),
      logTail,
    });
  });

  route('GET', /^\/api\/logs$/, async ({ res, url }) => {
    const n = Math.max(10, Math.min(5000, Number(url.searchParams.get('lines')) || 500));
    let text = '';
    try { text = fs.readFileSync(path.join(DATA, 'server.log'), 'utf8').split('\n').slice(-n).join('\n'); } catch { }
    json(res, 200, { text, file: path.join(DATA, 'server.log') });
  });
};
