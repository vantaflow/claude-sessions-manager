'use strict';
// Usage de Claude (refonte Atelier, 3.33) : indicateurs (jour, 7 ou 30 jours ; cette machine ou toutes), prévision
// du quota 5 h, tâches planifiées, détail par session. Ouvert par Ctrl+Alt+U, la palette, ou un clic sur les quotas
// de la barre latérale.
(() => {
  const $ = s => document.querySelector(s);
  const F = window.csmFeatures;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const hm = ts => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const dur = sec => { const m = Math.round(sec / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };
  const money = n => `${(n || 0).toFixed(2).replace('.', ',')} $`;
  const tok = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n || 0));
  const DAYS = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
  const when = ts => (new Date(ts).toDateString() === new Date().toDateString() ? hm(ts) : `${t(DAYS[new Date(ts).getDay()])} ${hm(ts)}`);

  function kpi(label, value, hint, cls) {
    const k = el('div', `dbKpi${cls ? ' ' + cls : ''}`);
    k.append(el('span', 'kl', label), el('span', 'kv', value), el('span', 'kh', hint || ''));
    return k;
  }

  // période et périmètre choisis (mémorisés dans ce navigateur)
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { } } };
  let days = [1, 7, 30].includes(Number(store.get('csm.usageDays'))) ? Number(store.get('csm.usageDays')) : 1;
  let scope = store.get('csm.usageScope') === 'all' ? 'all' : 'me';
  const PERIOD_LABEL = { 1: 'aujourd’hui', 7: '7 jours', 30: '30 jours' };

  // Graphique d'un quota : une barre par tranche (10 min sur 5 h, 1 jour sur 7 jours), pleines pour le passé
  // (mesures), hachurées pour la prévision jusqu'à la réinitialisation ; ligne du seuil de pause de la file (5 h) ;
  // heures (ou jours) en abscisse.
  function quotaChart(cur, hist0, fc, o) {
    const now = Date.now(), end = cur.resetAt || now + o.span / 2, start = end - o.span, N = Math.round(o.span / o.slot);
    const hist = [...(hist0 || [])].sort((a, b) => a.t - b.t);
    const plot = el('div', 'dbPlot'), chart = el('div', 'dbChart');
    for (let k = 0; k < N; k++) {
      const s0 = start + k * o.slot, s1 = s0 + o.slot, b = el('i');
      let pct = null;
      if (s0 <= now) {
        if (s1 > now) pct = cur.pct;
        else for (const p of hist) if (p.t <= s1) pct = p.pct;
      } else if (fc) {
        pct = fc.limitAt && s1 >= fc.limitAt ? 100 : Math.min(100, cur.pct + (fc.perHour || 0) * (s1 - now) / 3600e3);
        b.className = 'fc';
      }
      if (pct === null) b.className = 'none';
      b.style.height = pct === null ? '2px' : `${Math.max(2, Math.min(100, pct))}%`;
      b.title = pct === null ? o.label(s0) : `${o.label(s0)} · ${Math.round(pct)} %${b.className === 'fc' ? ` (${t('prévision')})` : ''}`;
      chart.append(b);
    }
    plot.append(chart);
    if (o.th) { const line = el('div', 'dbTh'); line.style.bottom = `${o.th}%`; line.title = `${t('Seuil de la pause')} : ${o.th} %`; plot.append(line); }
    const axis = el('div', 'dbAxis');
    for (let i = 0; i < o.ticks; i++) axis.append(el('span', '', o.label(start + i * o.tick)));
    return [plot, axis];
  }
  const CH5 = { span: 5 * 3600e3, slot: 10 * 60e3, tick: 3600e3, ticks: 6, label: hm };
  const CH7 = { span: 7 * 86400e3, slot: 86400e3, tick: 86400e3, ticks: 7, label: ts => t(DAYS[new Date(ts).getDay()]) };

  // « 12 sessions sur ce PC · 3 sur le Mac », d'après l'origine des sessions (machine qui les a créées)
  function machineSummary(machines) {
    const me = window.csmFeatures?.syncMachine, counts = new Map();
    for (const s of sessions.values()) { const o = s.origin && s.origin !== me ? s.origin : ''; counts.set(o, (counts.get(o) || 0) + 1); }
    const plat = Object.fromEntries((machines || []).map(m => [m.name, m.platform]));
    const mine = (machines || []).find(m => m.me)?.platform;
    const label = (o, p) => (o === '' ? (p === 'darwin' ? t('ce Mac') : t('ce PC')) : p === 'darwin' ? t('le Mac') : p === 'win32' ? t('le PC') : o);
    return [...counts].sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : 0))
      .map(([o, n], i) => `${n} ${i === 0 ? t(n > 1 ? 'sessions sur' : 'session sur') : t('sur')} ${label(o, o === '' ? mine : plat[o])}`).join(' · ');
  }

  async function load() {
    const q = `days=${days}${scope === 'all' ? '&scope=all' : ''}`;
    const [usage, quota, work, sch, tpls, sync] = await Promise.all([
      api('GET', `/api/usage?${q}`).catch(() => null), api('GET', '/api/quota').catch(() => null),
      api('GET', `/api/worktime?days=${days}`).catch(() => null), api('GET', '/api/schedules').catch(() => []),
      api('GET', '/api/templates').catch(() => []), api('GET', '/api/sync').catch(() => null),
    ]);
    // sélecteur de machines : seulement quand la synchro est active
    const canAll = !!sync?.enabled;
    if (!canAll && scope === 'all') { scope = 'me'; return load(); }
    $('#dbScope').hidden = !canAll; $('#dbScope').value = scope;
    document.querySelectorAll('#dbPeriod button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.d) === days)));
    $('#dbScopeHint').textContent = scope === 'all' ? t('Toutes les machines') : t('Sur cette machine');
    const all = [...sessions.values()], alive = all.filter(s => s.alive);
    const todo = F.attentionItems ? F.attentionItems() : [];
    const wp = work?.period || { total: 0, queued: 0, sessions: {} };
    const A = scope === 'all' ? usage?.all : null;
    const label = t(PERIOD_LABEL[days]);

    // indicateurs
    $('#dbKpis').replaceChildren(
      kpi(t('Sessions actives'), String(alive.length), `${all.length} ${t('au total')}`),
      kpi(t('À traiter'), String(todo.length), todo.some(x => x.risk) ? t('dont une autorisation à risque') : todo.length ? t('voir le centre d’attention') : t('rien en attente'), todo.length ? 'warn' : ''),
      kpi(t('Temps de travail de Claude'), dur(A ? A.total.work : wp.total), !A && wp.queued ? `${label} · ${t('dont')} ${dur(wp.queued)} ${t('sans toi (file d’attente)')}` : label),
      kpi(t('Équivalent API'), money(A ? A.total.cost : usage?.period?.cost), `${label} · ${t('non facturé, inclus dans ton abonnement')}`, 'accent'));

    // quota 5 h : historique et prévision
    const qbox = $('#dbQuota'); qbox.replaceChildren();
    if (!quota?.five) qbox.append(el('p', 'hint', t('Pas encore de quota : il arrive avec la barre d’état de Claude Code dès qu’une session répond.')));
    else {
      const fc = quota.forecast;
      const head = el('div', 'dbQHead');
      head.append(el('b', '', `${Math.round(quota.five.pct)} %`));
      const note = !fc ? t('Prévision dès quelques minutes de mesures.')
        : fc.limitAt ? `${t('Au rythme actuel, limite atteinte vers')} ${when(fc.limitAt)}`
          : t('Au rythme actuel, pas de limite avant la réinitialisation.');
      head.append(el('span', `dbFc${fc?.limitAt ? ' warn' : ''}`, note));
      const [plot, axis] = quotaChart(quota.five, quota.hist, quota.forecast, { ...CH5, th: quota.pause?.on ? quota.pause.threshold : 0 });
      plot.setAttribute('role', 'img'); plot.setAttribute('aria-label', `${t('Quota 5 h')} : ${note}`);
      const legend = el('div', 'dbLegend');
      legend.append(el('span', 'k now', t('mesuré')), el('span', 'k fc', t('prévision')), ...(quota.pause?.on ? [el('span', 'k th', t('seuil de pause'))] : []));
      const reset = quota.five.resetAt ? ` · ${t('réinitialisation à')} ${hm(quota.five.resetAt)}` : '';
      qbox.append(head, plot, axis, legend, el('p', 'hint', quota.pause?.on ? `${t('Pause de la file à')} ${quota.pause.threshold} %${reset}` : `${t('Pause de la file désactivée')}${reset}`));
    }

    // quota 7 jours : mêmes mesures, barres par jour
    const q7 = $('#dbQuota7'); q7.replaceChildren();
    if (!quota?.seven) q7.append(el('p', 'hint', t('Pas encore de quota sur 7 jours.')));
    else {
      const fc = quota.forecast7;
      const note = !fc ? t('Prévision dès quelques heures de mesures.')
        : fc.limitAt ? `${t('Au rythme actuel, limite atteinte vers')} ${when(fc.limitAt)}`
          : t('Au rythme actuel, pas de limite avant la réinitialisation.');
      const head = el('div', 'dbQHead');
      head.append(el('b', '', `${Math.round(quota.seven.pct)} %`), el('span', `dbFc${fc?.limitAt ? ' warn' : ''}`, note));
      const [plot, axis] = quotaChart(quota.seven, quota.hist7, fc, CH7);
      plot.setAttribute('role', 'img'); plot.setAttribute('aria-label', `${t('Quota 7 j')} : ${note}`);
      q7.append(head, plot, axis, el('p', 'hint', quota.seven.resetAt ? `${t('réinitialisation')} ${when(quota.seven.resetAt)}` : ''));
    }

    // tâches planifiées : quoi, où (session ou modèle) et quand
    const jobs = (Array.isArray(sch) ? sch : []).filter(x => x.enabled).sort((a, b) => (a.next || 9e15) - (b.next || 9e15));
    const where = x => (x.target === 'template'
      ? `▶ ${(Array.isArray(tpls) ? tpls : []).find(y => y.id === x.template)?.name || t('modèle supprimé')}`
      : `→ ${sessions.get(x.session)?.name || t('session supprimée')}`);
    $('#dbJobs').replaceChildren(...(jobs.length ? jobs.slice(0, 6).map(x => {
      const d = el('div', 'dbJob');
      d.append(el('b', '', x.name || (x.text || '').slice(0, 60) || t('Tâche')), el('span', 'hint', where(x)), el('span', 'hint', x.next ? `${t('prochaine')} : ${when(x.next)}` : t('à l’heure prévue')));
      return d;
    }) : [el('p', 'hint', t('Aucune tâche planifiée.'))]));

    // par session sur la période (+ colonne Machine en vue « toutes »)
    const rows = A ? A.rows : (usage?.top || []).map(x => ({ machine: '', name: x.name, work: x.work, tokens: (x.in || 0) + (x.out || 0) + (x.cr || 0) + (x.cw || 0), cost: x.cost }));
    $('#dbColMachine').hidden = !A;
    $('#dbST').textContent = `${t('Par session')} (${label})`;
    const tb = $('#dbRows'); tb.replaceChildren();
    for (const r of rows.slice(0, 15)) {
      const tr = el('tr');
      tr.append(el('td', '', r.name));
      if (A) tr.append(el('td', 'hint', r.machine));
      tr.append(el('td', 'num', r.work ? dur(r.work) : '—'), el('td', 'num', tok(r.tokens)), el('td', 'num', money(r.cost)));
      tb.append(tr);
    }
    if (!rows.length) { const tr = el('tr'); const td = el('td', 'hint', t('Pas encore de consommation sur cette période.')); td.colSpan = A ? 5 : 4; tr.append(td); tb.append(tr); }
    $('#dbMachines').textContent = A ? machineSummary(A.machines) : '';
    $('#dbNote').textContent = usage?.note ? t(usage.note) : '';
  }

  F.openUsage = () => { const d = $('#dlgUsage'); if (!d.open) d.showModal(); load(); };
  $('#dbSchedules').onclick = $('#dbSchAdd').onclick = () => { $('#dlgUsage').close(); F.openSettings('schedules'); };
  $('#dbPeriod').addEventListener('click', e => { const b = e.target.closest('button[data-d]'); if (!b) return; days = Number(b.dataset.d); store.set('csm.usageDays', String(days)); load(); });
  $('#dbScope').onchange = e => { scope = e.target.value === 'all' ? 'all' : 'me'; store.set('csm.usageScope', scope); load(); };
  $('#sideStatus')?.addEventListener('click', e => { if (!e.target.closest('.syncLine')) F.openUsage(); });
  window.addEventListener('csm:quota', () => { if ($('#dlgUsage').open) load(); });
  setInterval(() => { if ($('#dlgUsage').open) load(); }, 30e3);
})();
