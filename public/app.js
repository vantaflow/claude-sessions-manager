'use strict';
document.documentElement.dataset.boot = '1'; // script lancé (surveillance du démarrage, electron/main.js)
const $ = s => document.querySelector(s);
const TOKEN = document.querySelector('meta[name="csm-token"]').content;
const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent);
const LS = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } } };
// Page chargée pendant un redémarrage du serveur (mise à jour) : le terminal (xterm) n'a pas pu se charger.
// On recharge la page dès que le serveur répond, au lieu de laisser « Terminal is not defined » à la création.
if (typeof Terminal === 'undefined' || typeof FitAddon === 'undefined') {
  const n = Number(sessionStorage.getItem('csm.reloadXterm') || 0);
  if (n < 5) { sessionStorage.setItem('csm.reloadXterm', String(n + 1)); setTimeout(() => location.reload(), 1500 * (n + 1)); }
} else sessionStorage.removeItem('csm.reloadXterm');

const sessions = new Map(); // id -> public view
const terms = new Map();    // id -> { term, fit, el }
let active = LS.get('csm.active', null);
let ws = null;
let historyCache = [];

const STATUS_LABEL = { starting: t('démarrage'), working: t('travaille'), attention: t('attend une réponse'), idle: t('prêt'), exited: t('arrêtée') };

// Réglages (serveur) : voir lib/settings.js. Valeurs par défaut en attendant la réponse.
let SETTINGS = { theme: 'system', fontSize: 14, fontFamily: '', defaultModel: 'opus', defaultMode: '', notifications: true, sound: 'off', dnd: false, waitingMinutes: 10, longRunMinutes: 0, worktreeDefault: false, compactSidebar: false, autoUpdate: true, autoRestart: true, syncMinutes: 5, onboarded: true };
const THEMES = {
  // refonte Atelier : fond graphite / ivoire, curseur argile
  dark: { background: '#0e0f11', foreground: '#d6d3cc', cursor: '#d97757', cursorAccent: '#0e0f11', selectionBackground: '#34363c' },
  light: { background: '#fbfaf8', foreground: '#2a2a2d', cursor: '#b8552f', cursorAccent: '#fbfaf8', selectionBackground: '#e2dfd8', black: '#1c1c1e', brightBlack: '#5e6168', white: '#8a8d93', brightWhite: '#1c1c1e', yellow: '#9a6b00', brightYellow: '#8a5a00', green: '#1f7a3f', brightGreen: '#1a6b36', cyan: '#0e6f86', brightCyan: '#0b5f73', blue: '#1f5fbf', brightBlue: '#1a4fa0', magenta: '#8a3fa0', brightMagenta: '#7a2f90', red: '#c0392b', brightRed: '#a93226' },
};
const themeName = () => SETTINGS.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : SETTINGS.theme;
const termTheme = () => THEMES[themeName()] || THEMES.dark;
// Claude Code colore le code et les diffs en RVB pour son thème sombre : en thème clair, le terminal éclaircit ou
// fonce toute couleur trop proche du fond (contraste minimal WCAG AA), sans toucher au thème de Claude Code.
const termContrast = () => (themeName() === 'light' ? 4.5 : 1);
// Claude Code efface l'écran et l'historique de défilement (ESC[2J ESC[3J) à la compaction et à /clear : on garde
// l'historique (ESC[3J ignoré, l'écran effacé part dans le défilement au lieu de disparaître). Réglage keepScrollback.
const keepScrollback = () => SETTINGS.keepScrollback !== false;
const termData = d => (keepScrollback() && d.includes('\x1b[3J') ? d.replaceAll('\x1b[3J', '') : d);
function applySettings() {
  document.documentElement.dataset.theme = themeName();
  document.body.classList.toggle('compact', !!SETTINGS.compactSidebar);
  { // le bouton dit ce qu'il fera : réduire, ou déplier (flèche retournée en CSS)
    const b = $('#btnCompact'), l = SETTINGS.compactSidebar ? t('Déplier la barre latérale') : t('Réduire la barre latérale');
    if (b) { b.title = l; b.setAttribute('aria-label', l); b.setAttribute('aria-pressed', SETTINGS.compactSidebar ? 'true' : 'false'); }
  }
  window.csmNative?.setPrefs?.({ closeToTray: SETTINGS.closeToTray !== false });
  for (const tt of terms.values()) {
    tt.term.options.theme = termTheme();
    tt.el.style.setProperty('--term-bg', termTheme().background);
    tt.term.options.minimumContrastRatio = termContrast();
    tt.term.options.scrollOnEraseInDisplay = keepScrollback();
    if (SETTINGS.fontFamily) tt.term.options.fontFamily = SETTINGS.fontFamily;
  }
  fitAll(false);
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => SETTINGS.theme === 'system' && applySettings());
async function loadSettings() {
  try { SETTINGS = { ...SETTINGS, ...(await api('GET', '/api/settings')) }; } catch { }
  setLang(SETTINGS.lang); applySettings();
}
// heure courte (reprise après la limite de quota)
const hm = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
async function saveSettings(patch) {
  SETTINGS = { ...SETTINGS, ...patch };
  applySettings();
  try { SETTINGS = await api('PUT', '/api/settings', patch); } catch (e) { toast(t('Réglage non enregistré : ') + e.message, true); }
}

async function api(method, url, body) {
  const r = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json', 'X-CSM-Token': TOKEN, 'X-CSM-Unlock': window.csmUnlockHeader?.() || '' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

// ------------------------------------------------------------------ terminaux
function ensureTerm(id) {
  if (terms.has(id)) return terms.get(id);
  const el = document.createElement('div');
  el.className = 'term';
  $('#park').appendChild(el);
  const term = new Terminal({
    fontFamily: SETTINGS.fontFamily || '"JetBrains Mono", "Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, monospace', fontSize: LS.get('csm.font', SETTINGS.fontSize || 14),
    cursorBlink: true, scrollback: 10000, allowProposedApi: true, macOptionIsMeta: true, scrollOnEraseInDisplay: keepScrollback(),
    theme: termTheme(), minimumContrastRatio: termContrast(),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, '_blank')));
  term.open(el);
  term.onData(d => { send({ t: 'input', id, d }); if (d.includes('\r')) attachmentsSent(id); });
  // aperçu des images jointes (miniatures en haut à droite du terminal)
  const thumbs = document.createElement('div');
  thumbs.className = 'thumbs'; thumbs.hidden = true;
  el.appendChild(thumbs);
  // clic / focus dans un panneau de la vue partagée : ce panneau devient le panneau actif
  term.textarea?.addEventListener('focus', () => {
    const i = panes.indexOf(id);
    if (i >= 0 && id !== active) { focusedPane = i; active = id; LS.set('csm.active', id); unread.delete(id); render(); renderPaneFrames(); }
  });
  // Images / fichiers : glisser-déposer ou coller → copie enregistrée par le serveur, chemin collé dans Claude.
  el.addEventListener('dragover', e => { if (hasFiles(e.dataTransfer)) { e.preventDefault(); el.classList.add('dropping'); } });
  el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('dropping'); });
  el.addEventListener('drop', e => {
    el.classList.remove('dropping');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    attachFiles(id, files);
  });
  el.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
    if (!files.length) return; // texte : xterm s'en charge
    e.preventDefault(); e.stopImmediatePropagation();
    attachFiles(id, files);
  }, true); // phase de capture : avant le gestionnaire de xterm, qui ne garderait que le texte
  // copie (Cmd+C, menu Édition) : texte remis en forme (lignes recollées, retrait et espaces de fin retirés)
  el.addEventListener('copy', e => {
    if (!term.hasSelection() || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', selText(term)); e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && e.altKey && globalShortcut(e)) { e.csmDone = true; return false; } // traité ici : pas une 2e fois par le document
    // Windows : Ctrl+C avec sélection, Ctrl+Maj+C et Ctrl+Inser = copier ; Ctrl+V, Ctrl+Maj+V et Maj+Inser = coller
    // (événement paste natif). macOS : Cmd+C / Cmd+V sont natifs ; Ctrl+C et Ctrl+V restent à Claude (interrompre,
    // coller une image).
    if (!IS_MAC && term.hasSelection() && ((e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'c') || (e.ctrlKey && !e.shiftKey && e.key === 'Insert'))) {
      clip.copy(selText(term)); term.clearSelection(); e.preventDefault(); return false;
    }
    if (!IS_MAC && e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c') { e.preventDefault(); return false; } // rien de sélectionné : pas d'interruption non voulue
    if (!IS_MAC && e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'v') return false; // laisse l'événement paste natif
    if (!IS_MAC && e.shiftKey && !e.ctrlKey && e.key === 'Insert') return false; // idem
    if ((IS_MAC ? e.metaKey : e.ctrlKey) && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0')) { zoom(e.key); e.preventDefault(); return false; }
    return true;
  });
  el.style.setProperty('--term-bg', termTheme().background); // fond de la marge du terminal
  const t = { term, fit, el };
  terms.set(id, t);
  return t;
}

// Rendu GPU (WebGL) pour le terminal affiché seulement : fluide, et un seul contexte WebGL quel que soit
// le nombre de sessions (les navigateurs en limitent le nombre). Repli automatique sur le rendu DOM.
function gpu(t, on) {
  if (on && !t.webgl && window.WebglAddon) {
    try {
      const gl = new WebglAddon.WebglAddon();
      gl.onContextLoss(() => { gl.dispose(); t.webgl = null; });
      t.term.loadAddon(gl); t.webgl = gl;
    } catch { t.webgl = null; }
  } else if (!on && t.webgl) { try { t.webgl.dispose(); } catch { } t.webgl = null; }
}

function zoom(k) {
  let size = LS.get('csm.font', 14);
  size = k === '0' ? 14 : Math.max(9, Math.min(28, size + (k === '-' ? -1 : 1)));
  LS.set('csm.font', size);
  for (const t of terms.values()) t.term.options.fontSize = size;
  fitAll();
}

// redraw=true : force Claude à repeindre tout l'écran (le PTY ne signale un resize que si la taille change,
// d'où l'aller-retour rows-1 → rows). Nécessaire après un changement de session ou une reconnexion,
// car le terminal caché a reçu la sortie à une autre taille.
function fitOne(id, redraw) {
  const t = id && terms.get(id);
  if (!t || !t.el.classList.contains('show')) return;
  try { t.fit.fit(); } catch { }
  // garde-fou : la dernière ligne doit rester visible (police chargée après la mesure, zoom, bandeau qui
  // apparaît…) ; si l'écran du terminal dépasse sa zone, on retire les lignes en trop
  try {
    const over = t.el.querySelector('.xterm-screen').getBoundingClientRect().bottom - t.el.getBoundingClientRect().bottom;
    if (over > 1 && t.term.rows > 5) {
      const cell = t.el.querySelector('.xterm-screen').getBoundingClientRect().height / t.term.rows;
      t.term.resize(t.term.cols, Math.max(5, t.term.rows - Math.ceil(over / cell)));
    }
  } catch { }
  const { cols, rows } = t.term;
  if (!redraw && t.sent === `${cols}x${rows}`) return;
  t.sent = `${cols}x${rows}`;
  if (redraw) send({ t: 'resize', id, cols, rows: rows - 1 });
  setTimeout(() => send({ t: 'resize', id, cols, rows }), redraw ? 80 : 0);
  t.term.refresh(0, rows - 1);
}
function fitAll(redraw) { for (const id of visibleIds()) fitOne(id, redraw); }
const fitActive = redraw => fitOne(active, redraw);
new ResizeObserver(() => requestAnimationFrame(() => fitAll(false))).observe($('#terms'));
// barre de session : on retire les libellés par paliers tant qu'elle déborde ou que le nom n'a plus de place
// (largeur de fenêtre, police et boutons visibles varient : un seuil fixe en pixels ne suffit pas)
function fitBar() {
  const bar = $('#bar'), id = bar.querySelector('.curId');
  bar.classList.remove('fit1', 'fit2', 'fit3', 'fit4');
  const over = () => bar.scrollWidth > bar.clientWidth + 1;
  // libellés retirés aussi pour laisser lire le nom ; message masqué et seconde ligne seulement en cas de débordement
  for (let n = 1; n <= 4 && (over() || (n <= 2 && id && id.clientWidth < 200)); n++) bar.classList.add(`fit${n}`);
}
{
  // minuteur plutôt que requestAnimationFrame : une fenêtre masquée ou couverte (Windows) n'en exécute aucun
  let queued = false;
  const later = () => { if (!queued) { queued = true; setTimeout(() => { queued = false; fitBar(); }, 0); } };
  const ro = new ResizeObserver(later);
  ro.observe($('#bar'));
  for (const el of $('#bar').children) ro.observe(el);
  addEventListener('resize', later);
  // filet : barre qui déborde encore (notification manquée) recalculée
  setInterval(() => { const b = $('#bar'); if (b.scrollWidth > b.clientWidth + 1 && !b.classList.contains('fit4')) fitBar(); }, 3000);
}
// contrôle régulier (fenêtre visible) : un terminal qui déborde de sa zone est réajusté
setInterval(() => {
  if (document.hidden) return;
  for (const id of visibleIds()) {
    const t = terms.get(id); if (!t || !t.el.classList.contains('show')) continue;
    const s = t.el.querySelector('.xterm-screen');
    if (s && s.getBoundingClientRect().bottom - t.el.getBoundingClientRect().bottom > 1) fitOne(id, false);
  }
}, 3000);
const redrawTimers = {};
function scheduleRedraw(id = active) { clearTimeout(redrawTimers[id]); redrawTimers[id] = setTimeout(() => fitOne(id, true), 150); }

// ------------------------------------------------------------------ vue partagée (#11)
// Disposition : 1 panneau, 2 colonnes, 2 lignes ou grille 2×2 ; chaque panneau affiche une session.
const LAYOUTS = { 1: 1, '2c': 2, '2r': 2, 4: 4 };
let layout = LS.get('csm.layout', '1');
let panes = LS.get('csm.panes', []);
let focusedPane = 0;
const paneEls = () => [...$('#terms').querySelectorAll(':scope > .pane')];
const visibleIds = () => panes.slice(0, LAYOUTS[layout] || 1).filter(id => id && sessions.has(id));

function setLayout(l) {
  if (!LAYOUTS[l]) return;
  layout = l; LS.set('csm.layout', l);
  const n = LAYOUTS[l];
  panes = panes.filter(id => sessions.has(id));
  if (active && !panes.slice(0, n).includes(active)) panes = [active, ...panes.filter(x => x !== active)];
  for (const s of sorted()) { if (panes.length >= n) break; if (!panes.includes(s.id)) panes.push(s.id); }
  panes = panes.slice(0, n);
  focusedPane = Math.max(0, panes.indexOf(active));
  renderPanes();
  document.querySelectorAll('[data-layout]').forEach(b => b.classList.toggle('on', b.dataset.layout === l));
}

// petite icône SVG à traits ; `d` = tracés séparés par « | »
function svgIcon(d, size = 14) {
  const NS = 'http://www.w3.org/2000/svg', e = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ class: 'ic', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) e.setAttribute(k, v);
  for (const seg of d.split('|')) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', seg); e.appendChild(p); }
  return e;
}

// bandeau d'aide de la vue partagée (masquable, mémorisé)
function updatePaneHint() {
  const h = $('#paneHint'); if (!h) return;
  h.hidden = (LAYOUTS[layout] || 1) <= 1 || !!LS.get('csm.paneHintOff', false);
}

function renderPaneFrames() {
  updatePaneHint();
  const order = sorted().map(x => x.id);
  paneEls().forEach((p, i) => {
    p.classList.toggle('focused', i === focusedPane && (LAYOUTS[layout] || 1) > 1);
    const s = sessions.get(panes[i]);
    p.querySelector('.phead .dot').className = `dot ${s ? s.status : ''}`;
    p.querySelector('.phead .pn').textContent = s ? s.name : t('(vide — glisser une session ici)');
    p.querySelector('.phead .pb').textContent = s?.worktree ? `⎇ ${s.worktree.branch}` : '';
    p.querySelector('.phead .pnum').textContent = s ? order.indexOf(s.id) + 1 : '';
    p.querySelector('.phead .pnum').hidden = !s;
    const ask = !!(s && window.csmFeatures.paneAsk?.(s.id)); // autorisation en attente : Oui / Toujours / Non
    p.querySelector('.phead .pperm').hidden = !ask;
  });
  window.csmFeatures.lockOverlays?.();
}

function makePane() {
  const p = document.createElement('div');
  p.className = 'pane';
  p.innerHTML = '<div class="phead"><span class="pnum"></span><span class="dot"></span><span class="pn"></span><span class="pb"></span><span class="pperm" hidden></span><button class="pclose">✕</button></div><div class="pslot"></div>';
  p.querySelector('.pclose').title = t('Vider ce panneau');
  for (const [label, choice, cls] of [[t('Oui'), 'yes', 'primary'], [t('Toujours'), 'always', ''], [t('Non'), 'no', 'danger']]) {
    const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = label;
    b.onclick = e => { e.stopPropagation(); const id = panes[paneEls().indexOf(p)]; if (id) window.csmFeatures.answerPerm?.(id, choice); };
    p.querySelector('.pperm').appendChild(b);
  }
  const idx = () => paneEls().indexOf(p);
  p.addEventListener('mousedown', () => { const k = idx(); if (k !== focusedPane) { focusedPane = k; if (panes[k]) select(panes[k]); else renderPaneFrames(); } });
  p.querySelector('.pclose').onclick = e => { e.stopPropagation(); panes[idx()] = null; renderPanes(); };
  p.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('text/csm-session')) { e.preventDefault(); p.classList.add('dragover'); } });
  p.addEventListener('dragleave', () => p.classList.remove('dragover'));
  p.addEventListener('drop', e => {
    const sid = e.dataTransfer.getData('text/csm-session'); p.classList.remove('dragover');
    if (!sid) return; e.preventDefault(); e.stopPropagation();
    const k = idx(), old = panes.indexOf(sid);
    if (old >= 0 && old !== k) panes[old] = panes[k] || null;
    panes[k] = sid; focusedPane = k; select(sid);
  });
  return p;
}

function renderPanes() {
  const n = LAYOUTS[layout] || 1;
  const grid = $('#terms');
  grid.dataset.layout = layout;
  while (paneEls().length < 4) grid.appendChild(makePane());
  paneEls().forEach((p, i) => { p.hidden = i >= n; });
  const shown = new Set(visibleIds());
  for (const [id, tt] of terms) {
    const slot = shown.has(id) ? paneEls()[panes.indexOf(id)].querySelector('.pslot') : $('#park');
    if (tt.el.parentElement !== slot) slot.appendChild(tt.el);
    tt.el.classList.toggle('show', shown.has(id));
    gpu(tt, shown.has(id));
  }
  LS.set('csm.panes', panes);
  renderPaneFrames();
  requestAnimationFrame(() => fitAll(true));
}

// ------------------------------------------------------------------ WebSocket
function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws?token=${TOKEN}`);
  let fresh = true; // 1re liste de cette connexion : suivie d'un replay, les terminaux peuvent être remis à zéro
  ws.onopen = () => { $('#conn').classList.remove('off'); checkServerVersion(); };
  ws.onclose = () => { $('#conn').classList.add('off'); setTimeout(connect, 1500); };
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    window.dispatchEvent(new CustomEvent('csm:ws', { detail: m })); // modules (verrouillage…)
    if (m.t === 'sessions') {
      const ids = new Set(m.list.map(s => s.id));
      for (const id of [...sessions.keys()]) if (!ids.has(id)) removeLocal(id);
      // Liste rediffusée (ordre, etc.) sans replay : ne pas effacer les terminaux existants.
      for (const s of m.list) { const isNew = !terms.has(s.id); sessions.set(s.id, s); const t = ensureTerm(s.id); if (fresh || isNew) t.term.reset(); }
      fresh = false;
      if (!sessions.has(active)) active = sorted()[0]?.id || null;
      render(); select(active); setLayout(layout);
    } else if (m.t === 'replay' || m.t === 'out') {
      ensureTerm(m.id).term.write(termData(m.d));
      if (m.t === 'out' && m.id !== active) bump(m.id);
      if (m.t === 'replay' && visibleIds().includes(m.id)) scheduleRedraw(m.id);
    } else if (m.t === 'clear') {
      terms.get(m.id)?.term.reset();
    } else if (m.t === 'session') {
      const prev = sessions.get(m.s.id);
      sessions.set(m.s.id, m.s);
      ensureTerm(m.s.id);
      notifyTransition(prev, m.s);
      window.dispatchEvent(new CustomEvent('csm:session', { detail: { prev, s: m.s } }));
      render();
      if (!active) select(m.s.id);
      if (m.s.id === active) renderBar();
      if (panes.includes(m.s.id)) renderPaneFrames();
    } else if (m.t === 'settings') {
      const langChanged = m.settings.lang !== SETTINGS.lang;
      SETTINGS = { ...SETTINGS, ...m.settings }; applySettings(); render(); // groupes créés dans une autre fenêtre
      window.dispatchEvent(new CustomEvent('csm:settings')); // Réglages ouverts : champs remis à jour (changement venu d'une autre machine)
      if (langChanged) location.reload();
    } else if (m.t === 'schedules') {
      window.dispatchEvent(new CustomEvent('csm:schedules'));
    } else if (m.t === 'quota') {
      window.dispatchEvent(new CustomEvent('csm:quota'));
    } else if (m.t === 'view') {
      window.dispatchEvent(new CustomEvent('csm:view', { detail: m.id }));
    } else if (m.t === 'extensions') {
      window.dispatchEvent(new CustomEvent('csm:extensions'));
    } else if (m.t === 'auth') {
      window.dispatchEvent(new CustomEvent('csm:auth', { detail: m }));
    } else if (m.t === 'sync') {
      window.dispatchEvent(new CustomEvent('csm:sync', { detail: m.status }));
    } else if (m.t === 'memai') {
      window.dispatchEvent(new CustomEvent('csm:memai', { detail: m.id })); // onglet Mémoire du panneau
    } else if (m.t === 'templates' || m.t === 'prompts') {
      window.dispatchEvent(new CustomEvent(`csm:${m.t}`, { detail: m[m.t] }));
    } else if (m.t === 'removed') {
      removeLocal(m.id);
      panes = panes.map(x => (x === m.id ? null : x));
      if (active === m.id) active = visibleIds()[0] || sorted()[0]?.id || null;
      render(); select(active);
    }
  };
}

function removeLocal(id) {
  sessions.delete(id);
  const t = terms.get(id);
  if (t) { t.term.dispose(); t.el.remove(); terms.delete(id); }
}

const unread = new Set();
function bump(id) { if (!unread.has(id)) { unread.add(id); render(); } }

// ------------------------------------------------------------------ notifications
function notifyTransition(prev, s) {
  if (!prev || prev.status === s.status) return;
  const focused = document.hasFocus() && visibleIds().includes(s.id);
  const important = s.status === 'attention' || (s.status === 'idle' && prev.status === 'working');
  if (!important || focused) return;
  alertUser(s, s.status === 'attention' ? t('attend une réponse') : t('terminé'), s.locked ? t('Session verrouillée') : (s.message || s.cwd));
}

function alertUser(s, what, body) {
  if (SETTINGS.dnd || s.alerts?.mute) return;
  playSound();
  if (!SETTINGS.notifications) return;
  // macOS : par l'app (repli si elle n'est pas signée par Apple — le centre de notifications la refuse)
  // dans l'app : notification du système par le processus principal (clic = fenêtre au premier plan sur la session)
  if (window.csmNative?.notify) return window.csmNative.notify(`${s.name} — ${what}`, body, s.id);
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(`${s.name} — ${what}`, { body, tag: s.id, icon: 'icon.svg', silent: true });
  n.onclick = () => { window.csmNative ? window.csmNative.focus() : window.focus(); select(s.id); n.close(); };
}

// Son synthétisé (aucun fichier) : « discret » = deux notes douces, « clochette » = tintement.
let audioCtx = null;
function playSound(kind = SETTINGS.sound) {
  if (!kind || kind === 'off') return;
  try {
    audioCtx = audioCtx || new AudioContext();
    const now = audioCtx.currentTime;
    const notes = kind === 'bell' ? [[1318, 0, 0.9], [1975, 0.02, 0.6]] : [[660, 0, 0.18], [880, 0.12, 0.22]];
    for (const [freq, at, dur] of notes) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = kind === 'bell' ? 'triangle' : 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, now + at); g.gain.exponentialRampToValueAtTime(0.12, now + at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + at + dur);
      o.connect(g).connect(audioCtx.destination); o.start(now + at); o.stop(now + at + dur + 0.05);
    }
  } catch { }
}

// Rappels : session qui attend depuis longtemps / qui travaille depuis trop longtemps.
const reminded = new Map();
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    const key = `${s.id}:${s.status}:${s.statusSince}`;
    if (reminded.get(s.id) === key) continue;
    const mins = (now - s.statusSince) / 60000;
    if (s.status === 'attention' && SETTINGS.waitingMinutes > 0 && mins >= SETTINGS.waitingMinutes) {
      reminded.set(s.id, key); alertUser(s, t('attend toujours une réponse'), `${Math.round(mins)} min`);
    } else if (s.status === 'working' && SETTINGS.longRunMinutes > 0 && mins >= SETTINGS.longRunMinutes) {
      reminded.set(s.id, key); alertUser(s, t('travaille depuis longtemps'), `${Math.round(mins)} min`);
    }
  }
}, 30000);

// ------------------------------------------------------------------ groupes
// Groupes créés à la main (réglage groupList, visibles même vides) puis ceux portés par les sessions.
// Sous-groupes : chemin « Parent/Enfant » (séparateur /), stocké tel quel dans le groupe de la session et dans
// groupList ; une version sans sous-groupes l'affiche simplement comme un groupe nommé « Parent/Enfant ».
const GSEP = '/', GMAX = 120;
const gClean = x => String(x || '').split(GSEP).map(p => p.trim()).filter(Boolean).join(GSEP).slice(0, GMAX);
const gOf = s => gClean(s.group);
const gParent = g => (g.includes(GSEP) ? g.slice(0, g.lastIndexOf(GSEP)) : '');
const gLeaf = g => g.slice(g.lastIndexOf(GSEP) + 1);
const gDepth = g => (g && g !== '📌' ? g.split(GSEP).length - 1 : 0);
const gUnder = (x, g) => x === g || x.startsWith(g + GSEP);
const gLabel = g => g.split(GSEP).join(' › ');
const gIndent = g => ' '.repeat(gDepth(g));
const declaredGroups = () => String(SETTINGS.groupList || '').split('\n').map(gClean).filter(Boolean);
// Tous les groupes, parents compris, en arbre : un sous-groupe suit son parent, dans l'ordre d'apparition.
function groupNames() {
  const flat = [...declaredGroups(), ...[...sessions.values()].sort((a, b) => (a.order || 0) - (b.order || 0)).map(gOf).filter(Boolean)];
  const all = [];
  for (const g of flat) { const p = g.split(GSEP); for (let i = 1; i <= p.length; i++) { const x = p.slice(0, i).join(GSEP); if (!all.includes(x)) all.push(x); } }
  const out = [], walk = parent => { for (const x of all.filter(y => gParent(y) === parent)) { out.push(x); walk(x); } };
  walk('');
  return out;
}
const saveGroupList = list => saveSettings({ groupList: [...new Set(list.map(gClean).filter(Boolean))].join('\n') });
const moveToGroup = (id, g) => api('POST', `/api/sessions/${id}/meta`, { group: gClean(g) }).catch(e => toast(e.message, true));

// Champ « Groupe » de Nouvelle session : tous les groupes existants (même vides), « (aucun) » par défaut = Sans groupe,
// et « Nouveau groupe… » pour en créer un sans quitter le formulaire.
function setGroupField(value) {
  const sel = $('#formNew').group, v = gClean(value);
  const names = groupNames();
  if (v && !names.includes(v)) names.push(v); // groupe d'un modèle venu d'une autre machine
  const esc = x => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  sel.innerHTML = `<option value="">${esc(t('(aucun)'))}</option>` + names.map(x => `<option value="${esc(x)}">${esc(gLabel(x))}</option>`).join('')
    + `<option value="\u0000new">${esc(t('Nouveau groupe…'))}</option>`;
  sel.value = v;
  sel.dataset.prev = v;
}
async function pickNewGroup(sel) {
  if (sel.value !== '\u0000new') { sel.dataset.prev = sel.value; return; }
  const name = gClean(await askName(t('Nouveau groupe'), '', t('« Parent/Enfant » crée un sous-groupe.'), true));
  setGroupField(name || sel.dataset.prev || '');
}

$('#formNew').group.addEventListener('change', e => pickNewGroup(e.target));

// Nouveau groupe, ou sous-groupe de parent.
async function newGroup(moveId, parent = '') {
  const name = gClean(await askName(parent ? t('Nouveau sous-groupe') : t('Nouveau groupe'), '',
    (parent ? `${t('Dans')} « ${gLabel(parent)} ». ` : '') + t('Glisse ensuite des sessions sur son titre, ou clic droit sur une session › Déplacer vers le groupe.'), true));
  if (!name) return;
  const full = gClean(parent ? `${parent}${GSEP}${name}` : name);
  await saveGroupList([...declaredGroups(), full]);
  if (moveId) await moveToGroup(moveId, full);
  for (let g = full; g; g = gParent(g)) collapsed.delete(g);
  LS.set('csm.collapsed', [...collapsed]);
  render();
}
// Change le chemin d'un groupe : ses sous-groupes, leurs sessions et l'état replié suivent.
async function repathGroup(from, to) {
  to = gClean(to);
  if (!to || to === from) return;
  const swap = x => (gUnder(x, from) ? to + x.slice(from.length) : x);
  const list = declaredGroups();
  await saveGroupList(list.some(x => gUnder(x, from)) ? list.map(swap) : [...list, to]);
  await Promise.all([...sessions.values()].filter(s => gUnder(gOf(s), from)).map(s => moveToGroup(s.id, swap(gOf(s)))));
  for (const g of [...collapsed]) if (gUnder(g, from)) { collapsed.delete(g); collapsed.add(swap(g)); }
  LS.set('csm.collapsed', [...collapsed]);
  render();
}
async function renameGroup(g) {
  const leaf = (await askName(t('Renommer le groupe'), gLeaf(g), t('Toutes les sessions du groupe suivent.')))?.replaceAll(GSEP, '-').trim();
  if (!leaf) return;
  await repathGroup(g, gParent(g) ? `${gParent(g)}${GSEP}${leaf}` : leaf);
}
// Range le groupe (avec ses sous-groupes) dans dest, ou au premier niveau si dest est vide.
function moveGroup(g, dest) {
  if (dest && gUnder(dest, g)) return; // pas dans lui-même ni dans un de ses sous-groupes
  return repathGroup(g, dest ? `${dest}${GSEP}${gLeaf(g)}` : gLeaf(g));
}
// Supprimer un groupe supprime aussi ses sous-groupes ; leurs sessions remontent dans le groupe parent.
async function deleteGroup(g) {
  const members = [...sessions.values()].filter(s => gUnder(gOf(s), g));
  const subs = groupNames().filter(x => x !== g && gUnder(x, g));
  const dest = gParent(g);
  if ((members.length || subs.length) && !confirm(`${t('Supprimer le groupe')} « ${gLabel(g)} »${subs.length ? ` ${t('et ses sous-groupes')} (${subs.length})` : ''} ?`
    + (members.length ? ` ${members.length} ${t('session(s) passent dans')} « ${dest ? gLabel(dest) : t('Sans groupe')} » ${t('(elles ne sont pas fermées).')}` : ''))) return;
  const rest = declaredGroups().filter(x => !gUnder(x, g));
  if (dest && !rest.some(x => gUnder(x, dest))) rest.push(dest); // le parent reste, même vide
  await saveGroupList(rest);
  await Promise.all(members.map(s => moveToGroup(s.id, dest)));
  render();
}
function moveItems(id) {
  const s = sessions.get(id); if (!s) return [];
  const cur = gOf(s);
  return [
    ...groupNames().map(g => [(cur === g ? '✓ ' : '') + gIndent(g) + gLeaf(g), () => moveToGroup(id, g), { disabled: cur === g }]),
    '-',
    [t('Nouveau groupe…'), () => newGroup(id)],
    [t('Sans groupe'), () => moveToGroup(id, ''), { disabled: !cur }],
  ];
}
function groupMoveItems(g) {
  return [
    [t('Premier niveau'), () => moveGroup(g, ''), { disabled: !gParent(g) }],
    '-',
    ...groupNames().filter(x => !gUnder(x, g)).map(x => [gIndent(x) + gLeaf(x), () => moveGroup(g, x), { disabled: gParent(g) === x }]),
  ];
}
function groupItems(g) {
  return [
    [t('Nouvelle session dans ce groupe'), () => { openNew(); setGroupField(g); }],
    [t('Nouveau sous-groupe…'), () => newGroup(null, g)],
    [t('Renommer le groupe…'), () => renameGroup(g)],
    [t('Déplacer le groupe vers…'), () => showMenu(groupMoveItems(g), ...lastMenuPos)],
    '-',
    [t('Supprimer le groupe'), () => deleteGroup(g), { danger: true }],
  ];
}
// Titre de groupe : on y dépose une session ou un autre groupe (qui devient son sous-groupe ; sur « Sans groupe » =
// premier niveau) ; clic droit = menu du groupe.
function groupHeadEvents(el, g) {
  if (g === '📌') return;
  const types = e => [...e.dataTransfer.types];
  el.ondragover = e => { if (types(e).includes('text/csm-session') || types(e).includes('text/csm-group')) { e.preventDefault(); el.classList.add('dragover'); } };
  el.ondragleave = () => el.classList.remove('dragover');
  el.ondrop = e => {
    el.classList.remove('dragover');
    const grp = e.dataTransfer.getData('text/csm-group');
    if (grp) { e.preventDefault(); e.stopPropagation(); if (grp !== g) moveGroup(grp, g); return; }
    const id = e.dataTransfer.getData('text/csm-session'); if (!id) return;
    e.preventDefault(); e.stopPropagation();
    moveToGroup(id, g);
  };
  el.oncontextmenu = e => {
    e.preventDefault(); e.stopPropagation();
    showMenu(g ? groupItems(g) : [[t('Nouveau groupe…'), () => newGroup()]], e.clientX, e.clientY);
  };
}
// Titre d'un groupe : nom, nombre de sessions (sous-groupes compris) et, pour un groupe nommé, ✎ renommer / ✕ supprimer
// (aussi : double-clic = renommer, clic droit = menu, glisser le titre sur un autre groupe = en faire un sous-groupe).
let groupClickTimer = null;
function groupHead(g, count) {
  const h = document.createElement('li');
  h.innerHTML = '<span class="gcar">▾</span><span class="gname"></span><span class="gacts"></span><span class="gcount"></span>';
  h.querySelector('.gname').textContent = g === '📌' ? t('Épinglées') : g ? gLeaf(g) : t('Sans groupe');
  h.querySelector('.gcount').textContent = count;
  if (g && g !== '📌') {
    h.title = gLabel(g);
    h.style.setProperty('--gd', gDepth(g));
    h.draggable = true;
    h.ondragstart = e => e.dataTransfer.setData('text/csm-group', g);
    const acts = h.querySelector('.gacts');
    for (const [cls, icon, title, run] of [['gsub', '<svg class="ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>', t('Nouveau sous-groupe…'), x => newGroup(null, x)], ['gren', '<svg class="ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>', t('Renommer le groupe…'), renameGroup], ['gdel', '<svg class="ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>', t('Supprimer le groupe'), deleteGroup]]) {
      const b = document.createElement('button');
      b.className = cls; b.innerHTML = icon; b.title = title; b.setAttribute('aria-label', title); // icône fixe (pas de donnée)
      b.onclick = e => { e.stopPropagation(); clearTimeout(groupClickTimer); run(g); };
      b.ondblclick = e => e.stopPropagation();
      acts.appendChild(b);
    }
    h.ondblclick = e => { e.stopPropagation(); clearTimeout(groupClickTimer); renameGroup(g); };
  }
  groupHeadEvents(h, g);
  return h;
}
$('#btnNewGroup').onclick = () => newGroup();

// ------------------------------------------------------------------ rendu
// Ordre d'affichage : épinglées d'abord, puis par groupe (ordre d'apparition), puis ordre manuel.
function sorted() {
  const all = [...sessions.values()].sort((a, b) => (a.order || 0) - (b.order || 0));
  const groups = [...groupNames(), ''];
  return all.sort((a, b) => (!!b.pinned - !!a.pinned) || (a.pinned && b.pinned ? 0 : groups.indexOf(gOf(a)) - groups.indexOf(gOf(b))) || (a.order || 0) - (b.order || 0));
}
const collapsed = new Set(LS.get('csm.collapsed', []));

function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.floor(s)}s`; if (s < 3600) return `${Math.floor(s / 60)}min`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`; return `${Math.floor(s / 86400)}j`;
}

function render() {
  const ul = $('#list');
  ul.innerHTML = '';
  // Sections dans l'ordre de sorted() : épinglées, groupes en arbre (un sous-groupe sous son parent), Sans groupe.
  const list = sorted(), names = groupNames();
  const keyOf = s => (s.pinned ? '📌' : gOf(s));
  const showHeads = names.length || list.some(x => x.pinned);
  // replié par un groupe parent : titre masqué
  const underClosed = g => { for (let p = gParent(g); p; p = gParent(p)) if (collapsed.has(p)) return true; return false; };
  for (const g of ['📌', ...names, '']) {
    const own = list.filter(s => keyOf(s) === g);
    const total = g === '📌' || !g ? own.length : list.filter(s => !s.pinned && gUnder(gOf(s), g)).length;
    if ((g === '📌' || !g) && !own.length) continue;
    const hidden = g !== '📌' && underClosed(g), closed = hidden || collapsed.has(g);
    if (showHeads && !hidden) {
      const h = groupHead(g, total);
      h.className = 'ghead' + (collapsed.has(g) ? ' closed' : '') + (total ? '' : ' empty');
      // simple clic = replier (différé pour laisser le double-clic renommer)
      h.onclick = e => {
        clearTimeout(groupClickTimer);
        if (e.detail > 1) return;
        groupClickTimer = setTimeout(() => { collapsed.has(g) ? collapsed.delete(g) : collapsed.add(g); LS.set('csm.collapsed', [...collapsed]); render(); }, g && g !== '📌' ? 220 : 0);
      };
      ul.appendChild(h);
      if (!total && !collapsed.has(g) && !names.some(x => gParent(x) === g)) {
        const hint = document.createElement('li');
        hint.className = 'gempty';
        hint.style.setProperty('--gd', gDepth(g));
        hint.textContent = t('Glisse une session ici');
        groupHeadEvents(hint, g);
        ul.appendChild(hint);
      }
    }
    for (const s of own) if (!closed || s.id === active) renderItem(s, list.indexOf(s), gDepth(g));
  }
  function renderItem(s, i, depth) {
    const li = document.createElement('li');
    if (depth) li.style.setProperty('--gd', depth);
    li.className = `${s.id === active ? 'active' : ''} ${visibleIds().includes(s.id) ? 'shown' : ''} ${s.status}`;
    if (s.color) li.style.setProperty('--sc', s.color);
    li.draggable = true;
    li.dataset.id = s.id;
    li.title = `${s.name}\n${s.cwd}${s.worktree ? `\n⎇ ${s.worktree.branch}` : ''}\n${stateText(s, ' — ')}`;
    li.innerHTML = `<span class="dot ${s.status}"></span><span class="n"></span><span class="acts"><button class="ren" title="Renommer" aria-label="Renommer"><svg class="ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button><span class="k">${i < 9 ? i + 1 : ''}${unread.has(s.id) && s.id !== active ? ' •' : ''}</span></span><span class="sub"></span>`;
    li.querySelector('.n').textContent = (s.locked ? (window.csmFeatures.isLockedHere?.(s.id) ? '🔒 ' : '🔓 ') : '') + s.name;
    li.querySelector('.dot').textContent = '';
    li.querySelector('.dot').dataset.initial = (s.name || '?').trim().charAt(0).toUpperCase();
    const subEl = li.querySelector('.sub');
    subEl.textContent = (s.origin && window.csmFeatures?.syncMachine && s.origin !== window.csmFeatures.syncMachine ? `⇄ ${s.origin} · ` : '') + (s.worktree ? `⎇ ${s.worktree.branch} · ` : '') + (s.quotaWait ? `⏸ ${t('quota')} ${hm(s.quotaWait)} · ` : '') + (s.queue?.length ? `⏳${s.queue.length} · ` : '') + `${stateText(s, ' · ')} · ${ago(s.statusSince)}`;
    if (isRemote(s)) { const ph = svgIcon('M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z|M11 18h2', 12); ph.classList.add('remoteIc'); ph.setAttribute('aria-label', t('Accessible depuis l’app Claude')); subEl.prepend(ph); }
    li.onclick = () => select(s.id);
    li.ondblclick = () => renameSession(s.id);
    li.querySelector('.ren').onclick = e => { e.stopPropagation(); renameSession(s.id); };
    li.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); sessionMenu(s.id, e.clientX, e.clientY); };
    li.ondragstart = e => { e.dataTransfer.setData('text/plain', s.id); e.dataTransfer.setData('text/csm-session', s.id); };
    li.ondragover = e => { e.preventDefault(); li.classList.add('dragover'); };
    li.ondragleave = () => li.classList.remove('dragover');
    li.ondrop = e => {
      e.preventDefault(); li.classList.remove('dragover');
      const from = e.dataTransfer.getData('text/plain'); if (!from || from === s.id) return;
      const src = sessions.get(from);
      if (src && !s.pinned && gOf(src) !== gOf(s)) moveToGroup(from, gOf(s));
      const ids = sorted().map(x => x.id).filter(x => x !== from);
      ids.splice(ids.indexOf(s.id), 0, from);
      api('POST', '/api/order', { ids });
    };
    ul.appendChild(li);
  }
  const attn = [...sessions.values()].filter(s => s.status === 'attention').length;
  document.title = attn ? `(${attn}) Claude Sessions` : 'Claude Sessions';
  if (!$('#dlgNew')?.open) setGroupField($('#formNew').group.value);
  window.csmNative?.setAttention(attn); // pastille Dock / barre des tâches
  document.body.classList.toggle('nosession', sessions.size === 0);
  renderBar();
}
setInterval(render, 15000);

// état affiché : « en pause » (sur cette machine ou une autre) plutôt que « arrêtée — en pause »
function stateText(s, sep) {
  if (!s.alive && s.paused) return /^en pause sur /.test(s.message || '') ? t('en pause sur') + ' ' + s.message.slice(13) : t('en pause');
  return `${STATUS_LABEL[s.status] || s.status}${s.message && s.status !== 'working' ? sep + t(s.message) : ''}`;
}
function renderBar() {
  const s = sessions.get(active);
  if (!s) return;
  $('#curDot').className = `dot ${s.status}`;
  $('#curName').textContent = s.name;
  $('#curCwd bdi').textContent = s.cwd; // <bdi> : le chemin garde son sens de lecture, l'ellipse reste au début
  $('#curCwd').title = s.cwd + (s.claudeSessionId ? `\nsession ${s.claudeSessionId}` : '');
  $('#curMsg').textContent = `${stateText(s, ' — ')}`;
  $('#curMsg').className = `msg ${s.status}`;
  $('#btnKill').disabled = !s.alive;
  $('#btnPause').hidden = !s.alive; // en pause / arrêtée : « Reprendre » à la place
  $('#btnRestart .lbl').textContent = s.alive ? t('Relancer') : (s.claudeSessionId ? t('Reprendre') : t('Relancer'));
  window.csmFeatures?.renderTypeBar?.(s); // type de session d'une extension (public/extensions.js)
  $('#curBranch').hidden = !s.worktree;
  $('#curBranch').textContent = s.worktree ? `⎇ ${s.worktree.branch}` : '';
  $('#curBranch').title = s.worktree ? `${t('Worktree')} : ${s.worktree.path}\n${t('base')} : ${s.worktree.base}` : '';
  $('#curQueue').hidden = !s.queue?.length && !s.quotaWait;
  $('#curQueueTxt').textContent = (s.quotaWait ? `${t('quota — reprise à')} ${hm(s.quotaWait)}${s.queue?.length ? ' · ' : ''}` : '') + (s.queue?.length ? `${s.queue.length} ${t('en attente')}` : '');
  window.dispatchEvent(new CustomEvent('csm:active', { detail: s }));
}

function select(id) {
  if (!id || !sessions.has(id)) { active = null; LS.set('csm.active', null); render(); return; }
  active = id; LS.set('csm.active', id);
  unread.delete(id);
  const n = LAYOUTS[layout] || 1;
  const at = panes.indexOf(id);
  if (at >= 0 && at < n) focusedPane = at;
  else { focusedPane = Math.min(focusedPane, n - 1); panes[focusedPane] = id; }
  renderPanes();
  render();
  requestAnimationFrame(() => terms.get(id)?.term.focus());
  const s = sessions.get(id);
  if (s && !window.csmFeatures.isLockedHere?.(id) && s.status === 'idle' && s.message === 'terminé') api('POST', `/api/sessions/${id}/seen`).catch(() => { });
}

// ------------------------------------------------------------------ actions
// Boîte « Renommer » commune (barre, liste, menu clic droit, historique, Ctrl+Alt+R).
function askName(title, current, hint, allowSame) {
  const dlg = $('#dlgRename'), input = $('#renInput');
  $('#renTitle').textContent = title;
  $('#renHint').textContent = hint ?? t('Le nom est aussi enregistré dans la conversation Claude (historique, claude --resume).');
  input.value = current || '';
  dlg.returnValue = '';
  dlg.showModal();
  input.select();
  return new Promise(resolve => dlg.addEventListener('close', () => {
    const v = input.value.trim();
    resolve(dlg.returnValue === 'ok' && v && (allowSame || v !== current) ? v : null);
    terms.get(active)?.term.focus();
  }, { once: true }));
}

async function renameSession(id) {
  const s = sessions.get(id); if (!s) return;
  const name = await askName('Renommer la session', s.name);
  if (!name) return;
  try { const v = await api('POST', `/api/sessions/${id}/rename`, { name }); sessions.set(id, v); render(); }
  catch (e) { alert(`${t('Renommage impossible')} : ${e.message}`); }
}
function startRename() { if (active) renameSession(active); }
$('#curName').ondblclick = startRename;
$('#btnRename').onclick = startRename;

// ------------------------------------------------------------------ menu clic droit
// Menu propre à l'application partout : le menu du navigateur n'apparaît jamais.
// Entrée = [libellé, action, { kbd, danger, disabled }] ; '-' = séparateur.
// popover : passe au-dessus des boîtes de dialogue modales (top layer).
const MOD = IS_MAC ? '⌘' : 'Ctrl';
let lastMenuPos = [100, 100];
function showMenu(items, x, y) {
  lastMenuPos = [x, y];
  const menu = $('#ctx');
  // Une boîte modale rend inerte tout ce qui est hors d'elle : le menu doit vivre dedans pour être cliquable.
  const host = document.querySelector('dialog[open]') || document.body;
  if (menu.parentElement !== host) { hideMenu(); host.appendChild(menu); }
  menu.innerHTML = '';
  for (const it of items.filter((it, i, a) => it !== '-' || (i > 0 && a[i - 1] !== '-' && i < a.length - 1))) {
    if (it === '-') { menu.appendChild(document.createElement('hr')); continue; }
    const [label, fn, o = {}] = it;
    const b = document.createElement('button');
    b.innerHTML = '<span></span><kbd></kbd>';
    b.firstChild.textContent = t(label);
    b.lastChild.textContent = o.kbd || '';
    if (o.danger) b.className = 'danger';
    b.disabled = !!o.disabled;
    b.onclick = () => { hideMenu(); fn(); };
    menu.appendChild(b);
  }
  if (!menu.matches(':popover-open')) menu.showPopover();
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 6))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 6))}px`;
}
function hideMenu() { const m = $('#ctx'); if (m.matches(':popover-open')) m.hidePopover(); }
$('#ctx').addEventListener('keydown', e => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const bs = [...$('#ctx').querySelectorAll('button:not(:disabled)')]; if (!bs.length) return;
  const i = bs.indexOf(document.activeElement);
  bs[(i + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length].focus();
  e.preventDefault();
});

// sélection du terminal, remise en forme pour être collée ailleurs (public/copytext.js)
const selText = term => (window.tidyCopy ? window.tidyCopy(term.getSelection(), term.cols) : term.getSelection());
const clip = {
  copy: t => navigator.clipboard.writeText(t).catch(() => { }),
  read: () => navigator.clipboard.readText().catch(() => ''),
  // Images du presse-papiers (menu « Coller ») ; [] si refusé ou sans image.
  async images() {
    try {
      const out = [];
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find(t => t.startsWith('image/'));
        if (type) out.push(new File([await item.getType(type)], `image.${type.split('/')[1].replace('jpeg', 'jpg')}`, { type }));
      }
      return out;
    } catch { return []; }
  },
};

const hasFiles = dt => !!dt && [...dt.types].includes('Files');

let pickTarget = null;
function pickFiles(id) { pickTarget = id; $('#fileInput').value = ''; $('#fileInput').click(); }
$('#fileInput').onchange = () => { const f = [...$('#fileInput').files]; if (f.length && pickTarget) attachFiles(pickTarget, f); };
$('#btnAttach').onclick = () => active && pickFiles(active);

async function uploadFile(file) {
  const r = await fetch('/api/upload', {
    method: 'POST', body: file,
    headers: { 'X-CSM-Token': TOKEN, 'X-Filename': encodeURIComponent(file.name || 'image.png'), 'Content-Type': 'application/octet-stream' },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j.path;
}

// ------------------------------------------------------------------ aperçu des pièces jointes
// Par session : images (et fichiers) joints au message en cours, lus localement (URL blob, rien de plus n'est
// envoyé). Affiché seulement sur la session active ; vidé à l'envoi du message (Entrée).
const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const attachments = new Map();
const isImage = f => /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name || '');
function addAttachments(id, files) {
  const list = attachments.get(id) || [];
  for (const f of files) list.push({ name: f.name || 'image.png', url: isImage(f) ? URL.createObjectURL(f) : '', sent: false });
  while (list.length > 8) { const x = list.shift(); if (x.url) URL.revokeObjectURL(x.url); }
  attachments.set(id, list);
  renderAttachments(id, true);
}
function attachmentsSent(id) {
  const list = attachments.get(id);
  if (!list?.length) return;
  for (const x of list) if (x.url) URL.revokeObjectURL(x.url);
  attachments.delete(id);
  renderAttachments(id);
}
// changement de session active : seul l'aperçu de la session active est visible
window.addEventListener('csm:active', () => { for (const id of attachments.keys()) renderAttachments(id); });
function renderAttachments(id, show) {
  const t = terms.get(id), box = t?.el.querySelector('.thumbs');
  if (!box) return;
  const list = attachments.get(id) || [];
  if (show) box.dataset.closed = '';
  box.hidden = !list.length || box.dataset.closed === '1' || id !== active;
  box.innerHTML = list.map((x, i) => `<button class="thumb${x.sent ? ' sent' : ''}" data-i="${i}" title="${escHtml(x.name)}${x.sent ? ' · ' + t2('envoyée') : ''}">${x.url ? `<img src="${x.url}" alt="">` : '<span>📄</span>'}</button>`).join('')
    + `<button class="thumbsClose" title="${t2('Masquer')}">✕</button>`;
  box.querySelectorAll('.thumb').forEach(b => { b.onclick = e => { e.stopPropagation(); viewAttachment(list[+b.dataset.i]); }; });
  box.querySelector('.thumbsClose').onclick = e => { e.stopPropagation(); box.dataset.closed = '1'; box.hidden = true; t.term.focus(); };
}
function viewAttachment(x) {
  if (!x?.url) return;
  const d = $('#dlgImage');
  d.querySelector('img').src = x.url;
  d.querySelector('figcaption').textContent = x.name + (x.sent ? ' · ' + t2('envoyée') : '');
  d.showModal();
}
const t2 = s => (typeof t === 'function' ? t(s) : s);

// Colle les chemins comme le ferait un terminal après un glisser-déposer : Claude détecte les images et les attache.
async function attachFiles(id, files) {
  const tt = terms.get(id); if (!tt) return;
  toast(`${t('Envoi de')} ${files.length > 1 ? `${files.length} ${t('fichiers')}` : `« ${files[0].name || 'image'} »`}…`);
  try {
    const paths = [];
    for (const f of files) paths.push(await uploadFile(f));
    const quoted = paths.map(p => (/\s/.test(p) ? `"${p}"` : p));
    tt.term.paste(quoted.join(' ') + ' ');
    addAttachments(id, files);
    toast(files.length > 1 ? `${files.length} ${t('fichiers ajoutés')}` : t('Ajouté — il sera envoyé avec ton message'));
  } catch (e) { toast(`${t('Échec')} : ${e.message}`, true); }
  tt.term.focus();
}

let toastTimer = null;
function toast(msg, error) {
  const el = $('#toast');
  el.textContent = msg; el.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = 'toast'; }, error ? 5000 : 2500);
}

// Déposer un fichier ailleurs que sur un terminal ne doit pas faire quitter la page.
window.addEventListener('dragover', e => { if (hasFiles(e.dataTransfer)) e.preventDefault(); });
window.addEventListener('drop', e => {
  if (!hasFiles(e.dataTransfer)) return;
  e.preventDefault();
  if (active && !e.target.closest('.term')) attachFiles(active, [...e.dataTransfer.files]);
});

function sessionItems(id) {
  const s = sessions.get(id); if (!s) return [];
  return [
    ['Renommer', () => renameSession(id), { kbd: id === active ? `${MOD}+Alt+R` : '' }],
    [s.alive ? 'Relancer' : 'Reprendre', () => api('POST', `/api/sessions/${id}/restart`)],
    ['Arrêter', () => api('POST', `/api/sessions/${id}/kill`), { disabled: !s.alive }],
    [t('Ouvrir dans…'), () => showMenu(openItems(id), ...lastMenuPos)],
    ['Copier le chemin', () => clip.copy(s.cwd)],
    '-',
    ...moreItems(id).slice(0, -1),
    ...(s.claudeSessionId ? [['Copier l’identifiant de session', () => clip.copy(s.claudeSessionId)]] : []),
    '-',
    ['Fermer', () => closeSession(id), { kbd: id === active ? `${MOD}+Alt+W` : '' }],
    [t('Supprimer…'), () => deleteSession(id), { danger: true }],
  ];
}
// Menu clic droit sur une session de la liste.
function sessionMenu(id, x, y) { showMenu(sessionItems(id), x, y); }

function terminalItems(id) {
  const t = terms.get(id); if (!t) return [];
  const { term } = t;
  return [
    ['Copier', () => { clip.copy(selText(term)); term.clearSelection(); term.focus(); }, { disabled: !term.hasSelection(), kbd: IS_MAC ? '⌘C' : 'Ctrl+C' }],
    ['Copier tel quel', () => { clip.copy(term.getSelection()); term.clearSelection(); term.focus(); }, { disabled: !term.hasSelection() }],
    ['Coller', async () => {
      const imgs = await clip.images();
      if (imgs.length) return attachFiles(id, imgs);
      const txt = await clip.read(); if (txt) term.paste(txt); term.focus();
    }, { kbd: IS_MAC ? '⌘V' : 'Ctrl+V' }],
    ['Joindre un fichier…', () => pickFiles(id)],
    ['Tout sélectionner', () => term.selectAll()],
    ['Effacer l’écran', () => { term.clear(); term.focus(); }],
    '-',
    ['Zoom avant', () => zoom('+'), { kbd: `${MOD}+=` }],
    ['Zoom arrière', () => zoom('-'), { kbd: `${MOD}+-` }],
    ['Taille normale', () => zoom('0'), { kbd: `${MOD}+0` }],
    '-',
    ...sessionItems(id),
  ];
}

function fieldItems(el) {
  const ro = el.readOnly || el.disabled;
  const a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? el.value.length;
  const put = txt => { el.focus(); el.setRangeText(txt, a, b, 'end'); el.dispatchEvent(new Event('input', { bubbles: true })); };
  return [
    ['Couper', () => { clip.copy(el.value.slice(a, b)); put(''); }, { disabled: ro || b <= a, kbd: `${MOD}+X` }],
    ['Copier', () => { clip.copy(el.value.slice(a, b)); el.focus(); }, { disabled: b <= a, kbd: `${MOD}+C` }],
    ['Coller', async () => put(await clip.read()), { disabled: ro, kbd: `${MOD}+V` }],
    '-',
    ['Tout sélectionner', () => { el.focus(); el.select(); }, { kbd: `${MOD}+A` }],
  ];
}

function appItems() {
  return [
    ['Nouvelle session', openNew, { kbd: `${MOD}+Alt+N` }],
    ['Historique', openHistory, { kbd: `${MOD}+Alt+H` }],
    '-',
    ['Recharger la fenêtre', () => location.reload(), { kbd: 'F5' }],
  ];
}

document.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (e.target.closest('#ctx')) return;
  const x = e.clientX, y = e.clientY, tg = e.target;
  const field = tg.closest('input, textarea');
  if (field && !['checkbox', 'radio', 'button', 'submit'].includes(field.type)) return showMenu(fieldItems(field), x, y);
  const termEl = tg.closest('.term');
  if (termEl) { const id = [...terms].find(([, t]) => t.el === termEl)?.[0]; if (id) return showMenu(terminalItems(id), x, y); }
  const sel = String(getSelection() || '');
  const pageCopy = sel ? [['Copier', () => clip.copy(sel), { kbd: `${MOD}+C` }], '-'] : [];
  if (tg.closest('dialog')) { if (sel) showMenu(pageCopy, x, y); else hideMenu(); return; }
  if (tg.closest('#bar') && active) return showMenu([...pageCopy, ...sessionItems(active)], x, y);
  showMenu([...pageCopy, ...appItems()], x, y);
});

// Entrée dans un champ = bouton principal (sinon le navigateur valide le 1er bouton du formulaire : « Annuler »).
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.target.tagName !== 'INPUT') return;
  const form = e.target.closest('dialog form');
  const ok = form && form.querySelector('button.primary[value]');
  if (!ok) return;
  e.preventDefault();
  form.requestSubmit(ok); // respecte la validation (ex. dossier obligatoire)
}, true);
document.addEventListener('mousedown', e => { if (!$('#ctx').contains(e.target)) hideMenu(); }, true);
// Échap ferme le menu sans fermer la boîte de dialogue en dessous.
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#ctx').matches(':popover-open')) { hideMenu(); e.stopPropagation(); e.preventDefault(); } }, true);
window.addEventListener('blur', hideMenu);
window.addEventListener('resize', hideMenu);
for (const d of document.querySelectorAll('dialog')) d.addEventListener('close', hideMenu);

$('#btnRestart').onclick = () => active && api('POST', `/api/sessions/${active}/restart`);
function openItems(id) {
  return [
    [t('Dans l’éditeur'), () => openIn(id, 'editor'), { kbd: `${MOD}+Alt+E` }],
    [IS_MAC ? t('Dans le Finder') : t('Dans l’Explorateur'), () => openIn(id, 'folder')],
    [t('Dans un terminal'), () => openIn(id, 'terminal')],
  ];
}
async function openIn(id, target) { try { await api('POST', `/api/sessions/${id}/open`, { target }); } catch (e) { toast(e.message, true); } }
const at = el => { const r = el.getBoundingClientRect(); return [r.left, r.bottom + 4]; };
$('#btnOpen').onclick = e => active && showMenu(openItems(active), ...at(e.currentTarget));
$('#btnMore').onclick = e => active && showMenu(moreItems(active), ...at(e.currentTarget));
$('#emptyNew').onclick = () => openNew();
$('#btnCompact').onclick = () => saveSettings({ compactSidebar: !SETTINGS.compactSidebar });
$('#paneHintX').onclick = () => { LS.set('csm.paneHintOff', true); updatePaneHint(); };
document.querySelectorAll('[data-layout]').forEach(b => { b.onclick = () => setLayout(b.dataset.layout); });
function moreItems(id) {
  const s = sessions.get(id); if (!s) return [];
  return [
    [t('File d’attente…'), () => window.csmFeatures.openQueue(id), { kbd: `${MOD}+Alt+Q` }],
    [t('Insérer un prompt…'), () => window.csmFeatures.openPrompts(id)],
    [t('Envoyer à plusieurs sessions…'), () => window.csmFeatures.openBroadcast(), { kbd: `${MOD}+Alt+B` }],
    '-',
    [t('Modifications'), () => window.csmFeatures.showPanel('changes'), { kbd: `${MOD}+Alt+G` }],
    [t('Chronologie'), () => window.csmFeatures.showPanel('timeline')],
    [t('Consommation'), () => window.csmFeatures.showPanel('usage')],
    [t('Mes prompts'), () => window.csmFeatures.showPanel('prompts'), { kbd: `${MOD}+Alt+P` }],
      [t('Mémoire de la session'), () => window.csmFeatures.showPanel('memory')],
    [isRemote(s) ? t('Désactiver l’accès depuis l’app Claude') : t('Accès depuis l’app Claude (téléphone)'), () => setRemote(id, !isRemote(s))],
    [t('Exporter la conversation…'), () => window.csmFeatures.exportConversation(s), { disabled: !s.claudeSessionId }],
    [t('Enregistrer comme modèle…'), () => saveSessionAsTemplate(id)],
    '-',
    [t('Déplacer vers le groupe…'), () => showMenu(moveItems(id), ...lastMenuPos)],
    [s.pinned ? t('Désépingler') : t('Épingler en haut'), () => api('POST', `/api/sessions/${id}/meta`, { pinned: !s.pinned })],
    ...(window.csmFeatures.lockItems?.(id) || []),
    [s.alerts?.mute ? t('Réactiver les alertes') : t('Couper les alertes de cette session'), () => api('POST', `/api/sessions/${id}/meta`, { alerts: { mute: !s.alerts?.mute } })],
    '-',
    [t('Mettre en pause'), () => pauseSession(id), { disabled: !s.alive }],
    [window.csmFeatures.quotaStopLabel?.(s) || t('Plafond de quota…'), () => window.csmFeatures.openQuotaStop(id)],
    [t('Supprimer…'), () => deleteSession(id), { danger: true }],
    [t('Arrêter'), () => api('POST', `/api/sessions/${id}/kill`), { disabled: !s.alive }],
    ...(window.csmNative?.toTray ? ['-', [trayLabel(), () => window.csmNative.toTray()]] : []),
  ];
}
// Réduire (bouton de la fenêtre) va dans la barre des tâches ; la zone de notification se choisit ici
const trayLabel = () => window.csmNative?.platform === 'darwin' ? t('Réduire dans la barre des menus') : t('Réduire dans la zone de notification');
$('#btnKill').onclick = () => active && api('POST', `/api/sessions/${active}/kill`);
// Pause : arrêt, puis mémoire et synchro enregistrées avant de rendre la main (le serveur attend les deux)
async function pauseSession(id) {
  toast(t('Mise en pause… (mémoire et synchro)'));
  try {
    const r = await api('POST', `/api/sessions/${id}/pause`);
    const parts = [r.memory === true ? t('mémoire à jour') : r.memory === false ? t('mémoire non enregistrée') : '', r.synced === true ? t('synchronisée') : r.synced === false ? t('synchro en échec (voir Réglages › Synchronisation)') : ''].filter(Boolean);
    toast(t('En pause') + (parts.length ? ' — ' + parts.join(', ') : ''), r.synced === false || r.memory === false);
  } catch (e) { toast(e.message, true); }
}
$('#btnPause').onclick = () => active && pauseSession(active);
$('#btnClose').onclick = () => closeSession(active);
// Fermer : retirée de la liste de cette machine (la conversation reste dans l'Historique). Synchronisée, elle est
// d'abord mise en pause (mémoire et synchro enregistrées) et reste « en pause » sur les autres machines.
// Pour la retirer partout : Supprimer.
async function closeSession(id) {
  const s = sessions.get(id); if (!s) return;
  const synced = !!(s.syncId && SETTINGS.syncCode);
  if (synced) toast(t('Fermeture… (mémoire et synchro)'));
  try {
    const r = await api('DELETE', `/api/sessions/${id}?here=1`);
    if (synced) toast(r.kept ? t('Fermée ici — gardée en pause sur tes autres machines') : t('Fermée ici — synchro en échec : elle n’est peut-être pas à jour ailleurs'), !r.kept);
  } catch (e) { toast(e.message, true); }
}
// Supprimer : retirée de la liste (sur toutes les machines si elle est synchronisée) ; la conversation reste dans
// l'Historique. Session dans un worktree : garder, fusionner ou supprimer le worktree.
async function deleteSession(id) {
  const s = sessions.get(id); if (!s) return;
  if (s.worktree) {
    $('#cwTitle').textContent = `${t('Supprimer')} « ${s.name} »`;
    $('#cwInfo').textContent = `${t('Cette session travaille dans le worktree')} ${s.worktree.path} (${t('branche')} ${s.worktree.branch}, ${t('base')} ${s.worktree.base}).`;
    const dlg = $('#dlgCloseWt'); dlg.returnValue = ''; dlg.showModal();
    const choice = await new Promise(r => dlg.addEventListener('close', () => r(dlg.returnValue), { once: true }));
    try {
      if (choice === 'keep') await api('DELETE', `/api/sessions/${id}`);
      else if (choice === 'merge') {
        await api('POST', `/api/sessions/${id}/worktree/merge`);
        await api('POST', `/api/sessions/${id}/worktree/remove`, { deleteBranch: true });
        toast(`${t('Fusionné dans')} ${s.worktree.base}`);
      } else if (choice === 'remove') {
        if (!confirm(`${t('Supprimer définitivement le worktree et la branche')} ${s.worktree.branch} ?`)) return;
        await api('POST', `/api/sessions/${id}/worktree/remove`, { deleteBranch: true, force: true });
      }
    } catch (e) { alert(e.message); }
    return;
  }
  const synced = !!(s.syncId && SETTINGS.syncCode);
  if (!confirm(`${t('Supprimer')} « ${s.name} » ? ${synced ? t('Elle disparaît de la liste sur toutes tes machines.') : t('Elle disparaît de la liste.')} ${t('La conversation reste dans l’Historique.')}`)) return;
  try { await api('DELETE', `/api/sessions/${id}`); } catch (e) { toast(e.message, true); }
}

async function loadHistory() {
  try { historyCache = await api('GET', '/api/history'); } catch { historyCache = []; }
  const dirs = [...new Set([...sessions.values()].map(s => s.cwd).concat(historyCache.map(h => h.cwd)).filter(Boolean))];
  $('#dirs').innerHTML = '';
  for (const d of dirs.slice(0, 60)) { const o = document.createElement('option'); o.value = d; $('#dirs').appendChild(o); }
}

const isRemote = s => !!(s && (s.remote || (SETTINGS.remoteAll && s.remote !== false)));
async function setRemote(id, on) {
  try { const v = await api('POST', `/api/sessions/${id}/remote`, { on }); sessions.set(id, v); render(); toast(on ? t('Session accessible depuis l’app Claude (onglet Code)') : t('Accès depuis l’app Claude désactivé')); }
  catch (e) { toast(e.message, true); }
}
let templates = [];
async function saveSessionAsTemplate(id) {
  const s = sessions.get(id); if (!s) return;
  const parts = (s.args || '').match(/"[^"]*"|\S+/g) || [];
  let model = '', mode = ''; const extra = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '--model') model = parts[++i] || '';
    else if (parts[i] === '--permission-mode') mode = parts[++i] || '';
    else extra.push(parts[i]);
  }
  const name = await askName(t('Nom du modèle'), s.name, t('Reprend le dossier, le groupe, le modèle, le mode et le plafond de quota de cette session. Retrouvable dans « Nouvelle session » et la palette (Ctrl+K).'), true);
  if (!name) return;
  const list = await loadTemplates();
  list.push({ name, cwd: s.worktree ? s.worktree.repo : s.cwd, model, mode, extra: extra.join(' '), worktree: !!s.worktree, prompt: '', group: s.group || '',
    ...(s.quotaStop ? { quotaStop: { five: s.quotaStop.five, seven: s.quotaStop.seven, resume: !!s.quotaStop.resume } } : {}) });
  try { await api('PUT', '/api/templates', list); toast(`${t('Modèle enregistré')} : ${name}`); } catch (e) { toast(e.message, true); }
}
async function loadTemplates() { try { templates = await api('GET', '/api/templates'); } catch { templates = []; } return templates; }
window.addEventListener('csm:templates', e => { templates = e.detail; });
function openNew(tpl) {
  if (tpl && !tpl.id) tpl = null; // seul un vrai modèle (avec id) préremplit le formulaire
  const f = $('#formNew');
  f.reset();
  f.model.value = SETTINGS.defaultModel ?? 'opus';
  f.mode.value = SETTINGS.defaultMode || '';
  const cur = sessions.get(active);
  f.cwd.value = LS.get('csm.lastCwd', '') || (cur?.worktree ? cur.worktree.repo : cur?.cwd) || '';
  setGroupField(''); // rien de choisi = Sans groupe
  f.worktree.checked = !!SETTINGS.worktreeDefault;
  f.remote.checked = !!SETTINGS.remoteAll;
  loadHistory();
  f.dataset.type = ''; showTplInput(null); setQuotaFields(null);
  Promise.all([loadTemplates(), loadExtTemplates()]).then(([list, ext]) => {
    $('#tplRow').hidden = false;
    const sel = f.template;
    sel.replaceChildren(new Option(list.length || ext.length ? t('— aucun —') : t('— aucun modèle : « Enregistrer comme modèle » en bas —'), ''));
    for (const x of list) sel.add(new Option(x.name, x.id));
    // modèles des extensions, regroupés par extension (lecture seule)
    const byExt = new Map();
    for (const x of ext) { if (!byExt.has(x.extName)) byExt.set(x.extName, []); byExt.get(x.extName).push(x); }
    for (const [name, xs] of byExt) {
      const g = document.createElement('optgroup'); g.label = name;
      for (const x of xs) g.append(new Option(x.name, x.id));
      sel.append(g);
    }
    if (tpl) { sel.value = tpl.id; applyTemplate(tpl); }
  });
  $('#dlgNew').returnValue = ''; // Échap après un « ok » précédent : pas de création fantôme
  $('#dlgNew').showModal();
  checkRepo();
  const kb = $('#nsKbd'); if (kb) kb.textContent = IS_MAC ? '⌘⌥N' : 'Ctrl Alt N';
  f.cwd.select();
}
function applyTemplate(x) {
  const f = $('#formNew');
  if (!x) return;
  if (x.cwd) f.cwd.value = x.cwd;
  f.name.value = x.name || '';
  f.model.value = x.model ?? f.model.value; f.mode.value = x.mode || '';
  f.extra.value = x.extra || ''; f.prompt.value = x.prompt || ''; setGroupField(x.group);
  f.worktree.checked = !!x.worktree;
  f.dataset.type = x.type || ''; // type de session d'une extension (affichage dédié)
  showTplInput(x.input);
  setQuotaFields(x.quotaStop);
  checkRepo();
}
// plafond de quota (5 h / 7 jours) de la nouvelle session ; « reprise automatique » seulement avec un seuil
function setQuotaFields(q) {
  const f = $('#formNew');
  f.qFive.value = q?.five ? String(q.five) : ''; f.qSeven.value = q?.seven ? String(q.seven) : '';
  if (q?.five && !f.qFive.value) f.qFive.value = '95';
  if (q?.seven && !f.qSeven.value) f.qSeven.value = '95';
  f.qResume.checked = !!q?.resume;
  syncQuotaResume();
}
function quotaFields() {
  const f = $('#formNew'), five = Number(f.qFive.value) || null, seven = Number(f.qSeven.value) || null;
  return five || seven ? { five, seven, resume: f.qResume.checked } : null;
}
function syncQuotaResume() { const f = $('#formNew'); f.qResume.disabled = !f.qFive.value && !f.qSeven.value; if (f.qResume.disabled) f.qResume.checked = false; }
for (const n of ['qFive', 'qSeven']) $('#formNew')[n].addEventListener('change', syncQuotaResume);
// modèle d'extension avec « input » : un champ (numéros de tickets…) dont la valeur remplace {input} dans le premier message
function showTplInput(inp) {
  const f = $('#formNew'), row = $('#nsInputRow');
  row.hidden = !inp; f.input.value = ''; f.input.required = false;
  if (!inp) return;
  $('#nsInputLbl').textContent = inp.label || t('Valeur');
  f.input.placeholder = inp.placeholder || '';
  setTimeout(() => f.input.focus(), 0);
}
function firstPrompt(f) {
  const p = f.prompt.value.trim();
  if ($('#nsInputRow').hidden || !p.includes('{input}')) return p;
  const v = f.input.value.trim();
  return v ? p.replaceAll('{input}', () => v) : ''; // champ vide : pas de premier message, l'affichage propose la suite
}
$('#formNew').template.onchange = e => { const f = $('#formNew'); f.dataset.type = ''; showTplInput(null); applyTemplate([...templates, ...extTemplates].find(x => x.id === e.target.value)); };
let extTemplates = [];
async function loadExtTemplates() { try { extTemplates = await api('GET', '/api/extensions/templates'); } catch { extTemplates = []; } return extTemplates; }
// Worktree : proposé seulement dans un dépôt git ; nom de branche suggéré depuis le nom de la session.
let repoTimer = null;
// Indication sous le dossier : dépôt git (branche courante) ou non. r = réponse de suggest-branch, null = rien à dire.
function showGit(r) {
  const p = $('#cwdGit'); if (!p) return;
  p.hidden = !r; p.classList.toggle('repo', !!r?.repo);
  if (r) $('#cwdGitTxt').textContent = r.repo ? `${t('Dépôt git détecté')} · ${t('branche')} ${r.base}` : t('Pas un dépôt git');
}
function checkRepo() {
  clearTimeout(repoTimer);
  repoTimer = setTimeout(async () => {
    const f = $('#formNew');
    const cwd = f.cwd.value.trim(); if (!cwd) { $('#wtBox').hidden = true; showGit(null); return; }
    try {
      const r = await api('GET', `/api/git/suggest-branch?cwd=${encodeURIComponent(cwd)}&name=${encodeURIComponent(f.name.value || cwd.split(/[\\/]/).filter(Boolean).pop() || 'session')}`);
      showGit(r);
      $('#wtBox').hidden = !r.repo;
      if (!r.repo) { f.worktree.checked = false; return; }
      if (!f.branch.dataset.touched) f.branch.value = r.branch;
      $('#wtHint').textContent = f.worktree.checked ? `${t('Dossier')} : ${r.root}.worktrees/… · ${t('base')} : ${r.base}` : '';
    } catch { $('#wtBox').hidden = true; showGit(null); }
    $('#wtBranchRow').hidden = !f.worktree.checked;
  }, 250);
}
for (const n of ['cwd', 'name']) $('#formNew')[n].addEventListener('input', checkRepo);
$('#formNew').worktree.addEventListener('change', checkRepo);
$('#formNew').branch.addEventListener('input', e => { e.target.dataset.touched = '1'; });
$('#btnSaveTpl').onclick = async () => {
  const f = $('#formNew');
  const name = await askName(t('Nom du modèle'), f.name.value || f.cwd.value.split(/[\\/]/).filter(Boolean).pop() || t('Modèle'), t('Retrouvable dans « Modèle de session » et la palette (Ctrl+K).'), true);
  if (!name) { $('#dlgNew').returnValue = ''; return $('#dlgNew').showModal(); }
  const list = await loadTemplates();
  list.push({ name, cwd: f.cwd.value.trim(), model: f.model.value, mode: f.mode.value, extra: f.extra.value.trim(), worktree: f.worktree.checked, prompt: f.prompt.value, group: f.group.value.trim(), ...(quotaFields() ? { quotaStop: quotaFields() } : {}) });
  try { await api('PUT', '/api/templates', list); toast(`${t('Modèle enregistré')} : ${name}`); } catch (e) { toast(e.message, true); }
  if (!$('#dlgNew').open) { $('#dlgNew').returnValue = ''; $('#dlgNew').showModal(); }
};
$('#btnNew').onclick = () => openNew(); // (pas openNew directement : l'événement de clic serait pris pour un modèle)
$('#btnBrowse').onclick = async () => {
  const f = $('#formNew'), btn = $('#btnBrowse');
  btn.disabled = true; btn.textContent = t('Ouverture…');
  try {
    const initial = f.cwd.value.trim();
    // Application : boîte de dialogue native d'Electron ; navigateur : dialogue système ouvert par le serveur.
    const path = window.csmNative ? await window.csmNative.pickFolder(initial) : (await api('POST', '/api/pick-folder', { initial })).path;
    if (path) {
      f.cwd.value = path; checkRepo();
      if (!f.name.value.trim()) f.name.placeholder = path.split(/[\\/]/).filter(Boolean).pop() || t('(nom du dossier)');
    }
  } catch (e) { alert(`${t('Sélecteur indisponible')} : ${e.message}`); }
  finally { btn.disabled = false; btn.textContent = t('Parcourir…'); f.cwd.focus(); }
};
$('#dlgNew').addEventListener('close', async () => {
  if ($('#dlgNew').returnValue !== 'ok') return;
  const f = $('#formNew');
  const args = [f.model.value && `--model ${f.model.value}`, f.mode.value && `--permission-mode ${f.mode.value}`, f.extra.value.trim()].filter(Boolean).join(' ');
  const cwd = f.cwd.value.trim().replace(/^"|"$/g, '');
  LS.set('csm.lastCwd', cwd);
  const wantLock = f.lockpw.checked, cap = quotaFields();
  const body = { cwd, name: f.name.value.trim() || undefined, args, group: f.group.value.trim() || undefined, initialPrompt: firstPrompt(f) || undefined, remote: f.remote.checked, type: f.dataset.type || undefined };
  try {
    const s = f.worktree.checked && !$('#wtBox').hidden
      ? await api('POST', '/api/worktree/session', { ...body, branch: f.branch.value.trim() })
      : await api('POST', '/api/sessions', body);
    sessions.set(s.id, s); ensureTerm(s.id); select(s.id);
    if (cap) api('POST', `/api/sessions/${s.id}/quota-stop`, cap).catch(e => toast(`${t('Plafond de quota')} : ${e.message}`, true));
    if (wantLock) window.csmFeatures.setPassword?.(s.id); // même flux que « Verrouiller par mot de passe… »
  } catch (e) { alert(`${t('Création impossible')} : ${e.message}`); return; }
  delete f.branch.dataset.touched;
  askNotify();
});

// ------------------------------------------------------------------ historique
let histSel = 0;
function renderHistory() {
  const q = $('#histSearch').value.toLowerCase().trim();
  const items = historyCache.filter(h => !q || `${h.title} ${h.cwd} ${h.lastPrompt} ${h.branch || ''}`.toLowerCase().includes(q)).slice(0, 200);
  histSel = Math.min(histSel, Math.max(0, items.length - 1));
  const ul = $('#histList'); ul.innerHTML = '';
  items.forEach((h, i) => {
    const li = document.createElement('li');
    if (i === histSel) li.classList.add('sel');
    li.innerHTML = `<span class="t"></span><span class="d"></span><span class="c"></span><span class="d"></span><span class="p"></span>`;
    const [ti, d1, c, d2, p] = li.children;
    ti.textContent = h.title;
    if (h.managed) ti.insertAdjacentHTML('beforeend', `<span class="tag">${t('ouverte')}</span>`);
    const ren = document.createElement('button');
    ren.className = 'ren'; ren.textContent = '✎'; ren.title = t('Renommer');
    ren.onclick = e => { e.stopPropagation(); renameHistory(h); };
    ti.prepend(ren);
    d1.textContent = new Date(h.mtime).toLocaleString(LANG === 'en' ? 'en-GB' : 'fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    c.textContent = h.cwd || '';
    d2.textContent = h.branch || '';
    p.textContent = h.lastPrompt;
    li.onclick = () => resumeHistory(h);
    li.oncontextmenu = e => {
      e.preventDefault(); e.stopPropagation();
      histSel = i; [...ul.children].forEach((x, j) => x.classList.toggle('sel', j === i));
      showMenu([
        [h.managed ? 'Afficher' : 'Reprendre', () => resumeHistory(h), { kbd: 'Entrée' }],
        ['Renommer', () => renameHistory(h)],
        '-',
        ['Copier le chemin', () => clip.copy(h.cwd || ''), { disabled: !h.cwd }],
        ['Copier l’identifiant de session', () => clip.copy(h.id)],
      ], e.clientX, e.clientY);
    };
    ul.appendChild(li);
  });
  ul.children[histSel]?.scrollIntoView({ block: 'nearest' });
  return items;
}
async function renameHistory(h) {
  const name = await askName('Renommer la conversation', h.title);
  $('#histSearch').focus();
  if (!name) return;
  try { await api('POST', `/api/history/${h.id}/rename`, { name }); h.title = name; renderHistory(); }
  catch (err) { alert(`${t('Renommage impossible')} : ${err.message}`); }
}
async function openHistory() {
  $('#histSearch').value = ''; histSel = 0;
  $('#histList').innerHTML = `<li><span class="t">${t('Chargement…')}</span></li>`;
  $('#dlgHistory').showModal();
  $('#histSearch').focus();
  await loadHistory();
  renderHistory();
}
async function resumeHistory(h) {
  $('#dlgHistory').close();
  const existing = [...sessions.values()].find(s => s.claudeSessionId === h.id);
  if (existing) { select(existing.id); if (!existing.alive) api('POST', `/api/sessions/${existing.id}/restart`); return; }
  const s = await api('POST', '/api/sessions', { cwd: h.cwd, name: h.title.slice(0, 40), resume: h.id });
  sessions.set(s.id, s); ensureTerm(s.id); select(s.id);
}
$('#btnHistory').onclick = openHistory;
$('#histClose').onclick = () => $('#dlgHistory').close();
$('#histSearch').oninput = () => { histSel = 0; renderHistory(); };
$('#histSearch').onkeydown = e => {
  if (e.key === 'ArrowDown') { histSel++; renderHistory(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { histSel = Math.max(0, histSel - 1); renderHistory(); e.preventDefault(); }
  else if (e.key === 'Enter') { const it = renderHistory()[histSel]; if (it) resumeHistory(it); }
};
$('#dlgHistory').addEventListener('close', () => terms.get(active)?.term.focus());

// ------------------------------------------------------------------ sessions ouvertes dans un terminal
let external = [];
async function refreshExternal() {
  try { external = await api('GET', '/api/external'); } catch { return; }
  $('#ext').hidden = external.length === 0;
  $('#extCount').textContent = external.length ? `(${external.length})` : '';
  const ul = $('#extList'); ul.innerHTML = '';
  for (const x of external) {
    const li = document.createElement('li');
    li.title = `${x.cwd}\nPID ${x.pid} · ${x.status === 'busy' ? t('travaille') : t('prête')}\n${t('Cliquer pour la ramener dans csm')}`;
    li.innerHTML = `<span class="dot ${x.status === 'busy' ? 'working' : 'idle'}"></span><span class="n"></span><span class="k">${t('ramener')}</span><span class="sub"></span>`;
    li.querySelector('.n').textContent = x.title;
    li.querySelector('.sub').textContent = x.cwd;
    li.onclick = () => importExternal([x]);
    li.oncontextmenu = e => {
      e.preventDefault(); e.stopPropagation();
      showMenu([
        [t('Ramener dans csm…'), () => importExternal([x])],
        [t('Copier le chemin'), () => clip.copy(x.cwd)],
      ], e.clientX, e.clientY);
    };
    ul.appendChild(li);
  }
}
async function importExternal(items) {
  const busy = items.filter(x => x.status === 'busy');
  $('#impTitle').textContent = items.length > 1 ? `${t('Ramener')} ${items.length} ${t('sessions dans csm')}` : `${t('Ramener')} « ${items[0].title} »`;
  $('#impWarn').hidden = !busy.length;
  $('#impWarn').textContent = `⚠ ${busy.length > 1 ? `${busy.length} ${t('sessions travaillent')}` : t('Cette session travaille')} ${t('en ce moment : « Déplacer » l’arrête dans le terminal, puis la tâche reprend toute seule dans csm. « Copier » ne l’interrompt pas.')}`;
  const dlg = $('#dlgImport');
  dlg.returnValue = '';
  dlg.showModal();
  const mode = await new Promise(r => dlg.addEventListener('close', () => r(dlg.returnValue), { once: true }));
  if (mode !== 'move' && mode !== 'copy') return;
  $('#btnImportAll').disabled = true;
  try {
    const r = await api('POST', '/api/import', { items, mode });
    for (const s of r.done) { sessions.set(s.id, s); ensureTerm(s.id); }
    if (r.done[0]) select(r.done[0].id);
    if (r.errors.length) alert(r.errors.join('\n'));
  } catch (e) { alert(e.message); }
  finally { $('#btnImportAll').disabled = false; refreshExternal(); }
}
$('#btnImportAll').onclick = () => external.length && importExternal(external);
setInterval(refreshExternal, 5000);
refreshExternal();

// ------------------------------------------------------------------ raccourcis
function globalShortcut(e) {
  if (document.querySelector('dialog[open]')) return false; // pas de raccourci pendant une saisie
  // saisie dans un champ (hors terminal) : Ctrl+Alt+lettre peut y produire un caractère (AltGr), pas un raccourci
  const f = e.target instanceof Element ? e.target : document.activeElement;
  if (f && !f.closest('.xterm') && (f.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(f.tagName))) return false;
  const k = e.key.toLowerCase();
  const list = sorted();
  const idx = list.findIndex(s => s.id === active);
  if (k === 'n') { openNew(); return true; }
  if (k === 'h') { openHistory(); return true; }
  if (k === 'r') { startRename(); return true; }
  if (k === 'w') { $('#btnClose').click(); return true; }
  // Chiffres par touche physique (AZERTY : 1 = « & »). Un caractère AltGr (@ # { [ | \ ^ ] }) n'est pas un raccourci.
  const digit = /^Digit[1-9]$/.test(e.code) && (/^[0-9&é"'(\-è_çà]$/.test(e.key)) ? +e.code.slice(5) : 0;
  if (digit) { if (list[digit - 1]) select(list[digit - 1].id); return true; }
  if (e.key === 'ArrowDown' && list.length) { select(list[(idx + 1) % list.length].id); return true; }
  if (e.key === 'ArrowUp' && list.length) { select(list[(idx - 1 + list.length) % list.length].id); return true; }
  if (k === 'a') { const a = list.find(s => s.status === 'attention' && s.id !== active); if (a) select(a.id); return true; }
  if (k === 'g') { window.csmFeatures.togglePanel('changes'); return true; }
  if (k === 'p') { window.csmFeatures.togglePanel('prompts'); return true; }
  if (k === 'e' && active) { openIn(active, 'editor'); return true; }
  if (k === 'q' && active) { window.csmFeatures.openQueue(active); return true; }
  if (k === 'b') { window.csmFeatures.openBroadcast(); return true; }
  if (k === 'i') { window.csmFeatures.openAttention?.(); return true; }
  if (k === 'u') { window.csmFeatures.openUsage?.(); return true; }
  if (k === 'f') { document.body.classList.toggle('focusmode'); requestAnimationFrame(() => fitAll(true)); return true; }
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const vis = panes.slice(0, LAYOUTS[layout] || 1);
    if (vis.length > 1) { let i = focusedPane; do { i = (i + (e.key === 'ArrowRight' ? 1 : vis.length - 1)) % vis.length; } while (!vis[i] && i !== focusedPane); if (vis[i]) select(vis[i]); }
    return true;
  }
  return false;
}
document.addEventListener('keydown', e => { if (e.csmDone) { e.preventDefault(); return; } if (e.ctrlKey && e.altKey && globalShortcut(e)) e.preventDefault(); });
// Ctrl+K / Cmd+K : palette ; Ctrl+, : réglages ; Ctrl+Maj+F : recherche dans les sessions.
document.addEventListener('keydown', e => {
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'k' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); window.csmFeatures.openPalette(); }
  else if (e.key === ',') { e.preventDefault(); window.csmFeatures.openSettings(); }
  else if (k === 'f' && e.shiftKey) { e.preventDefault(); window.csmFeatures.openSearch(); }
}, true);

function askNotify() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}
document.addEventListener('click', askNotify, { once: true });

// Actions venant du menu de l'application (barre des tâches / de menus).
window.csmNative?.onAction(a => {
  if (a === 'new') openNew(); else if (a === 'history') openHistory(); else if (a === 'settings') window.csmFeatures.openSettings();
  else if (a.startsWith('select:') && sessions.has(a.slice(7))) select(a.slice(7)); // depuis le menu de l'icône
});

window.csmFeatures = {}; // rempli par panel.js, settings.js, palette.js
// polices embarquées chargées avant de mesurer les terminaux (sinon largeur des caractères fausse)
const fontsReady = (document.fonts?.load ? Promise.all(['400 13px "JetBrains Mono"', '500 13px "JetBrains Mono"', '400 14px "IBM Plex Sans"'].map(f => document.fonts.load(f))) : Promise.resolve()).catch(() => { });
// police arrivée après l'ouverture des terminaux : nouvelle mesure des caractères, puis ajustement
fontsReady.then(() => { for (const tt of terms.values()) { tt.term.options.fontFamily = tt.term.options.fontFamily; } fitAll(true); });
// fenêtre de nouveau visible (sortie de la zone de notification…) : terminaux réajustés et redessinés
document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(() => fitAll(true), 50); });
loadSettings().then(() => Promise.race([fontsReady, new Promise(r => setTimeout(r, 1500))])).finally(() => { connect(); setLayout(layout); window.dispatchEvent(new Event('csm:ready')); document.documentElement.dataset.ready = '1'; }); // réglages et langue définitifs (repère pour les tests)

// ------------------------------------------------------------------ version du serveur
// Le serveur survit aux mises à jour de l'app : s'il tourne un ancien code, les nouvelles routes manquent.
const UI_VERSION = document.querySelector('meta[name="csm-version"]')?.content || '';
async function checkServerVersion() {
  let server = '';
  try { server = (await api('GET', '/api/version')).version; } catch { server = ''; } // ancienne version : route absente
  // pilotage à distance : sans réponse, c'est le tunnel qui se reconnecte, pas une ancienne version du serveur
  if (!server && window.csmRemote) { $('#stale').hidden = true; return; }
  const expected = window.csmNative?.appVersion?.() || UI_VERSION;
  const stale = !server || (expected && server !== expected);
  $('#stale').hidden = !stale;
  if (!stale) return;
  $('#staleMsg').textContent = `${t('Le serveur tourne')} ${server ? t('la version') + ' ' + server : t('une ancienne version')}${expected ? ` (${t('application')} : ${expected})` : ''} : ${t('certaines fonctions ne marchent pas. Redémarrer le relance avec le bon code ; les sessions ouvertes reviennent toutes seules.')}`;
  $('#btnStale').hidden = !window.csmNative?.restartServer;
  if (!window.csmNative) $('#staleMsg').textContent += ` ${t('Commande')} : csm restart`;
}
$('#btnStale').onclick = async () => {
  $('#btnStale').disabled = true; $('#btnStale').textContent = t('Redémarrage…');
  const ok = await window.csmNative.restartServer();
  if (!ok) { $('#btnStale').disabled = false; $('#btnStale').textContent = t('Redémarrer le serveur'); toast(t('Le serveur ne redémarre pas — voir le journal'), true); }
};
