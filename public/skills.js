'use strict';
// Skills disponibles dans CSM (fenêtre « Skills », Ctrl+Alt+K) : tous les skills que Claude Code peut lancer —
// personnels, plugins activés, et ceux du dossier de la session active — avec ce que fait chacun. « Lancer » écrit
// /nom dans la saisie de la session active (on ajoute sa demande puis Entrée) ; ⌨ range un skill sur Ctrl+Maj+1…9.
(() => {
  const F = window.csmFeatures;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const SKEYS = 'csm.skillKeys';
  const skillKeys = () => LS.get(SKEYS, {});
  const cache = new Map(); // dossier → liste
  let list = [], q = '';

  async function skillsFor(id) {
    const key = sessions.get(id)?.cwd || '';
    try { cache.set(key, await api('GET', `/api/skills?session=${encodeURIComponent(id || '')}&cwd=${encodeURIComponent(key)}`)); }
    catch (e) { if (!cache.has(key)) throw e; }
    return cache.get(key);
  }
  // Écrit la commande dans la saisie de la session active, sans valider.
  function useSkill(cmd) {
    const tt = terms.get(active);
    if (!tt) { toast(t('Ouvre ou sélectionne une session pour y lancer un skill'), true); return; }
    if ($('#dlgSkills').open) $('#dlgSkills').close();
    tt.term.paste(cmd + ' ');
    tt.term.focus();
  }
  F.useSkill = useSkill;
  F.skillsFor = skillsFor;
  F.runSkillSlot = n => {
    const cmd = skillKeys()[n];
    if (!cmd) { toast(`${t('Aucun skill sur')} Ctrl+Maj+${n} : ${t('fenêtre Skills')} (Ctrl+Alt+K)`, true); return; }
    useSkill(cmd);
  };
  function setSlot(cmd) {
    const keys = skillKeys(), cur = Object.keys(keys).find(k => keys[k] === cmd);
    if (cur) { delete keys[cur]; LS.set(SKEYS, keys); toast(t('Raccourci retiré')); return; }
    const free = [1, 2, 3, 4, 5, 6, 7, 8, 9].find(n => !keys[n]);
    if (!free) { toast(t('Les 9 raccourcis sont pris : retirez-en un'), true); return; }
    keys[free] = cmd; LS.set(SKEYS, keys);
    toast(`${cmd} → Ctrl+Maj+${free}`);
  }

  function render() {
    const keys = skillKeys(), slotOf = c => Object.keys(keys).find(k => keys[k] === c);
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = list.filter(x => words.every(w => `${x.command} ${x.description} ${x.plugin}`.toLowerCase().includes(w)));
    const s = sessions.get(active);
    // ordre : personnels, plugins (par nom), puis ceux du dossier de la session active
    const groups = new Map();
    const add = (g, x) => { if (!groups.has(g)) groups.set(g, []); groups.get(g).push(x); };
    for (const x of shown.filter(x => x.source === 'user')) add(t('Personnels'), x);
    for (const x of shown.filter(x => x.source === 'plugin').sort((a, b) => a.plugin.localeCompare(b.plugin))) add(`${t('Plugin')} ${x.plugin}`, x);
    for (const x of shown.filter(x => x.source === 'project')) add(`${t('Dossier de la session active')}${s ? ' · ' + s.name : ''}`, x);
    const item = x => {
      const k = slotOf(x.command);
      return `<li data-c="${esc(x.command)}"><div class="pmeta"><span class="skName">${esc(x.command)}${x.args ? ` <small>${esc(x.args)}</small>` : ''}</span>
        <span class="acts"><button data-a="key" class="${k ? 'on' : ''}" title="${k ? t('Retirer le raccourci') : t('Donner un raccourci Ctrl+Maj+1…9')}">${k ? `⌨ ${k}` : '⌨'}</button><button data-a="use" title="${t('Écrire la commande dans la saisie de la session active')}">${t('Lancer')}</button></span></div>
        <div class="ptext">${esc(x.description || t('(sans description)'))}</div></li>`;
    };
    const fav = Object.keys(keys).sort().map(k => ({ k, cmd: keys[k] }));
    const favHtml = fav.length && !words.length
      ? `<li class="skHead">${t('Raccourcis')}</li><li class="skFav">${fav.map(f => `<button data-f="${esc(f.cmd)}" title="Ctrl+Maj+${f.k}"><kbd>${f.k}</kbd> ${esc(f.cmd)}</button>`).join('')}</li>` : '';
    const body = [...groups].map(([g, l]) => `<li class="skHead">${esc(g)} <small>${l.length}</small></li>${l.map(item).join('')}`).join('');
    const ul = $('#skillList');
    ul.innerHTML = favHtml + (body || `<li class="hint">${list.length ? t('Aucun skill ne correspond.') : t('Aucun skill installé.')}</li>`);
    ul.querySelectorAll('li[data-c]').forEach(li => {
      const c = li.dataset.c;
      li.querySelector('.ptext').onclick = () => li.classList.toggle('open');
      li.querySelector('[data-a=use]').onclick = () => useSkill(c);
      li.querySelector('[data-a=key]').onclick = () => { setSlot(c); render(); };
    });
    ul.querySelectorAll('[data-f]').forEach(b => { b.onclick = () => useSkill(b.dataset.f); });
    $('#skillCount').textContent = `${list.length} ${t('skill(s)')}`;
  }

  F.openSkills = async () => {
    const d = $('#dlgSkills');
    if (d.open) { d.close(); return; }
    q = ''; $('#skillQ').value = '';
    $('#skillList').innerHTML = `<li class="hint">${t('Chargement…')}</li>`;
    d.showModal(); $('#skillQ').focus();
    try { list = await skillsFor(active); } catch (e) { $('#skillList').innerHTML = `<li class="err">${esc(e.message)}</li>`; return; }
    render();
  };
  $('#skillQ').oninput = e => { q = e.target.value; render(); };
  $('#skillClose').onclick = () => $('#dlgSkills').close();
  $('#btnSkills').onclick = () => F.openSkills();
})();
