'use strict';
// Verrouillage d'une session par mot de passe.
// Appliqué côté serveur : une session verrouillée n'envoie ni sortie ni relecture aux fenêtres non
// déverrouillées, refuse leur saisie et ses routes sensibles (git, export, file d'attente…).
// Le déverrouillage est propre à une connexion WebSocket (une fenêtre) et délivre un « ticket »
// à joindre aux requêtes HTTP de cette fenêtre (en-tête X-CSM-Unlock : id:ticket,id:ticket).
// Limite assumée : c'est un écran de confidentialité de l'application ; les transcripts de Claude Code
// (~/.claude/projects) restent des fichiers en clair sur le disque.
const crypto = require('crypto');

const hash = (password, salt) => crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 }).toString('hex');
function makeLock(password, hint) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hash(password, salt), hint: String(hint || '').slice(0, 120) };
}
function check(lock, password) {
  if (!lock || typeof password !== 'string') return false;
  const a = Buffer.from(hash(password, lock.salt), 'hex'), b = Buffer.from(lock.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = function (ctx) {
  const { route, json, readBody, sessions, publicView, persist, broadcast } = ctx;
  const tickets = new Map();  // sessionId -> Map(ticket -> ws)
  const fails = new Map();    // sessionId -> { n, until }

  const isLocked = s => !!(s && s.lock);
  // Essai de mot de passe, limité par session quel que soit le chemin (WebSocket ou HTTP) :
  // 5 échecs, puis attente croissante (15 s, 30 s… 5 min). Évite aussi de bloquer le serveur avec scrypt.
  function attempt(s, password) {
    const f = fails.get(s.id) || { n: 0, until: 0 };
    if (Date.now() < f.until) return { ok: false, error: `Trop d'essais : réessaie dans ${Math.ceil((f.until - Date.now()) / 1000)} s`, code: 429 };
    if (!check(s.lock, password)) {
      f.n++; if (f.n >= 5) f.until = Date.now() + Math.min(300, 15 * 2 ** (f.n - 5)) * 1000;
      fails.set(s.id, f);
      return { ok: false, error: 'Mot de passe incorrect', code: 403 };
    }
    fails.delete(s.id);
    return { ok: true };
  }
  function ticketsOf(req) {
    const out = new Map();
    for (const part of String(req.headers['x-csm-unlock'] || '').split(',')) {
      const [id, tk] = part.trim().split(':');
      if (id && tk) out.set(id, tk);
    }
    return out;
  }
  const hasTicket = (s, tk) => !!tk && !!tickets.get(s.id)?.has(tk);
  // Une requête HTTP peut-elle agir sur cette session ?
  ctx.canAccess = (s, req) => !isLocked(s) || hasTicket(s, ticketsOf(req).get(s.id));
  // Une connexion WebSocket peut-elle voir / piloter cette session ?
  ctx.wsCan = (s, ws) => !isLocked(s) || [...(tickets.get(s.id)?.values() || [])].includes(ws);
  ctx.lockedByConversation = claudeId => [...sessions.values()].find(s => isLocked(s) && s.claudeSessionId === claudeId);

  function revoke(s, ws) {
    const m = tickets.get(s.id); if (!m) return;
    for (const [tk, w] of m) if (!ws || w === ws) { m.delete(tk); try { w.send(JSON.stringify({ t: 'relocked', id: s.id })); } catch { } }
  }
  ctx.onWsClose = ws => { for (const m of tickets.values()) for (const [tk, w] of m) if (w === ws) m.delete(tk); };

  // Messages WebSocket : { t:'unlock', id, password } / { t:'lock', id }
  ctx.onWsMessage = (ws, m) => {
    const s = sessions.get(m.id);
    if (!s || !isLocked(s)) return false;
    if (m.t === 'unlock') {
      const reply = o => ws.send(JSON.stringify({ t: 'unlock-result', id: s.id, ...o }));
      const a = attempt(s, m.password);
      if (!a.ok) { reply({ ok: false, error: a.error }); return true; }
      const tk = crypto.randomBytes(18).toString('hex');
      if (!tickets.has(s.id)) tickets.set(s.id, new Map());
      tickets.get(s.id).set(tk, ws);
      reply({ ok: true, ticket: tk });
      if (s.buf) ws.send(JSON.stringify({ t: 'replay', id: s.id, d: s.buf }));
      return true;
    }
    if (m.t === 'lock') { revoke(s, ws); return true; }
    return false;
  };

  // Définir / changer le mot de passe (si déjà verrouillée : ancien mot de passe ou fenêtre déverrouillée).
  route('POST', /^\/api\/sessions\/(\w+)\/lock$/, async ({ req, res, m }) => {
    const s = sessions.get(m[1]); if (!s) return json(res, 404, { error: 'session inconnue' });
    const { password, current, hint } = await readBody(req);
    if (typeof password !== 'string' || password.length < 4) return json(res, 400, { error: 'mot de passe trop court (4 caractères minimum)' });
    if (isLocked(s) && !ctx.canAccess(s, req)) {
      const a = attempt(s, current);
      if (!a.ok) return json(res, a.code, { error: a.code === 429 ? a.error : 'mot de passe actuel incorrect' });
    }
    s.lock = makeLock(password, hint);
    revoke(s); // toutes les fenêtres doivent redéverrouiller
    persist(); broadcast({ t: 'session', s: publicView(s) });
    json(res, 200, publicView(s));
  });

  route('POST', /^\/api\/sessions\/(\w+)\/unlock-remove$/, async ({ req, res, m }) => {
    const s = sessions.get(m[1]); if (!s) return json(res, 404, { error: 'session inconnue' });
    if (!isLocked(s)) return json(res, 200, publicView(s));
    const { password } = await readBody(req);
    const a = attempt(s, password);
    if (!a.ok) return json(res, a.code, { error: a.code === 429 ? a.error : 'mot de passe incorrect' });
    delete s.lock; tickets.delete(s.id);
    persist(); broadcast({ t: 'session', s: publicView(s) });
    json(res, 200, publicView(s));
  });
  // session supprimée : tickets et essais oubliés
  ctx.on('removed', s => { tickets.delete(s.id); fails.delete(s.id); });
};
module.exports.check = check;
