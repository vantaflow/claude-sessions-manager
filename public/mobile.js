'use strict';
// Version mobile (téléphone : pilotage depuis un navigateur, page /web) : sous 760 px de large, la liste des sessions
// devient un tiroir (bouton ☰), une seule session est affichée, la barre ne garde que les icônes, les fenêtres et le
// panneau prennent tout l'écran, et une zone de saisie avec les touches utiles remplace la frappe dans le terminal
// (le clavier d'un téléphone y marche mal : pas d'Échap, de Tab ni de flèches).
(() => {
  const mq = matchMedia('(max-width: 760px)');
  const KEYS = [['Échap', '\x1b'], ['Tab', '\t'], ['⇧Tab', '\x1b[Z'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'], ['Ctrl+C', '\x03'], ['⏎', '\r']];
  const tr = s => (typeof t === 'function' ? t(s) : s);

  // bouton ☰ en tête de la barre de session, fond qui referme le tiroir
  const burger = document.createElement('button');
  burger.id = 'btnSide'; burger.className = 'icon'; burger.type = 'button';
  burger.setAttribute('aria-label', tr('Sessions')); burger.title = tr('Sessions'); burger.textContent = '☰';
  burger.onclick = () => document.body.classList.toggle('sideOpen');
  $('#bar').prepend(burger);
  const shade = document.createElement('div');
  shade.id = 'sideShade'; shade.onclick = () => document.body.classList.remove('sideOpen');
  document.body.append(shade);

  // zone de saisie : le texte part dans la session active (collé d'un bloc, puis Entrée), touches spéciales à côté
  const bar = document.createElement('div');
  bar.id = 'mobileInput';
  bar.innerHTML = `<div class="mkeys">${KEYS.map(([l], i) => `<button type="button" data-k="${i}">${l}</button>`).join('')}</div>
    <div class="mrow"><textarea rows="1" placeholder="${tr('Écrire à Claude…')}" enterkeyhint="send" autocapitalize="sentences"></textarea><button type="button" class="primary" data-a="send">${tr('Envoyer')}</button></div>`;
  $('#work').after(bar);
  const ta = bar.querySelector('textarea');
  const input = d => { if (active) send({ t: 'input', id: active, d }); };
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; };
  function submit() {
    const v = ta.value;
    if (!active) return;
    if (v) { const tt = terms.get(active); if (tt) tt.term.paste(v); else input(v); }
    setTimeout(() => input('\r'), v ? 60 : 0); // après le collage : Entrée envoie
    ta.value = ''; grow();
  }
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
  bar.querySelector('[data-a=send]').onclick = () => { submit(); ta.focus(); };
  // pointerdown sans perte du focus : le clavier du téléphone reste ouvert entre deux touches
  bar.querySelectorAll('[data-k]').forEach(b => {
    b.addEventListener('pointerdown', e => e.preventDefault());
    b.onclick = () => input(KEYS[+b.dataset.k][1]);
  });

  function apply() {
    const on = mq.matches;
    document.body.classList.toggle('mobile', on);
    if (!on) document.body.classList.remove('sideOpen');
    if (on && typeof setLayout === 'function' && typeof layout !== 'undefined' && layout !== '1') setLayout('1');
    requestAnimationFrame(() => typeof fitAll === 'function' && fitAll(true));
  }
  mq.addEventListener('change', apply);
  window.addEventListener('csm:ready', apply);
  // autre session choisie : tiroir fermé (csm:active part aussi à chaque rafraîchissement de la barre)
  let shown = null;
  window.addEventListener('csm:active', e => { const id = e.detail?.id; if (id !== shown) { if (shown !== null) document.body.classList.remove('sideOpen'); shown = id; } });
  apply();
})();
