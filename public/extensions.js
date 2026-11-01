'use strict';
// Extensions (lib/extensions.js) : Réglages › Extensions, et affichage dédié des sessions d'un type d'extension.
// Tout ce qui vient d'une extension ou de la vue écrite par Claude est inséré en texte (textContent), jamais en HTML.
(() => {
  const $ = s => document.querySelector(s);
  const F = window.csmFeatures;
  const el = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'text') e.textContent = v;
      else if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e[k] = v;
      else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) if (c) e.append(c);
    return e;
  };

  // ---------------------------------------------------------------- Réglages › Extensions
  async function renderList() {
    const ul = $('#extsList'); if (!ul) return;
    let list = [];
    try { list = await api('GET', '/api/extensions'); } catch (e) { ul.replaceChildren(el('li', { class: 'hint', text: e.message })); return; }
    if (!list.length) { ul.replaceChildren(el('li', { class: 'hint', text: t('Aucune extension. Importe un fichier .csm.json reçu ou créé pour toi.') })); return; }
    ul.replaceChildren(...list.map(x => {
      const parts = [];
      if (x.counts.templates) parts.push(`${x.counts.templates} ${t('modèle(s)')}`);
      if (x.counts.sessionTypes) parts.push(`${x.counts.sessionTypes} ${t('type(s) de session')}`);
      if (x.counts.prompts) parts.push(`${x.counts.prompts} ${t('prompt(s)')}`);
      const sw = el('input', { type: 'checkbox', 'aria-label': `${t('Activer')} ${x.name}` });
      sw.checked = !!x.enabled; sw.disabled = !!x.error;
      sw.onchange = () => api('POST', `/api/extensions/${encodeURIComponent(x.id)}/enabled`, { on: sw.checked }).then(renderList).catch(e => toast(e.message, true));
      return el('li', { class: 'extItem' },
        el('label', { class: 'extMain' }, sw,
          el('span', {},
            el('b', { text: `${x.name} ` }), el('span', { class: 'hint', text: `${x.version || ''} · ${x.from ? `${t('reçue de')} ${x.from}` : x.url ? t('importée par lien') : t(x.source)}${x.toEnable ? ` · ${t('désactivée : coche pour l’activer ici')}` : ''}` }),
            el('div', { class: 'hint', text: x.error ? `${t('Invalide')} : ${x.error}` : (x.description || parts.join(' · ')) }),
            x.description && parts.length ? el('div', { class: 'hint', text: parts.join(' · ') }) : null)),
        x.url ? el('button', { type: 'button', text: t('Mettre à jour'), title: x.url, onclick: () => importUrl(x.url) }) : null,
        x.removable ? el('button', { type: 'button', class: 'danger', text: t('Supprimer'), onclick: async () => {
          if (!confirm(`${t('Supprimer l’extension')} « ${x.name} » ?`)) return;
          try { await api('DELETE', `/api/extensions/${encodeURIComponent(x.id)}`); renderList(); } catch (e) { toast(e.message, true); }
        } }) : null);
    }));
  }
  async function importFiles(files) {
    for (const f of files) {
      try {
        const r = await api('POST', '/api/extensions', { content: await f.text() });
        toast(`${r.replaced ? t('Extension mise à jour') : t('Extension ajoutée')} : ${r.name}`);
      } catch (e) { toast(`${f.name} : ${e.message}`, true); }
    }
    renderList();
  }
  // lien GitHub (fichier, dossier, dépôt), gist ou adresse https : récupéré par le serveur (lib/extfetch.js)
  async function importUrl(url) {
    url = String(url || '').trim(); if (!url) { $('#extUrl').focus(); return; }
    const btn = $('#extUrlGo'); btn.disabled = true;
    try {
      const r = await api('POST', '/api/extensions', { url });
      toast(r.imported.map(x => `${x.replaced ? t('Extension mise à jour') : t('Extension ajoutée')} : ${x.name}`).join(' · '));
      for (const e of r.errors || []) toast(e, true);
      $('#extUrl').value = '';
    } catch (e) { toast(e.message, true); }
    btn.disabled = false;
    renderList();
  }
  $('#extUrlGo').onclick = () => importUrl($('#extUrl').value);
  $('#extUrl').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); importUrl($('#extUrl').value); } });
  $('#extImport').onclick = () => $('#extFile').click();
  $('#extFile').onchange = () => { importFiles([...$('#extFile').files]); $('#extFile').value = ''; };
  const zone = $('section[data-st=extensions]');
  zone.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); zone.classList.add('dropping'); } });
  zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('dropping'); });
  zone.addEventListener('drop', e => { zone.classList.remove('dropping'); const fs = [...(e.dataTransfer?.files || [])]; if (fs.length) { e.preventDefault(); e.stopPropagation(); importFiles(fs); } });
  document.querySelector('.setNav [data-st=extensions]')?.addEventListener('click', renderList);
  // ouverture directe sur la page Extensions (palette, lien) : la liste se charge aussi
  const open0 = F.openSettings;
  if (open0) F.openSettings = async (which, ...rest) => { const r = await open0(which, ...rest); if (which === 'extensions') renderList(); return r; };
  F.renderExtensions = renderList;
  window.addEventListener('csm:extensions', () => { if (!zone.hidden) renderList(); });

  // ---------------------------------------------------------------- secrets demandés par les extensions
  // Au démarrage (et quand les extensions changent) : ceux qui manquent, avec le lien pour les obtenir.
  // La valeur part au serveur local qui la range ; elle n'est jamais relue ni réaffichée.
  // une vérification plus récente (ou un enregistrement) annule celle en cours : jamais de fenêtre rouverte
  // avec une liste lue avant l'enregistrement
  let askSeq = 0;
  async function askSecrets(force) {
    const seq = ++askSeq;
    let list; try { list = await api('GET', '/api/secrets'); } catch { return; }
    if (seq !== askSeq) return;
    const missing = list.filter(x => !x.present && (force || !x.dismissed));
    const dlg = $('#dlgSecrets');
    if (!missing.length) { if (dlg.open) dlg.close(); return; }
    const box = $('#secretList');
    // déjà affichée pour les mêmes jetons : on garde ce que l'utilisateur est en train de saisir
    const keys = missing.map(x => `${x.ext}/${x.id}`).join(',');
    if (dlg.open && box.dataset.keys === keys) return;
    box.dataset.keys = keys;
    box.replaceChildren();
    for (const x of missing) {
      const input = el('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: t('Colle le jeton ici') });
      const msg = el('small', { class: 'hint secretMsg' });
      const save = el('button', { type: 'button', class: 'primary', text: t('Enregistrer'), onclick: async () => {
        save.disabled = true; askSeq++;
        try {
          const r = await api('POST', `/api/secrets/${x.ext}/${x.id}`, { value: input.value });
          input.value = '';
          if (r.present) { card.remove(); if (!box.children.length) dlg.close(); toast(t('Jeton enregistré')); }
          else msg.textContent = t('Enregistré, mais toujours introuvable : vérifie le trousseau ou la variable.');
        } catch (e) { msg.textContent = e.message; } finally { save.disabled = false; }
      } });
      const card = el('div', { class: 'secretCard' },
        el('b', { text: `${x.name} · ${x.extName}` }),
        // nom de la variable bien visible : on sait ce que l'extension va poser
        x.env ? el('p', { class: 'secretEnv' }, el('span', { text: t('Variable d’environnement') + ' : ' }), el('code', { text: x.env })) : null,
        x.description ? el('p', { text: x.description }) : null,
        x.url ? el('p', {}, el('a', { href: x.url, target: '_blank', rel: 'noopener', text: t('Obtenir le jeton') + ' ↗' }), el('small', { class: 'hint', text: ' ' + x.url })) : null,
        el('div', { class: 'row' }, input, save),
        el('small', { class: 'hint', text: t('Rangé dans') + ' ' + x.where }),
        msg,
        el('button', { type: 'button', class: 'link', text: t('Ne plus demander'), onclick: async () => { await api('POST', `/api/secrets/${x.ext}/${x.id}/dismiss`); card.remove(); if (!box.children.length) dlg.close(); } }));
      box.append(card);
    }
    if (!dlg.open) dlg.showModal();
  }
  $('#secretsLater').onclick = () => $('#dlgSecrets').close();
  $('#dlgSecrets').addEventListener('close', () => { $('#secretList').dataset.keys = ''; });
  F.askSecrets = askSecrets;
  setTimeout(() => askSecrets(false), 2500);
  window.addEventListener('csm:extensions', () => setTimeout(() => askSecrets(false), 500));

  // ---------------------------------------------------------------- vue d'une session typée
  const LS2 = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { } } };
  const modeOf = id => LS2.get(`csm.view.${id}`) || 'view';
  const views = new Map(); // id -> { type, view }

  // états d'affichage qui survivent aux mises à jour de la vue : sections ouvertes, brouillons dépliés, élément choisi
  const openFolds = new Set(), openDrafts = new Set(), lotSel = new Map(), draftVals = new Map(), inputVals = new Map();
  const ICON = {
    ok: '<path d="m5 12 5 5 9-10"/>',
    warn: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  };
  const icon = k => { const sv = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); sv.setAttribute('viewBox', '0 0 24 24'); sv.setAttribute('class', 'ic'); sv.setAttribute('aria-hidden', 'true'); sv.innerHTML = ICON[k] || ICON.info; return sv; }; // icônes fixes de l'app, jamais de contenu externe
  function section(s, i, id, item) {
    // section repliée (fold) : titre seul, ouverte d'un clic
    const key = `${id}|${item ?? ''}|${s.kind}|${s.title}`;
    const box = el(s.fold ? 'details' : 'section', { class: `tvSec tv-${s.kind}${s.level === 'warn' ? ' warn' : ''}${s.fold ? ' tvFold' : ''}` });
    const count = s.items?.length || s.rows?.length || 0;
    const head = el(s.fold ? 'summary' : 'h3', {}, s.title || (s.fold ? t('Détails') : ''), s.badge ? el('span', { class: 'tvBadge', text: s.badge }) : null,
      s.fold && count ? el('span', { class: 'tvCount', text: String(count) }) : null);
    if (s.title || s.badge || s.fold) box.append(head);
    if (s.fold) { box.open = openFolds.has(key); box.addEventListener('toggle', () => { if (box.open) openFolds.add(key); else openFolds.delete(key); }); }
    if (s.kind === 'text' || s.kind === 'alert') {
      const p = el('p', { text: s.text });
      box.append(p);
      if (!s.fold && s.text.length > 420) { // texte long : quelques lignes, puis « Voir plus »
        p.classList.add('tvClamp');
        const more = el('button', { type: 'button', class: 'tvMore', text: t('Voir plus'), onclick: () => { const on = p.classList.toggle('tvClamp'); more.textContent = on ? t('Voir plus') : t('Voir moins'); } });
        box.append(more);
      }
    }
    if (s.kind === 'list') box.append(el('ul', {}, s.items.map(x => el('li', { text: x }))));
    if (s.kind === 'kv') box.append(el('dl', {}, s.items.map(x => [el('dt', { text: x.label }), el('dd', { text: x.value })])));
    if (s.kind === 'timeline') box.append(el('ol', { class: 'tvTime' }, s.items.map(x => el('li', {}, el('span', { class: 'tvAt', text: x.at }), el('span', { text: x.text })))));
    if (s.kind === 'table') box.append(el('div', { class: 'tvScroll' }, el('table', {},
      el('thead', {}, el('tr', {}, s.columns.map(c => el('th', { text: c })))),
      el('tbody', {}, s.rows.map(r => el('tr', {}, r.map(c => el('td', { text: c }))))))));
    if (s.kind === 'checklist') box.append(el('ul', { class: 'tvCheck' }, s.items.map(x => el('li', { class: x.done ? 'done' : '' },
      el('span', { class: 'tvBox', 'aria-hidden': 'true', text: x.done ? '✓' : '' }), el('span', {}, el('span', { text: x.label }), x.hint ? el('small', { text: x.hint }) : null)))));
    if (s.kind === 'draft') {
      // replié sur une ligne d'aperçu ; « Relire » l'ouvre (et il reste ouvert pendant les mises à jour)
      if (!openDrafts.has(key)) {
        const first = (s.text.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 2).join(' ')).slice(0, 220);
        box.classList.add('tvDraftClosed');
        box.append(el('div', { class: 'tvPreview' }, el('p', { text: first }),
          el('button', { type: 'button', text: t('Relire'), onclick: () => { openDrafts.add(key); renderView(id); } })));
        return box;
      }
      const ta = el('textarea', { rows: String(Math.min(14, Math.max(3, s.text.split('\n').length + Math.ceil(s.text.length / 140)))), 'aria-label': s.title || t('Brouillon') });
      // texte en cours de relecture gardé tel quel quand Claude met l'affichage à jour (sauf s'il propose un nouveau texte)
      const kept = draftVals.get(key);
      ta.value = kept && kept.base === s.text ? kept.value : s.text;
      ta.addEventListener('input', () => draftVals.set(key, { base: s.text, value: ta.value }));
      box.append(ta, el('div', { class: 'tvActs' }, s.actions.map((a, j) => el('button', {
        type: 'button', class: j === 0 ? 'primary' : '', text: a.label,
        onclick: () => act(id, { item, section: i, index: j, draft: ta.value }),
      })), el('button', { type: 'button', text: t('Copier'), onclick: () => navigator.clipboard.writeText(ta.value).then(() => toast(t('Copié'))) }),
      el('button', { type: 'button', class: 'tvLink', text: t('Replier'), onclick: () => { openDrafts.delete(key); renderView(id); } })));
    }
    return box;
  }
  // sections ouvertes en grille, puis les sections repliées regroupées en bas
  function sectionsBlock(list, id, item) {
    const main = [], folds = [];
    list.forEach((x, i) => (x.fold ? folds : main).push(section(x, i, id, item)));
    return [main.length ? el('div', { class: 'tvBody' }, main) : null, folds.length ? el('div', { class: 'tvDetails' }, folds) : null];
  }
  function stepsEl(st) {
    if (!st) return null;
    return el('ol', { class: 'tvSteps', 'aria-label': t('Avancement') }, st.items.map((label, k) => {
      const state = k < st.current ? 'done' : k === st.current ? 'cur' : 'todo';
      return el('li', { class: state }, el('span', { class: 'dot', text: state === 'done' ? '✓' : String(k + 1) }), el('span', { text: label }));
    }));
  }
  function heroRow(v, id, item) {
    const parts = [];
    if (v.verdict || v.steps) {
      parts.push(el('section', { class: `tvVerdict lv-${v.verdict?.level || 'info'}`, 'aria-label': t('Conclusion') },
        v.verdict ? el('div', { class: 'tvVMain' }, el('span', { class: 'tvVIcon' }, icon(v.verdict.level)),
          el('div', {}, el('p', { text: v.verdict.text }), v.verdict.sub ? el('span', { class: 'hint', text: v.verdict.sub }) : null)) : null,
        stepsEl(v.steps)));
    }
    if (v.next) {
      parts.push(el('section', { class: 'tvNext', 'aria-label': t('Prochaine étape') },
        el('span', { class: 'tvNextK', text: t('Prochaine étape') }), el('p', { text: v.next.label }),
        v.next.send ? el('button', { type: 'button', class: 'primary', text: v.next.button || t('Faire'), onclick: () => act(id, { next: true, item }) }) : null));
    }
    return parts.length ? el('div', { class: 'tvHero' }, parts) : null;
  }
  async function act(id, body, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    try { await api('POST', `/api/sessions/${id}/view-action`, body); toast(t('Envoyé à la session')); return true; } catch (e) { toast(e.message, true); return false; }
  }
  function boxOf(id) {
    const tt = terms.get(id); if (!tt) return null;
    let b = tt.el.querySelector('.typeView');
    if (!b) { b = el('div', { class: 'typeView', hidden: true }); tt.el.append(b); }
    return b;
  }
  function renderView(id) {
    const s = sessions.get(id), b = boxOf(id), d = views.get(id);
    if (!b) return;
    b.hidden = !(s?.typeInfo && modeOf(id) === 'view') || !!s.locked;
    if (b.hidden) return;
    const ti = s.typeInfo, v = d?.view;
    const items = v?.items || [];
    // lot : compteurs par état (et éléments à risque)
    const counts = {};
    for (const x of items) if (x.state) counts[x.state] = (counts[x.state] || 0) + 1;
    const risks = items.filter(x => x.risk).length;
    const head = el('header', { class: 'tvHead' },
      el('span', { class: 'tvType', text: ti.badge || ti.name, style: ti.color ? `--tc:${ti.color}` : null }),
      el('div', { class: 'tvTitle' }, el('h2', { text: v?.title || s.name }), v?.subtitle ? el('div', { class: 'hint', text: v.subtitle }) : null,
        v?.meta?.length ? el('div', { class: 'tvMeta' }, v.meta.map(m => el('span', { class: 'tvChip', title: m.label }, m.value || m.label))) : null),
      items.length ? el('div', { class: 'tvCounters' }, Object.entries(counts).map(([k, n]) => el('span', { class: 'tvCounter' }, el('b', { text: String(n) }), ' ' + k)),
        risks ? el('span', { class: 'tvCounter warn' }, el('b', { text: String(risks) }), ' ' + t('avec risque')) : null) : null,
      el('div', { class: 'tvActs' }, ti.actions.map(a => el('button', {
        type: 'button', class: a.primary ? 'primary' : '', text: a.label,
        onclick: () => act(id, { action: a.id }, a.confirm ? `${a.label} ?` : ''),
      }))));
    // champ du type (ex. numéros de tickets) : envoyé à la session avec son bouton
    if (ti.input) {
      const inp = el('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: ti.input.placeholder || '', 'aria-label': ti.input.label || t('Valeur') });
      inp.value = inputVals.get(id) || '';
      if (b.contains(document.activeElement) && document.activeElement.closest('.tvInput')) queueMicrotask(() => inp.focus()); // vue mise à jour pendant la saisie
      inp.addEventListener('input', () => inputVals.set(id, inp.value));
      const form = el('form', { class: 'tvInput' }, ti.input.label ? el('label', { text: ti.input.label }) : null, inp,
        el('button', { type: 'submit', class: 'primary', text: ti.input.button || t('Envoyer') }));
      form.onsubmit = async e => {
        e.preventDefault();
        if (!inp.value.trim()) return inp.focus();
        if (await act(id, { input: inp.value })) { inputVals.delete(id); inp.value = ''; }
      };
      head.append(form);
    }
    const empty = !v || (!v.sections?.length && !items.length && !v.verdict && !v.next);
    if (empty) { b.replaceChildren(head, el('p', { class: 'tvEmpty', text: t('L’affichage se remplira quand Claude aura avancé. La conversation reste dans « Terminal ».') })); return; }
    if (items.length) {
      const sel = Math.min(lotSel.get(id) || 0, items.length - 1), it = items[sel];
      const nav = el('nav', { class: 'tvLotNav', 'aria-label': t('Éléments') }, items.map((x, k) => el('button', {
        type: 'button', class: k === sel ? 'on' : '', 'aria-current': k === sel ? 'true' : null,
        onclick: () => { lotSel.set(id, k); renderView(id); },
      }, el('span', { class: 'tvLotTop' }, x.id ? el('span', { class: 'tvLotId', text: x.id }) : null, x.state ? el('span', { class: 'tvChip', text: x.state }) : null,
        x.risk ? el('span', { class: 'tvRisk', text: t('risque') }) : null),
        el('b', { text: x.title || x.id }), x.verdict ? el('span', { class: 'hint', text: x.verdict.text }) : null)));
      const go = k => () => { lotSel.set(id, k); renderView(id); };
      const prev = sel > 0 ? el('button', { type: 'button', class: 'tvLink', text: '‹ ' + t('Élément précédent'), onclick: go(sel - 1) }) : null;
      const next = sel < items.length - 1 ? el('button', { type: 'button', class: 'tvLink', text: t('Élément suivant') + ' ›', onclick: go(sel + 1) }) : null;
      const detail = el('div', { class: 'tvLotDetail' },
        el('div', { class: 'tvLotHead' }, el('h3', { text: [it.id, it.title].filter(Boolean).join(' · ') }),
          prev || next ? el('span', { class: 'tvLotPager' }, prev, next) : null),
        heroRow(it, id, sel), ...sectionsBlock(it.sections, id, sel));
      b.replaceChildren(...[head, heroRow(v, id), el('div', { class: 'tvLot' }, nav, detail), ...sectionsBlock(v.sections || [], id)].filter(Boolean));
      return;
    }
    b.replaceChildren(...[head, heroRow(v, id), ...sectionsBlock(v.sections || [], id)].filter(Boolean));
  }
  async function loadView(id) {
    try { views.set(id, await api('GET', `/api/sessions/${id}/view`)); } catch { }
    renderView(id);
  }
  // barre du haut : badge du type + bascule Vue / Terminal
  F.renderTypeBar = s => {
    const badge = $('#curType'), btn = $('#btnView');
    const ti = s?.typeInfo;
    badge.hidden = btn.hidden = !ti;
    if (!ti) return;
    badge.textContent = ti.badge || ti.name;
    badge.style.setProperty('--tc', ti.color || 'var(--accent)');
    btn.querySelector('.lbl').textContent = modeOf(s.id) === 'view' ? t('Terminal') : t('Affichage');
    if (!views.has(s.id)) loadView(s.id); else renderView(s.id);
  };
  $('#btnView').onclick = () => {
    if (!active) return;
    LS2.set(`csm.view.${active}`, modeOf(active) === 'view' ? 'term' : 'view');
    F.renderTypeBar(sessions.get(active));
    if (modeOf(active) === 'term') terms.get(active)?.term.focus();
  };
  window.addEventListener('csm:view', e => { const id = e.detail; if (sessions.get(id)?.typeInfo) loadView(id); });
})();
