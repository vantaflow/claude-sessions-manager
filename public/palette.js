'use strict';
// Palette de commandes (#5), recherche dans les sessions (#19), envoi groupé (#18),
// file d'attente (#17), bibliothèque de prompts (#16).
(() => {
  const F = window.csmFeatures;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  let prompts = [];
  let extPrompts = []; // prompts des extensions actives (lecture seule)
  let skills = []; // skills de la session active (lib/skills.js)
  const loadPrompts = async () => {
    try { prompts = await api('GET', '/api/prompts'); } catch { prompts = []; }
    try { extPrompts = await api('GET', '/api/extensions/prompts'); } catch { extPrompts = []; }
    return prompts;
  };
  window.addEventListener('csm:prompts', e => { prompts = e.detail; });

  // Correspondance floue : toutes les lettres de la requête, dans l'ordre ; bonus début de mot / contiguïté.
  function score(q, text) {
    if (!q) return 1;
    const s = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    q = q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const direct = s.indexOf(q);
    if (direct >= 0) return 1000 - direct + (direct === 0 || /\W/.test(s[direct - 1]) ? 200 : 0);
    let i = 0, sc = 0, run = 0;
    for (const c of s) { if (c === q[i]) { i++; run++; sc += run; if (i === q.length) return sc; } else run = 0; }
    return 0;
  }

  // ---------------------------------------------------------------- palette
  const RECENT = LS.get('csm.recent', []);
  let items = [], sel = 0;
  let syncOn = false; // synchro configurée (action « Synchroniser maintenant »)
  // Icônes à traits (même style que public/index.html) : contenu des <svg> 24×24.
  const IC = {
    plus: '<path d="M12 5v14M5 12h14"/>', group: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3"/>', history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>', chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5"/>', diff: '<path d="M12 3v14M5 10h14"/><path d="M5 21h14"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', coin: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9a2.5 2 0 0 0-2.5-1.5c-1.4 0-2.5.8-2.5 2s1.1 1.7 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2A2.5 2 0 0 1 9.5 15M12 6v1.5M12 16.5V18"/>',
    l1: '<rect x="4" y="4" width="16" height="16" rx="2"/>', l2c: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 4v16"/>',
    l2r: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12h16"/>', l4: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 4v16M4 12h16"/>',
    focus: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="m15 10-2 2 2 2"/>',
    theme: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/>',
    pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>', log: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h7"/>',
    pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>', x: '<path d="M6 6l12 12M18 6 6 18"/>',
    ext: '<path d="M14 4h6v6"/><path d="M10 14 20 4"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', term: '<path d="m5 8 4 4-4 4M12 17h7"/>',
    queue: '<path d="M5 3h14M5 21h14M7 3v3a5 5 0 0 0 5 5 5 5 0 0 0 5-5V3M7 21v-3a5 5 0 0 1 5-5 5 5 0 0 1 5 5v3"/>',
    gauge: '<path d="M12 14l3-3"/><path d="M3.5 18a9 9 0 1 1 17 0"/>',
    down: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>', bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14-4L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14 4l2-2"/><path d="M20 20v-5h-5"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', note: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h5"/>',
    puzzle: '<path d="M10 4a2 2 0 1 1 4 0v2h4v4h-2a2 2 0 1 0 0 4h2v4h-4v-2a2 2 0 1 0-4 0v2H6v-4H4a2 2 0 1 1 0-4h2V6h4z"/>',
    session: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>', chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
    sync: '<path d="M20 11a8 8 0 0 0-14-4L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14 4l2-2"/><path d="M20 20v-5h-5"/>',
  };
  const svg = n => `<svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[n] || ''}</svg>`;
  // Texte sans accents, avec la correspondance position normalisée → position d'origine (pour le surlignage).
  function fold(text) {
    let out = ''; const map = [];
    for (let i = 0; i < text.length; i++) {
      const c = text[i].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      for (const ch of c) { out += ch; map.push(i); }
    }
    return { out, map };
  }
  // Remplit `el` avec `text`, le terme `q` entouré de <mark> : nœuds texte uniquement, jamais innerHTML.
  function highlight(el, text, q) {
    text = String(text ?? ''); el.textContent = '';
    const qq = q ? fold(q).out : '';
    const f = qq ? fold(text) : null;
    const at = f ? f.out.indexOf(qq) : -1;
    if (at < 0) { el.textContent = text; return; }
    const a = f.map[at], b = f.map[at + qq.length - 1] + 1;
    const m = document.createElement('mark'); m.textContent = text.slice(a, b);
    el.append(text.slice(0, a), m, text.slice(b));
  }
  const base = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
  const sessionSub = s => [base(s.cwd), s.worktree ? '⎇ ' + s.worktree.branch : '',
    s.origin && F.syncMachine && s.origin !== F.syncMachine ? `⇄ ${s.origin}` : ''].filter(Boolean).join(' · ');

  function actions() {
    const s = sessions.get(active);
    const a = [
      ['plus', t('Nouvelle session'), () => openNew(), `${MOD}+Alt+N`],
      ['group', t('Nouveau groupe'), () => newGroup()],
      ['key', t('Renouveler la connexion à Claude (/login)'), () => F.renewLogin?.()],
      ['history', t('Historique des conversations'), () => openHistory(), `${MOD}+Alt+H`],
      ['search', t('Rechercher dans toutes les sessions'), () => F.openSearch(), `${MOD}+Maj+F`],
      ['send', t('Envoyer à plusieurs sessions'), () => F.openBroadcast(), `${MOD}+Alt+B`],
      ['bell', t('Centre d’attention (demandes des sessions)'), () => F.openAttention?.(), `${MOD}+Alt+I`],
      ['chart', t('Usage de Claude (temps, coût, quota, tâches)'), () => F.openUsage?.(), `${MOD}+Alt+U`],
      ['book', t('Bibliothèque de prompts'), () => F.openPrompts(active)],
      ['diff', t('Panneau Modifications'), () => F.togglePanel('changes'), `${MOD}+Alt+G`],
      ['clock', t('Chronologie de la session'), () => F.showPanel('timeline')],
      ['coin', t('Consommation'), () => F.showPanel('usage')],
      ['l1', t('Disposition : une session'), () => setLayout('1')],
      ['l2c', t('Disposition : deux colonnes'), () => setLayout('2c')],
      ['l2r', t('Disposition : deux lignes'), () => setLayout('2r')],
      ['l4', t('Disposition : grille 2×2'), () => setLayout('4')],
      ['focus', t('Mode focus (masquer la barre latérale)'), () => { document.body.classList.toggle('focusmode'); requestAnimationFrame(() => fitAll(true)); }, `${MOD}+Alt+F`],
      ['sidebar', t('Barre latérale compacte'), () => saveSettings({ compactSidebar: !SETTINGS.compactSidebar })],
      ['theme', t('Thème : basculer clair / sombre'), () => saveSettings({ theme: themeName() === 'dark' ? 'light' : 'dark' })],
      ['gear', t('Réglages'), () => F.openSettings(), `${MOD}+,`],
      ['key', t('Coffre : PAT et secrets'), () => F.openVault?.()],
      ['sync', t('Piloter une autre machine'), () => F.openPilot?.()],
      ['pulse', t('Diagnostic'), () => F.openSettings('diag')],
      ['log', t('Journaux'), () => F.openSettings('logs')],
    ];
    if (window.csmNative?.toTray) a.push(['sidebar', trayLabel(), () => window.csmNative.toTray()]);
    if (syncOn) a.push(['sync', t('Synchroniser maintenant'), syncNow]);
    for (const g of groupNames()) a.push(
      ['pen', `${t('Renommer le groupe')} « ${gLabel(g)} »`, () => renameGroup(g)],
      ['plus', `${t('Nouveau sous-groupe')} « ${gLabel(g)} »`, () => newGroup(null, g)],
      ['x', `${t('Supprimer le groupe')} « ${gLabel(g)} »`, () => deleteGroup(g)],
    );
    if (s) a.push(
      ['pen', `${t('Renommer')} « ${s.name} »`, () => renameSession(s.id), `${MOD}+Alt+R`],
      ['ext', t('Ouvrir dans l’éditeur'), () => openIn(s.id, 'editor'), `${MOD}+Alt+E`],
      ['folder', IS_MAC ? t('Ouvrir dans le Finder') : t('Ouvrir dans l’Explorateur'), () => openIn(s.id, 'folder')],
      ['term', t('Ouvrir un terminal ici'), () => openIn(s.id, 'terminal')],
      ['queue', t('File d’attente de la session'), () => F.openQueue(s.id), `${MOD}+Alt+Q`],
      ['gauge', t('Plafond de quota de la session…'), () => F.openQuotaStop(s.id)],
      ['down', t('Exporter la conversation'), () => F.exportConversation(s)],
      ['bolt', t('Enregistrer la session comme modèle'), () => saveSessionAsTemplate(s.id)],
      ['phone', isRemote(s) ? t('Désactiver l’accès depuis l’app Claude') : t('Accès depuis l’app Claude (téléphone)'), () => setRemote(s.id, !isRemote(s))],
      ['refresh', s.alive ? t('Relancer la session') : t('Reprendre la session'), () => api('POST', `/api/sessions/${s.id}/restart`)],
      ['x', t('Fermer la session'), () => closeSession(s.id), `${MOD}+Alt+W`],
      ['🗑', t('Supprimer la session…'), () => deleteSession(s.id)],
      ['lock', s.locked ? t('Verrouiller maintenant') : t('Verrouiller par mot de passe…'), () => (s.locked ? F.lockNow(s.id) : F.setPassword(s.id)), `${MOD}+Alt+L`],
    );
    return a.map(([icon, label, run, kbd]) => ({ sec: 'action', icon, label, run, kbd }));
  }
  async function syncNow() {
    try { const st = await api('POST', '/api/sync/now'); toast(st.lastError ? `✗ ${st.lastError}` : t('Synchronisé'), !!st.lastError); }
    catch (e) { toast(e.message, true); }
  }
  // Ouvre une session dans un panneau de la vue partagée (2 colonnes si on est en disposition 1).
  function openInPane(id) {
    if (!sessions.has(id)) return;
    if (layout === '1') setLayout('2c');
    const n = LAYOUTS[layout] || 1;
    if (panes.slice(0, n).includes(id)) { select(id); return; }
    let k = -1;
    for (let i = 0; i < n; i++) if (!panes[i] || !sessions.has(panes[i])) { k = i; break; }
    if (k < 0) k = (focusedPane + 1) % n;
    panes[k] = id; focusedPane = k; select(id);
  }
  // Sections dans l'ordre d'affichage. « > » : actions seulement ; « / » : prompts seulement.
  const SECTIONS = [['session', 'Sessions', 15], ['action', 'Actions', 20], ['prompt', 'Prompts', 10], ['skill', 'Skills', 10], ['template', 'Modèles', 8], ['history', 'Conversations', 10]];
  async function build(raw) {
    const mode = raw[0] === '>' ? 'action' : raw[0] === '/' ? 'prompt' : raw[0] === '@' ? 'skill' : '';
    const q = (mode ? raw.slice(1) : raw).trim();
    const all = [
      ...sorted().map(s => ({ sec: 'session', id: s.id, icon: 'session', cls: s.status, label: s.name, sub: sessionSub(s), run: () => select(s.id), runPane: () => openInPane(s.id) })),
      ...actions(),
      ...prompts.map(p => ({ sec: 'prompt', icon: 'note', label: p.title, sub: p.text.slice(0, 90), run: () => insertPrompt(active, p) })),
      ...extPrompts.map(p => ({ sec: 'prompt', icon: 'puzzle', label: p.title, sub: `${p.extName} · ${p.text.slice(0, 80)}`, run: () => insertPrompt(active, p) })),
      ...skills.map(x => ({ sec: 'skill', icon: 'puzzle', label: x.command, sub: (x.plugin ? x.plugin + ' · ' : '') + x.description.slice(0, 110), run: () => F.useSkill?.(x.command) })),
      ...templates.map(x => ({ sec: 'template', icon: 'bolt', label: x.name, sub: x.cwd, run: () => openNew(x) })),
      ...(q.length >= 2 && !mode ? historyCache.filter(h => !h.managed).slice(0, 200).map(h => ({ sec: 'history', icon: 'chat', label: h.title, sub: `${h.cwd || ''} · ${new Date(h.mtime).toLocaleDateString()}`, run: () => resumeHistory(h) })) : []),
    ].filter(x => !mode || x.sec === mode);
    const scored = all.map(x => ({ ...x, q, sc: score(q, `${x.label} ${x.sub || ''}`) + (RECENT.indexOf(x.label) >= 0 ? 50 - RECENT.indexOf(x.label) : 0) })).filter(x => x.sc > 0);
    const out = [];
    for (const [sec, title, max] of SECTIONS) {
      const l = scored.filter(x => x.sec === sec).sort((a, b) => b.sc - a.sc).slice(0, max);
      if (l.length) out.push({ head: t(title), sec }, ...l);
    }
    return out;
  }
  const selectable = () => items.map((x, i) => (x.head ? -1 : i)).filter(i => i >= 0);
  async function renderPalette() {
    items = await build($('#palInput').value.trimStart());
    const ok = selectable();
    if (!ok.includes(sel)) sel = ok.find(i => i >= sel) ?? ok[ok.length - 1] ?? 0;
    const ul = $('#palList'); ul.textContent = '';
    for (let i = 0; i < items.length; i++) {
      const x = items[i], li = document.createElement('li');
      if (x.head) { li.className = 'palSec'; li.textContent = x.head; ul.append(li); continue; }
      li.dataset.i = i; li.className = i === sel ? 'sel' : '';
      const pi = document.createElement('span');
      if (x.sec === 'session') pi.className = `pi dot ${x.cls}`; else { pi.className = 'pi'; pi.innerHTML = svg(x.icon); } // icône interne (constante), pas du contenu externe
      const pl = document.createElement('span'); pl.className = 'pl';
      const lb = document.createElement('span'); lb.className = 'lb'; highlight(lb, x.label, x.q); pl.append(lb);
      if (x.sub) { const sm = document.createElement('small'); highlight(sm, x.sub, x.q); pl.append(sm); }
      const pk = document.createElement('span'); pk.className = 'pk';
      if (x.kbd) { const k = document.createElement('kbd'); k.textContent = x.kbd; pk.append(k); }
      li.append(pi, pl, pk);
      li.onmousedown = e => { e.preventDefault(); run(i, e.ctrlKey || e.metaKey); };
      ul.append(li);
    }
    if (!ok.length) { const li = document.createElement('li'); li.className = 'hint'; li.textContent = t('Aucun résultat'); ul.append(li); }
    ul.querySelector('li.sel')?.scrollIntoView({ block: 'nearest' });
    if (sel === ok[0]) ul.scrollTop = 0; // garde le titre de la première section visible
  }
  function move(d) {
    const ok = selectable(); if (!ok.length) return;
    const k = ok.indexOf(sel);
    sel = ok[Math.max(0, Math.min(ok.length - 1, (k < 0 ? 0 : k) + d))];
    renderPalette();
  }
  function run(i, pane) {
    const x = items[i]; if (!x || x.head) return;
    $('#dlgPalette').close();
    const ix = RECENT.indexOf(x.label); if (ix >= 0) RECENT.splice(ix, 1);
    RECENT.unshift(x.label); RECENT.length = Math.min(RECENT.length, 20); LS.set('csm.recent', RECENT);
    setTimeout(pane && x.runPane ? x.runPane : x.run, 0);
  }
  // Pied de palette : aides clavier (⌘ sur Mac).
  (() => {
    const foot = $('#palFoot'); if (!foot) return;
    const bits = [[['↑↓'], t('naviguer')], [['Entrée'], t('ouvrir')], [[IS_MAC ? '⌘' : 'Ctrl', 'Entrée'], t('dans un panneau')], [['>'], t('commandes')], [['/'], t('prompts')], [['@'], t('skills')]];
    bits.forEach(([keys, label]) => {
      const sp = document.createElement('span');
      for (const k of keys) { const e = document.createElement('kbd'); e.textContent = k; sp.append(e); }
      sp.append(` ${label}`); foot.append(sp);
    });
  })();
  F.openPalette = async () => {
    const d = $('#dlgPalette');
    if (d.open) { d.close(); return; }
    $('#palInput').value = ''; sel = 0;
    d.showModal(); $('#palInput').focus();
    loadTemplates(); loadPrompts();
    F.skillsFor?.(active).then(l => { skills = l || []; if (d.open) renderPalette(); }).catch(() => { }); if (!historyCache.length) loadHistory().then(renderPalette);
    api('GET', '/api/sync').then(st => { F.syncMachine = st.machine; const was = syncOn; syncOn = !!(st.enabled && !st.invalid); if (syncOn !== was && d.open) renderPalette(); }).catch(() => { });
    renderPalette();
  };
  $('#palInput').oninput = () => { sel = 0; renderPalette(); };
  $('#palInput').onkeydown = e => {
    if (e.key === 'ArrowDown') { move(1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { move(-1); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(sel, e.ctrlKey || e.metaKey); }
  };
  $('#dlgPalette').addEventListener('click', e => { if (e.target === $('#dlgPalette')) $('#dlgPalette').close(); });
  $('#dlgPalette').addEventListener('close', () => terms.get(active)?.term.focus());
  $('#btnPalette').onclick = () => F.openPalette();
  $('#palKbd').textContent = IS_MAC ? '⌘K' : 'Ctrl+K';

  // ---------------------------------------------------------------- recherche dans les terminaux ouverts
  F.openSearch = () => { $('#srchInput').value = ''; $('#srchList').innerHTML = ''; $('#dlgSearch').showModal(); $('#srchInput').focus(); };
  $('#srchClose').onclick = () => $('#dlgSearch').close();
  let srchTimer = null;
  $('#srchInput').oninput = () => { clearTimeout(srchTimer); srchTimer = setTimeout(doSearch, 150); };
  function doSearch() {
    const q = $('#srchInput').value.trim().toLowerCase();
    const out = [];
    if (q.length >= 2) for (const s of sorted()) {
      const tt = terms.get(s.id); if (!tt) continue;
      const b = tt.term.buffer.active;
      for (let y = 0; y < b.length && out.length < 300; y++) {
        const line = b.getLine(y)?.translateToString(true) || '';
        const i = line.toLowerCase().indexOf(q);
        if (i >= 0) out.push({ s, y, line, i });
      }
    }
    $('#srchList').innerHTML = out.length ? out.map((r, k) => `<li data-k="${k}"><b>${esc(r.s.name)}</b><code>${esc(r.line.slice(Math.max(0, r.i - 40), r.i))}<mark>${esc(r.line.substr(r.i, q.length))}</mark>${esc(r.line.slice(r.i + q.length, r.i + q.length + 80))}</code></li>`).join('')
      : q.length >= 2 ? `<li class="hint">${t('Aucun résultat dans les terminaux ouverts.')}</li>` : '';
    $('#srchList').querySelectorAll('li[data-k]').forEach(li => {
      li.onclick = () => {
        const r = out[+li.dataset.k];
        $('#dlgSearch').close(); select(r.s.id);
        requestAnimationFrame(() => { const tt = terms.get(r.s.id); tt.term.scrollToLine(Math.max(0, r.y - 5)); tt.term.select(r.i, r.y, q.length); });
      };
    });
  }

  // ---------------------------------------------------------------- variables de prompt
  function fill(text, id) {
    const s = sessions.get(id);
    const sel = terms.get(id)?.term.getSelection() || '';
    return text.replace(/\{dossier\}|\{folder\}/g, s?.cwd || '').replace(/\{branche\}|\{branch\}/g, s?.worktree?.branch || '')
      .replace(/\{nom\}|\{name\}/g, s?.name || '').replace(/\{selection\}/g, sel);
  }
  // Insère dans la ligne de saisie de Claude sans valider (l'utilisateur relit puis Entrée).
  function insertPrompt(id, p) {
    if (!id) return;
    const tt = terms.get(id); if (!tt) return;
    select(id);
    tt.term.paste(fill(p.text, id));
    tt.term.focus();
  }

  // ---------------------------------------------------------------- bibliothèque de prompts
  let prTarget = null;
  F.openPrompts = async id => {
    prTarget = id || active;
    $('#prSearch').value = '';
    $('#dlgPrompts').showModal(); $('#prSearch').focus();
    await loadPrompts(); renderPrompts();
  };
  $('#prClose').onclick = () => $('#dlgPrompts').close();
  $('#prSearch').oninput = () => renderPrompts();
  $('#prNew').onclick = () => editPrompt(null);
  function renderPrompts() {
    const q = $('#prSearch').value.trim();
    const list = prompts.map((p, i) => ({ p, i, sc: score(q, `${p.title} ${p.tags} ${p.text}`) })).filter(x => x.sc > 0).sort((a, b) => b.sc - a.sc);
    $('#prList').innerHTML = list.length ? list.map(({ p, i }) => `<li data-i="${i}"><div><b>${esc(p.title)}</b>${p.tags ? `<span class="tag">${esc(p.tags)}</span>` : ''}<small>${esc(p.text.slice(0, 160))}</small></div>
      <span class="acts"><button data-a="use" class="primary">${t('Insérer')}</button><button data-a="send">${t('Envoyer')}</button><button data-a="edit">✎</button></span></li>`).join('')
      : `<li class="hint">${prompts.length ? t('Aucun résultat') : t('Aucun prompt. « + Nouveau » pour en créer un (ex. « Relis les modifications et propose des tests »).')}</li>`;
    $('#prList').querySelectorAll('li[data-i]').forEach(li => {
      const p = prompts[+li.dataset.i];
      li.querySelector('[data-a=use]').onclick = () => { $('#dlgPrompts').close(); insertPrompt(prTarget, p); };
      li.querySelector('[data-a=send]').onclick = () => { $('#dlgPrompts').close(); sendTo([prTarget], fill(p.text, prTarget), true); };
      li.querySelector('[data-a=edit]').onclick = () => editPrompt(+li.dataset.i);
    });
  }
  async function editPrompt(i) {
    const p = i == null ? { title: '', text: '', tags: '' } : prompts[i];
    $('#peTitle').value = p.title; $('#peText').value = p.text; $('#peTags').value = p.tags || '';
    $('#peDelete').hidden = i == null;
    const d = $('#dlgPromptEdit'); d.returnValue = ''; d.showModal(); $('#peTitle').focus();
    const r = await new Promise(res => d.addEventListener('close', () => res(d.returnValue), { once: true }));
    if (r === 'delete') prompts.splice(i, 1);
    else if (r === 'ok') {
      const v = { ...p, title: $('#peTitle').value.trim(), text: $('#peText').value, tags: $('#peTags').value.trim() };
      if (i == null) prompts.push(v); else prompts[i] = v;
    } else return;
    try { prompts = await api('PUT', '/api/prompts', prompts); } catch (e) { toast(e.message, true); }
    renderPrompts();
  }
  $('#peDelete').onclick = () => { if (confirm(t('Supprimer ce prompt ?'))) $('#dlgPromptEdit').close('delete'); };

  // ---------------------------------------------------------------- envoi (direct ou file d'attente)
  async function sendTo(ids, text, queueIfBusy) {
    let n = 0;
    for (const id of ids) {
      const s = sessions.get(id); if (!s) continue;
      try {
        if (queueIfBusy && s.status !== 'idle') await api('PUT', `/api/sessions/${id}/queue`, [...(s.queue || []), { text }]);
        else await api('POST', `/api/sessions/${id}/prompt`, { text });
        n++;
      } catch (e) { toast(`${s.name} : ${e.message}`, true); }
    }
    if (n) toast(`${t('Envoyé à')} ${n} ${t(n > 1 ? 'sessions' : 'session')}`);
  }

  F.sendTo = sendTo;
  F.openBroadcast = () => {
    const alive = sorted().filter(s => s.alive);
    $('#bcList').innerHTML = alive.map(s => `<label class="check"><input type="checkbox" value="${s.id}" ${visibleIds().includes(s.id) ? 'checked' : ''}> <span class="dot ${s.status}"></span> <span>${esc(s.name)}</span></label>`).join('')
      || `<p class="hint">${t('Aucune session active.')}</p>`;
    $('#bcText').value = ''; $('#bcQueue').checked = true;
    const d = $('#dlgBroadcast'); d.returnValue = ''; d.showModal(); $('#bcText').focus();
    d.addEventListener('close', () => {
      if (d.returnValue !== 'ok') return;
      const ids = [...$('#bcList').querySelectorAll('input:checked')].map(x => x.value);
      if (ids.length) sendTo(ids, $('#bcText').value, $('#bcQueue').checked);
    }, { once: true });
  };

  // ---------------------------------------------------------------- file d'attente
  let qId = null;
  F.openQueue = id => {
    qId = id; const s = sessions.get(id); if (!s) return;
    $('#qName').textContent = s.name; $('#qNew').value = '';
    renderQueue(); $('#dlgQueue').showModal(); $('#qNew').focus();
  };
  function renderQueue() {
    const s = sessions.get(qId); const q = s?.queue || [];
    $('#qList').innerHTML = q.length ? q.map((x, i) => `<li data-i="${i}"><span>${esc(x.text.slice(0, 300))}</span><span class="acts">
      <button class="icon" data-a="up" title="${t('Monter')}" ${i ? '' : 'disabled'}>↑</button><button class="icon" data-a="del" title="${t('Retirer')}">✕</button></span></li>`).join('')
      : `<li class="hint">${t('File vide.')}</li>`;
    $('#qList').querySelectorAll('li[data-i]').forEach(li => {
      const i = +li.dataset.i;
      li.querySelector('[data-a=del]').onclick = () => saveQueue(q.filter((_, k) => k !== i));
      li.querySelector('[data-a=up]').onclick = () => { const c = q.slice(); [c[i - 1], c[i]] = [c[i], c[i - 1]]; saveQueue(c); };
    });
  }
  async function saveQueue(q) {
    try { const v = await api('PUT', `/api/sessions/${qId}/queue`, q); sessions.set(qId, v); renderQueue(); render(); } catch (e) { toast(e.message, true); }
  }
  $('#qAdd').onclick = () => {
    const text = $('#qNew').value.trim(); if (!text) return;
    $('#qNew').value = '';
    saveQueue([...(sessions.get(qId)?.queue || []), { text }]);
  };
  $('#qNew').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#qAdd').click(); } });
  $('#curQueue').onclick = () => active && F.openQueue(active);
  window.addEventListener('csm:session', e => { if ($('#dlgQueue').open && e.detail.s.id === qId) renderQueue(); });
})();
