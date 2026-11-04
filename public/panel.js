'use strict';
// Panneau latéral : Modifications (#12), Chronologie (#21), Consommation (#20) ; export (#24) et groupes (#13).
(() => {
  const F = window.csmFeatures;
  let tab = LS.get('csm.panelTab', 'changes');
  let open = LS.get('csm.panelOpen', false);
  let gitState = null, selFile = null, busy = false;

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const fmtN = n => n >= 1e6 ? (n / 1e6).toFixed(1) + ' M' : n >= 1e3 ? (n / 1e3).toFixed(1) + ' k' : String(n || 0);
  const fmt$ = n => (n || 0) < 0.01 ? '< 0,01 $' : (n || 0).toFixed(2).replace('.', ',') + ' $';

  function setOpen(v, which) {
    open = v; if (which) tab = which;
    LS.set('csm.panelOpen', open); LS.set('csm.panelTab', tab);
    $('#panel').hidden = !open;
    document.querySelectorAll('.ptabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    for (const n of ['changes', 'timeline', 'usage', 'prompts', 'memory']) $(`#tab-${n}`).hidden = n !== tab;
    $('#btnChanges').classList.toggle('on', open && tab === 'changes');
    requestAnimationFrame(() => fitAll(true));
    if (open) refresh();
  }
  F.showPanel = which => setOpen(true, which);
  F.togglePanel = which => setOpen(!(open && tab === which), which);
  $('#btnChanges').onclick = () => F.togglePanel('changes');
  $('#panelClose').onclick = () => setOpen(false);
  document.querySelectorAll('.ptabs [data-tab]').forEach(b => { b.onclick = () => setOpen(true, b.dataset.tab); });

  function refresh() {
    if (F.isLockedHere?.(active)) {
      $('#changesCount').textContent = t('Modifications'); $('#btnChanges').classList.remove('has');
      for (const n of ['changes', 'timeline', 'usage', 'prompts', 'memory']) $(`#tab-${n}`).innerHTML = `<p class="hint">🔒 ${t('Session verrouillée')}</p>`;
      return;
    }
    if (tab === 'changes' || !open) loadChanges(); // compteur de la barre toujours à jour
    if (!open) return;
    if (tab === 'timeline') loadTimeline();
    if (tab === 'usage') loadUsage();
    if (tab === 'prompts') loadPrompts();
    if (tab === 'memory') loadMemory();
  }

  // ---------------------------------------------------------------- Modifications
  async function loadChanges() {
    const id = active; if (!id) return;
    try { gitState = await api('GET', `/api/sessions/${id}/git`); } catch (e) { gitState = { error: e.message }; }
    if (id !== active) return;
    const n = gitState?.files?.length || 0;
    $('#changesCount').textContent = gitState?.repo ? (n ? `${n} ${t(n > 1 ? 'modifications' : 'modification')}` : t('Aucune modification')) : t('Modifications');
    $('#btnChanges').classList.toggle('has', n > 0);
    if (open && tab === 'changes') renderChanges();
  }

  function renderChanges() {
    const el = $('#tab-changes');
    const st = gitState;
    if (!st) { el.innerHTML = `<p class="hint">${t('Chargement…')}</p>`; return; }
    if (st.error) { el.innerHTML = `<p class="err">${esc(st.error)}</p>`; return; }
    if (!st.repo) { el.innerHTML = `<p class="hint">${t('Le dossier de cette session n’est pas un dépôt git.')}</p>`; return; }
    const s = sessions.get(active);
    const files = st.files;
    el.innerHTML = `
      <div class="gitHead">
        <span class="branch">⎇ ${esc(st.branch)}</span>
        ${st.ahead != null ? `<span class="hint">↑${st.ahead} ↓${st.behind}</span>` : ''}
        <span class="spacer"></span>
        <button class="icon" data-act="refresh" title="${t('Actualiser')}">⟳</button>
      </div>
      ${s?.worktree ? `<div class="wtInfo">${t('Worktree dédié')} · ${t('base')} <b>${esc(s.worktree.base)}</b>
        <button data-act="merge">${t('Fusionner dans')} ${esc(s.worktree.base)}</button></div>` : ''}
      ${files.length ? `<ul class="files">${files.map((f, i) => `
        <li data-i="${i}" class="${f.path === selFile ? 'sel' : ''}">
          <span class="fst st-${f.index === '?' ? 'new' : f.state === 'supprimé' ? 'del' : 'mod'}" title="${esc(f.state)}${f.staged ? ' · ' + t('indexé') : ''}">${f.index === '?' ? 'N' : f.state === 'supprimé' ? 'S' : f.state === 'renommé' ? 'R' : 'M'}</span>
          <span class="fp" title="${esc(f.path)}">${esc(f.path.split('/').pop())}<small>${esc(f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '')}</small></span>
          <button class="icon" data-act="discard" title="${t('Annuler les modifications de ce fichier')}">↺</button>
        </li>`).join('')}</ul>
        <div class="commit">
          <textarea id="commitMsg" rows="2" placeholder="${t('Message du commit')}" spellcheck="false"></textarea>
          <div class="row"><button data-act="suggest">${t('Proposer un message')}</button><span class="spacer"></span><button class="primary" data-act="commit">${t('Committer tout')} (${files.length})</button></div>
        </div>
        <div id="diffView" class="diff">${selFile ? '' : `<p class="hint">${t('Cliquer un fichier pour voir le diff.')}</p>`}</div>`
        : `<p class="hint">${t('Aucune modification dans ce dossier.')}</p>`}`;
    el.querySelectorAll('.files li').forEach(li => {
      li.onclick = e => { if (e.target.closest('button')) return; showDiff(files[+li.dataset.i].path); };
      li.querySelector('[data-act=discard]').onclick = () => discard(files[+li.dataset.i]);
    });
    el.querySelector('[data-act=refresh]').onclick = () => loadChanges();
    el.querySelector('[data-act=commit]')?.addEventListener('click', commit);
    el.querySelector('[data-act=suggest]')?.addEventListener('click', suggest);
    el.querySelector('[data-act=merge]')?.addEventListener('click', merge);
    if (selFile && files.some(f => f.path === selFile)) showDiff(selFile, true);
  }

  async function showDiff(p, keep) {
    selFile = p;
    if (!keep) $('#tab-changes').querySelectorAll('.files li').forEach(li => li.classList.toggle('sel', gitState.files[+li.dataset.i].path === p));
    const box = $('#diffView'); if (!box) return;
    try {
      const { diff } = await api('GET', `/api/sessions/${active}/git/diff?path=${encodeURIComponent(p)}`);
      box.innerHTML = `<div class="dfile">${esc(p)}</div><pre>${diff.split('\n').map(l => {
        const c = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') ? 'dh' : l.startsWith('@@') ? 'dat' : l.startsWith('+') ? 'dadd' : l.startsWith('-') ? 'ddel' : '';
        return `<span class="${c}">${esc(l)}</span>`;
      }).join('\n') || t('(fichier binaire ou vide)')}</pre>`;
    } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  }

  async function discard(f) {
    if (!confirm(`${t('Annuler toutes les modifications de')} ${f.path} ?${f.index === '?' ? '\n' + t('Le fichier (non suivi) sera supprimé.') : ''}`)) return;
    try { await api('POST', `/api/sessions/${active}/git/discard`, { paths: [f.path] }); if (selFile === f.path) selFile = null; loadChanges(); }
    catch (e) { toast(e.message, true); }
  }

  function suggest() {
    const files = gitState.files;
    const add = files.filter(f => f.index === '?' || f.state === 'ajouté').map(f => f.path.split('/').pop());
    const del = files.filter(f => f.state === 'supprimé').map(f => f.path.split('/').pop());
    const mod = files.filter(f => !add.includes(f.path.split('/').pop()) && f.state !== 'supprimé').map(f => f.path.split('/').pop());
    const parts = [];
    if (mod.length) parts.push(`${t('Modifie')} ${mod.slice(0, 3).join(', ')}${mod.length > 3 ? '…' : ''}`);
    if (add.length) parts.push(`${t('ajoute')} ${add.slice(0, 3).join(', ')}${add.length > 3 ? '…' : ''}`);
    if (del.length) parts.push(`${t('supprime')} ${del.slice(0, 3).join(', ')}${del.length > 3 ? '…' : ''}`);
    const s = sessions.get(active);
    $('#commitMsg').value = (parts.join(', ') || t('Mise à jour')).replace(/^./, c => c.toUpperCase()) + (s ? `\n\n${t('Session')} : ${s.name}` : '');
    $('#commitMsg').focus();
  }

  async function commit() {
    const msg = $('#commitMsg').value.trim();
    if (!msg) { suggest(); return; }
    busy = true;
    try { await api('POST', `/api/sessions/${active}/git/commit`, { message: msg, all: true }); toast(t('Commit créé')); selFile = null; loadChanges(); }
    catch (e) { toast(e.message, true); } finally { busy = false; }
  }

  async function merge() {
    const s = sessions.get(active); if (!s?.worktree) return;
    if (!confirm(`${t('Fusionner la branche')} ${s.worktree.branch} ${t('dans')} ${s.worktree.base} ?`)) return;
    try { await api('POST', `/api/sessions/${active}/worktree/merge`); toast(`${t('Fusionné dans')} ${s.worktree.base}`); loadChanges(); }
    catch (e) { alert(e.message); }
  }

  // ---------------------------------------------------------------- Chronologie
  const ICON = { Read: '📖', Edit: '✏️', MultiEdit: '✏️', Write: '📝', Bash: '▶', Grep: '🔎', Glob: '🗂', WebFetch: '🌐', WebSearch: '🌐', Task: '🤖', Agent: '🤖', TodoWrite: '☑', NotebookEdit: '📓' };
  async function loadTimeline() {
    const el = $('#tab-timeline');
    let list = [];
    try { list = await api('GET', `/api/sessions/${active}/timeline`); } catch (e) { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    if (!list.length) { el.innerHTML = `<p class="hint">${t('Aucune action pour l’instant.')}</p>`; return; }
    const s = sessions.get(active);
    el.innerHTML = `<ul class="timeline">${list.slice().reverse().map(x => `
      <li title="${esc(x.target)}"><span class="ti">${ICON[x.name] || '•'}</span>
        <span class="tn">${esc(x.name)}</span>
        <span class="tt">${esc(x.target.replace(s?.cwd || '\u0000', '.'))}</span>
        <span class="tw">${x.ts ? new Date(x.ts).toLocaleTimeString(LANG === 'en' ? 'en-GB' : 'fr-FR', { hour: '2-digit', minute: '2-digit' }) : ''}</span></li>`).join('')}</ul>`;
  }

  // ---------------------------------------------------------------- Mes prompts
  // Toutes les demandes tapées dans la session, pour se rappeler de quoi elle parle : recherche, copier, réutiliser.
  let promptQ = '';
  async function loadPrompts() {
    const el = $('#tab-prompts'), id = active;
    let list = [];
    try { list = await api('GET', `/api/sessions/${id}/prompts`); } catch (e) { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    if (id !== active) return;
    const fmt = ts => ts ? new Date(ts).toLocaleString(LANG === 'en' ? 'en-GB' : 'fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    const render = () => {
      const words = promptQ.toLowerCase().split(/\s+/).filter(Boolean);
      const shown = list.map((p, i) => ({ ...p, i })).filter(p => words.every(w => p.text.toLowerCase().includes(w))).reverse();
      $('#promptList').innerHTML = shown.length ? shown.map(p => `<li data-i="${p.i}"><div class="pmeta"><span>#${p.i + 1} · ${esc(fmt(p.t))}</span>
          <span class="acts"><button data-a="copy" title="${t('Copier')}">${t('Copier')}</button><button data-a="use" title="${t('Insérer dans la saisie')}">${t('Réutiliser')}</button></span></div>
          <div class="ptext">${esc(p.text)}</div></li>`).join('')
        : `<li class="hint">${list.length ? t('Aucun prompt ne correspond.') : t('Aucun prompt dans cette session pour l’instant.')}</li>`;
      $('#promptList').querySelectorAll('li[data-i]').forEach(li => {
        const p = list[+li.dataset.i];
        li.querySelector('.ptext').onclick = () => li.classList.toggle('open');
        li.querySelector('[data-a=copy]').onclick = () => clip.copy(p.text).then(() => toast(t('Copié')));
        li.querySelector('[data-a=use]').onclick = () => { const tt = terms.get(active); if (tt) { tt.term.paste(p.text); tt.term.focus(); } };
      });
    };
    // reconstruction (rafraîchissement du panneau) pendant une recherche : focus et curseur gardés
    const had = document.activeElement?.id === 'promptQ' ? document.activeElement : null;
    const sel = had ? [had.selectionStart, had.selectionEnd] : null;
    el.innerHTML = `<div class="promptsHead"><input id="promptQ" type="search" placeholder="${t('Chercher dans mes prompts…')}" spellcheck="false" value="${esc(promptQ)}"><small class="hint">${list.length} ${t('prompt(s)')}</small></div><ul id="promptList" class="prompts"></ul>`;
    $('#promptQ').oninput = e => { promptQ = e.target.value; render(); };
    if (sel) { const i = $('#promptQ'); i.focus(); try { i.setSelectionRange(...sel); } catch { } }
    render();
  }
  F.showPrompts = () => setOpen(true, 'prompts');

  // ---------------------------------------------------------------- Mémoire (mémoire IA de la session)
  // La fiche écrite par Haiku pour cette session, rangée : le sujet en cours puis les sujets terminés, chacun avec
  // demande / où on en est / ensuite et ses observations groupées par type ; puis les autres sessions du dossier.
  const OBS = [['todo', '☐', 'À faire'], ['decision', '◆', 'Décisions'], ['fix', '✔', 'Corrections'], ['change', '✎', 'Changements'], ['discovery', '🔎', 'Découvertes'], ['preference', '★', 'Préférences']];
  const topicOpen = new Map(); // sujet ouvert / replié à la main (par défaut : seul le premier est ouvert)
  async function loadMemory() {
    const el = $('#tab-memory'), id = active, s = sessions.get(id);
    if (!s) { el.innerHTML = ''; return; }
    const cid = s.claudeSessionId;
    let d;
    try { d = cid ? await api('GET', `/api/memory/ai/session/${cid}?cwd=${encodeURIComponent(s.cwd || '')}`) : null; }
    catch (e) { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    if (id !== active) return;
    const fmt = ts => ts ? new Date(ts).toLocaleString(LANG === 'en' ? 'en-GB' : 'fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    if (d && !d.enabled) { el.innerHTML = `<p class="hint">${t('Mémoire IA coupée (Réglages › Général).')}</p>`; return; }
    const a = d?.analysis || {};
    const state = !d ? t('Pas encore de conversation dans cette session.')
      : a.running ? '⏳ ' + t('Analyse en cours…')
        : a.suspended ? '⚠ ' + t('Analyses suspendues après plusieurs échecs') + (a.lastError ? ` : ${a.lastError}` : '')
          : a.waiting ? '⏳ ' + t('Analyse prévue : 3 minutes après la dernière réponse de Claude (20 minutes au plus).')
            : d.topics.length ? '' : t('Aucune fiche pour l’instant : elle est écrite 3 minutes après une réponse de Claude (20 minutes au plus si la session travaille sans arrêt).');
    const obsHtml = obs => OBS.map(([k, ic, label]) => {
      const list = obs.filter(o => o.type === k);
      return list.length ? `<div class="mobs"><b>${ic} ${t(label)}</b><ul>${list.map(o => `<li><span class="mt">${esc(o.title)}</span>${o.body ? ` — ${esc(o.body)}` : ''}${o.files?.length ? `<small>${o.files.map(esc).join(', ')}</small>` : ''}</li>`).join('')}</ul></div>` : '';
    }).join('');
    const topic = (e, i) => {
      const opened = topicOpen.get(e.id) ?? i === 0;
      return `<section class="mtopic${opened ? ' open' : ''}" data-id="${esc(e.id)}">
        <header><b>${esc(e.title)}</b><small>${e.current ? t('sujet en cours') : t('sujet terminé')} · ${esc(fmt(e.updated))}${e.machine ? ' · ' + esc(e.machine) : ''}${e.branch ? ' · ' + esc(e.branch) : ''}</small></header>
        <div class="mbody">
          ${e.request ? `<h4>${t('Demande')}</h4><p>${esc(e.request)}</p>` : ''}
          <h4>${t('Où on en est')}</h4><p>${esc(e.state)}</p>
          ${e.next && e.next !== 'rien' ? `<h4>${t('Ensuite')}</h4><p class="mnext">${esc(e.next)}</p>` : ''}
          ${obsHtml(e.obs)}
        </div></section>`;
    };
    el.innerHTML = `<div class="memHead"><small class="hint">${esc(state)}</small>${cid ? `<button type="button" data-a="now" title="${t('Analyse tout de suite la partie de la conversation pas encore analysée')}">${t('Analyser maintenant')}</button>` : ''}</div>
      ${d?.topics.length ? (d.topics.length > 1 ? `<h3>${d.topics.length} ${t('sujets dans cette session')}</h3>` : '') + d.topics.map(topic).join('') : ''}
      ${d?.others.length ? `<h3>${t('Dans ce dossier')}</h3><ul class="mothers">${d.others.map(o => `<li><b>${esc(o.title)}</b><small>${esc(fmt(o.updated))}${o.machine ? ' · ' + esc(o.machine) : ''}</small><p>${esc(o.state)}</p>${o.next && o.next !== 'rien' ? `<p class="mnext">${t('Ensuite')} : ${esc(o.next)}</p>` : ''}</li>`).join('')}</ul>` : ''}
      <p class="hint">${t('Corriger ou oublier une fiche : Réglages › Mémoire.')}</p>`;
    el.querySelectorAll('.mtopic header').forEach(h => { h.onclick = () => { const sec = h.parentElement; topicOpen.set(sec.dataset.id, sec.classList.toggle('open')); }; });
    el.querySelector('[data-a=now]')?.addEventListener('click', async () => {
      try { await api('POST', `/api/memory/ai/analyze/${cid}`); toast(t('Analyse demandée')); } catch (err) { toast(err.message, true); }
      loadMemory();
    });
  }
  F.showMemory = () => setOpen(true, 'memory');

  // Encart « Mémoire IA » au démarrage d'une session (comme claude-mem dans la console) : posé par l'app au-dessus
  // du terminal, sans toucher à l'affichage de Claude Code. Fermé par ✕, au premier travail de Claude, ou au bout
  // de 2 minutes.
  const memCards = new Map(); // session → encart
  function closeMemCard(id) { const c = memCards.get(id); if (c) { clearTimeout(c.timer); c.el.remove(); memCards.delete(id); } }
  window.addEventListener('csm:memshow', e => {
    const { id, text } = e.detail || {};
    const tt = terms.get(id);
    if (!tt || !text) return;
    closeMemCard(id);
    const lines = String(text).split('\n');
    const body = lines.slice(1).filter(l => !/^Détail : /.test(l)).map(l => {
      if (l.startsWith('• ')) return `<div class="mcItem">${esc(l.slice(2))}</div>`;
      if (/^ {2}→ /.test(l)) return `<div class="mcNext">→ ${esc(l.slice(4))}</div>`;
      if (/^ {2}☐ /.test(l)) return `<div class="mcTodo">☐ ${esc(l.slice(4))}</div>`;
      if (/^ {2}◆ /.test(l)) return `<div class="mcDec">◆ ${esc(l.slice(4))}</div>`;
      if (/^(À faire|Décisions) :$/.test(l)) return `<div class="mcHead">${t(l.replace(/ :$/, ''))}</div>`;
      return `<div class="mcState">${esc(l.trim())}</div>`;
    }).join('');
    const el = document.createElement('div');
    el.className = 'memCard'; el.setAttribute('role', 'status');
    el.innerHTML = `<header><b>🧠 ${esc(lines[0])}</b><span><button type="button" data-a="more">${t('Détail')}</button><button type="button" data-a="x" title="${t('Fermer')}">✕</button></span></header><div class="mcBody">${body}</div>`;
    el.querySelector('[data-a=x]').onclick = () => { closeMemCard(id); tt.term.focus(); };
    el.querySelector('[data-a=more]').onclick = () => { closeMemCard(id); if (id === active) setOpen(true, 'memory'); };
    tt.el.append(el);
    memCards.set(id, { el, timer: setTimeout(() => closeMemCard(id), 120e3) });
  });
  window.addEventListener('csm:session', e => { const { prev, s } = e.detail; if (prev && prev.status !== 'working' && s.status === 'working') closeMemCard(s.id); });
  window.addEventListener('csm:memai', e => { if (open && tab === 'memory' && e.detail === sessions.get(active)?.claudeSessionId) debounce1(loadMemory); });
  let memT; const debounce1 = fn => { clearTimeout(memT); memT = setTimeout(fn, 300); };


  async function loadUsage() {
    const el = $('#tab-usage');
    el.innerHTML = `<p class="hint">${t('Calcul…')}</p>`;
    try {
      const [mine, all] = await Promise.all([active ? api('GET', `/api/sessions/${active}/usage`) : null, api('GET', '/api/usage')]);
      const row = (label, u) => `<tr><td>${label}</td><td>${fmtN(u.in + u.cr + u.cw)}</td><td>${fmtN(u.out)}</td><td>${fmt$(u.cost)}</td></tr>`;
      const days = Object.entries(all.perDay).sort();
      const max = Math.max(1, ...days.map(([, v]) => v));
      el.innerHTML = `
        <h3>${t('Cette session')}</h3>
        ${mine ? `<table class="usage"><tr><th></th><th>${t('Entrée')}</th><th>${t('Sortie')}</th><th>${t('Équivalent API')}</th></tr>
          ${row(t('Total'), mine.total)}
          ${Object.entries(mine.models).map(([m, u]) => row(`<small>${esc(m)}</small>`, u)).join('')}</table>` : ''}
        <h3>${t('Toutes les sessions')}</h3>
        <table class="usage"><tr><th></th><th>${t('Entrée')}</th><th>${t('Sortie')}</th><th>${t('Équivalent API')}</th></tr>
          ${row(t('5 dernières heures'), all.h5)}${row(t('Aujourd’hui'), all.today)}${row(t('7 derniers jours'), all.d7)}</table>
        <div class="bars">${days.map(([d, v]) => `<div class="bar" title="${d} : ${fmtN(v)} tokens"><i style="height:${Math.round(v / max * 100)}%"></i><span>${d.slice(8)}</span></div>`).join('')}</div>
        <h3>${t('Sessions les plus gourmandes (7 jours)')}</h3>
        <ul class="topUse">${all.top.map(x => `<li><span>${esc(x.name)}</span><b>${fmt$(x.cost)}</b></li>`).join('')}</ul>
        <p class="hint">${t('Ce que ces tokens coûteraient via l’API payante, à titre indicatif : non facturé, inclus dans un abonnement Claude. Entrée = tokens lus, cache compris.')}</p>`;
    } catch (e) { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  }

  // ---------------------------------------------------------------- export de conversation
  F.exportConversation = async (s) => {
    const id = s.claudeSessionId || s.id;
    let r;
    try { r = await api('GET', `/api/history/${id}/export`); } catch (e) { return toast(e.message, true); }
    const name = (s.name || r.title || 'conversation').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'conversation';
    showMenu([
      [t('Enregistrer en Markdown (.md)'), () => download(`${name}.md`, r.markdown, 'text/markdown')],
      [t('Copier le Markdown'), () => clip.copy(r.markdown).then(() => toast(t('Copié')))],
      [t('Imprimer / PDF…'), () => printMarkdown(r.title, r.markdown)],
    ], ...lastMenuPos);
  };
  // Electron bloque les téléchargements : boîte native puis écriture par l'app ; navigateur : lien <a download>.
  async function download(name, text, type) {
    const n = window.csmNative;
    if (n?.pickSave && n.saveText) {
      const file = await n.pickSave(name).catch(() => null);
      if (!file) return;
      if (await n.saveText(file, text).catch(() => false)) toast(t('Enregistré'));
      else toast(t('Échec de l’enregistrement'), true);
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  // Rendu Markdown minimal (titres, code, listes, gras) pour l'impression — iframe sans script.
  function printMarkdown(title, md) {
    const blocks = md.split(/\n```/);
    const html = md.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
      .replace(/```[\w-]*\n([\s\S]*?)```/g, (_, c) => `<pre>${c}</pre>`)
      .replace(/^### (.*)$/gm, '<h3>$1</h3>').replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>')
      .replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>').replace(/^- (.*)$/gm, '<li>$1</li>')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n{2,}/g, '<br><br>');
    void blocks;
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
    f.sandbox = 'allow-modals allow-same-origin';
    document.body.appendChild(f);
    f.srcdoc = `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:13px/1.55 -apple-system,Segoe UI,sans-serif;max-width:780px;margin:24px auto;color:#111}h1{font-size:22px}h2{font-size:15px;margin-top:22px;border-bottom:1px solid #ddd}pre,code{font-family:Consolas,Menlo,monospace;font-size:12px}pre{background:#f5f5f5;padding:8px;white-space:pre-wrap}blockquote{color:#666;margin:0}li{margin-left:18px}</style>${html}`;
    f.onload = () => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 60000); };
  }

  // ---------------------------------------------------------------- groupe
  F.setGroup = async id => {
    const s = sessions.get(id); if (!s) return;
    const existing = groupNames();
    const g = await askName(t('Groupe de la session'), s.group || '', (existing.length ? `${t('Groupes existants')} : ${existing.join(', ')}. ` : '') + t('« Parent/Enfant » pour un sous-groupe.') + ' ' + t('« - » pour retirer la session de son groupe.'), true);
    if (g === null) return;
    api('POST', `/api/sessions/${id}/meta`, { group: g.trim() === '-' ? '' : gClean(g) }).catch(e => toast(e.message, true));
  };

  // ---------------------------------------------------------------- rafraîchissements
  window.addEventListener('csm:active', debounce(refresh, 150));
  window.addEventListener('csm:session', e => {
    const { prev, s } = e.detail;
    // fin d'un tour de Claude : les fichiers ont pu changer
    if (s.id === active && prev && prev.status !== s.status && (s.status === 'idle' || s.status === 'attention') && !busy) refresh();
  });
  setInterval(() => { if (document.visibilityState === 'visible') loadChanges(); }, 20000);
  function debounce(fn, ms) { let h; return () => { clearTimeout(h); h = setTimeout(fn, ms); }; }
  window.addEventListener('csm:ready', () => setOpen(open));
})();
