'use strict';
// Pilotage à distance (lib/remote) dans l'interface :
// - machine qui pilote : bouton en tête de la barre latérale, liste des machines de l'espace qui l'autorisent ;
//   en choisir une fait naviguer la fenêtre vers son CSM (mandataire local, lib/remote/pilot.js) ;
// - machine pilotée : bandeau « Pilotée à distance depuis … » avec « Couper » ;
// - session : qui a tapé en dernier (« ici » ou le nom du pilote) ;
// - Réglages › Synchronisation › Pilotage à distance : état, accès web par mot de passe.
(() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const F = window.csmFeatures || (window.csmFeatures = {});
  const remote = !!window.csmRemote; // page affichée à distance (pilot-bar.js)
  const btn = $('#btnMachines'), menu = $('#pilotMenu');
  let list = [];

  async function refreshMachines() {
    if (remote || !btn) return;
    try { list = (await api('GET', '/api/remote/machines')).filter(m => m.remote); } catch { list = []; }
    btn.hidden = !list.length;
  }
  async function pilot(dev) {
    menu.hidden = true;
    try { const r = await api('POST', '/api/remote/open', { dev }); window.csmNative?.allowPilot?.(new URL(r.url).origin); location.href = r.url; } catch (e) { toast(t(e.message), true); }
  }
  F.openPilot = async () => {
    await refreshMachines();
    if (!list.length) return toast(t('Aucune autre machine n’autorise le pilotage (Réglages › Synchronisation, sur la machine à piloter).'));
    menu.innerHTML = `<b>${t('Piloter une autre machine')}</b>` + list.map(m => `<button type="button" data-dev="${esc(m.dev)}">${esc(m.name)} <small>${esc(m.platform === 'win32' ? 'Windows' : m.platform === 'darwin' ? 'macOS' : m.platform || '')}</small></button>`).join('');
    menu.querySelectorAll('[data-dev]').forEach(b => { b.onclick = () => pilot(b.dataset.dev); });
    menu.hidden = false;
  };
  btn?.addEventListener('click', e => { e.stopPropagation(); menu.hidden ? F.openPilot() : (menu.hidden = true); });
  document.addEventListener('click', e => { if (menu && !menu.hidden && !menu.contains(e.target)) menu.hidden = true; });

  // ---------------------------------------------------------------- machine pilotée : bandeau
  let banner = null;
  function showPilots(pilots) {
    if (remote) return; // à distance, c'est le bandeau du pilote (pilot-bar.js) qui s'affiche
    if (!pilots?.length) { banner?.remove(); banner = null; return; }
    if (!banner) {
      banner = document.createElement('div'); banner.className = 'remoteBanner'; banner.setAttribute('role', 'status');
      document.body.appendChild(banner);
    }
    banner.innerHTML = `<span>${t('Pilotée à distance depuis')} ${pilots.map(p => esc(p.name)).join(', ')}</span><button type="button">${t('Couper')}</button>`;
    banner.querySelector('button').onclick = async () => { try { await api('POST', '/api/remote/cut'); } catch (e) { toast(e.message, true); } };
  }
  window.addEventListener('csm:ws', e => { if (e.detail?.t === 'remote') { showPilots(e.detail.pilots); renderState(); } });

  // ---------------------------------------------------------------- qui a tapé en dernier
  window.addEventListener('csm:active', e => {
    const s = e.detail, msg = $('#curMsg');
    if (!msg) return;
    let tag = $('#curTyped');
    if (!tag) { tag = document.createElement('span'); tag.id = 'curTyped'; tag.className = 'typedBy'; msg.after(tag); }
    tag.hidden = !s.typedBy;
    tag.textContent = s.typedBy ? `⌨ ${s.typedBy}` : '';
    tag.title = s.typedBy ? `${t('Dernière saisie depuis')} ${s.typedBy}` : '';
  });

  // ---------------------------------------------------------------- réglages
  async function renderState() {
    const el = $('#remoteState');
    if (!el) return;
    let st; try { st = await api('GET', '/api/remote/status'); } catch { return; }
    const h = st.host;
    el.textContent = !h.on ? t('Désactivé : cette machine ne peut pas être pilotée.')
      : !h.connected ? t('Activé, en attente du serveur de synchro (code de synchro requis).')
      : h.pilots.length ? `${t('Pilotée en ce moment depuis')} ${h.pilots.map(p => p.name).join(', ')}` : t('Prête : tes autres machines peuvent la piloter.');
    $('#remoteBox').hidden = remote;
    if (st.web) { $('#remoteLinkRow').hidden = !st.web.url; $('#remoteLink').value = st.web.url || ''; $('#remotePwOff').hidden = !st.web.url; }
    showPilots(h.pilots);
  }
  $('#remotePwSet')?.addEventListener('click', async () => {
    const pw = $('#remotePw').value;
    if (pw.length < 12) return toast(t('Mot de passe trop court (12 caractères au moins).'), true);
    const b = $('#remotePwSet'); b.disabled = true;
    try { await api('POST', '/api/remote/web', { password: pw }); $('#remotePw').value = ''; toast(t('Accès web enregistré')); } catch (e) { toast(t(e.message), true); }
    b.disabled = false; renderState();
  });
  $('#remotePwOff')?.addEventListener('click', async () => {
    if (!confirm(t('Couper l’accès web ? Le lien ne marchera plus.'))) return;
    try { await api('DELETE', '/api/remote/web'); } catch (e) { toast(t(e.message), true); }
    renderState();
  });
  $('#remoteLinkCopy')?.addEventListener('click', () => { clip.copy($('#remoteLink').value); toast(t('Lien copié')); });
  F.renderRemote = renderState;
  window.addEventListener('csm:ready', () => { refreshMachines(); renderState(); setInterval(refreshMachines, 60e3); });
})();
