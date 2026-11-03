'use strict';
// Mises à jour automatiques (#3). Authenticité : latest*.yml doit être signé par la clé du projet (update-verify.js) ;
// une version publiée sans cette signature n'est ni téléchargée (Windows) ni installée (macOS).
// Windows : electron-updater (GitHub Releases) — téléchargement en arrière-plan, installation au redémarrage.
// macOS : Squirrel.Mac exige une app signée par Apple → mise à jour maison : téléchargement du .dmg de
// l'architecture (empreinte sha512 vérifiée contre latest-mac.yml), copie de l'app dans un dossier d'attente,
// puis au redémarrage un petit script remplace l'app et la relance (mot de passe demandé seulement si le
// dossier de l'app n'est pas modifiable). En cas d'échec : lien vers la release, comme avant.
// Sur les deux systèmes, une version prête s'installe seule (redémarrage compris) dès que canRestart() le permet :
// réglage actif, aucune session au travail, fenêtre réduite / cachée ou ordinateur inactif. Les sessions sont restaurées au redémarrage.
// Quitter l'app avec une version prête l'installe (sans relancer l'app) ; une version prête trouvée au lancement
// (téléchargée avant, ou dans les 3 premières minutes) s'installe tout de suite, sans rien demander.
// « Plus tard » (bulle de mise à jour) : cette version ne s'installe plus seule jusqu'au prochain lancement de l'app ;
// elle reste installable à tout moment (Réglages › À propos, menu de l'icône). Une version plus récente repropose.
const { app, net, shell, Notification } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { signedByProject, sha512Of } = require('./update-verify');

const REPO = 'vantaflow/claude-sessions-manager';
const EVERY = 30 * 60e3; // assez souvent pour qu'une app laissée ouverte en arrière-plan trouve la nouvelle version le jour même

// version publiée : x.y.z strict (elle finit dans des chemins, des messages et le script d'installation macOS)
const VERSION = /^\d+\.\d+\.\d+$/;
const validVersion = v => (VERSION.test(String(v || '').replace(/^v/, '')) ? String(v).replace(/^v/, '') : null);

// requête avec délai : sans réponse (réseau pas encore prêt au réveil, connexion qui pend), elle échoue au lieu
// d'attendre pour toujours — une vérification restée en suspens bloquait toutes les suivantes (« Recherche de mises
// à jour… » sans fin, plus aucune mise à jour proposée)
const fetchT = (u, opts = {}, ms = 30e3) => net.fetch(u, { ...opts, signal: AbortSignal.timeout(ms) });

function newer(a, b) { // a > b ?
  const pa = String(a).replace(/^v/, '').split('.').map(Number), pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

module.exports = function setupUpdater({ enabled, canRestart = async () => false, beforeInstall, onState, log }) {
  const state = { status: 'idle', version: null, url: `https://github.com/${REPO}/releases/latest`, error: null };
  const BOOT = Date.now();
  let atLaunch = () => { };
  let readyVersion = null; // Windows : version téléchargée (update-downloaded)
  let hasReady = () => !!readyVersion;
  const set = patch => {
    // version déjà prête : une vérification suivante (en cours, sans nouveauté, en erreur) ne la fait pas oublier
    if (state.status === 'ready' && ['checking', 'uptodate', 'error'].includes(patch.status) && hasReady()) {
      if (patch.error) log(`[maj] ${patch.error} (version ${state.version} toujours prête)`);
      patch = { ...patch }; delete patch.status; delete patch.error;
    }
    if (patch.status && patch.status !== state.status && patch.status !== 'checking') log(`[maj] ${patch.status}${patch.version || state.version ? ' ' + (patch.version || state.version) : ''}${patch.error ? ' : ' + patch.error : ''}`);
    const nowReady = patch.status === 'ready' && state.status !== 'ready';
    Object.assign(state, patch); onState({ ...state });
    if (nowReady && Date.now() - BOOT < 3 * 60e3) setTimeout(() => atLaunch(), 0);
  };
  if (!app.isPackaged) { set({ status: 'dev' }); return { state, check: async () => { }, install: () => { } }; }
  // Version Microsoft Store : c'est le Store qui installe les mises à jour.
  if (process.windowsStore) { set({ status: 'store' }); return { state, check: async () => { }, install: () => shell.openExternal('ms-windows-store://downloadsandupdates'), onFocus: () => { } }; }

  let updater = null;
  if (process.platform === 'win32') {
    try {
      ({ autoUpdater: updater } = require('electron-updater'));
      updater.autoDownload = false; // téléchargée seulement après vérification de la signature (verifiedWin)
      updater.autoInstallOnAppQuit = false; // on installe seulement sur demande (sessions redémarrées proprement)
      updater.logger = { info: m => log(`[maj] ${m}`), warn: m => log(`[maj] ${m}`), error: m => log(`[maj] ${m}`), debug: () => { } };
      updater.on('checking-for-update', () => set({ status: 'checking', error: null }));
      updater.on('update-not-available', () => set({ status: 'uptodate' }));
      updater.on('update-available', i => {
        const v = validVersion(i?.version);
        if (!v) return set({ status: 'error', error: `version invalide : ${String(i?.version).slice(0, 40)}` });
        if (v !== readyVersion) readyVersion = null; // une plus récente remplace celle qui était prête
        // latest.yml signé par la clé du projet, et même empreinte d'installeur que celle annoncée à electron-updater
        verifiedWin(v, i).then(() => { set({ status: 'downloading', version: v }); return updater.downloadUpdate(); })
          .catch(e => { log(`[maj] ${v} refusée : ${e.message}`); set({ status: 'error', error: `mise à jour refusée : ${e.message}` }); });
      });
      updater.on('download-progress', p => set({ status: 'downloading', progress: Math.round(p.percent) }));
      updater.on('update-downloaded', i => {
        const v = validVersion(i?.version);
        if (!v) return set({ status: 'error', error: `version invalide : ${String(i?.version).slice(0, 40)}` });
        readyVersion = v;
        set({ status: 'ready', version: v });
        if (Date.now() - BOOT > 3 * 60e3 && Notification.isSupported()) new Notification({ title: 'Claude Sessions', body: `Version ${v} prête : elle s'installera toute seule dès que la fenêtre sera en arrière-plan, ou en quittant l'application.` }).show();
      });
      updater.on('error', e => set({ status: 'error', error: String(e && e.message || e).slice(0, 300) }));
    } catch (e) { log(`[maj] electron-updater indisponible : ${e.message}`); updater = null; }
  }

  // ---------------------------------------------------------------- macOS
  const STAGE = path.join(app.getPath('userData'), 'update');
  const bundle = () => { const b = path.resolve(process.execPath, '..', '..', '..'); return b.endsWith('.app') ? b : null; };
  const sh = (cmd, args, opts = {}) => new Promise((res, rej) => execFile(cmd, args, { timeout: 5 * 60e3, ...opts }, (e, out, err) => e ? rej(new Error(String(err || e.message).trim().slice(0, 300))) : res(out)));
  let staged = null; // { version, app } : nouvelle version prête à installer
  if (process.platform === 'darwin') hasReady = () => !!(staged && fs.existsSync(staged.app));
  let busy = false;

  // latest*.yml d'une version, vérifié : signé par la clé du projet (electron/update-key.js), sinon refusé
  const RELEASES = (() => { const p = require('../package.json').build.publish[0]; return `https://github.com/${p.owner}/${p.repo}/releases/download`; })();
  async function signedYml(version, name) {
    const get = async u => { const r = await fetchT(u); if (!r.ok) throw new Error(`${path.basename(u)} : HTTP ${r.status}`); return r.text(); };
    const [text, sig] = await Promise.all([get(`${RELEASES}/v${version}/${name}`), get(`${RELEASES}/v${version}/${name}.sig`).catch(() => '')]);
    if (!sig) throw new Error('version non signée');
    if (!signedByProject(text, sig)) throw new Error('signature invalide');
    return text;
  }
  async function verifiedWin(version, info) {
    const yml = await signedYml(version, 'latest.yml');
    const files = (info?.files || []).filter(f => f && f.url && f.sha512);
    if (!files.length) throw new Error('aucun installeur annoncé');
    for (const f of files) if (sha512Of(yml, f.url) !== f.sha512) throw new Error(`empreinte non signée : ${f.url}`);
  }

  async function download(url, file, total) {
    const r = await fetchT(url, {}, 10 * 60e3); // .dmg : téléchargement long
    if (!r.ok) throw new Error(`téléchargement : HTTP ${r.status}`);
    const hash = crypto.createHash('sha512'), out = fs.createWriteStream(file);
    let got = 0, shown = -1;
    const reader = r.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value); got += value.length;
        if (!out.write(Buffer.from(value))) await new Promise(res => out.once('drain', res));
        const p = total ? Math.floor(got * 100 / total) : 0;
        if (p !== shown && p % 5 === 0) { shown = p; set({ progress: p }); }
      }
    } finally { await new Promise(res => out.end(res)); }
    return hash.digest('base64');
  }

  async function stage(rel, version) {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const dmg = rel.assets.find(a => a.name.endsWith(`-${arch}.dmg`));
    const yml = rel.assets.find(a => a.name === 'latest-mac.yml');
    if (!dmg || !yml) throw new Error(`pas de .dmg ${arch} dans la release`);
    const sha = sha512Of(await signedYml(version, 'latest-mac.yml'), dmg.name); // signé par la clé du projet
    if (!sha) throw new Error('empreinte absente de latest-mac.yml');
    staged = null; // le dossier d'attente est vidé : l'ancienne version prête n'existe plus
    fs.rmSync(STAGE, { recursive: true, force: true });
    fs.mkdirSync(STAGE, { recursive: true });
    const file = path.join(STAGE, dmg.name), mnt = path.join(STAGE, 'mnt'), dest = path.join(STAGE, version);
    set({ status: 'downloading', version, progress: 0 });
    if (await download(dmg.browser_download_url, file, dmg.size) !== sha) throw new Error('empreinte du téléchargement invalide');
    fs.mkdirSync(mnt);
    await sh('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, file]);
    try {
      const name = fs.readdirSync(mnt).find(f => f.endsWith('.app'));
      if (!name) throw new Error('aucune application dans le .dmg');
      fs.mkdirSync(dest);
      await sh('ditto', [path.join(mnt, name), path.join(dest, name)]);
      staged = { version, app: path.join(dest, name) };
    } finally { await sh('hdiutil', ['detach', mnt, '-force']).catch(() => { }); }
    fs.rmSync(file, { force: true });
    await sh('xattr', ['-cr', staged.app]).catch(() => { }); // pas de quarantaine : l'app se relance sans alerte
  }

  let busyAt = 0;
  async function checkMac() {
    // filet : une vérification en cours depuis plus de 20 min est considérée comme perdue
    if (busy && Date.now() - busyAt < 20 * 60e3) return;
    busy = true; busyAt = Date.now();
    set({ status: 'checking', error: null });
    let rel = null;
    try {
      const r = await fetchT(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
      rel = await r.json();
      const version = validVersion(rel.tag_name);
      if (!version || !newer(version, app.getVersion())) { set({ status: 'uptodate' }); return; }
      set({ url: rel.html_url, version });
      if (!(staged && staged.version === version && fs.existsSync(staged.app))) {
        if (!bundle()) throw new Error('emplacement de l’application inconnu');
        await stage(rel, version);
      }
      set({ status: 'ready', version, progress: null });
      if (Date.now() - BOOT > 3 * 60e3 && Notification.isSupported()) new Notification({ title: 'Claude Sessions', body: `Version ${version} prête : elle s'installera toute seule dès que la fenêtre sera en arrière-plan, ou en quittant l'application.` }).show();
    } catch (e) {
      log(`[maj] ${e.message}`);
      // repli : lien vers la release
      const v = validVersion(rel?.tag_name);
      if (hasReady()) set({ version: staged.version, progress: null }); // la version prête reste celle affichée
      if (v && newer(v, app.getVersion()) && !hasReady()) set({ status: 'available', version: v, url: rel.html_url, error: e.message, progress: null });
      else set({ status: 'error', error: e.message });
    } finally { busy = false; }
  }

  // Remplace l'app une fois celle-ci fermée, puis la relance.
  // Trois cas, du plus simple au plus contraint :
  //  - dossier parent modifiable (ex. ~/Applications, ou /Applications pour un administrateur) : app remplacée ;
  //  - app modifiable mais pas son dossier : son contenu (Contents) est remplacé sur place, sans mot de passe ;
  //  - sinon (app installée par un autre compte) : mot de passe demandé UNE fois, et l'app est rendue à
  //    l'utilisateur (chown) : les mises à jour suivantes passent par le cas précédent.
  const canWrite = p => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } };
  const macMode = dest => (canWrite(path.dirname(dest)) && canWrite(dest) ? 'replace'
    : canWrite(dest) && canWrite(path.join(dest, 'Contents')) ? 'inplace' : 'admin');
  async function installMac(auto, relaunch = true) {
    const dest = bundle();
    await beforeInstall({ auto });
    const mode = macMode(dest), who = os.userInfo().username.replace(/[^\w.-]/g, '');
    log(`[maj] installation macOS : ${mode}`);
    const steps = {
      replace: 'rm -rf "$CSM_DEST.old"; mv "$CSM_DEST" "$CSM_DEST.old" && if ditto "$CSM_SRC" "$CSM_DEST"; then rm -rf "$CSM_DEST.old"; else rm -rf "$CSM_DEST"; mv "$CSM_DEST.old" "$CSM_DEST"; fi',
      inplace: 'rm -rf "$CSM_DEST/Contents.old"; mv "$CSM_DEST/Contents" "$CSM_DEST/Contents.old" && if ditto "$CSM_SRC/Contents" "$CSM_DEST/Contents"; then rm -rf "$CSM_DEST/Contents.old"; else rm -rf "$CSM_DEST/Contents"; mv "$CSM_DEST/Contents.old" "$CSM_DEST/Contents"; fi',
      admin: `osascript -e "do shell script \"rm -rf '$CSM_DEST' && ditto '$CSM_SRC' '$CSM_DEST' && chown -R ${who}:staff '$CSM_DEST' && xattr -cr '$CSM_DEST'\" with prompt \"Claude Sessions installe la version ${staged.version}. Mot de passe demandé une seule fois : les prochaines mises à jour s'installeront sans.\" with administrator privileges"`,
    };
    const script = [
      'while kill -0 "$CSM_PID" 2>/dev/null; do sleep 0.3; done',
      steps[mode],
      'xattr -cr "$CSM_DEST" 2>/dev/null',
      'rm -rf "$CSM_STAGE"',
      '[ -n "$CSM_NO_OPEN" ] || open "$CSM_DEST"',
    ].join('\n');
    const out = path.join(os.tmpdir(), 'csm-update.log'), fd = fs.openSync(out, 'a');
    spawn('/bin/sh', ['-c', script], {
      detached: true, stdio: ['ignore', fd, fd],
      env: { ...process.env, CSM_PID: String(process.pid), CSM_SRC: staged.app, CSM_DEST: dest, CSM_STAGE: STAGE, CSM_NO_OPEN: relaunch ? '' : '1' },
    }).unref();
    fs.closeSync(fd); // le script garde sa propre copie
    app.quit();
  }

  async function check() {
    if (!(await enabled())) { set({ status: 'disabled' }); return; }
    if (updater) { // Windows : même délai (sans réponse, l'état restait « recherche… »)
      try { await Promise.race([updater.checkForUpdates(), new Promise((_, rej) => setTimeout(() => rej(new Error('pas de réponse de GitHub (réessai dans 30 min)')), 60e3))]); }
      catch (e) { set({ status: 'error', error: e.message }); }
    }
    else await checkMac();
  }

  async function install(auto = false, relaunch = true) {
    if (process.platform === 'darwin' && state.status === 'ready' && staged && bundle()) return installMac(auto, relaunch);
    if (updater && state.status === 'ready') {
      await beforeInstall({ auto }); // arrêt propre du serveur : il redémarre avec le nouveau code, sessions restaurées
      updater.quitAndInstall(true, relaunch);
    } else shell.openExternal(state.url);
  }

  // au lancement, toutes les 30 min, et au retour sur la fenêtre si la dernière vérification date de plus d'une heure
  let last = 0;
  const run = () => { last = Date.now(); return check(); };
  setTimeout(run, 3e3); // tôt : une version déjà téléchargée s'installe dès le lancement
  setInterval(run, EVERY);
  // Installation automatique : vérifiée chaque minute tant qu'une version est prête.
  // Sur macOS, seulement si l'app peut être remplacée sans mot de passe (sinon personne n'est là pour le taper).
  let installing = false;
  setInterval(async () => {
    if (installing || state.status !== 'ready' || state.later === state.version) return;
    if (process.platform === 'darwin' && !(staged && bundle() && macMode(bundle()) !== 'admin')) return; // (3.24 → 3.46 : macWritable inexistant, l'installation automatique ne partait jamais)
    try {
      if (!(await enabled()) || !(await canRestart())) return;
      installing = true;
      log(`[maj] installation automatique de la version ${state.version}`);
      await install(true);
    } catch (e) { installing = false; log(`[maj] installation automatique : ${e.message}`); }
  }, 60e3);
  // installable sans personne pour taper un mot de passe (macOS : app modifiable par l'utilisateur)
  const silentOk = () => state.status === 'ready' && (process.platform !== 'darwin' || !!(staged && bundle() && macMode(bundle()) !== 'admin'));
  atLaunch = async () => {
    if (installing || !silentOk()) return;
    try {
      if (!(await enabled())) return;
      installing = true;
      log(`[maj] version ${state.version} prête au lancement : installation tout de suite`);
      await install(false);
    } catch (e) { installing = false; log(`[maj] installation au lancement : ${e.message}`); }
  };
  // Quitter : la version prête s'installe, l'app ne se relance pas (les sessions reprendront au prochain lancement).
  const installOnQuit = async () => {
    if (installing || !silentOk() || !(await enabled().catch(() => false))) return false;
    installing = true;
    log(`[maj] installation de la version ${state.version} en quittant`);
    try { await install(false, false); return true; } catch (e) { installing = false; log(`[maj] installation en quittant : ${e.message}`); return false; }
  };
  const onFocus = () => { if (Date.now() - last > 3600e3 && state.status !== 'ready' && state.status !== 'downloading') run(); };
  const postpone = () => { if (state.version) { log(`[maj] version ${state.version} reportée (Plus tard)`); set({ later: state.version }); } };
  return { state, check: run, install, onFocus, postpone, installOnQuit, readyOnQuit: silentOk };
};
