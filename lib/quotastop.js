'use strict';
// Plafond de quota d'une session : « quand le quota 5 h ou 7 jours atteint N %, demande à Claude d'enregistrer
// où il en est, puis mets la session en pause » (et, au choix, reprise automatique à la réinitialisation).
//
// s.quotaStop = { five, seven : seuils en % (null = pas de plafond sur ce quota), resume, text,
//   stage : '' (armé) | 'pending' (seuil atteint, Claude travaille : demande à la fin de son tour)
//         | 'asked' (demande envoyée, pause à la fin de sa réponse) | 'done' (en pause),
//   hit, hitPct, resetAt : quota atteint, sa valeur, sa réinitialisation ; window : fenêtre déjà traitée }
// Le quota vient de la barre d'état de Claude Code (lib/queue.js, ctx.quota).

const DEFAULT_TEXT = 'Le quota Claude {quota} vient d’atteindre {pct} % : cette session va être mise en pause pour continuer plus tard. '
  + 'Termine l’étape en cours sans en commencer une nouvelle, puis enregistre de quoi reprendre : ce qui est fait, ce qui reste à faire, '
  + 'les fichiers en cours et les commandes utiles, dans le fichier de notes du projet (sinon NOTES-REPRISE.md à la racine du dossier). '
  + 'Si c’est un dépôt git, commite le travail en cours sur la branche actuelle, sans pousser. Réponds ensuite en une ligne : « Prêt pour la pause ».';
const RESUME_TEXT = 'Le quota Claude est réinitialisé : reprends le travail là où tu t’étais arrêté, d’après les notes de reprise enregistrées avant la pause.';
const LABEL = { five: '5 h', seven: '7 jours' };
const SEUIL = v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 10 && n <= 100 ? n : null; };

module.exports = function (ctx) {
  const { route, on, json, readBody, sessions, publicView, persist, broadcast } = ctx;
  const ASK_TIMEOUT = Number(process.env.CSM_QUOTASTOP_TIMEOUT) || 20 * 60e3; // pas de fin de tour : pause quand même
  const MARGIN = Number(process.env.CSM_QUOTA_MARGIN) || 60e3; // reprise 1 min après la réinitialisation
  const RETRY = Number(process.env.CSM_QUOTASTOP_RETRY) || 2 * 60e3, MAX_TRIES = 30; // reprise échouée : réessayée (1 h max)
  const timers = new Map();
  const tell = s => { persist(); broadcast({ t: 'session', s: publicView(s) }); };
  const near = (a, b) => a && b && Math.abs(a - b) < 5 * 60e3;

  // quota atteint pour ce plafond ? (valeur récente, fenêtre pas encore réinitialisée, pas déjà traitée)
  function reached(q, now = Date.now()) {
    const Q = ctx.quota;
    if (!Q || !Q.at || now - Q.at > 6 * 3600e3) return null;
    const list = [];
    if (q.five && Q.pct !== null && Q.pct >= q.five && (!Q.resetAt || Q.resetAt > now)) list.push({ which: 'five', pct: Q.pct, resetAt: Q.resetAt || 0 });
    if (q.seven && Q.seven && Q.seven.pct >= q.seven && (!Q.seven.resetAt || Q.seven.resetAt > now)) list.push({ which: 'seven', pct: Q.seven.pct, resetAt: Q.seven.resetAt || 0 });
    return list.find(r => !(q.window && q.window.which === r.which && near(q.window.resetAt, r.resetAt))) || null;
  }
  const textFor = q => (q.text || DEFAULT_TEXT).replace(/\{quota\}/g, LABEL[q.hit] || '').replace(/\{pct\}/g, String(q.hitPct));

  function ask(s) {
    const q = s.quotaStop;
    if (!s.pty || !ctx.sendPrompt?.(s, textFor(q))) return;
    // en plein travail : Claude Code garde le message et le prend au tour suivant ; seul ce tour-là compte
    q.stage = 'asked'; q.askedAt = Date.now(); q.seen = false; q.busy = s.status !== 'idle';
    clearTimeout(timers.get(s.id));
    const tm = setTimeout(() => stop(s), ASK_TIMEOUT); tm.unref?.();
    timers.set(s.id, tm);
    tell(s);
  }
  async function stop(s) {
    const q = s.quotaStop;
    if (!q || q.stage !== 'asked') return;
    clearTimeout(timers.get(s.id)); timers.delete(s.id);
    q.stage = 'pausing';
    try { await ctx.pauseAndSave(s); } catch { }
    q.stage = 'done'; q.pausedAt = Date.now();
    q.window = { which: q.hit, resetAt: q.resetAt };
    s.message = `en pause : quota ${LABEL[q.hit]} à ${q.hitPct} %`;
    tell(s);
    broadcast({ t: 'quotastop', id: s.id, quota: LABEL[q.hit], pct: q.hitPct, resume: !!q.resume });
    planResume(s);
  }
  // reprise automatique : à la réinitialisation du quota atteint (+1 min), ou plus tôt si le quota est remis à zéro
  // avant (relevé sous le seuil), si la session est toujours en pause
  // Relance échouée (dossier introuvable, Claude Code en cours de mise à jour…) : la session reste en pause et la
  // reprise est retentée toutes les RETRY, au plus MAX_TRIES fois.
  async function resumeNow(s, tries = 0) {
    clearTimeout(timers.get(s.id)); timers.delete(s.id);
    const cur = sessions.get(s.id);
    if (!cur || cur.pty || cur.quotaStop?.stage !== 'done' || !cur.paused) return;
    cur.paused = false; cur.wantRun = true;
    cur.initialPrompt = RESUME_TEXT; // envoyé quand Claude est prêt (lib/queue.js, événement « start »)
    try { await ctx.restartSession(cur); } catch (e) { console.error('plafond de quota : reprise', e); }
    if (cur.pty || !sessions.has(cur.id) || cur.quotaStop?.stage !== 'done') return;
    cur.paused = true; cur.wantRun = false; delete cur.initialPrompt; tell(cur); // toujours en pause
    if (tries + 1 >= MAX_TRIES) return;
    const tm = setTimeout(() => resumeNow(cur, tries + 1), RETRY); tm.unref?.();
    timers.set(cur.id, tm);
  }
  function planResume(s) {
    const q = s.quotaStop;
    if (!q?.resume || q.stage !== 'done' || !q.resetAt) return;
    clearTimeout(timers.get(s.id));
    const tm = setTimeout(() => resumeNow(s), Math.max(500, q.resetAt - Date.now() + MARGIN));
    tm.unref?.();
    timers.set(s.id, tm);
  }
  // valeur actuelle d'un quota (relevé récent), null si inconnue
  const current = which => {
    const Q = ctx.quota;
    if (!Q || !Q.at || Date.now() - Q.at > 6 * 3600e3) return null;
    return which === 'five' ? Q.pct : Q.seven ? Q.seven.pct : null;
  };

  function check(s) {
    const q = s.quotaStop;
    if (!q || q.stage || !s.pty || s.lock) return false;
    const r = reached(q);
    if (!r) return false;
    q.hit = r.which; q.hitPct = Math.round(r.pct); q.resetAt = r.resetAt;
    // tout de suite, même en plein travail (un long tour pouvait ne jamais finir) ; pas pendant une demande
    // d'autorisation (le texte y répondrait) : dès que Claude reprend ou a fini
    if (s.status === 'idle' || s.status === 'working') ask(s);
    else { q.stage = 'pending'; tell(s); }
    return true;
  }

  on('quota', () => {
    for (const s of sessions.values()) {
      const q = s.quotaStop; if (!q) continue;
      // quota redescendu sous le seuil (remis à zéro avant sa date) : fenêtre traitée oubliée, reprise si demandée
      if (q.window && current(q.window.which) !== null && current(q.window.which) < (q[q.window.which] || 100)) {
        delete q.window;
        if (q.stage === 'done' && q.resume && q.hit) { resumeNow(s); continue; }
      }
      check(s);
    }
  });
  // demande prise en compte par Claude (début de son tour) : la fin de ce tour déclenche la pause
  on('working', (s, d) => {
    const q = s.quotaStop;
    if (q?.stage === 'pending') return ask(s); // demande d'autorisation réglée : Claude reprend
    if (q?.stage !== 'asked' || q.seen) return;
    // envoyée au repos : le premier tour qui suit est le sien ; en plein travail : le tour qui commence par ce message
    if (!q.busy || (typeof d?.prompt === 'string' && d.prompt.includes(textFor(q).slice(0, 80)))) q.seen = true;
  });
  on('idle', s => {
    const q = s.quotaStop;
    if (!q) return;
    if (q.stage === 'pending') ask(s);
    else if (q.stage === 'asked' && q.seen) stop(s);
    else check(s);
  });
  // relancée (Reprendre, ou reprise automatique) : plafond de nouveau armé ; la fenêtre déjà traitée ne compte plus
  // s'il a été repris à la main avant la réinitialisation (pas de nouvelle demande dans la même fenêtre)
  on('start', (s, d) => {
    const q = s.quotaStop;
    if (!q || !q.stage) return;
    if (d && (d.source === 'compact' || d.source === 'clear')) return; // même claude (compactage, /clear) : rien à réarmer
    clearTimeout(timers.get(s.id)); timers.delete(s.id);
    if (q.stage !== 'done') q.window = { which: q.hit, resetAt: q.resetAt };
    q.stage = ''; tell(s);
  });
  on('removed', s => { clearTimeout(timers.get(s.id)); timers.delete(s.id); });
  // serveur redémarré : reprises automatiques à replanifier ; demande en cours perdue (session arrêtée)
  setTimeout(() => {
    for (const s of sessions.values()) {
      const q = s.quotaStop; if (!q) continue;
      if (q.stage === 'done') planResume(s);
      else if (q.stage && !s.pty) q.stage = '';
    }
  }, 2000).unref?.();

  route('POST', /^\/api\/sessions\/(\w+)\/quota-stop$/, async ({ req, res, m }) => {
    const s = sessions.get(m[1]); if (!s) return json(res, 404, { error: 'session inconnue' });
    const b = await readBody(req);
    clearTimeout(timers.get(s.id)); timers.delete(s.id);
    const five = SEUIL(b.five), seven = SEUIL(b.seven);
    if (b.off || (!five && !seven)) { delete s.quotaStop; tell(s); return json(res, 200, { session: publicView(s), triggered: false }); }
    const old = s.quotaStop || {};
    const text = String(b.text || '').trim().slice(0, 4000);
    s.quotaStop = { five, seven, resume: !!b.resume, text: text && text !== DEFAULT_TEXT ? text : '', stage: old.stage === 'done' ? 'done' : '', window: old.window };
    if (s.quotaStop.stage === 'done') { s.quotaStop.hit = old.hit; s.quotaStop.hitPct = old.hitPct; s.quotaStop.resetAt = old.resetAt; planResume(s); }
    const triggered = check(s); // déjà au-dessus du seuil : appliqué tout de suite
    tell(s);
    json(res, 200, { session: publicView(s), triggered });
  });
  route('GET', /^\/api\/quota-stop\/default$/, async ({ res }) => json(res, 200, { text: DEFAULT_TEXT }));
};
module.exports.DEFAULT_TEXT = DEFAULT_TEXT;
