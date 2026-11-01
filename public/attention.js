'use strict';
// Centre d'attention (refonte Atelier, 3.32) : toutes les demandes des sessions au même endroit —
// autorisations (Autoriser, Toujours pour ce projet, Refuser), questions (réponse directe) et tâches terminées
// à relire. Les réponses sont des frappes envoyées à la session, exactement comme au clavier dans son terminal
// (1 = oui, 2 = oui pour ce projet, Échap = non). Sessions verrouillées : ni contenu ni action.
(() => {
  const $ = s => document.querySelector(s);
  const F = window.csmFeatures;
  const RISK = /\b(git\s+push|push\s+--force|rm\s+-rf?|rmdir|del\s+\/|drop\s+(table|database)|delete\s+from|truncate|deploy|publish|npm\s+publish|wrangler\s+deploy|kubectl|terraform\s+apply|format\s+[a-z]:|shutdown|curl[^|]*\|\s*(ba)?sh)\b/i;
  const READ_ONLY = /^\s*(Read|Glob|Grep|LS|WebFetch|WebSearch|NotebookRead)\b|\b(Read|Glob|Grep|LS)\(/;

  // dernières lignes utiles du terminal d'une session (contexte de la demande)
  function context(id, n = 12) {
    const tt = terms.get(id); if (!tt) return '';
    const b = tt.term.buffer.active, out = [];
    for (let y = b.length - 1; y >= 0 && out.length < n; y--) {
      const l = b.getLine(y)?.translateToString().replace(/\s+$/, '');
      if (l && l.trim() && !/^[─━═╭╰│\s]+$/.test(l)) out.unshift(l);
    }
    return out.join('\n');
  }
  // Sépare une demande d'autorisation en : phrase de la demande, outil + commande concernés, reste du contexte.
  // Mise en page de Claude Code : « Bash command » (ou « Edit file »…), la commande indentée, puis « Do you want to proceed? ».
  const NL = '\n';
  const ASK = /Do you want|proceed|permission|autoris|approv/i;
  const TOOL = /^\s*(?:(?:Bash|Read|Edit|Write|Update|MultiEdit|NotebookEdit|Glob|Grep|WebFetch|WebSearch|Task)\(.*|[A-Z][\w ]*(?:command|file))\s*$/;
  function splitPerm(ctx) {
    const L = ctx.split(NL);
    let q = -1; for (let i = L.length - 1; i >= 0; i--) if (ASK.test(L[i])) { q = i; break; }
    if (q < 0) return { ask: '', tool: '', cmd: '', rest: ctx };
    let h = -1; for (let i = q - 1; i >= Math.max(0, q - 8); i--) if (TOOL.test(L[i])) { h = i; break; }
    if (h < 0) return { ask: L[q].trim(), tool: '', cmd: '', rest: L.filter((_, i) => i !== q).join(NL) };
    const call = /^\s*(\w+)\((.*)\)\s*$/.exec(L[h]);
    const body = L.slice(h + 1, q).map(x => x.replace(/^ {1,4}/, '')).join(NL).trim();
    return {
      ask: L[q].trim(), tool: call ? call[1] : L[h].trim(), cmd: call ? call[2] : body,
      rest: [...L.slice(0, h), ...L.slice(q + 1)].join(NL),
    };
  }
  const ago = ts => { const m = Math.max(0, Math.round((Date.now() - ts) / 60000)); return m < 1 ? t('à l’instant') : m < 60 ? `${t('il y a')} ${m} min` : `${t('il y a')} ${Math.round(m / 60)} h`; };

  const isPerm = (s, ctx) => /permission|autoris|approv|proceed|Do you want/i.test(`${s.message} ${ctx.slice(-400)}`);
  const CHOICE = { yes: '1', always: '2', no: '\x1b' };

  function items() {
    const out = [];
    for (const s of sorted()) {
      if (s.locked) continue;
      if (s.status === 'attention') {
        const ctx = context(s.id);
        const perm = isPerm(s, ctx);
        out.push({ s, kind: perm ? 'perm' : 'question', ctx, risk: perm && RISK.test(ctx), readOnly: perm && READ_ONLY.test(ctx) && !RISK.test(ctx) });
      } else if (s.status === 'idle' && s.message === 'terminé' && unread.has(s.id)) {
        out.push({ s, kind: 'review', ctx: context(s.id, 6) });
      }
    }
    // autorisations à risque d'abord, puis autorisations, questions, relectures
    const rank = x => (x.kind === 'perm' ? (x.risk ? 0 : 1) : x.kind === 'question' ? 2 : 3);
    return out.sort((a, b) => rank(a) - rank(b) || a.s.statusSince - b.s.statusSince);
  }

  const keys = (id, d) => send({ t: 'input', id, d });
  // réponse uniquement si la session attend toujours (la demande a pu être réglée dans le terminal entre-temps)
  const stillAsks = id => sessions.get(id)?.status === 'attention';
  const answer = (id, d) => { if (!stillAsks(id)) { render(true); return false; } keys(id, d); return true; };
  // texte libre : ni échappement (sortie du collage encadré) ni caractère de contrôle
  const clean = v => v.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  const drafts = new Map(); // réponse en cours de saisie, par session (survit aux reconstructions)
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (label, cls, fn) => { const b = el('button', cls, label); b.type = 'button'; b.onclick = fn; return b; };

  function card(x) {
    const s = x.s, art = el('article', `atCard ${x.kind}${x.risk ? ' risk' : ''}`);
    art.dataset.sid = s.id;
    const head = el('div', 'atHead');
    const dot = el('span', `dot ${s.status}`);
    const kind = x.kind === 'perm' ? (x.risk ? t('autorisation · risque') : x.readOnly ? t('autorisation · lecture') : t('autorisation')) : x.kind === 'question' ? t('question') : t('à relire');
    head.append(dot, el('b', '', s.name), el('span', `atKind k-${x.kind}${x.risk ? ' risk' : ''}`, kind), el('span', 'atWhen', ago(s.statusSince)));
    art.append(head);
    if (x.kind !== 'review' && s.message && s.message !== 'attend une réponse') art.append(el('p', '', t(s.message)));
    if (x.kind === 'perm') {
      const p = splitPerm(x.ctx);
      if (p.ask) art.append(el('p', 'atAsk', p.ask));
      if (p.cmd) {
        const box = el('div', 'atCmdBox');
        if (p.tool) box.append(el('span', 'atCmdLbl', p.tool));
        box.append(el('pre', 'atCmd', p.cmd));
        art.append(box);
      }
      if (p.rest.trim()) art.append(el('pre', 'atCtx', p.rest));
    } else if (x.ctx) art.append(el('pre', 'atCtx', x.ctx));
    const acts = el('div', 'atActs');
    const done = () => setTimeout(() => render(true), 400);
    if (x.kind === 'perm') {
      acts.append(
        btn(t('Autoriser'), 'primary', () => { if (answer(s.id, '1')) done(); }),
        btn(t('Toujours pour ce projet'), '', () => { if (answer(s.id, '2')) done(); }),
        btn(t('Refuser'), 'danger', () => { if (answer(s.id, '\x1b')) done(); }));
    } else if (x.kind === 'question') {
      const inp = el('input'); inp.placeholder = t('Ta réponse…'); inp.setAttribute('aria-label', `${t('Réponse à')} ${s.name}`);
      inp.value = drafts.get(s.id) || '';
      inp.addEventListener('input', () => drafts.set(s.id, inp.value));
      const go = () => {
        const v = clean(inp.value).trim(); if (!v) return;
        if (!answer(s.id, `\x1b[200~${v}\x1b[201~`)) return;
        setTimeout(() => keys(s.id, '\r'), 120); inp.value = ''; drafts.delete(s.id); done();
      };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      acts.append(inp, btn(t('Répondre'), 'primary', go));
    } else {
      acts.append(btn(t('Voir les modifications'), 'primary', () => { $('#dlgAttention').close(); select(s.id); F.showPanel?.('changes'); }));
      acts.append(btn(t('Marquer comme vu'), '', () => { unread.delete(s.id); api('POST', `/api/sessions/${s.id}/seen`).catch(() => { }); render(true); }));
    }
    acts.append(btn(t('Ouvrir la session'), 'ghost', () => { $('#dlgAttention').close(); select(s.id); }));
    art.append(acts);
    return art;
  }

  function render(force) {
    const list = items();
    // compteur dans la barre du haut
    const b = $('#btnAttention');
    if (b) { b.hidden = !list.length; $('#atCount').textContent = list.length; b.classList.toggle('hot', list.some(x => x.kind === 'perm')); }
    const dlg = $('#dlgAttention'); if (!dlg?.open) return;
    $('#atTitleCount').textContent = list.length;
    const ro = list.filter(x => x.readOnly);
    $('#atReadOnly').hidden = !ro.length;
    $('#atReadOnly').textContent = `${t('Autoriser les lectures seules')} (${ro.length})`;
    // saisie en cours dans la liste : pas de reconstruction périodique (focus et frappe gardés) ;
    // reconstruction demandée (après une réponse) : la saisie et le focus sont rétablis
    const box = $('#atList'), f = document.activeElement;
    const typing = !!f && f.tagName === 'INPUT' && box.contains(f);
    if (!force && typing) return;
    const sid = typing ? f.closest('[data-sid]')?.dataset.sid : null;
    const sel = typing ? [f.selectionStart, f.selectionEnd] : null;
    box.replaceChildren(...(list.length ? list.map(card) : [el('p', 'atEmpty', t('Rien à traiter. Tes sessions travaillent.'))]));
    for (const id of drafts.keys()) if (!list.some(x => x.s.id === id && x.kind === 'question')) drafts.delete(id);
    if (sid && typing) { const i = box.querySelector(`[data-sid="${CSS.escape(sid)}"] input`); if (i) { i.focus(); try { i.setSelectionRange(...sel); } catch { } } }
  }
  $('#atReadOnly').onclick = () => { for (const x of items().filter(y => y.readOnly)) if (stillAsks(x.s.id)) keys(x.s.id, '1'); setTimeout(() => render(true), 400); };
  F.openAttention = () => { const d = $('#dlgAttention'); if (!d.open) d.showModal(); render(true); };
  $('#btnAttention').onclick = F.openAttention;
  window.addEventListener('csm:session', () => render());
  setInterval(render, 5000); // « il y a N min »
  window.addEventListener('csm:ready', render);
  F.attentionItems = items;
  // vue partagée : un panneau dont la session attend une autorisation affiche Oui / Toujours / Non
  F.paneAsk = id => { const s = sessions.get(id); return !!(s && !s.locked && s.status === 'attention' && isPerm(s, context(id))); };
  F.answerPerm = (id, choice) => { if (CHOICE[choice] && answer(id, CHOICE[choice])) setTimeout(() => render(true), 400); };
})();
