'use strict';
// Réglages › Export / import : toutes les sessions de cette machine dans un fichier .csmx (lib/transfer.js),
// pour changer d'ordinateur sans synchronisation.
(() => {
  const $ = s => document.querySelector(s);
  if (!$('#trExport')) return;
  const mo = n => (n / 1e6 < 1 ? `${Math.max(1, Math.round(n / 1e3))} Ko` : `${(n / 1e6).toFixed(1)} Mo`);
  const say = (sel, text, bad) => { const p = $(sel); p.textContent = text; p.classList.toggle('bad', !!bad); };

  // ---------------------------------------------------------------- export
  $('#trExport').onclick = async () => {
    const pw = $('#trPw').value, pw2 = $('#trPw2').value;
    if (pw !== pw2) return say('#trExportMsg', t('Les deux mots de passe ne correspondent pas.'), true);
    const def = await api('GET', '/api/transfer/default');
    let file = def.path;
    if (window.csmNative?.pickSave) { file = await window.csmNative.pickSave(def.name); if (!file) return; }
    const btn = $('#trExport'); btn.disabled = true;
    say('#trExportMsg', t('Export en cours…'));
    try {
      const r = await api('POST', '/api/transfer/export', { path: file, password: pw, transcripts: $('#trConv').checked });
      say('#trExportMsg', `${t('Exporté')} : ${r.path} (${mo(r.size)}) · ${r.sessions} ${t('sessions')}, ${r.transcripts} ${t('conversations')}`
        + (r.failed ? ` · ${r.failed} ${t('élément(s) illisible(s), non exporté(s)')}` : '')
        + (r.locked ? ` · ${r.locked} ${t('session(s) verrouillée(s) sans sa conversation (à déverrouiller avant l’export)')}` : '')
        + (r.encrypted ? '' : ` · ${t('sans mot de passe : garde ce fichier en lieu sûr')}`));
      $('#trPw').value = $('#trPw2').value = '';
    } catch (e) { say('#trExportMsg', e.message, true); } finally { btn.disabled = false; }
  };

  // ---------------------------------------------------------------- import : fichier, aperçu, confirmation
  const reset = () => { $('#trPreview').hidden = true; $('#trGo').hidden = true; $('#trList').replaceChildren(); $('#trSummary').textContent = ''; $('#trInPw').value = ''; };
  $('#trImport').onclick = () => $('#trFile').click();
  $('#trFile').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    reset(); say('#trImportMsg', `${t('Lecture du fichier')}… (${mo(f.size)})`);
    try {
      const r = await fetch('/api/transfer/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-CSM-Token': TOKEN }, body: f });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      say('#trImportMsg', '');
      await preview();
    } catch (err) { say('#trImportMsg', err.message, true); }
  };
  async function preview() {
    $('#trPreview').hidden = false;
    const r = await fetch('/api/transfer/preview', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSM-Token': TOKEN }, body: JSON.stringify({ password: $('#trInPw').value }) });
    const d = await r.json().catch(() => ({}));
    if (d.password || (!r.ok && $('#trInPw').value)) {
      // fichier protégé : mot de passe demandé (ou refusé)
      $('#trPwRow').hidden = false; $('#trGo').hidden = true;
      say('#trImportMsg', d.password ? t('Ce fichier est protégé par un mot de passe.') : d.error || r.statusText, !d.password);
      $('#trInPw').focus();
      return;
    }
    if (!r.ok) { say('#trImportMsg', d.error || r.statusText, true); return; }
    $('#trPwRow').hidden = !$('#trInPw').value; say('#trImportMsg', '');
    const fresh = d.sessions.filter(s => !s.here).length;
    const when = d.exportedAt ? new Date(d.exportedAt).toLocaleString() : '';
    $('#trSummary').textContent = `${t('Exporté de')} « ${d.machine || '?'} »${when ? ` ${t('le')} ${when}` : ''} : ${d.sessions.length} ${t('sessions')} (${fresh} ${t('nouvelles ici')}), ${d.transcripts} ${t('conversations')}, ${d.groups} ${t('groupes')}, ${d.templates} ${t('modèles')}, ${d.extensions} ${t('extensions')}.`;
    $('#trList').replaceChildren(...d.sessions.map(s => {
      const li = document.createElement('li');
      const b = document.createElement('b'); b.textContent = s.name;
      const sub = document.createElement('span'); sub.className = 'hint';
      sub.textContent = ` · ${s.here ? t('déjà ici') : s.found ? s.cwd : `${s.cwd} — ${t('dossier introuvable ici : ouverte dans le dossier personnel')}`}${s.conversation ? '' : ` · ${t('sans conversation')}`}`;
      li.append(b, sub);
      if (s.here) li.classList.add('dim');
      return li;
    }));
    $('#trGo').hidden = false;
    $('#trGo').textContent = fresh ? `${t('Importer')} ${fresh} ${t('sessions')}` : t('Importer');
  }
  $('#trOpen').onclick = () => preview();
  $('#trInPw').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); preview(); } });
  $('#trCancel').onclick = () => { reset(); say('#trImportMsg', ''); api('DELETE', '/api/transfer/upload').catch(() => { }); };
  $('#trGo').onclick = async () => {
    const btn = $('#trGo'); btn.disabled = true;
    say('#trImportMsg', t('Import en cours…'));
    try {
      const r = await api('POST', '/api/transfer/import', { password: $('#trInPw').value });
      reset();
      say('#trImportMsg', `${t('Importé')} : ${r.sessions} ${t('sessions')}, ${r.transcripts} ${t('conversations')}`
        + (r.failed ? ` · ${r.failed} ${t('élément(s) non écrit(s)')}` : '')
        + (r.skipped ? ` · ${r.skipped} ${t('déjà présentes')}` : '') + (r.groups ? ` · ${r.groups} ${t('groupes')}` : '')
        + (r.templates ? ` · ${r.templates} ${t('modèles')}` : '') + (r.extensions ? ` · ${r.extensions} ${t('extensions')}` : '')
        + `. ${t('« Reprendre » continue chaque conversation.')}`);
    } catch (e) { say('#trImportMsg', e.message, true); } finally { btn.disabled = false; }
  };
})();
