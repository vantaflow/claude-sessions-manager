'use strict';
// Réglages (#6), modèles de session (#14), diagnostic (#7), journaux (#23), mises à jour (#3), assistant (#25).
(() => {
  const F = window.csmFeatures;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const dlg = $('#dlgSettings');

  function page(name) {
    dlg.querySelectorAll('.setNav [data-st]').forEach(b => b.classList.toggle('on', b.dataset.st === name));
    dlg.querySelectorAll('.setPages > section').forEach(s => { s.hidden = s.dataset.st !== name; });
    if (name === 'diag') loadDiag();
    if (name === 'logs') loadLogs();
    if (name === 'templates') renderTemplates();
    if (name === 'schedules') renderSchedules();
    if (name === 'memory') renderMemory();
    if (name === 'about') renderAbout();
    if (name === 'sync') loadSync();
    if (name === 'general') api('GET', '/api/sync').then(renderEngine).catch(() => { });
  }
  dlg.querySelectorAll('.setNav [data-st]').forEach(b => { b.onclick = () => page(b.dataset.st); });
  $('#setClose').onclick = () => dlg.close();
  dlg.addEventListener('close', () => terms.get(active)?.term.focus());

  // Champs data-set="clé" liés aux réglages du serveur, enregistrés à chaque changement.
  function fill() {
    dlg.querySelectorAll('[data-set]').forEach(el => {
      const v = SETTINGS[el.dataset.set];
      if (el.type === 'checkbox') el.checked = !!v; else if (el.type === 'radio') el.checked = el.value === v; else el.value = v ?? '';
    });
    $('#editorCmdRow').hidden = SETTINGS.editor !== 'custom';
  }
  dlg.querySelectorAll('[data-set]').forEach(el => {
    el.addEventListener('change', () => {
      const k = el.dataset.set;
      const v = el.type === 'checkbox' ? el.checked : el.type === 'number' || typeof SETTINGS[k] === 'number' ? Number(el.value) : el.value;
      saveSettings({ [k]: v });
      if (k === 'memoryEngine') api('GET', '/api/sync').then(renderEngine).catch(() => { });
      // réglages lus par Claude Code au démarrage : proposer de relancer les sessions ouvertes
      if (['replyLanguage', 'memoryEngine', 'autoCompactWindow', 'statusLine', 'commitSignature'].includes(k)) setTimeout(offerApply, 400);
      if (k === 'editor') $('#editorCmdRow').hidden = v !== 'custom';
      if (k === 'fontSize') { LS.set('csm.font', v); for (const tt of terms.values()) tt.term.options.fontSize = v; fitAll(); }
      if (k === 'notifications' && v && 'Notification' in window) Notification.requestPermission();
      if (k === 'lang') setTimeout(() => location.reload(), 300);
      if (k.startsWith('sync')) setTimeout(() => syncNow(), 300);
    });
  });
  // Plugins Claude Code reçus d'une autre machine : à installer (ou désinstaller) après validation
  async function renderPlugins() {
    let v; try { v = await api('GET', '/api/sync/plugins'); } catch { return; }
    $('#plugPending').hidden = !v.pending.length;
    const ul = $('#plugList'); ul.replaceChildren();
    for (const p of v.pending) {
      const li = document.createElement('li');
      const txt = document.createElement('div');
      const b = document.createElement('b'); b.textContent = `${p.action === 'uninstall' ? t('Désinstaller') : t('Installer')} ${p.plugin}`;
      const sm = document.createElement('small'); sm.textContent = ` ${p.repo} · ${t('depuis')} ${p.from || '?'}${p.error ? ` · ${t('Échec')} : ${p.error}` : ''}`;
      txt.append(b, sm);
      const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'primary'; ok.textContent = p.action === 'uninstall' ? t('Désinstaller') : t('Installer');
      const no = document.createElement('button'); no.type = 'button'; no.textContent = t('Ignorer');
      const go = apply => async () => {
        ok.disabled = no.disabled = true; ok.textContent = apply ? t('En cours…') : ok.textContent;
        try { await api('POST', '/api/sync/plugins/decide', { uid: p.uid, apply }); toast(apply ? t('Fait : redémarre les sessions pour charger le plugin') : t('Ignoré')); }
        catch (e) { toast(e.message, true); }
        renderPlugins();
      };
      ok.onclick = go(true); no.onclick = go(false);
      li.append(txt, ok, no); ul.append(li);
    }
  }
  window.addEventListener('csm:sync', () => renderPlugins());
  document.querySelector('.setNav [data-st=sync]')?.addEventListener('click', renderPlugins);
  // pas encore de code : curseur dans le champ « J'ai déjà un code », prêt à coller
  document.querySelector('.setNav [data-st=sync]')?.addEventListener('click', () => setTimeout(() => { if (!$('#syncSetup').hidden) $('#syncJoinCode').focus(); }, 60));
  $('#soundTest').onclick = () => playSound($('[data-set=sound]').value);
  // Notification de test : par l'app (natif) ou, dans un navigateur, par l'API Notification
  $('#notifTest').onclick = async () => {
    const out = $('#notifTestResult');
    if (window.csmNative?.notifyTest) {
      const r = await window.csmNative.notifyTest();
      out.textContent = !r ? '' : r.how === 'native'
        ? t('Envoyée. Rien ne s’affiche ? Vérifie les notifications de Claude Sessions dans les réglages du système (et le mode Ne pas déranger / Concentration).')
        : r.how === 'applescript'
          ? t('Envoyée par macOS (via « Éditeur de script ») : l’app n’est pas signée par Apple, macOS refuse ses propres notifications. Autorise « Éditeur de script » dans Réglages Système › Notifications.')
          : t('Notifications non prises en charge par ce système.');
      return;
    }
    if (!('Notification' in window)) { out.textContent = t('Notifications non prises en charge par ce système.'); return; }
    if (Notification.permission !== 'granted') await Notification.requestPermission();
    if (Notification.permission === 'granted') { new Notification('Claude Sessions', { body: t('Notification de test : si tu la vois, tout fonctionne.') }); out.textContent = t('Envoyée.'); }
    else out.textContent = t('Refusée par le navigateur : autorise les notifications pour ce site.');
  };

  F.openSettings = async (which = 'general') => {
    fill();
    dlg.querySelectorAll('.app-only').forEach(el => { el.hidden = !window.csmNative; });
    try {
      const eds = await api('GET', '/api/editors');
      const sel = $('#setEditor');
      sel.innerHTML = `<option value="auto">${t('Automatique')}</option>` + eds.map(e => `<option value="${e.id}">${esc(e.label)}</option>`).join('') + `<option value="custom">${t('Commande personnalisée…')}</option>`;
      sel.value = SETTINGS.editor || 'auto';
    } catch { }
    if (!dlg.open) dlg.showModal();
    page(which);
  };
  $('#btnSettings').onclick = () => F.openSettings();
  $('#openPrompts').onclick = () => { dlg.close(); F.openPrompts(active); };

  // ---------------------------------------------------------------- modèles
  async function renderTemplates() {
    const list = await loadTemplates();
    const ul = $('#tplList');
    if (!list.length) {
      ul.innerHTML = `<li class="empty"><div><b>${t('Aucun modèle pour l’instant.')}</b><small>${t('Un modèle relance en un clic une session type : même dossier, groupe, modèle Claude, mode, worktree et premier prompt.')}</small></div>
        <span class="acts">${active ? `<button data-a="from" class="primary">${t('Créer depuis la session active')}</button>` : ''}<button data-a="new">${t('Nouvelle session…')}</button></span></li>`;
      ul.querySelector('[data-a=from]')?.addEventListener('click', async () => { await saveSessionAsTemplate(active); renderTemplates(); });
      ul.querySelector('[data-a=new]').onclick = () => { dlg.close(); openNew(); };
      return;
    }
    ul.innerHTML = list.map((x, i) => `<li data-i="${i}"><div><b>${esc(x.name)}</b><small>${esc(x.cwd)}${x.worktree ? ' · ⎇ worktree' : ''}${x.model ? ' · ' + esc(x.model) : ''}${x.group ? ' · ' + esc(x.group) : ''}</small></div>
      <span class="acts"><button data-a="run">${t('Lancer')}</button><button data-a="ren">${t('Renommer')}</button><button data-a="del" class="danger">${t('Supprimer')}</button></span></li>`).join('');
    ul.querySelectorAll('li[data-i]').forEach(li => {
      const x = list[+li.dataset.i];
      li.querySelector('[data-a=run]').onclick = () => { dlg.close(); openNew(x); };
      li.querySelector('[data-a=ren]').onclick = async () => { const n = await askName(t('Renommer le modèle'), x.name, ' '); if (n) { x.name = n; await api('PUT', '/api/templates', list); renderTemplates(); } };
      li.querySelector('[data-a=del]').onclick = async () => { if (!confirm(`${t('Supprimer le modèle')} « ${x.name} » ?`)) return; list.splice(+li.dataset.i, 1); await api('PUT', '/api/templates', list); renderTemplates(); };
    });
  }

  // ---------------------------------------------------------------- synchronisation (#27)
  // Pas de code : « Créer un code » (le serveur le génère et l'enregistre) ou « J'ai déjà un code ».
  // Avec un code : affiché en clair, copiable, pour le saisir sur les autres machines.
  const count = (n, label) => n ? ` · ${t(label)} : ${n}` : '';
  const memInfo = st => (!st.memory ? ''
    : st.memAvailable === false ? ` · ${t('claude-mem introuvable sur cette machine')}`
    : count(st.memReceived, 'mémoire reçue') + count(st.memSent, 'mémoire envoyée'))
    + count(st.nmReceived, 'résumés reçus') + count(st.nmSent, 'résumés envoyés')
    + count(st.cfReceived, 'fichiers de Claude reçus') + count(st.cfSent, 'fichiers de Claude envoyés');
  const ENGINE_HINT = "Une seule mémoire à la fois, seulement pour les sessions lancées par l'app. Avec la synchro, le même choix s'applique à toutes les machines.";
  function renderEngine(st) {
    const el = $('#memEngineInfo');
    if (!el || !st) return;
    $('#memSuggest').hidden = st.memSuggest !== 'claude-mem' || SETTINGS.memoryEngine === 'claude-mem';
    if (SETTINGS.memoryEngine === 'off') { el.textContent = t('Mémoire désactivée : choisis-en une pour l’activer.'); return; }
    const mi = st.memInstall || '';
    el.textContent = t(ENGINE_HINT) + (st.memEngine !== 'claude-mem' ? ''
      : mi === 'installing' ? ' · ' + t('installation de claude-mem…')
      : mi.startsWith('error') ? ' · ' + t('installation de claude-mem impossible') + mi.slice(5)
      : st.memInstalled ? ' · ' + t('claude-mem installé') : '');
  }
  function renderSync(st) {
    if (!st) return;
    renderEngine(st);
    $('#machinesBox').hidden = !st.enabled;
    if (st.enabled && !dlg.querySelector('section[data-st=sync]').hidden) renderMachines();
    $('#cfWarning').hidden = !st.cfWarning;
    $('#cfWarning').textContent = st.cfWarning ? t('{n} fichiers de Claude ont disparu d’un coup : leur suppression n’est pas envoyée aux autres machines. Vérifie ~/.claude.').replace('{n}', st.cfWarning) : '';
    $('#cfPendingCount').textContent = st.cfPending ? `(${st.cfPending} ${t('à valider')})` : '';
    if (st.cfPending && !$('#cfReview').open) $('#cfReview').open = true;
    if ($('#cfReview').open) renderClaudeSync();
    F.syncMachine = st.machine;
    $('#syncMachine').placeholder = st.machine;
    $('#syncServer').placeholder = st.server;
    $('#syncSetup').hidden = st.enabled;
    $('#syncOn').hidden = !st.enabled;
    $('#syncCodeShow').textContent = st.code || '';
    if (!st.enabled) setCodeShown(false);
    const got = (st.received || 0) + (st.memReceived || 0) + (st.nmReceived || 0) + (st.cfReceived || 0);
    $('#syncRecv').textContent = st.enabled && got ? `${got} ${t('éléments reçus')}` : '';
    const when = st.lastOk ? new Date(st.lastOk).toLocaleTimeString() : '';
    $('#syncStatus').textContent = st.invalid ? t('Code de synchro invalide : vérifie qu’il a bien 20 caractères (XXXX-XXXX-XXXX-XXXX-XXXX).')
      : !st.enabled ? t('Synchronisation désactivée.')
      : st.lastError ? `✗ ${st.lastError}`
      : st.lastOk ? `✓ ${t('Synchronisé')} · ${when}${st.pending ? ` · ${st.pending} ${t('en attente')}` : ''}${memInfo(st)}`
      : t('Synchronisation…');
    $('#syncStatus').classList.toggle('bad', !!(st.invalid || st.lastError));
  }
  async function loadSync() { try { renderSync(await api('GET', '/api/sync')); } catch (e) { $('#syncStatus').textContent = e.message; } }
  async function syncNow() {
    $('#syncStatus').textContent = t('Synchronisation…');
    try { renderSync(await api('POST', '/api/sync/now')); } catch (e) { $('#syncStatus').textContent = e.message; }
  }
  async function useCode(code) { await saveSettings({ syncCode: code }); await syncNow(); }
  $('#syncNow').onclick = syncNow;
  // code masqué par défaut (le texte reste dans l'élément, c'est le CSS qui le cache)
  function setCodeShown(on) {
    $('#syncCodeShow').classList.toggle('masked', !on);
    const b = $('#syncReveal'); b.textContent = t(on ? 'Masquer' : 'Afficher'); b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  $('#syncReveal').onclick = () => setCodeShown($('#syncCodeShow').classList.contains('masked'));
  $('#machAdd').onclick = () => { setCodeShown(true); $('#syncOn').scrollIntoView({ block: 'center' }); $('#syncReveal').focus(); };
  $('#syncCopy').onclick = () => clip.copy($('#syncCodeShow').textContent).then(() => toast(t('Code copié : saisis-le dans Réglages › Synchronisation sur ton autre machine. Ne le partage avec personne d’autre.')));
  $('#syncOff').onclick = async () => {
    if (!confirm(t('Désactiver la synchronisation sur cette machine ? Les sessions restent ici. Garde ton code si tu veux la réactiver.'))) return;
    await useCode('');
  };
  $('#syncNew').onclick = async () => {
    const b = $('#syncNew'); b.disabled = true;
    $('#syncStatus').textContent = t('Création du code…');
    try { const r = await api('POST', '/api/sync/code'); await useCode(r.code); }
    catch (e) { $('#syncStatus').textContent = `✗ ${e.message}`; $('#syncStatus').classList.add('bad'); }
    finally { b.disabled = false; }
  };
  $('#syncJoin').onclick = async () => {
    const code = $('#syncJoinCode').value.trim();
    if (!code) return $('#syncJoinCode').focus();
    await useCode(code);
    if (!$('#syncOn').hidden) $('#syncJoinCode').value = '';
  };
  $('#syncJoinCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('#syncJoin').click(); });
  window.addEventListener('csm:sync', e => { if (dlg.open) renderSync(e.detail); });
  window.addEventListener('csm:ready', () => api('GET', '/api/sync').then(st => { F.syncMachine = st.machine; render(); }).catch(() => { }));

  // ---------------------------------------------------------------- diagnostic et journaux
  let diagText = '';
  async function loadDiag() {
    const out = $('#diagOut'); out.textContent = t('Chargement…');
    try {
      const d = await api('GET', '/api/diag');
      const app = window.csmNative?.appVersion?.();
      diagText = [
        `Claude Sessions ${app || d.app} (${t('serveur')} ${d.app}, ${d.runtime})`,
        `${t('Système')} : ${d.platform}`,
        `claude : ${d.claude.ok ? '✓ ' + d.claude.version : '✗ ' + t('introuvable ou en erreur')} — ${d.claude.path}`,
        `git : ${d.git.ok ? '✓ ' + d.git.version : '✗ ' + t('introuvable (worktrees et panneau Modifications indisponibles)')}`,
        `hooks : ${d.hooks.ok ? '✓' : '✗'} ${d.hooks.file}`,
        `${t('Données')} : ${d.data}`,
        `${t('Code')} : ${d.code}`,
        `${t('Sessions')} : ${d.sessions.alive}/${d.sessions.total} ${t('actives')} · ${t('mémoire')} ${d.memory} Mo · ${t('en service depuis')} ${Math.round(d.uptime / 60)} min`,
        '', `— ${t('dernières lignes du journal')} —`, d.logTail,
      ].join('\n');
      out.textContent = diagText;
      out.classList.toggle('bad', !d.claude.ok);
    } catch (e) { out.textContent = e.message; }
  }
  $('#diagRefresh').onclick = loadDiag;
  $('#diagCopy').onclick = () => clip.copy('```\n' + diagText + '\n```').then(() => toast(t('Rapport copié — à coller dans une issue GitHub')));

  let logText = '';
  async function loadLogs() {
    try { logText = (await api('GET', '/api/logs?lines=2000')).text; } catch (e) { logText = e.message; }
    renderLogs();
  }
  function renderLogs() {
    const q = $('#logFilter').value.toLowerCase();
    const lines = logText.split('\n').filter(l => !q || l.toLowerCase().includes(q));
    const out = $('#logOut');
    out.innerHTML = lines.map(l => `<span class="${/erreur|error|uncaught|échec|✗/i.test(l) ? 'lerr' : /\[maj\]/.test(l) ? 'lupd' : ''}">${esc(l)}</span>`).join('\n');
    out.scrollTop = out.scrollHeight;
  }
  $('#logFilter').oninput = renderLogs;
  $('#logRefresh').onclick = loadLogs;

  // ---------------------------------------------------------------- réglages de lancement changés
  async function offerApply() {
    let st; try { st = await api('GET', '/api/apply-settings'); } catch { return; }
    if (!st.count) return;
    const msg = t('{n} session(s) ouverte(s) utilisent encore l’ancien réglage (Claude Code ne le lit qu’au démarrage). Les relancer maintenant ? La conversation reprend là où elle en était ; une session en plein travail sera relancée dès qu’elle aura fini.').replace('{n}', st.count);
    if (!confirm(msg)) return;
    try { const r = await api('POST', '/api/apply-settings'); toastMsg(t('{a} relancée(s), {b} à la fin de leur tour').replace('{a}', r.now).replace('{b}', r.later)); } catch (e) { alert(e.message); }
  }
  const toastMsg = m => (typeof toast === 'function' ? toast(m) : null);

  // ---------------------------------------------------------------- demandes programmées (lib/schedule.js)
  const DAYS = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
  const schF = $('#schForm');
  schF.querySelector('.schDays').insertAdjacentHTML('beforeend', [1, 2, 3, 4, 5, 6, 0].map(d => `<label class="check"><input type="checkbox" name="day" value="${d}"> <span>${t(DAYS[d])}</span></label>`).join(''));
  const schToggle = () => {
    const tpl = schF.target.value === 'template';
    schF.querySelector('[data-for=session]').hidden = tpl;
    schF.querySelector('[data-for=template]').hidden = !tpl;
    schF.querySelector('[data-for=once]').hidden = [...schF.querySelectorAll('[name=day]:checked')].length > 0;
  };
  schF.target.onchange = schToggle;
  schF.addEventListener('change', e => { if (e.target.name === 'day') schToggle(); });
  let schedules = [];
  async function renderSchedules() {
    schedules = await api('GET', '/api/schedules');
    const tpls = await loadTemplates();
    schF.session.innerHTML = [...sessions.values()].map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    schF.template.innerHTML = tpls.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
    const d = new Date(); // date locale (pas UTC)
    if (!schF.date.value) schF.date.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    schToggle();
    const what = x => x.target === 'template' ? `▶ ${esc(tpls.find(y => y.id === x.template)?.name || t('modèle supprimé'))}` : `→ ${esc(sessions.get(x.session)?.name || t('session supprimée'))}`;
    const when = x => `${x.time} · ${x.days.length ? x.days.map(d => t(DAYS[d])).join(' ') : x.date}`;
    $('#schList').innerHTML = schedules.length ? schedules.map((x, i) => `<li data-i="${i}"><div><b>${esc(x.name || x.text.slice(0, 60) || t('Sans nom'))}</b><small>${when(x)} · ${what(x)}${x.next ? ' · ' + t('prochaine') + ' ' + esc(new Date(x.next).toLocaleString()) : ''}${x.lastResult ? ' · ' + esc(t(x.lastResult)) : ''}</small></div>
      <span class="acts"><label class="check"><input type="checkbox" data-a="on" ${x.enabled ? 'checked' : ''}></label><button data-a="run">${t('Lancer')}</button><button data-a="del" class="danger">${t('Supprimer')}</button></span></li>`).join('')
      : `<li class="empty"><small>${t('Aucune demande programmée.')}</small></li>`;
    $('#schList').querySelectorAll('li[data-i]').forEach(li => {
      const i = +li.dataset.i;
      li.querySelector('[data-a=on]').onchange = e => saveSchedules(schedules.map((x, j) => j === i ? { ...x, enabled: e.target.checked } : x));
      li.querySelector('[data-a=run]').onclick = async () => { await api('POST', `/api/schedules/${schedules[i].id}/run`); renderSchedules(); };
      li.querySelector('[data-a=del]').onclick = () => saveSchedules(schedules.filter((_, j) => j !== i));
    });
  }
  async function saveSchedules(list) { schedules = await api('PUT', '/api/schedules', list); renderSchedules(); }
  schF.onsubmit = e => {
    e.preventDefault();
    const days = [...schF.querySelectorAll('[name=day]:checked')].map(c => +c.value);
    const x = { name: schF.name.value.trim(), target: schF.target.value, session: schF.session.value, template: schF.template.value, text: schF.text.value, time: schF.time.value, days, date: schF.date.value, enabled: true };
    if (x.target === 'session' && !x.text.trim()) return alert(t('Écris le prompt à envoyer.'));
    saveSchedules([...schedules, x]);
    schF.name.value = ''; schF.text.value = '';
  };
  window.addEventListener('csm:schedules', () => { if (dlg.open && !dlg.querySelector('section[data-st=schedules]').hidden) renderSchedules(); });

  // ---------------------------------------------------------------- machines de l'espace de synchro
  const OS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
  // unités binaires, comme la limite du serveur (1 Go = 1024 Mo) : « 94 Mo sur 1 Go »
  const fmtMB = b => { const m = b / 1048576; return m >= 1024 ? (m / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' Go' : Math.max(0.1, m).toLocaleString(undefined, { maximumFractionDigits: m >= 100 ? 0 : 1 }) + ' Mo'; };
  const PART_LABEL = { conversations: 'Conversations', config: 'Configuration de Claude', claudemem: 'claude-mem', memory: 'Mémoire intégrée' };
  let machinesAt = 0;
  async function renderMachines(force) {
    if (!force && Date.now() - machinesAt < 5000) return;
    machinesAt = Date.now();
    let d; try { d = await api('GET', '/api/sync/machines'); } catch { return; }
    const u = d.usage;
    $('#usageBar').hidden = !u;
    if (u) {
      $('#usageBar span').style.width = Math.min(100, u.bytes / u.max * 100).toFixed(1) + '%';
      const detail = Object.entries(u.parts || {}).sort((a, b) => b[1].bytes - a[1].bytes).map(([k, p]) => `${t(PART_LABEL[k] || k)} ${fmtMB(p.bytes)} (${p.n})`).join(' · ');
      $('#usageBar small').textContent = `${t('Place sur le serveur de synchro')} : ${fmtMB(u.bytes)} ${t('sur')} ${fmtMB(u.max)} · ${u.sessions} ${t('sessions')}${detail ? '\n' + detail : ''}`;
    }
    const nm = d.machines.length;
    $('#syncMachCount').textContent = `${nm} ${t(nm > 1 ? 'machines' : 'machine')}`;
    const mine = { win32: 'ce PC', darwin: 'ce Mac' };
    $('#machineList').textContent = '';
    for (const m of d.machines) {
      const li = document.createElement('li'); li.dataset.id = m.id; if (m.me) li.classList.add('me');
      const box = document.createElement('div');
      const b = document.createElement('b'); b.textContent = m.name;
      if (m.me) { const tag = document.createElement('span'); tag.className = 'meTag'; tag.textContent = t(mine[m.platform] || 'cette machine'); b.append(' ', tag); }
      const sm = document.createElement('small');
      sm.textContent = `${OS[m.platform] || m.platform || '?'} · v${m.version || '?'} · ${t('mémoire')} ${m.engine === 'claude-mem' ? 'claude-mem' : m.engine === 'off' ? t('désactivée') : t('intégrée')}${m.seen ? ' · ' + t('vue') + ' ' + new Date(m.seen).toLocaleString() : ''}`;
      box.append(b, sm); li.append(box);
      if (!m.me) { const acts = document.createElement('span'); acts.className = 'acts'; const x = document.createElement('button'); x.dataset.a = 'del'; x.textContent = t('Retirer'); acts.append(x); li.append(acts); }
      $('#machineList').append(li);
    }
    $('#machineList').querySelectorAll('[data-a=del]').forEach(b => {
      b.onclick = async () => { await api('DELETE', `/api/sync/machines/${b.closest('li').dataset.id}`); renderMachines(true); };
    });
  }
  $('#syncRotate').onclick = async () => {
    if (!confirm(t('Changer de code ? Un nouveau code est créé, tout part de cette machine vers le nouvel espace, et l’ancien est effacé du serveur : les machines restées sur l’ancien code ne se synchronisent plus jusqu’à ce que tu y saisisses le nouveau.'))) return;
    const b = $('#syncRotate'); b.disabled = true; b.textContent = t('Changement en cours…');
    try {
      const r = await api('POST', '/api/sync/rotate', {});
      SETTINGS.syncCode = r.code;
      alert(t('Nouveau code (à saisir sur tes autres machines, Réglages › Synchronisation › J’ai déjà un code) :') + '\n\n' + r.code);
      loadSync();
    } catch (e) { alert(e.message); }
    finally { b.disabled = false; b.textContent = t('Changer de code (couper l’accès d’une machine)…'); renderMachines(true); }
  };

  // ---------------------------------------------------------------- mémoire (fiches, notes de Claude Code, claude-mem)
  let memTimer = null;
  ['#memQ', '#memProject', '#memMachine', '#memSrc'].forEach(sel => $(sel).addEventListener(sel === '#memQ' ? 'input' : 'change', () => { clearTimeout(memTimer); memTimer = setTimeout(renderMemory, 250); }));
  const when = x => x ? new Date(x).toLocaleString() : '';
  async function renderMemory() {
    const src = $('#memSrc').value, q = encodeURIComponent($('#memQ').value.trim());
    $('#memProject').hidden = $('#memMachine').hidden = src !== 'cards';
    $('#memEdit').hidden = true;
    const ul = $('#memList');
    try {
      if (src === 'cards') {
        const d = await api('GET', `/api/memory/cards?q=${q}&project=${encodeURIComponent($('#memProject').value)}&machine=${encodeURIComponent($('#memMachine').value)}`);
        const keep = (sel, list, all) => { const v = $(sel).value; $(sel).innerHTML = `<option value="">${t(all)}</option>` + list.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join(''); $(sel).value = list.includes(v) ? v : ''; };
        keep('#memProject', d.projects, 'Tous les dossiers'); keep('#memMachine', d.machines, 'Toutes les machines');
        ul.innerHTML = d.items.length ? d.items.map(e => `<li data-id="${esc(e.id)}"><div><b>${esc(e.title)}</b><small>${e.note ? '📌 ' + esc(e.note.slice(0, 80)) + ' · ' : ''}${esc(e.project || '?')} · ${esc(e.machine || '?')} · ${esc(when(e.updated))} · ${e.prompts} ${t('demandes')}</small></div></li>`).join('')
          : `<li class="empty"><small>${d.enabled ? t('Aucune fiche.') : t('La mémoire intégrée n’est pas la mémoire choisie (Réglages › Général).')}</small></li>`;
        ul.querySelectorAll('li[data-id]').forEach(li => { li.onclick = () => editCard(li.dataset.id); });
      } else if (src === 'notes') {
        const d = await api('GET', `/api/memory/notes?q=${q}`);
        ul.innerHTML = d.length ? d.map((n, i) => `<li data-i="${i}"><div><b>${esc(n.p.split('/').slice(3).join('/'))}</b><small>${esc(n.project)} · ${esc(when(n.mtime))} · ${esc(n.text.slice(0, 100))}</small></div></li>`).join('')
          : `<li class="empty"><small>${t('Aucune note de Claude Code.')}</small></li>`;
        ul.querySelectorAll('li[data-i]').forEach(li => { li.onclick = () => editNote(d[+li.dataset.i]); });
      } else {
        const d = await api('GET', `/api/memory/claude-mem?q=${q}`);
        ul.innerHTML = d.items.length ? d.items.map(o => `<li><div><b>${esc(o.title || o.type || '')}</b><small>${esc(o.project || '')} · ${esc(when(o.at))} · ${esc(o.text)}</small></div></li>`).join('')
          : `<li class="empty"><small>${d.available ? t('Rien trouvé.') : t('claude-mem n’est pas utilisé par l’app sur cette machine.')}</small></li>`;
      }
    } catch (e) { ul.innerHTML = `<li class="empty"><small>${esc(e.message)}</small></li>`; }
  }
  async function editCard(id) {
    const e = await api('GET', `/api/memory/cards/${id}`), box = $('#memEdit');
    box.hidden = false;
    box.innerHTML = `<label>${t('Titre')} <input name="title" maxlength="120" value="${esc(e.title)}"></label>
      <label>${t('À retenir (donné à Claude en premier dans ce dossier)')} <textarea name="note" rows="3" maxlength="4000">${esc(e.note)}</textarea></label>
      <div class="acts"><button data-a="save" class="primary">${t('Enregistrer')}</button><button data-a="forget" class="danger">${t('Oublier cette fiche')}</button><button data-a="close">${t('Fermer')}</button></div>
      <small>${esc(e.project || '')} · ${esc(e.machine || '')}${e.branch ? ' · ' + esc(e.branch) : ''} · ${esc(when(e.updated))}</small>
      <b>${t('Demandes')}</b><ul data-k="p">${e.prompts.map((p, i) => `<li><span>${esc(p.text)}</span><button data-i="${i}" title="${t('Retirer')}">✕</button></li>`).join('')}</ul>
      <b>${t('Réponses de Claude')}</b><ul data-k="a">${e.answers.map((a, i) => `<li><span>${esc(a)}</span><button data-i="${i}" title="${t('Retirer')}">✕</button></li>`).join('')}</ul>
      ${e.files.length ? `<b>${t('Fichiers modifiés')}</b><small>${e.files.map(esc).join(', ')}</small>` : ''}`;
    box.querySelector('[data-a=save]').onclick = async () => { await api('PATCH', `/api/memory/cards/${id}`, { title: box.querySelector('[name=title]').value, note: box.querySelector('[name=note]').value }); renderMemory(); };
    box.querySelector('[data-a=forget]').onclick = async () => { if (!confirm(t('Oublier cette fiche ? Elle ne sera plus donnée à Claude, ici ni sur tes autres machines.'))) return; await api('PATCH', `/api/memory/cards/${id}`, { forget: true }); renderMemory(); };
    box.querySelector('[data-a=close]').onclick = () => { box.hidden = true; };
    box.querySelectorAll('ul[data-k] button').forEach(b => {
      b.onclick = async () => {
        const k = b.closest('ul').dataset.k, i = +b.dataset.i;
        await api('PATCH', `/api/memory/cards/${id}`, k === 'p' ? { dropPrompt: e.prompts[i].text } : { dropAnswer: e.answers[i] });
        editCard(id);
      };
    });
    box.scrollIntoView({ block: 'nearest' });
  }
  function editNote(n) {
    const box = $('#memEdit');
    box.hidden = false;
    box.innerHTML = `<b>${esc(n.p)}</b><textarea name="text" rows="12">${esc(n.text)}</textarea>
      <div class="acts"><button data-a="save" class="primary">${t('Enregistrer')}</button><button data-a="del" class="danger">${t('Supprimer')}</button><button data-a="close">${t('Fermer')}</button></div>
      <small>${t('Une copie de la version actuelle est gardée 30 jours (claude-sync-backup). Le changement suit la synchro de ~/.claude.')}</small>`;
    box.querySelector('[data-a=save]').onclick = async () => { await api('PUT', '/api/memory/notes', { p: n.p, text: box.querySelector('[name=text]').value }); renderMemory(); };
    box.querySelector('[data-a=del]').onclick = async () => { if (!confirm(t('Supprimer cette note ?'))) return; await api('PUT', '/api/memory/notes', { p: n.p, delete: true }); renderMemory(); };
    box.querySelector('[data-a=close]').onclick = () => { box.hidden = true; };
  }

  // ---------------------------------------------------------------- configuration de Claude reçue
  // À valider (appliquer / refuser) et journal des changements reçus (restaurer la version remplacée).
  const ACTION = { created: 'créé', replaced: 'remplacé', deleted: 'supprimé', pending: 'en attente', rejected: 'refusé', restored: 'restauré', refused: 'refusé (chemin interdit)', linked: 'ignoré (lien)' };
  async function renderClaudeSync() {
    let d; try { d = await api('GET', '/api/claude-sync'); } catch { return; }
    const when = x => new Date(x).toLocaleString();
    $('#cfApplyAll').hidden = $('#cfRejectAll').hidden = !d.pending.length;
    $('#cfPendingList').innerHTML = d.pending.length ? d.pending.map(x => `<li data-uid="${esc(x.uid)}"><div><b>${esc(x.p)}</b><small>${x.del ? t('suppression') : `${Math.ceil(x.size / 1024)} Ko`} · ${esc(x.from || '?')} · ${esc(when(x.at))}</small></div>
      <span class="acts"><button data-a="ok" class="primary">${t('Appliquer')}</button><button data-a="no">${t('Refuser')}</button></span></li>`).join('')
      : `<li class="empty"><small>${t('Rien à valider.')}</small></li>`;
    $('#cfPendingList').querySelectorAll('li[data-uid]').forEach(li => li.querySelectorAll('button').forEach(b => {
      b.onclick = async () => { try { await api('POST', '/api/claude-sync/decide', { uids: [li.dataset.uid], apply: b.dataset.a === 'ok' }); } catch (e) { alert(t(e.message)); } renderClaudeSync(); };
    }));
    $('#cfLogList').innerHTML = d.log.slice(0, 50).map(x => `<li data-id="${esc(x.id)}"><div><b>${esc(x.p)}</b><small>${t(ACTION[x.action] || x.action)}${x.from ? ' · ' + esc(x.from) : ''} · ${esc(when(x.at))}</small></div>
      ${x.backup ? `<span class="acts"><button data-a="restore">${t('Restaurer')}</button></span>` : ''}</li>`).join('') || `<li class="empty"><small>${t('Aucun changement reçu pour l’instant.')}</small></li>`;
    $('#cfLogList').querySelectorAll('button[data-a=restore]').forEach(b => {
      b.onclick = async () => {
        const li = b.closest('li');
        if (!confirm(t('Remettre la version d’avant ce changement ? (la version actuelle est copiée d’abord)'))) return;
        try { await api('POST', '/api/claude-sync/restore', { id: li.dataset.id }); } catch (e) { alert(e.message); }
        renderClaudeSync();
      };
    });
  }
  $('#cfReview').addEventListener('toggle', () => { if ($('#cfReview').open) renderClaudeSync(); });
  $('#cfApplyAll').onclick = async () => { try { await api('POST', '/api/claude-sync/decide', { apply: true }); } catch (e) { alert(t(e.message)); } renderClaudeSync(); };
  $('#cfRejectAll').onclick = async () => { if (confirm(t('Refuser tous les fichiers reçus ? Les versions de cette machine restent.'))) { await api('POST', '/api/claude-sync/decide', { apply: false }); renderClaudeSync(); } };
  $('#memSuggestBtn').onclick = () => { saveSettings({ memoryEngine: 'claude-mem' }); SETTINGS.memoryEngine = 'claude-mem'; fill(); };
  // réglages changés ailleurs (autre machine, autre fenêtre) pendant que la boîte est ouverte
  window.addEventListener('csm:settings', () => { if (dlg.open) { fill(); api('GET', '/api/sync').then(renderEngine).catch(() => { }); } });

  // ---------------------------------------------------------------- à propos / mises à jour
  let upd = null;
  const UPD_LABEL = {
    dev: 'Version de développement : mises à jour automatiques désactivées.', store: 'Version Microsoft Store : les mises à jour sont installées par le Store.', idle: '', checking: 'Recherche de mises à jour…',
    uptodate: 'Claude Sessions est à jour.', disabled: 'Mises à jour automatiques désactivées dans les réglages.',
    downloading: 'Téléchargement de la version {v}… {p}', ready: 'Version {v} prête : elle s’installe en quittant l’app, ou toute seule dès que la fenêtre est en arrière-plan.',
    available: 'Version {v} disponible au téléchargement.', error: 'Échec de la vérification : {e}',
  };
  const updText = st => t(st.status === 'ready' && st.later === st.version ? 'Version {v} prête, reportée : installe-la quand tu veux avec « Redémarrer pour mettre à jour ».' : UPD_LABEL[st.status] || '').replace('{v}', st.version || '').replace('{p}', st.progress ? st.progress + ' %' : '').replace('{e}', st.error || '');
  function renderAbout() {
    $('#aboutVersion').textContent = window.csmNative?.appVersion?.() || document.querySelector('meta[name="csm-version"]').content;
    $('#updateStatus').textContent = upd ? updText(upd) : (window.csmNative ? '' : t('Dans le navigateur : mettre à jour avec git pull puis csm restart.'));
    $('#updateCheck').hidden = !window.csmNative?.update;
    // version téléchargée : redémarrer tout de suite (sessions relancées avec leur conversation)
    const rs = $('#updateRestart');
    rs.hidden = !window.csmNative?.update || !upd || !['ready', 'available'].includes(upd.status);
    if (!rs.hidden) rs.textContent = upd.status === 'ready' ? t('Redémarrer pour mettre à jour') : t('Télécharger');
  }
  function onUpdate(st) {
    upd = st;
    const bar = $('#updateBar');
    // « Plus tard » : bulle fermée pour cette version (reproposée par une version plus récente ou au prochain lancement)
    bar.hidden = !(st.status === 'ready' || st.status === 'available') || (!!st.version && st.later === st.version) || laterHere === st.version;
    $('#btnUpdateLater').hidden = !window.csmNative?.update;
    $('#updateMsg').textContent = updText(st);
    $('#btnUpdate').textContent = st.status === 'ready' ? t('Redémarrer pour mettre à jour') : t('Télécharger');
    if (dlg.open) renderAbout();
  }
  $('#btnUpdate').onclick = $('#updateRestart').onclick = () => window.csmNative?.update('install');
  let laterHere = null; // version « Disponible » (pas encore téléchargée) écartée dans cette fenêtre
  $('#btnUpdateLater').onclick = async () => {
    $('#updateBar').hidden = true;
    laterHere = upd?.version || null;
    const st = await window.csmNative?.update('later');
    if (st) onUpdate(st);
  };
  $('#updateCheck').onclick = async () => { $('#updateStatus').textContent = t('Recherche de mises à jour…'); onUpdate(await window.csmNative.update('check')); };
  if (window.csmNative?.onUpdate) { window.csmNative.onUpdate(onUpdate); window.csmNative.update('state').then(st => st && onUpdate(st)); }

  // ---------------------------------------------------------------- assistant de premier lancement
  // Machine neuve : Claude Code absent (commande d'installation à copier) ou pas connecté à un compte
  // (connexion depuis l'app) ; « Vérifier de nouveau » relit l'état sans redémarrer quoi que ce soit.
  async function checkInstall() {
    const box = $('#welcomeCheck');
    box.innerHTML = `<p class="hint">${t('Vérification de l’installation…')}</p>`;
    let r;
    try { r = await api('GET', '/api/diag'); } catch (e) { box.textContent = e.message; return; }
    const c = r.claude, rows = [], todo = !c.ok || c.auth?.loggedIn === false;
    if (c.ok) rows.push(`<div class="ok">✓ Claude Code ${esc(c.version)}</div>`);
    else rows.push(`<div class="bad">✗ ${t('Claude Code n’est pas installé sur cette machine.')}</div>`,
      `<div class="fix"><span>${t('Pour l’installer, colle cette commande dans')} ${IS_MAC ? 'Terminal' : 'PowerShell'} :</span><code>${esc(c.install || '')}</code><button type="button" data-a="copy">${t('Copier')}</button></div>`);
    if (c.auth?.loggedIn === false) rows.push(`<div class="bad">✗ ${t('Claude Code n’est pas connecté à ton compte Claude.')}</div>`,
      `<div class="fix"><button type="button" class="primary" data-a="login">${t('Se connecter à Claude')}</button></div>`);
    else if (c.auth?.loggedIn) rows.push(`<div class="ok">✓ ${t('Connecté à Claude')}</div>`);
    rows.push(`<div class="${r.git.ok ? 'ok' : 'bad'}">${r.git.ok ? '✓ ' + esc(r.git.version) : '✗ ' + t('git introuvable : worktrees et panneau Modifications indisponibles (facultatif).')}</div>`);
    if (todo) rows.push(`<div class="fix"><button type="button" data-a="recheck">${t('Vérifier de nouveau')}</button></div>`);
    box.innerHTML = rows.join('');
    box.dataset.todo = todo ? '1' : '';
    box.querySelector('[data-a=copy]')?.addEventListener('click', () => { clip.copy(c.install); toast(t('Commande copiée')); });
    box.querySelector('[data-a=recheck]')?.addEventListener('click', checkInstall);
    box.querySelector('[data-a=login]')?.addEventListener('click', () => {
      window.csmFeatures.renewLogin?.();
      $('#dlgAuth').addEventListener('close', () => { if ($('#dlgWelcome').open) checkInstall(); }, { once: true });
    });
  }
  async function welcome() {
    if (SETTINGS.onboarded) return;
    if (sessions.size) { saveSettings({ onboarded: true }); return; } // déjà utilisé : pas d'assistant
    const d = $('#dlgWelcome');
    d.showModal();
    await checkInstall();
    const choice = await new Promise(res => d.addEventListener('close', () => res(d.returnValue), { once: true }));
    saveSettings({ onboarded: true });
    if (choice === 'ok') {
      const cwd = $('#welcomeCwd').value.trim();
      if (cwd) { try { const s = await api('POST', '/api/sessions', { cwd, args: SETTINGS.defaultModel ? `--model ${SETTINGS.defaultModel}` : '' }); sessions.set(s.id, s); ensureTerm(s.id); select(s.id); } catch (e) { alert(e.message); } }
      else openNew();
    }
  }
  $('#welcomeBrowse').onclick = async () => {
    const p = window.csmNative ? await window.csmNative.pickFolder('') : (await api('POST', '/api/pick-folder', { initial: '' }).catch(() => ({}))).path;
    if (p) $('#welcomeCwd').value = p;
  };
  window.addEventListener('csm:ready', () => setTimeout(welcome, 800));
})();
