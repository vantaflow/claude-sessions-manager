'use strict';
// Menu « Coffre » : PAT Azure DevOps et secrets (lib/vault). Les valeurs ne sont jamais affichées : « Copier » les
// demande une à une, après confirmation.
(() => {
  const $ = s => document.querySelector(s);
  const dlg = $('#dlgVault');
  if (!dlg) return;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const when = x => (x ? new Date(x).toLocaleString() : '');
  const KIND = { 'azure-pat': 'PAT Azure DevOps', secret: 'Secret' };
  const err = e => toast(t(e.message || String(e)), true);
  let D = null, importSel = new Set();

  async function load() {
    try { D = await api('GET', '/api/vault'); } catch (e) { return err(e); }
    const box = $('#vaultBody'), parts = [];
    $('#vaultSync').textContent = D.sync ? t('Partagé chiffré entre tes machines (synchro).') : t('Sur cette machine seulement (sans synchro, ou partage du coffre coupé).');
    for (const w of D.warnings) parts.push(`<div class="vaultWarn">⚠ ${esc(t(w.message))}${w.cwd ? ` <small>(${esc(w.cwd)})</small>` : ''} <a href="${esc(w.url)}" target="_blank" rel="noopener">${t('Créer un PAT')}</a></div>`);
    for (const c of D.conflicts) parts.push(`<div class="vaultWarn" data-c="${esc(c.id)}">⚠ <b>${esc(c.name)}</b> : ${t('valeur différente sur')} ${esc(c.from || t('une autre machine'))} (${esc(when(c.at))}). ${t('Rien n’a été écrasé.')}
      <button type="button" data-k="local">${t('Garder celle d’ici')}</button><button type="button" data-k="remote">${t('Prendre celle de')} ${esc(c.from || '?')}</button></div>`);
    if (!D.importOffered) {
      const imp = await api('GET', '/api/vault/import').catch(() => ({ candidates: [] }));
      if (imp.candidates.length) {
        importSel = new Set(imp.candidates.map(c => c.key));
        parts.push(`<div class="vaultImport"><b>${t('PAT et secrets déjà présents sur cette machine')}</b><small>${t('Les ranger dans le coffre (les valeurs restent où elles sont, et sont partagées avec tes autres machines) ?')}</small>
          ${imp.candidates.map(c => `<label class="check"><input type="checkbox" data-imp="${esc(c.key)}" checked> <span>${esc(c.name)} · ${esc(t(KIND[c.kind]))}</span></label>`).join('')}
          <div class="acts"><button type="button" data-a="impNo">${t('Non merci')}</button><button type="button" class="primary" data-a="impOk">${t('Importer')}</button></div></div>`);
      }
    }
    parts.push(D.items.length ? `<ul class="results vaultList">${D.items.map(it => {
      const orgs = Object.entries(it.orgs).map(([o, r]) => `<span class="vOrg ${r.ok ? 'ok' : 'bad'}" title="${esc(when(r.at))}">${r.ok ? '✓' : '✗'} ${esc(o)}</span>`).join(' ');
      const tg = [it.targets.keychain && `${t('trousseau')} « ${esc(it.targets.keychain)} »`, it.targets.env && `${t('variable')} ${esc(it.targets.env)}`].filter(Boolean).join(' · ');
      const pend = it.pendingTargets ? `<small class="vPend">${t('Reçu avec une cible à poser sur cette machine')} (${tg}) : ${t('pas posée sans ton accord.')} <button type="button" data-a="apply">${t('Utiliser ici aussi')}</button></small>` : '';
      return `<li data-id="${esc(it.id)}"><div><b>${it.isDefault ? '★ ' : ''}${esc(it.name)}</b><small>${esc(t(KIND[it.kind]))}${tg ? ' · ' + tg : ''}${it.folders.length ? ' · ' + t('dossiers') + ' : ' + it.folders.map(esc).join(', ') : ''} · ${esc(it.origin || '')} · ${esc(when(it.updated))}</small>${orgs ? `<small>${orgs}</small>` : ''}${pend}<span class="vEdit" hidden><input type="password" autocomplete="off" spellcheck="false" placeholder="${t('Nouvelle valeur')}"><button type="button" data-a="editOk" class="primary">${t('Remplacer')}</button><button type="button" data-a="editNo">${t('Annuler')}</button></span></div>
        <span class="acts">${it.kind === 'azure-pat' ? `<button type="button" data-a="check">${t('Vérifier')}</button>${it.isDefault ? '' : `<button type="button" data-a="def">${t('Par défaut')}</button>`}` : ''}<button type="button" data-a="copy">${t('Copier')}</button><button type="button" data-a="edit">${t('Remplacer')}</button><button type="button" data-a="del" class="danger">${t('Supprimer')}</button></span></li>`;
    }).join('')}</ul>` : `<p class="hint">${t('Le coffre est vide.')}</p>`);
    if (D.declared.length) parts.push(`<b>${t('Demandés par les extensions')}</b><ul class="results">${D.declared.map((x, i) => `<li><div><b>${esc(x.name)}</b><small>${esc(x.extName)}${x.description ? ' · ' + esc(x.description) : ''}</small></div><span class="acts"><button type="button" data-decl="${i}">${t('Ajouter au coffre')}</button></span></li>`).join('')}</ul>`);
    box.innerHTML = parts.join('');
    $('#vaultFolderId').innerHTML = `<option value="">${t('PAT par défaut')}</option>` + D.items.filter(x => x.kind === 'azure-pat').map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
    $('#vaultMacOnly').hidden = D.platform !== 'mac';
    wire(box);
  }

  function wire(box) {
    box.querySelectorAll('[data-c] button').forEach(b => { b.onclick = async () => { try { await api('POST', `/api/vault/conflict/${b.closest('[data-c]').dataset.c}`, { keep: b.dataset.k }); } catch (e) { err(e); } load(); }; });
    box.querySelectorAll('[data-imp]').forEach(c => { c.onchange = () => { c.checked ? importSel.add(c.dataset.imp) : importSel.delete(c.dataset.imp); }; });
    box.querySelector('[data-a=impOk]')?.addEventListener('click', async () => { try { const r = await api('POST', '/api/vault/import', { keys: [...importSel] }); toast(`${r.imported} ${t('importé(s)')}`); } catch (e) { err(e); } load(); });
    box.querySelector('[data-a=impNo]')?.addEventListener('click', async () => { await api('POST', '/api/vault/import', { keys: [] }).catch(err); load(); });
    box.querySelectorAll('[data-decl]').forEach(b => { b.onclick = () => { const x = D.declared[+b.dataset.decl]; fillForm({ name: x.name, kind: 'secret', keychain: x.targets.keychain, env: x.targets.env }); }; });
    box.querySelectorAll('.vaultList li[data-id]').forEach(li => li.querySelectorAll('button[data-a]').forEach(b => {
      const id = li.dataset.id, it = D.items.find(x => x.id === id);
      b.onclick = async () => {
        try {
          if (b.dataset.a === 'copy') {
            if (!confirm(`${t('Copier la valeur de')} « ${it.name} » ${t('dans le presse-papiers ?')}`)) return;
            clip.copy((await api('POST', `/api/vault/${id}/reveal`)).value); toast(t('Copié'));
          } else if (b.dataset.a === 'check') {
            b.disabled = true; b.textContent = t('Vérification…');
            const r = await api('POST', `/api/vault/${id}/check`, {});
            const n = Object.keys(r.results).length;
            toast(n ? Object.entries(r.results).map(([o, v]) => `${o} : ${t(v === 'ok' ? 'accepté' : v === 'refused' ? 'refusé' : 'injoignable')}`).join(' · ') : t('Aucune organisation connue : ouvre une session dans un dépôt Azure DevOps.'));
          } else if (b.dataset.a === 'def') await api('PATCH', `/api/vault/${id}`, { isDefault: true });
          else if (b.dataset.a === 'edit') { const e = li.querySelector('.vEdit'); e.hidden = false; e.querySelector('input').focus(); return; }
          else if (b.dataset.a === 'editNo') { li.querySelector('.vEdit').hidden = true; return; }
          else if (b.dataset.a === 'editOk') {
            const v = li.querySelector('.vEdit input').value;
            if (!v) return;
            await withOverwrite(o => api('PATCH', `/api/vault/${id}`, { value: v, ...o })); toast(t('Remplacé'));
          } else if (b.dataset.a === 'apply') { await withOverwrite(o => api('PATCH', `/api/vault/${id}`, { applyTargets: true, ...o })); toast(t('Cible posée sur cette machine')); }
          else if (b.dataset.a === 'del') {
            if (!confirm(`${t('Supprimer')} « ${it.name} » ${t('du coffre, ici et sur tes autres machines ?')}`)) return;
            await api('DELETE', `/api/vault/${id}`);
          }
        } catch (e) { err(e); }
        load();
      };
    }));
  }

  // cible qui contient déjà une autre valeur (posée par un autre outil) : remplacée seulement après confirmation
  async function withOverwrite(call) {
    try { return await call({}); } catch (e) {
      if (!/déjà une autre valeur/.test(e.message) || !confirm(t('Cette cible (trousseau ou variable) contient déjà une autre valeur, posée par un autre outil. La remplacer ?'))) throw e;
      return call({ overwrite: true });
    }
  }
  const fillForm = o => {
    $('#vaultName').value = o.name || ''; $('#vaultKind').value = o.kind || 'azure-pat';
    $('#vaultKeychain').value = o.keychain || ''; $('#vaultEnv').value = o.env || ''; $('#vaultValue').focus();
  };
  $('#vaultAdd').onclick = async () => {
    const body = { name: $('#vaultName').value, kind: $('#vaultKind').value, value: $('#vaultValue').value, targets: { keychain: $('#vaultKeychain').value.trim(), env: $('#vaultEnv').value.trim() } };
    try { await withOverwrite(o => api('POST', '/api/vault', { ...body, ...o })); $('#vaultValue').value = ''; $('#vaultName').value = ''; toast(t('Ajouté au coffre')); } catch (e) { return err(e); }
    load();
  };
  $('#vaultFolderSet').onclick = async () => {
    const cwd = $('#vaultFolder').value.trim();
    if (!cwd) return;
    try { const r = await api('PUT', '/api/vault/folder', { cwd, id: $('#vaultFolderId').value }); toast(r.org ? `${t('Dossier de l’organisation')} ${r.org} : ${t('le PAT qui marche y est choisi tout seul')}` : t('Enregistré')); } catch (e) { return err(e); }
    load();
  };
  $('#vaultFolderBrowse').onclick = async () => {
    const p = window.csmNative ? await window.csmNative.pickFolder('') : (await api('POST', '/api/pick-folder', { initial: '' }).catch(() => ({}))).path;
    if (p) $('#vaultFolder').value = p;
  };
  const F = window.csmFeatures || (window.csmFeatures = {});
  F.openVault = () => { if (!dlg.open) dlg.showModal(); load(); };
  $('#btnVault')?.addEventListener('click', () => F.openVault());
})();
