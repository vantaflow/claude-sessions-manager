'use strict';
// Sortie standard fermée (app lancée sans console, terminal parent disparu) : une écriture lève EPIPE, qui
// deviendrait une « erreur JavaScript dans le processus principal ». Ces erreurs d'écriture sont ignorées.
for (const s of [process.stdout, process.stderr]) s?.on?.('error', () => { });
for (const k of ['log', 'info', 'warn', 'error']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { try { orig(...a); } catch { } };
}
require('../lib/tz').alignTimezone(); // avant tout usage de Date : suivre le fuseau du système
// Claude Sessions — application de bureau (Windows / macOS).
// La fenêtre n'est qu'une vue : les sessions vivent dans le serveur local (processus séparé), qui continue
// de tourner quand on ferme ou quitte l'application.
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain, session, screen, Notification, nativeTheme, powerMonitor } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFile, execFileSync, spawnSync } = require('child_process');
const { ROOT, PORT, IS_WIN, IS_MAC, DATA } = require('../lib/config');

const ORIGIN = `http://127.0.0.1:${PORT}`;
const URL_ = `${ORIGIN}/`;
const SERVER = path.join(ROOT, 'server.js');
const ICON = path.join(ROOT, 'public', IS_WIN ? 'icon.ico' : 'icon.png');
const STATE = path.join(DATA, 'app-window.json');
const READY_MS = Number(process.env.CSM_READY_WATCH_MS) || 25000; // délai avant de vérifier qu'une page a démarré
const READY_MAX = Number(process.env.CSM_READY_MAX_MS) || 180e3;   // page qui tourne mais attend encore : recréée au-delà
// --hidden : démarrage de session ; hidden-once : relance après une mise à jour installée pendant que la fenêtre était cachée
const HIDDEN_ONCE = path.join(DATA, 'start-hidden-once');
const START_HIDDEN = process.argv.includes('--hidden') || (() => { try { fs.unlinkSync(HIDDEN_ONCE); return true; } catch { return false; } })();

app.setName('Claude Sessions');
// Autre port = instance séparée (tests, essais) : profil et verrou d'instance unique distincts.
if (PORT !== 7890) app.setPath('userData', path.join(DATA, 'electron'));
if (IS_WIN) app.setAppUserModelId('com.claude-sessions.app'); // notifications Windows rattachées à l'app
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

let win = null;
let tray = null;
let quitting = false;
// Préférences de fenêtre transmises par la page (réglages du serveur) ; valeurs par défaut en attendant.
const prefs = { closeToTray: true };
let attention = 0;
let updates = null; // electron/updater.js
// Journal des mises à jour (DATA/update.log, 256 Ko max) : dit pourquoi une installation automatique attend.
let lastWhy = null;
function updLog(m) {
  try { console.log(m); } catch { } // EPIPE possible, levé tout de suite sous Windows
  try {
    const f = path.join(DATA, 'update.log');
    try { if (fs.statSync(f).size > 256e3) fs.renameSync(f, f + '.1'); } catch { }
    fs.appendFileSync(f, `${new Date().toISOString()} ${m}\n`);
  } catch { }
}

// macOS : sans signature Apple (identifiant d'équipe), le centre de notifications refuse l'app
// (UNErrorDomain 1 « Notifications are not allowed ») et masque aussi la pastille du Dock — sans
// aucune erreur côté Electron. On le détecte une fois pour passer par des replis.
let macNative = null;
function macNotificationsAllowed() {
  if (macNative !== null) return macNative;
  if (!IS_MAC) return (macNative = true);
  try {
    const bundle = path.resolve(process.execPath, '..', '..', '..');
    const r = spawnSync('codesign', ['-dv', bundle], { encoding: 'utf8', timeout: 3000 });
    const team = (/TeamIdentifier=(.+)/.exec(r.stderr || '') || [])[1];
    macNative = !!team && team.trim() !== 'not set';
  } catch { macNative = false; }
  return macNative;
}

// Notification système. Repli macOS (app non signée) : celle d'AppleScript, toujours autorisée, sans action au clic.
const liveNotes = new Set(); // référence gardée jusqu'au clic / à la fermeture (sinon l'événement « click » est perdu)
function notify(title, body, sessionId) {
  const clean = v => String(v || '').replace(/[\u0000-\u001f]+/g, ' ').slice(0, 300);
  title = clean(title) || 'Claude Sessions'; body = clean(body);
  // instances de test (fenêtre cachée) : rien n'apparaît sur le bureau de l'utilisateur
  if (process.env.CSM_HIDE_WINDOW) return IS_MAC && !macNotificationsAllowed() ? 'applescript' : Notification.isSupported() ? 'native' : 'unsupported';
  if (IS_MAC && !macNotificationsAllowed()) {
    execFile('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body], () => { });
    return 'applescript';
  }
  if (!Notification.isSupported()) return 'unsupported';
  const n = new Notification({ title, body, silent: true });
  liveNotes.add(n);
  n.on('click', () => { liveNotes.delete(n); if (sessionId) send(`select:${sessionId}`); else showWindow(); });
  n.on('close', () => liveNotes.delete(n));
  n.show();
  return 'native';
}

// Lecture d'un réglage du serveur (le jeton est dans le dossier de données, lisible par l'utilisateur seul).
function serverGet(p) {
  return new Promise(resolve => {
    let token = ''; try { token = fs.readFileSync(path.join(DATA, 'token'), 'utf8').trim(); } catch { }
    const req = http.get(`${ORIGIN}${p}`, { headers: { 'X-CSM-Token': token }, timeout: 2000 }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ---------------------------------------------------------------- serveur
function isUp() {
  return new Promise(resolve => {
    const req = http.get(URL_, { timeout: 800 }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// Une app lancée depuis le Finder / le Dock n'a pas le PATH du shell (claude, git, node… introuvables).
function loginShellPath() {
  if (!IS_MAC) return process.env.PATH;
  try {
    const sh = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(sh, ['-ilc', 'printf "__P__%s__P__" "$PATH"'], { encoding: 'utf8', timeout: 10000 });
    return (out.match(/__P__(.*)__P__/) || [])[1] || process.env.PATH;
  } catch { return process.env.PATH; }
}

async function ensureServer() {
  if (await isUp()) return true;
  fs.mkdirSync(DATA, { recursive: true });
  // Electron lui-même en mode Node : aucune installation de Node.js requise. Détaché = survit à l'app.
  // langue préférée du système (Node lancé depuis le Finder ne la connaît pas : il répondrait en-US)
  let sysLang = '';
  try { sysLang = (app.getPreferredSystemLanguages?.()[0] || app.getLocale() || '').slice(0, 2).toLowerCase(); } catch { }
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: loginShellPath(), CSM_SYS_LANG: sysLang };
  spawn(process.execPath, [SERVER, `--port=${PORT}`], { cwd: ROOT, env, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 150; i++) { if (await isUp()) return true; await new Promise(r => setTimeout(r, 200)); }
  return false;
}

const windowAway = () => !win || win.isDestroyed() || !win.isVisible() || win.isMinimized();

// Arrêt propre : le serveur mémorise les sessions ouvertes et fait une dernière synchro (≤ 12 s) avant de sortir.
// Demandé par /api/shutdown (sous Windows, process.kill termine le processus net, sans synchro) ; serveur
// injoignable ou toujours là après 20 s : arrêt forcé.
function serverPost(p) {
  return new Promise(resolve => {
    let token = ''; try { token = fs.readFileSync(path.join(DATA, 'token'), 'utf8').trim(); } catch { }
    const req = http.request(`${ORIGIN}${p}`, { method: 'POST', headers: { 'X-CSM-Token': token, 'Content-Length': 0 }, timeout: 3000 }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}
async function stopServer() {
  let pid = 0; try { pid = Number(fs.readFileSync(path.join(DATA, 'server.pid'), 'utf8')); } catch { }
  if (await serverPost('/api/shutdown')) for (let i = 0; i < 100 && (await isUp()); i++) await new Promise(r => setTimeout(r, 200));
  if (!(await isUp())) return;
  try { if (pid) process.kill(pid, IS_WIN ? undefined : 'SIGTERM'); } catch { } // SIGTERM : les sessions ouvertes sont mémorisées
  for (let i = 0; i < 75 && (await isUp()); i++) await new Promise(r => setTimeout(r, 200));
}

// ---------------------------------------------------------------- fenêtre
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    const visible = screen.getAllDisplays().some(d => {
      const a = d.workArea;
      return s.x < a.x + a.width - 100 && s.x + s.width > a.x + 100 && s.y >= a.y - 10 && s.y < a.y + a.height - 100;
    });
    return visible ? s : { width: s.width, height: s.height, maximized: s.maximized };
  } catch { return { width: 1400, height: 900 }; }
}
function saveState() {
  if (!win || win.isDestroyed()) return;
  try { fs.writeFileSync(STATE, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch { }
}

const sameOrigin = url => { try { return new URL(url).origin === ORIGIN; } catch { return false; } };
const external = url => { try { return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol); } catch { return false; } };

function createWindow({ hidden = false } = {}) {
  const st = loadState();
  win = new BrowserWindow({
    x: st.x, y: st.y, width: st.width || 1400, height: st.height || 900, minWidth: 760, minHeight: 480,
    title: 'Claude Sessions', icon: ICON, show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181c' : '#f4f1ec', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
      spellcheck: false, backgroundThrottling: false, // le terminal reste réactif quand la fenêtre est en arrière-plan
    },
  });
  if (st.maximized) win.maximize();

  // Navigation verrouillée sur le serveur local ; tout lien externe part dans le navigateur par défaut.
  win.webContents.setWindowOpenHandler(({ url }) => { if (external(url) && !sameOrigin(url) && !pilotAt) shell.openExternal(url); return { action: 'deny' }; });
  // pilotage à distance (lib/remote/pilot.js) : la fenêtre peut ouvrir le mandataire local d'une autre machine,
  // seulement à l'origine exacte annoncée par la page de cette machine (IPC csm:pilot-origin), y rester, puis
  // revenir ; les appels natifs (IPC) restent réservés à la page de cette machine (trusted), et la page d'une autre
  // machine n'ouvre pas de lien dans le navigateur
  win.webContents.on('will-navigate', (e, url) => {
    if (sameOrigin(url)) { pilotAt = ''; return; }
    let u = null; try { u = new URL(url); } catch { }
    if (u && pilotAllowed && u.origin === pilotAllowed) { pilotAt = pilotAllowed; return; }
    e.preventDefault();
    if (external(url) && !pilotAt) shell.openExternal(url);
  });
  win.webContents.on('will-attach-webview', e => e.preventDefault());

  win.once('ready-to-show', () => { if (process.env.CSM_HIDE_WINDOW || hidden) return; if (!START_HIDDEN || win.__forceShow) win.show(); }); // CSM_HIDE_WINDOW : tests automatiques, rien à l'écran
  win.on('close', e => {
    saveState();
    if (quitting) return;
    if (prefs.closeToTray) { e.preventDefault(); toTray(); } // fermer = masquer (notifications, sessions continuent)
    else if (updates?.readyOnQuit?.()) { e.preventDefault(); quitApp(); } // version prête : installée en quittant
    else { quitting = true; } // fermer = quitter l'app ; le serveur et les sessions continuent
  });
  // Réduire : dans la barre des tâches / le Dock, comme toute fenêtre ; la zone de notification se choisit dans
  // un menu (⋯, palette, icône de la zone de notification, Fenêtre sur macOS).
  for (const ev of ['resize', 'move']) win.on(ev, debounce(saveState, 500));
  win.on('focus', () => { win.flashFrame(false); updates?.onFocus?.(); });
  // F5 recharge la fenêtre (Windows n'a pas de barre de menus ; Ctrl+R reste à Claude : recherche dans l'historique)
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type === 'keyDown' && i.key === 'F5' && !i.control && !i.alt && !i.meta) { e.preventDefault(); reloadWindow(); }
  });
  win.on('show', () => updates?.onFocus?.());
  // fermeture de la session Windows ou extinction : synchro tout de suite (le serveur s'arrête avec)
  win.on('query-session-end', () => { serverPost('/api/sync/now'); });

  // Affichage tué (mémoire saturée, plantage) ou figé : la fenêtre resterait noire, et Cmd+R n'y peut
  // rien puisqu'il n'y a plus de page pour l'exécuter. On recrée la fenêtre ; serveur et sessions intacts.
  let frozen = null;
  win.webContents.on('render-process-gone', (e, d) => { if (d.reason !== 'clean-exit') recoverWindow(`affichage arrêté (${d.reason})`); });
  win.on('unresponsive', () => { clearTimeout(frozen); frozen = setTimeout(() => recoverWindow('affichage figé depuis 20 s'), 20000); });
  win.on('responsive', () => clearTimeout(frozen));
  win.on('closed', () => { clearTimeout(frozen); clearTimeout(unready); });

  // Page restée inachevée (vu après un plantage du GPU : squelette affiché, script jamais lancé, aucune
  // connexion au serveur, sans que l'affichage soit « figé » au sens d'Electron) : on recrée la fenêtre.
  // Page encore en chargement, ou dont le script tourne et attend le serveur (premier lancement après l'allumage :
  // ouverture de session et sessions Claude relancées en même temps) : on la laisse finir, recréer ne ferait que
  // tout recommencer ; au-delà de READY_MAX seulement, elle est recréée.
  let unready = null;
  const w = win;
  const watchReady = () => {
    clearTimeout(unready);
    const since = Date.now();
    let noted = false;
    const check = async () => {
      if (w.isDestroyed()) return;
      const st = await Promise.race([
        w.webContents.executeJavaScript('[document.documentElement.dataset.boot || "", document.documentElement.dataset.ready || ""].join("|")', true).catch(() => ''),
        new Promise(r => setTimeout(() => r(''), 5000)),
      ]);
      if (w.isDestroyed() || w !== win || st.endsWith('|1')) return;
      // script lancé qui attend le serveur, ou page sans réponse parce que le serveur ne répond pas encore ;
      // page servie dont le script n'a jamais démarré (plantage du GPU) : recréée
      const waiting = st.startsWith('1|') || (!st && !(await isUp()));
      if (waiting && Date.now() - since < READY_MAX) {
        if (!noted) { noted = true; updLog(`[fenêtre] page lente à démarrer (${st ? 'attente du serveur' : 'serveur pas encore prêt'}) : on la laisse finir`); }
        unready = setTimeout(check, 5000);
        return;
      }
      recoverWindow(`page pas prête après ${Math.round((Date.now() - since) / 1000)} s (${!st ? 'page sans réponse' : st.startsWith('1|') ? 'attente du serveur' : 'script jamais lancé'})`);
    };
    unready = setTimeout(check, READY_MS);
  };
  win.webContents.on('did-start-loading', watchReady);

  win.webContents.on('did-fail-load', async (e, code, desc, url, isMain) => {
    if (!isMain) return;
    // Serveur pas encore prêt ou arrêté : on le relance puis on recharge.
    // fenêtre capturée (w) : le global win a pu être recréé ou remis à null entre-temps
    if (await ensureServer()) setTimeout(() => !w.isDestroyed() && w.loadURL(URL_), 300);
    else (process.env.CSM_HIDE_WINDOW ? (t, m) => console.error(m) : dialog.showErrorBox)('Claude Sessions', `Le serveur local ne démarre pas.\n\nJournal : ${path.join(DATA, 'server.log')}`);
  });
  win.loadURL(URL_);
}

// Recrée la fenêtre après un plantage de l'affichage ou du GPU, en gardant son état (visible ou cachée).
// Machine encore saturée (3 reprises en 1 min) : on attend 15 s au lieu d'1 pour ne pas boucler.
let recoveries = [], recoverTimer = null;
function recoverWindow(why, delay) {
  if (quitting || recoverTimer) return;
  const now = Date.now();
  recoveries = recoveries.filter(t => now - t < 60000);
  delay ??= recoveries.length >= 3 ? 15000 : 1000;
  updLog(`[fenêtre] ${why} : recréation dans ${delay / 1000} s`);
  recoverTimer = setTimeout(() => {
    recoverTimer = null;
    if (quitting) return;
    recoveries.push(Date.now());
    const visible = !!win && !win.isDestroyed() && win.isVisible();
    if (win && !win.isDestroyed()) { saveState(); win.destroy(); }
    win = null;
    if (visible) showWindow(); else createWindow({ hidden: true });
  }, delay);
}

// Recharger : simple rechargement si la page vit, sinon recréation de la fenêtre.
function reloadWindow() {
  if (!win || win.isDestroyed() || win.webContents.isCrashed()) recoverWindow('rechargement demandé', 0);
  else win.webContents.reloadIgnoringCache();
}

// Masque la fenêtre (plus d'entrée dans la barre des tâches) ; la 1re fois, explique où elle est passée.
// macOS : fermer (Cmd+W) garde l'icône du Dock, comme toute app Mac (un clic la rouvre) ; seul le choix explicite
// « Réduire dans la barre des menus » l'enlève aussi du Dock.
function toTray(explicit = false) {
  if (!win || win.isDestroyed()) return;
  win.hide();
  if (IS_MAC && explicit) app.dock?.hide?.();
  const flag = path.join(DATA, 'app-tray-hint');
  if (tray && !fs.existsSync(flag)) {
    try { fs.writeFileSync(flag, new Date().toISOString()); } catch { }
    const msg = IS_WIN
      ? 'Claude Sessions continue en arrière-plan, avec tes sessions. Clique sur son icône près de l’horloge pour la rouvrir (si elle n’est pas visible : flèche ^).'
      : 'Claude Sessions continue en arrière-plan, avec tes sessions. Rouvre-la depuis le Dock ou son icône dans la barre des menus.';
    if (IS_WIN && tray.displayBalloon) tray.displayBalloon({ title: 'Claude Sessions', content: msg, iconType: 'info' });
    else notify('Claude Sessions', msg);
  }
}

function showWindow() {
  if (IS_MAC) app.dock?.show?.();
  if (!win || win.isDestroyed()) createWindow();
  win.__forceShow = true;
  if (win.isMinimized()) win.restore();
  if (process.env.CSM_HIDE_WINDOW) return;
  win.show(); win.focus();
}
const send = (action) => { showWindow(); win.webContents.send('csm:action', action); };

// ---------------------------------------------------------------- sécurité de la session web
function hardenSession() {
  const ses = session.defaultSession;
  const allowed = new Set(['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((wc, perm, cb, details) => cb(allowed.has(perm) && sameOrigin(details.requestingUrl || wc.getURL())));
  ses.setPermissionCheckHandler((wc, perm, origin) => allowed.has(perm) && sameOrigin(origin + '/'));
  ses.on('will-download', e => e.preventDefault());
}

// IPC : uniquement depuis la page du serveur local.
function trusted(e) { return sameOrigin(e.senderFrame?.url || ''); }
// pilotage à distance : origine du mandataire local annoncée par la page de cette machine, et page affichée
let pilotAllowed = '', pilotAt = '';
const pickedText = new Set(); // chemins .md choisis dans la boîte native, en attente d'écriture
const SAVE_TEXT_MAX = 50 * 1024 * 1024;
function registerIpc() {
  ipcMain.handle('csm:pick-folder', async (e, initial) => {
    if (!trusted(e)) return null;
    const r = await dialog.showOpenDialog(win, {
      title: 'Dossier de travail de la session Claude',
      defaultPath: typeof initial === 'string' && initial && fs.existsSync(initial) ? initial : undefined,
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });
    return r.canceled ? null : r.filePaths[0] || null;
  });
  // Réglages › Export / import : emplacement du fichier d'export (le serveur local l'écrit lui-même)
  // Export de conversation (.md) : même boîte native, filtre Markdown ; le chemin choisi est retenu pour csm:save-text.
  ipcMain.handle('csm:pick-save', async (e, name) => {
    if (!trusted(e)) return null;
    const base = typeof name === 'string' && name ? path.basename(name) : 'claude-sessions.csmx';
    const md = /\.md$/i.test(base);
    // dossier Téléchargements introuvable (déplacé, profil sans dossier connu) : getPath lève une erreur, la boîte ne
    // s'ouvrait jamais ; dossier personnel à la place
    const dir = (() => { try { return app.getPath('downloads'); } catch { return app.getPath('home'); } })();
    const r = await dialog.showSaveDialog(win, md
      ? { title: 'Enregistrer la conversation', defaultPath: path.join(dir, base), filters: [{ name: 'Markdown', extensions: ['md'] }] }
      : { title: 'Exporter les sessions', defaultPath: path.join(dir, base), filters: [{ name: 'Export Claude Sessions', extensions: ['csmx'] }] });
    let file = r.canceled ? null : r.filePath || null;
    if (file && md && !/\.md$/i.test(file)) file += '.md'; // extension retirée dans la boîte : remise
    if (file && md) { pickedText.add(file); setTimeout(() => pickedText.delete(file), 10 * 60e3); }
    return file;
  });
  // Écriture d'un texte (.md) : uniquement vers un chemin rendu par la boîte native ci-dessus, une seule fois, taille bornée.
  ipcMain.handle('csm:save-text', async (e, file, text) => {
    if (!trusted(e) || typeof file !== 'string' || typeof text !== 'string') return false;
    if (!pickedText.has(file) || !/\.md$/i.test(file) || Buffer.byteLength(text) > SAVE_TEXT_MAX) return false;
    pickedText.delete(file);
    try { await fs.promises.writeFile(file, text, 'utf8'); return true; } catch { return false; }
  });
  ipcMain.on('csm:attention', (e, n) => {
    if (!trusted(e)) return;
    n = Math.max(0, Math.min(99, Number(n) || 0));
    if (IS_MAC) { if (macNotificationsAllowed()) app.setBadgeCount(n); else setDockBadge(n); }
    if (IS_WIN && win) win.setOverlayIcon(n ? badgeIcon(n) : null, n ? `${n} session${n > 1 ? 's' : ''} en attente` : '');
    // macOS : un seul rebond du Dock par nouvelle attente (flashFrame rebondit sans fin jusqu'au retour dans l'app)
    if (IS_MAC) { if (n > attention && win && !win.isFocused()) app.dock?.bounce?.('informational'); }
    else if (n && win && !win.isFocused()) win.flashFrame(true);
    attention = n;
    refreshTrayIcon();
  });
  ipcMain.on('csm:prefs', (e, p) => {
    if (!trusted(e) || !p || typeof p !== 'object') return;
    for (const k of Object.keys(prefs)) if (typeof p[k] === 'boolean') prefs[k] = p[k];
  });
  ipcMain.on('csm:focus', e => { if (trusted(e)) showWindow(); });
  ipcMain.on('csm:pilot-origin', (e, origin) => { if (trusted(e) && typeof origin === 'string' && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(origin)) pilotAllowed = origin; });
  ipcMain.on('csm:to-tray', e => { if (trusted(e) && tray) toTray(true); });
  ipcMain.on('csm:notify', (e, o) => { if (trusted(e) && o && typeof o === 'object') notify(o.title, o.body, typeof o.id === 'string' ? o.id : ''); });
  // Réglages › Notifications › Tester : montre une notification et dit par quel moyen elle passe
  ipcMain.handle('csm:notify-test', e => {
    if (!trusted(e)) return null;
    const how = notify('Claude Sessions', 'Notification de test : si tu la vois, tout fonctionne.', '');
    return { how, signed: macNotificationsAllowed() };
  });
  ipcMain.handle('csm:update', async (e, action) => {
    if (!trusted(e) || !updates) return updates?.state || null;
    if (action === 'check') await updates.check();
    else if (action === 'install') await updates.install();
    else if (action === 'later') updates.postpone?.();
    return updates.state;
  });
  ipcMain.on('csm:app-version', e => { e.returnValue = trusted(e) ? app.getVersion() : ''; });
  ipcMain.handle('csm:restart-server', async e => {
    if (!trusted(e)) return false;
    await stopServer();
    const ok = await ensureServer();
    if (ok && win && !win.isDestroyed()) win.loadURL(URL_);
    return ok;
  });
}

let trayImg = null, trayImgAlert = null;
function trayImages() {
  if (trayImg) return;
  const size = IS_MAC ? 18 : 16;
  trayImg = nativeImage.createFromPath(path.join(ROOT, 'public', 'icon.png')).resize({ width: size, height: size, quality: 'best' });
  // même icône + point rouge en bas à droite (toBitmap : pixels BGRA, Windows comme macOS)
  const s = trayImg.getSize(), bmp = Buffer.from(trayImg.toBitmap());
  const r = Math.round(s.width * 0.28), cx = s.width - r - 0.5, cy = s.height - r - 0.5;
  for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) {
    const d = Math.hypot(x - cx, y - cy), i = (y * s.width + x) * 4;
    if (d <= r + 1) {
      const edge = d > r; // liseré sombre pour détacher le point
      const [R_, G, B] = edge ? [30, 27, 24] : [240, 86, 74];
      bmp[i] = B; bmp[i + 1] = G; bmp[i + 2] = R_;
      bmp[i + 3] = 255;
    }
  }
  trayImgAlert = nativeImage.createFromBitmap(bmp, { width: s.width, height: s.height });
}
async function refreshTrayIcon() {
  if (!tray) return;
  trayImages();
  tray.setImage(attention ? trayImgAlert : trayImg);
  const list = (await serverGet('/api/sessions')) || [];
  const alive = list.filter(s => s.alive).length;
  tray.setToolTip(`Claude Sessions — ${alive} session${alive > 1 ? 's' : ''} active${alive > 1 ? 's' : ''}${attention ? ` · ${attention} en attente de réponse` : ''}`);
}

// ---------------------------------------------------------------- pastille avec le nombre
// Chiffres en police bitmap 5×7 (le processus principal n'a pas de canvas) : pastille rouge et nombre en blanc,
// dessinés sur l'icône du Dock (macOS sans signature Apple : la pastille native est masquée) et en overlay de la
// barre des tâches Windows.
const GLYPHS = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'], 1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00110', '01000', '10000', '11111'], 3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'], 5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'], 7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'], 9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
};
// Dessine dans un bitmap BGRA (w×h) une pastille centrée en (cx, cy), rayon r, avec le texte.
function paintBadge(bmp, w, h, cx, cy, r, text) {
  for (let y = Math.max(0, Math.floor(cy - r - 1)); y < Math.min(h, Math.ceil(cy + r + 1)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r - 1)); x < Math.min(w, Math.ceil(cx + r + 1)); x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy), i = (y * w + x) * 4;
      if (d > r + 1) continue;
      const a = Math.min(1, r + 1 - d);
      [48, 59, 230].forEach((c, k) => { bmp[i + k] = Math.round(bmp[i + k] * (1 - a) + c * a); }); // rouge (BGRA)
      bmp[i + 3] = Math.max(bmp[i + 3], Math.round(255 * a));
    }
  }
  if (!text) return;
  const chars = String(text).split('');
  const gap = 1, cols = chars.length * 5 + (chars.length - 1) * gap;
  const scale = Math.max(1, Math.floor(Math.min((r * 1.25) / 7, (r * 1.5) / cols)));
  const tw = cols * scale, th = 7 * scale;
  const x0 = Math.round(cx - tw / 2), y0 = Math.round(cy - th / 2);
  chars.forEach((ch, n) => {
    const g = GLYPHS[ch]; if (!g) return;
    for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) {
      if (g[gy][gx] !== '1') continue;
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
        const x = x0 + (n * (5 + gap) + gx) * scale + sx, y = y0 + gy * scale + sy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = (y * w + x) * 4;
        bmp[i] = bmp[i + 1] = bmp[i + 2] = 255; bmp[i + 3] = 255;
      }
    }
  });
}
const badgeText = n => (n > 9 ? '9+' : String(n));

// macOS sans signature Apple : nombre dessiné sur l'icône du Dock.
let dockBase = null, dockShown = -1;
function setDockBadge(n) {
  if (!app.dock || n === dockShown) return;
  dockShown = n;
  if (!dockBase) dockBase = nativeImage.createFromPath(path.join(ROOT, 'public', 'icon.png'));
  if (!n) { app.dock.setIcon(dockBase); return; }
  const s = dockBase.getSize(), bmp = Buffer.from(dockBase.toBitmap());
  const r = s.width * 0.19;
  paintBadge(bmp, s.width, s.height, s.width - r - s.width * 0.02, r + s.height * 0.02, r, badgeText(n));
  app.dock.setIcon(nativeImage.createFromBitmap(bmp, { width: s.width, height: s.height }));
}

// Windows : overlay de la barre des tâches avec le nombre (32 px : net aussi sur écran haute densité).
const overlays = new Map();
function badgeIcon(n) {
  const t = badgeText(n);
  if (overlays.has(t)) return overlays.get(t);
  const size = 32, buf = Buffer.alloc(size * size * 4);
  paintBadge(buf, size, size, 16, 16, 15, t);
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size });
  overlays.set(t, img);
  return img;
}

// ---------------------------------------------------------------- barre des tâches / de menus
function loginItem() { return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin; }
function setLoginItem(on) { app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true, args: ['--hidden'] }); }

let refreshTray = () => { };
function updateMenuItems() {
  const st = updates?.state; if (!st) return [];
  if (st.status === 'ready') return [{ label: `Redémarrer pour installer la version ${st.version}`, click: () => updates.install() }, { type: 'separator' }];
  if (st.status === 'available') return [{ label: `Télécharger la version ${st.version}…`, click: () => updates.install() }, { type: 'separator' }];
  if (st.status === 'downloading') return [{ label: `Téléchargement de la version ${st.version || ''}… ${st.progress ? st.progress + ' %' : ''}`, enabled: false }, { type: 'separator' }];
  return [];
}
function buildTray() {
  const img = nativeImage.createFromPath(path.join(ROOT, 'public', 'icon.png')).resize({ width: IS_MAC ? 18 : 16, height: IS_MAC ? 18 : 16 });
  tray = new Tray(img);
  tray.setToolTip('Claude Sessions');
  const STATE = { working: '🟠', attention: '🔴', idle: '🟢', starting: '⚪', exited: '⚫' };
  const LABEL = { working: 'travaille', attention: 'attend ta réponse', idle: 'prête', starting: 'démarre', exited: 'arrêtée' };
  let lastSessions = [];
  const sessionItems = () => {
    const list = lastSessions.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    if (!list.length) return [];
    const items = list.slice(0, 12).map(s => ({
      label: `${STATE[s.status] || '•'}  ${s.name.length > 40 ? s.name.slice(0, 39) + '…' : s.name}   —  ${LABEL[s.status] || s.status}`,
      click: () => send(`select:${s.id}`),
    }));
    if (list.length > 12) items.push({ label: `… et ${list.length - 12} autre(s)`, click: showWindow });
    return [{ label: 'Sessions', enabled: false }, ...items, { type: 'separator' }];
  };
  const menu = () => Menu.buildFromTemplate([
    ...sessionItems(),
    { label: 'Ouvrir Claude Sessions', click: showWindow },
    { label: IS_MAC ? 'Réduire dans la barre des menus' : 'Réduire dans la zone de notification', click: () => toTray(true), visible: !!win && win.isVisible() },
    ...updateMenuItems(),
    { label: 'Nouvelle session…', click: () => send('new') },
    { label: 'Historique…', click: () => send('history') },
    { label: 'Réglages…', click: () => send('settings') },
    { type: 'separator' },
    { label: 'Rechercher des mises à jour', click: () => updates?.check(), visible: !!updates && app.isPackaged },
    { label: 'Lancer au démarrage de l’ordinateur', type: 'checkbox', checked: loginItem(), click: i => setLoginItem(i.checked), visible: !process.windowsStore }, // version Store : non géré par l'app
    { label: 'Recharger la fenêtre', click: reloadWindow },
    { label: 'Redémarrer le serveur (les sessions reviennent)', click: async () => { await stopServer(); await ensureServer(); win?.loadURL(URL_); } },
    { type: 'separator' },
    updates?.readyOnQuit?.()
      ? { label: `Quitter et installer la version ${updates.state.version} (les sessions reprennent au prochain lancement)`, click: quitApp }
      : { label: 'Quitter (les sessions continuent)', click: quitApp },
    { label: 'Quitter et arrêter toutes les sessions', click: async () => { quitting = true; await stopServer(); quitApp(); } },
  ]);
  // Menu reconstruit à chaque ouverture (état des sessions à jour).
  const popup = async () => { lastSessions = (await serverGet('/api/sessions')) || []; tray.popUpContextMenu(menu()); };
  refreshTray = () => { if (IS_MAC) tray.setContextMenu(menu()); };
  if (IS_MAC) { tray.setContextMenu(menu()); tray.on('mouse-enter', async () => { lastSessions = (await serverGet('/api/sessions')) || []; tray.setContextMenu(menu()); }); }
  else {
    tray.on('click', () => (win && win.isVisible() && win.isFocused() ? toTray() : showWindow())); // clic = afficher / masquer
    tray.on('right-click', popup);
  }
  tray.on('double-click', showWindow);
  refreshTrayIcon();
  setInterval(refreshTrayIcon, 15000);
}

// Libellés des menus natifs selon la langue du système (la page, elle, suit le réglage « Langue »).
const L = (fr, en) => (/^fr/i.test(app.getLocale() || '') ? fr : en);
function buildAppMenu() {
  if (!IS_MAC) { Menu.setApplicationMenu(null); return; } // Windows : pas de barre de menus
  // macOS : menu requis pour Cmd+C/V/X/A/Q dans les champs.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu', submenu: [{ role: 'about', label: L('À propos de Claude Sessions', 'About Claude Sessions') }, { type: 'separator' }, { role: 'hide', label: L('Masquer Claude Sessions', 'Hide Claude Sessions') }, { role: 'hideOthers', label: L('Masquer les autres', 'Hide Others') }, { role: 'unhide', label: L('Tout afficher', 'Show All') }, { type: 'separator' },
      { label: L('Quitter (les sessions continuent)', 'Quit (sessions keep running)'), accelerator: 'Cmd+Q', click: quitApp }] },
    { label: L('Fichier', 'File'), submenu: [{ label: L('Nouvelle session…', 'New session…'), accelerator: 'Cmd+N', click: () => send('new') }, { label: L('Historique…', 'History…'), accelerator: 'Cmd+Shift+H', click: () => send('history') }, { label: L('Réglages…', 'Settings…'), accelerator: 'Cmd+,', click: () => send('settings') }, { type: 'separator' }, { role: 'close', label: L('Fermer la fenêtre', 'Close Window') }] },
    // Édition et Fenêtre construits à la main : les menus prédéfinis d'Electron restent en anglais
    { label: L('Édition', 'Edit'), submenu: [
      { role: 'undo', label: L('Annuler', 'Undo') }, { role: 'redo', label: L('Rétablir', 'Redo') }, { type: 'separator' },
      { role: 'cut', label: L('Couper', 'Cut') }, { role: 'copy', label: L('Copier', 'Copy') }, { role: 'paste', label: L('Coller', 'Paste') },
      { role: 'pasteAndMatchStyle', label: L('Coller et adapter le style', 'Paste and Match Style') }, { role: 'delete', label: L('Supprimer', 'Delete') },
      { role: 'selectAll', label: L('Tout sélectionner', 'Select All') }] },
    { label: L('Présentation', 'View'), submenu: [{ label: L('Recharger', 'Reload'), accelerator: 'Cmd+R', click: reloadWindow }, { role: 'togglefullscreen', label: L('Plein écran', 'Toggle Full Screen') }] },
    { label: L('Fenêtre', 'Window'), role: 'window', submenu: [
      { role: 'minimize', label: L('Réduire', 'Minimize') }, { label: L('Réduire dans la barre des menus', 'Hide to Menu Bar'), click: () => toTray(true) }, { role: 'zoom', label: L('Zoom', 'Zoom') }, { type: 'separator' },
      { role: 'front', label: L('Tout ramener au premier plan', 'Bring All to Front') }] },
  ]));
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---------------------------------------------------------------- cycle de vie
// Quitter : une version prête s'installe au passage (le serveur est arrêté proprement, les sessions reprennent au
// prochain lancement, sur la nouvelle version) ; sinon l'app se ferme et les sessions continuent.
async function quitApp() {
  quitting = true;
  if (await updates?.installOnQuit?.()) return;
  app.quit();
}
app.on('second-instance', showWindow);
app.on('activate', showWindow); // clic sur l'icône du Dock
app.on('before-quit', () => { quitting = true; saveState(); });
app.on('window-all-closed', e => e.preventDefault()); // reste dans la barre des tâches / de menus
// GPU tué (mémoire saturée) : Electron le relance, mais la fenêtre peut rester noire.
app.on('child-process-gone', (e, d) => { if (d.type === 'GPU' && d.reason !== 'clean-exit') recoverWindow(`GPU arrêté (${d.reason})`); });
app.on('web-contents-created', (e, wc) => { wc.on('will-attach-webview', ev => ev.preventDefault()); });

app.whenReady().then(async () => {
  // mise en veille (capot fermé) ou extinction : ce qui n'est pas encore parti est envoyé avant la coupure
  for (const ev of ['suspend', 'shutdown', 'lock-screen']) powerMonitor.on(ev, () => { serverPost('/api/sync/now'); });
  hardenSession();
  registerIpc();
  buildAppMenu();
  if (!process.env.CSM_HIDE_WINDOW) buildTray();
  // Premier lancement : démarrage automatique activé (désactivable dans le menu de l'icône).
  const firstRun = path.join(DATA, 'app-first-run');
  if (app.isPackaged && !process.windowsStore && PORT === 7890 && !fs.existsSync(firstRun)) { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(firstRun, new Date().toISOString()); setLoginItem(true); }
  if (!(await ensureServer())) {
    (process.env.CSM_HIDE_WINDOW ? (t, m) => console.error(m) : dialog.showErrorBox)('Claude Sessions', `Le serveur local ne démarre pas.\n\nJournal : ${path.join(DATA, 'server.log')}`);
  }
  createWindow();
  // module des mises à jour : s'il plante au lancement, l'erreur est écrite dans update.log (3.59.1 à 3.64.3, une
  // erreur silencieuse ici a bloqué toutes les mises à jour)
  try { updates = setupUpdates(); } catch (e) { updLog(`[maj] module des mises à jour indisponible : ${e.stack || e.message}`); }
});
function setupUpdates() {
  return require('./updater')({
    enabled: async () => ((await serverGet('/api/settings')) || {}).autoUpdate !== false,
    // redémarrage automatique : réglage actif, aucune session au travail, et fenêtre réduite / cachée
    // en arrière-plan ou ordinateur inactif depuis 5 min
    canRestart: async () => {
      const why = await (async () => {
        if (((await serverGet('/api/settings')) || {}).autoRestart === false) return 'réglage désactivé';
        if (!windowAway() && powerMonitor.getSystemIdleTime() < 300) return 'fenêtre au premier plan et ordinateur utilisé';
        const list = await serverGet('/api/sessions');
        if (!Array.isArray(list)) return 'serveur local injoignable';
        const busy = list.filter(s => s.alive && s.status === 'working');
        return busy.length ? `session au travail : ${busy.map(s => s.name || s.id).join(', ').slice(0, 200)}` : '';
      })();
      if (why !== lastWhy) { lastWhy = why; if (why) updLog(`[maj] installation automatique en attente : ${why}`); }
      return !why;
    },
    beforeInstall: async ({ auto } = {}) => {
      // installée en arrière-plan : l'app revient cachée, sans passer devant ce que tu fais
      if (auto && windowAway()) { try { fs.writeFileSync(HIDDEN_ONCE, '1'); } catch { } }
      await stopServer(); },
    onState: st => { refreshTray(); if (win && !win.isDestroyed()) win.webContents.send('csm:update-state', st); },
    log: updLog,
  });
}
