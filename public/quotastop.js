'use strict';
// Plafond de quota d'une session (lib/quotastop.js) : ⋯ › Plafond de quota…, palette ; notification à la pause.
(() => {
  const $ = s => document.querySelector(s);
  const dlg = $('#dlgQuotaStop'), f = $('#formQS');
  if (!dlg) return;
  const F = window.csmFeatures || (window.csmFeatures = {});
  let cur = null, defaultText = '';

  // libellé court : « 5 h ≥ 95 %, 7 j ≥ 90 % » ; état : en attente, demandé, en pause
  const summary = q => [q?.five ? `${t('5 h')} ≥ ${q.five} %` : '', q?.seven ? `${t('7 j')} ≥ ${q.seven} %` : ''].filter(Boolean).join(', ');
  F.quotaStopLabel = s => (s?.quotaStop ? `${t('Plafond de quota')} (${summary(s.quotaStop)})…` : `${t('Plafond de quota')}…`);
  const stageText = q => ({
    pending: t('Seuil atteint : la demande partira dès que la demande d’autorisation en cours sera réglée.'),
    asked: t('Demande envoyée : pause à la fin de la réponse de Claude.'),
    pausing: t('Mise en pause…'),
    done: t('En pause (plafond atteint).') + (q.resume ? ' ' + t('Reprise automatique à la réinitialisation du quota.') : ''),
  })[q?.stage] || '';

  F.openQuotaStop = async id => {
    const s = sessions.get(id); if (!s) return;
    cur = id;
    if (!defaultText) { try { defaultText = (await api('GET', '/api/quota-stop/default')).text; } catch { } }
    const q = s.quotaStop || {};
    $('#qsName').textContent = s.name;
    f.fiveOn.checked = !!q.five; f.five.value = String(q.five || 95);
    f.sevenOn.checked = !!q.seven; f.seven.value = String(q.seven || 95);
    if (!f.five.value) f.five.value = '95';
    if (!f.seven.value) f.seven.value = '95';
    f.resume.checked = !!q.resume;
    f.text.value = q.text || defaultText;
    $('#qsOff').hidden = !s.quotaStop;
    $('#qsState').textContent = stageText(q);
    $('#qsNow').textContent = '';
    try {
      const Q = await api('GET', '/api/quota');
      const parts = [Q.five ? `${t('5 h')} : ${Math.round(Q.five.pct)} %` : '', Q.seven ? `${t('7 jours')} : ${Math.round(Q.seven.pct)} %` : ''].filter(Boolean);
      $('#qsNow').textContent = parts.length ? `${t('Quota actuel')} — ${parts.join(' · ')}` : t('Quota actuel inconnu : il s’affiche après une réponse de Claude.');
    } catch { }
    dlg.returnValue = ''; // sinon le « ok » de la fois précédente resterait si on ferme par Échap
    dlg.showModal();
  };
  dlg.addEventListener('close', async () => {
    const v = dlg.returnValue, id = cur; cur = null;
    if (!id || (v !== 'ok' && v !== 'off')) return;
    const body = v === 'off' || (!f.fiveOn.checked && !f.sevenOn.checked) ? { off: true } : {
      five: f.fiveOn.checked ? Number(f.five.value) : null, seven: f.sevenOn.checked ? Number(f.seven.value) : null,
      resume: f.resume.checked, text: f.text.value.trim() === defaultText.trim() ? '' : f.text.value,
    };
    try {
      const r = await api('POST', `/api/sessions/${id}/quota-stop`, body);
      toast(body.off ? t('Plafond de quota retiré') : r.triggered ? t('Seuil déjà atteint : la session enregistre son travail puis se met en pause') : `${t('Plafond de quota')} : ${summary(r.session.quotaStop)}`);
    } catch (e) { toast(e.message, true); }
  });
  // une case cochée en choisissant un seuil
  for (const k of ['five', 'seven']) f[k].addEventListener('change', () => { f[`${k}On`].checked = true; });

  // pause par plafond : notification (comme une fin de tour)
  window.addEventListener('csm:ws', e => {
    const m = e.detail;
    if (m?.t !== 'quotastop') return;
    const s = sessions.get(m.id); if (!s) return;
    const body = `${t('Quota')} ${m.quota} : ${m.pct} %` + (m.resume ? ` — ${t('reprise automatique à la réinitialisation')}` : ` — ${t('« Reprendre » pour continuer')}`);
    toast(`${s.name} : ${t('en pause (plafond de quota)')}`);
    alertUser(s, t('en pause (plafond de quota)'), body);
  });
})();
