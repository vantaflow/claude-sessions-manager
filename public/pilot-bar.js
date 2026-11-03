'use strict';
// Pilotage à distance : ajouté par le mandataire local (lib/remote/pilot.js) en tête de la page de la machine
// pilotée. Bandeau permanent « Vous pilotez <machine> » avec le retour sur cette machine.
(() => {
  window.csmRemote = true;
  const show = info => {
    const b = document.createElement('div');
    b.id = 'csmPilotBar';
    b.setAttribute('role', 'status');
    b.style.cssText = 'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:9999;background:#d97757;color:#111;font:600 12px system-ui,sans-serif;padding:3px 12px;border-radius:0 0 8px 8px;display:flex;gap:10px;align-items:center';
    const txt = document.createElement('span');
    txt.textContent = (document.documentElement.lang === 'en' ? 'Remote control: ' : 'Vous pilotez ') + info.machine;
    const back = document.createElement('a');
    back.href = info.back;
    // fermer le tunnel avant de revenir : sans ça, la machine pilotée garde le bandeau « Pilotée à distance »
    back.addEventListener('click', e => { e.preventDefault(); fetch('/__pilot-close').catch(() => { }).finally(() => { location.href = info.back; }); });
    back.textContent = document.documentElement.lang === 'en' ? 'Back to this machine' : 'Revenir sur cette machine';
    back.style.cssText = 'color:#111;text-decoration:underline';
    b.append(txt, back);
    document.body.appendChild(b);
    // « Couper » sur la machine pilotée : annoncé, avec le retour (la fenêtre ne se reconnecte pas)
    const poll = setInterval(() => fetch('/__pilot-info').then(r => r.json()).then(i => {
      if (!i.cut) return;
      clearInterval(poll);
      txt.textContent = document.documentElement.lang === 'en' ? 'Remote control stopped from the machine' : 'Pilotage coupé depuis la machine';
    }).catch(() => { }), 3000);
  };
  fetch('/__pilot-info').then(r => r.json()).then(info => { if (document.body) show(info); else addEventListener('DOMContentLoaded', () => show(info)); }).catch(() => { });
})();
