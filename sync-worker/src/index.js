// Synchro des sessions de Claude Sessions Manager (#27) et de leurs conversations, chiffrées par l'app avant
// l'envoi (AES-256-GCM, clé dérivée du code) : ici, les conversations ne sont que des octets illisibles.
// GET  /sessions?since=<rev>  -> { rev, items: [{ uid, data, updatedAt, deleted, origin, rev }] }
// POST /sessions { items }    -> { rev, applied }   (une ligne n'écrase que si updatedAt est plus récent)
// POST /spaces { auth }       -> { ok }             (crée un espace ; auth = SHA-256 de la clé d'accès, calculée
//                                                   par l'app à partir d'un code qu'elle a tiré : le code ne vient jamais ici)
// POST /spaces sans auth       -> 410               (ancien format d'avant la 3.8 : le serveur tirait le code)
// POST /spaces/link { auth }  (Bearer ancien code)  rattache une clé d'accès à un espace créé avant la 3.8
// GET  /transcripts           -> { items: [{ uid, cid, ver, chunks, size, updatedAt, origin }] }
// PUT  /transcripts/<uid>/<ver>/<n>   octets        (morceau n de la version ver, 1 Mo au plus)
// GET  /transcripts/<uid>/<ver>/<n>   -> octets
// GET  /usage                 -> { bytes, max, sessions, transcripts, parts }   (place occupée, détail par catégorie)
// DELETE /space                -> { ok }   efface tout l'espace (données, morceaux R2, accès) : changement de code
// GET  /live (WebSocket)       -> « changed » dès qu'une autre machine du même espace écrit (sessions ou conversation
//                                validée) ; l'app synchronise alors tout de suite au lieu d'attendre son relevé.
//                                X-CSM-Client (en-tête des requêtes et de /live) : l'auteur n'est pas prévenu de ses
//                                propres écritures. Un Durable Object par espace (Hub), connexions en hibernation.
// Pilotage à distance (3.64) : relais de trames chiffrées de bout en bout entre une machine pilotée (hôte) et une
// machine qui la pilote ; le Hub de l'espace les transmet sans les lire.
// GET  /relay?role=host&dev=<dev> (WebSocket, authentifié)      -> reçoit { c, d } des pilotes, { c, ev } (open/close)
// GET  /relay?role=pilot&to=<dev>&c=<id> (WebSocket, authentifié) -> trames d de l'hôte, envoie ses trames brutes
// PUT  /web-access { w, dev, salt, iter, verifier, envelope } (authentifié) ; DELETE /web-access/<w>
// GET  /web/info?w=  -> { salt, iter }       (public)
// POST /web/unlock { w, proof } -> { envelope, ticket } (public ; 10 échecs par heure et par lien → 429)
// GET  /web/relay?w=&ticket= (WebSocket, public, ticket à usage unique de 2 min) : pilote web
// PUT  /transcripts/<uid> { cid, ver, chunks, size, updatedAt, origin } -> { applied }
//      (valide une version dont tous les morceaux sont envoyés ; les autres versions sont effacées)
// Une session supprimée (POST /sessions, deleted) efface aussi sa conversation.
//
// Authorization: Bearer <clé d'accès>, dérivée du code par l'app (le code, qui sert aussi à chiffrer, ne vient
// jamais ici). Une clé est acceptée si son empreinte est dans csm_auth (rattachée à un espace), dans csm_spaces,
// ou si elle figure dans le secret SYNC_KEYS. Le serveur ne garde que des empreintes.
// Stockage : métadonnées dans D1, morceaux chiffrés dans R2 (BUCKET, clé <space>/<uid>/<ver>/<n>), place occupée
// tenue dans csm_usage (aucune requête ne relit toutes les lignes).
// Limites : 5 créations d'espace par jour et par adresse (/64 en IPv6), 2000 par jour au total ; par espace
// 5000 lignes et 1 Gio de données ; 8 Gio au total (R2 gratuit : 10 Go).
// Le rev est attribué dans SQL : D1 sérialise les écritures, deux push simultanés n'ont jamais le même rev.

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const sha256 = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
  .map(b => b.toString(16).padStart(2, '0')).join('');

const DAY = 86400000;
const PER_IP_PER_DAY = 5;
const PER_DAY = 2000;
const CHUNK_MAX = 1024 * 1024 + 64, MAX_CHUNKS = 40;
const SPACE_MAX = 1024 * 1024 * 1024;      // octets par espace (1 Gio ; R2 gratuit : 10 Go au total)
const TOTAL_MAX = 8 * 1024 * 1024 * 1024;  // octets de conversations tous espaces confondus (R2 gratuit : 10 Go)
const ROWS_MAX = 5000;                     // sessions / groupes / modèles par espace (hors suppressions)
const TOMBSTONE_DAYS = 90;                 // suppressions gardées 90 jours (le temps que toutes les machines les voient)
// Horloges : une date à plus d'1 h dans le futur est refusée (tolérance large : une horloge un peu en avance ne
// doit pas bloquer une machine) (elle figerait la ligne pour toutes les autres
// machines ; la date est liée au chiffré par l'app, le serveur ne peut pas la corriger). Une ligne déjà enregistrée
// avec une telle date (avant cette règle) peut être remplacée par n'importe quelle écriture.
const FUTURE_MS = 60 * 60e3;
const HEX64 = /^[0-9a-f]{64}$/;
// IPv6 : on compte par /64 (un attaquant dispose en général de tout un /64)
function ipKey(req) {
  const ip = req.headers.get('cf-connecting-ip') || '';
  return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') + '::/64' : ip;
}

const partKey = (space, uid, ver, n) => `${space}/${uid}/${ver}/${n}`;

// ---------------------------------------------------------------- temps réel (Durable Object par espace)
const CLIENT = /^[0-9a-f]{16,32}$/;
const LIVE_MAX = 50; // connexions par espace
const PILOTS_MAX = 4; // pilotes par machine pilotée
const WEB_TRIES = 10, WEB_WINDOW = 3600e3, TICKET_MS = 120e3;
const DEV = /^[0-9a-f]{12}$/, CID = /^[0-9a-f]{8,32}$/, WID = /^[0-9a-f]{32}$/;
const clientOf = req => { const c = req.headers.get('x-csm-client') || ''; return CLIENT.test(c) ? c : ''; };
// Prévient les machines connectées de l'espace (sauf l'auteur), sans retarder la réponse.
function notify(env, ctx, space, req) {
  if (!env.HUB) return;
  const p = env.HUB.get(env.HUB.idFromName(space)).fetch('https://hub/notify?from=' + clientOf(req)).catch(() => { });
  if (ctx?.waitUntil) ctx.waitUntil(p);
}
export class Hub {
  constructor(state) {
    this.state = state;
    // « ping » de maintien de la connexion : répondu sans réveiller l'objet
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/notify') {
      const from = url.searchParams.get('from') || '';
      for (const ws of this.state.getWebSockets()) {
        if (from && this.state.getTags(ws).includes(from)) continue;
        if (this.state.getTags(ws).includes('relay')) continue; // trames du relais : pas de « changed »
        try { ws.send('changed'); } catch { }
      }
      return new Response('ok');
    }
    // pilotage à distance : ticket d'un pilote web (créé après /web/unlock, usage unique), générations d'accès web
    if (url.pathname === '/ticket') {
      const t = [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('');
      await this.state.storage.put('ticket:' + t, { dev: url.searchParams.get('dev'), gen: Number(url.searchParams.get('gen')), at: Date.now() });
      return json({ ticket: t });
    }
    if (url.pathname === '/webgen') { // nouveau mot de passe : pilotes web de l'ancienne génération déconnectés
      const dev = url.searchParams.get('dev'), gen = url.searchParams.get('gen');
      for (const ws of this.state.getWebSockets('pilot:' + dev)) { const tg = this.state.getTags(ws); if (tg.some(x => x.startsWith('web:')) && !tg.includes('web:' + gen)) try { ws.close(4403, 'accès changé'); } catch { } }
      return json({ ok: true });
    }
    if ((req.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return json({ error: 'websocket attendu' }, 426);
    if (this.state.getWebSockets().length >= LIVE_MAX) return json({ error: 'trop de connexions' }, 429);
    if (url.pathname === '/relay') return this.relay(url);
    const [client, server] = Object.values(new WebSocketPair());
    const c = clientOf(req);
    this.state.acceptWebSocket(server, c ? [c] : []);
    return new Response(null, { status: 101, webSocket: client });
  }
  // relais : un hôte par machine (une nouvelle connexion remplace l'ancienne), PILOTS_MAX pilotes par hôte
  async relay(url) {
    const role = url.searchParams.get('role'), dev = url.searchParams.get('dev') || url.searchParams.get('to') || '';
    if (!DEV.test(dev)) return json({ error: 'machine invalide' }, 400);
    const [client, server] = Object.values(new WebSocketPair());
    if (role === 'host') {
      for (const old of this.state.getWebSockets('host:' + dev)) try { old.close(4409, 'remplacé'); } catch { }
      this.state.acceptWebSocket(server, ['relay', 'host:' + dev]);
      return new Response(null, { status: 101, webSocket: client });
    }
    const c = url.searchParams.get('c') || '';
    if (role !== 'pilot' || !CID.test(c)) return json({ error: 'pilote invalide' }, 400);
    let web = null;
    if (url.searchParams.has('ticket')) { // pilote web : ticket à usage unique
      const k = 'ticket:' + url.searchParams.get('ticket'), t = await this.state.storage.get(k);
      await this.state.storage.delete(k);
      if (!t || t.dev !== dev || Date.now() - t.at > TICKET_MS) return json({ error: 'ticket' }, 401);
      web = t.gen;
    }
    const host = this.state.getWebSockets('host:' + dev)[0];
    if (!host) return json({ error: 'machine pilotée hors ligne' }, 404);
    if (this.state.getWebSockets('pilot:' + dev).length >= PILOTS_MAX) return json({ error: 'trop de pilotes' }, 429);
    this.state.acceptWebSocket(server, ['relay', 'pilot:' + dev, 'c:' + c, ...(web !== null ? ['web:' + web] : [])]);
    try { host.send(JSON.stringify({ c, ev: 'open', web: web !== null })); } catch { }
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws, msg) {
    const tags = this.state.getTags(ws);
    if (typeof msg !== 'string' || msg.length > 1.5 * 1024 * 1024) return;
    const host = tags.find(t => t.startsWith('host:'));
    if (host) {
      let f; try { f = JSON.parse(msg); } catch { return; }
      if (!f || !CID.test(f.c || '')) return;
      const dev = host.slice(5);
      const p = this.state.getWebSockets('c:' + f.c).find(x => this.state.getTags(x).includes('pilot:' + dev));
      if (!p) return;
      if (f.ev === 'close') { try { p.close(4000, 'coupé par la machine pilotée'); } catch { } return; }
      if (typeof f.d === 'string') try { p.send(f.d); } catch { }
      return;
    }
    const pilot = tags.find(t => t.startsWith('pilot:'));
    if (!pilot) return;
    const h = this.state.getWebSockets('host:' + pilot.slice(6))[0], c = tags.find(t => t.startsWith('c:')).slice(2);
    if (!h) { try { ws.close(4404, 'machine pilotée hors ligne'); } catch { } return; }
    try { h.send(JSON.stringify({ c, d: msg })); } catch { }
  }
  webSocketClose(ws, code) {
    const tags = this.state.getTags(ws);
    const host = tags.find(t => t.startsWith('host:'));
    if (host) for (const p of this.state.getWebSockets('pilot:' + host.slice(5))) try { p.close(4404, 'machine pilotée hors ligne'); } catch { }
    const pilot = tags.find(t => t.startsWith('pilot:'));
    if (pilot) { const h = this.state.getWebSockets('host:' + pilot.slice(6))[0]; if (h) try { h.send(JSON.stringify({ c: tags.find(t => t.startsWith('c:')).slice(2), ev: 'close' })); } catch { } }
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch { }
  }
  webSocketError(ws) { try { ws.close(1011, 'error'); } catch { } }
}
const PENDING_MAX = 200;                   // morceaux envoyés mais pas encore validés, par espace
// Place occupée = octets de tous les morceaux présents (validés ou en attente), comptés par le serveur à la
// réception (jamais la taille annoncée par l'app) ; recalculée chaque nuit (scheduled) contre toute dérive.
const usedBytes = async (env, space) => (await env.DB.prepare('SELECT bytes FROM csm_usage WHERE space = ?').bind(space).first())?.bytes || 0;
const totalBytes = async env => (await env.DB.prepare('SELECT COALESCE(SUM(bytes), 0) AS t FROM csm_usage').first()).t;
const addUsage = (env, space, delta) => env.DB.prepare(
  'INSERT INTO csm_usage (space, bytes) VALUES (?1, MAX(0, ?2)) ON CONFLICT(space) DO UPDATE SET bytes = MAX(0, bytes + ?2)',
).bind(space, delta);
// Efface des morceaux : objets R2 d'abord (par lots), puis lignes D1 et place occupée (requêtes groupées).
// Si R2 échoue, les lignes restent et le prochain ménage réessaie : aucun objet ne reste sans sa ligne.
// rows = [{ space, uid, ver, n, size }]
async function dropParts(env, rows) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 1000) await env.BUCKET.delete(rows.slice(i, i + 1000).map(r => partKey(r.space, r.uid, r.ver, r.n)));
  const del = env.DB.prepare('DELETE FROM csm_parts WHERE space = ? AND uid = ? AND ver = ? AND n = ?');
  const freed = new Map();
  for (const r of rows) freed.set(r.space, (freed.get(r.space) || 0) + (r.size || 0));
  for (let i = 0; i < rows.length; i += 400) {
    await env.DB.batch(rows.slice(i, i + 400).map(r => del.bind(r.space, r.uid, r.ver, r.n)));
  }
  await env.DB.batch([...freed].map(([sp, b]) => addUsage(env, sp, -b)));
}

async function transcripts(req, env, space, parts, ctx) {
  const [uid, ver, n] = parts;
  if (uid !== undefined && !/^[\w-]{6,64}$/.test(uid)) return json({ error: 'bad uid' }, 400);
  if (ver !== undefined && !/^[0-9a-f]{32}$/.test(ver)) return json({ error: 'bad version' }, 400);
  const idx = Number(n);
  if (n !== undefined && !(Number.isInteger(idx) && idx >= 0 && idx < MAX_CHUNKS)) return json({ error: 'bad chunk' }, 400);

  if (!uid && req.method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT uid, cid, ver, chunks, size, updatedAt, origin FROM csm_transcripts WHERE space = ?',
    ).bind(space).all();
    return json({ items: results });
  }
  if (n !== undefined && req.method === 'GET') {
    const obj = await env.BUCKET.get(partKey(space, uid, ver, idx));
    return obj ? new Response(obj.body, { headers: { 'content-type': 'application/octet-stream' } }) : json({ error: 'not found' }, 404);
  }
  if (n !== undefined && req.method === 'PUT') {
    const body = new Uint8Array(await req.arrayBuffer());
    if (!body.length || body.length > CHUNK_MAX) return json({ error: 'chunk too large' }, 413);
    const prev = await env.DB.prepare('SELECT size FROM csm_parts WHERE space = ? AND uid = ? AND ver = ? AND n = ?').bind(space, uid, ver, idx).first();
    const delta = body.length - (prev?.size || 0);
    if (!prev) {
      // envois en attente récents seulement (ceux de plus d'une heure sont abandonnés, retirés la nuit)
      const pend = await env.DB.prepare('SELECT COUNT(*) AS c FROM csm_parts WHERE space = ? AND ok = 0 AND at > ?').bind(space, Date.now() - 3600e3).first();
      if (pend.c >= PENDING_MAX) return json({ error: 'too many pending chunks' }, 429);
    }
    if (await usedBytes(env, space) + delta > SPACE_MAX) return json({ error: 'space full' }, 413);
    if (await totalBytes(env) + delta > TOTAL_MAX) return json({ error: 'server full' }, 507);
    // la ligne d'abord (en attente) : si l'écriture R2 échoue, le ménage nocturne la retire
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO csm_parts (space, uid, ver, n, size, at, ok) VALUES (?, ?, ?, ?, ?, ?, 0) ON CONFLICT(space, uid, ver, n) DO UPDATE SET size = excluded.size, at = excluded.at',
      ).bind(space, uid, ver, idx, body.length, Date.now()),
      addUsage(env, space, delta),
    ]);
    await env.BUCKET.put(partKey(space, uid, ver, idx), body);
    return json({ ok: true });
  }
  if (uid && ver === undefined && req.method === 'PUT') {
    let b;
    try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
    const chunks = Number(b.chunks);
    if (!/^[0-9a-f]{32}$/.test(b.ver || '') || !/^[\w-]{1,64}$/.test(b.cid || '') || !(Number.isInteger(chunks) && chunks >= 1 && chunks <= MAX_CHUNKS)) return json({ error: 'bad meta' }, 400);
    // taille comptée ici, à partir des morceaux reçus (0..chunks-1 tous présents)
    const have = await env.DB.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS size FROM csm_parts WHERE space = ? AND uid = ? AND ver = ? AND n < ?')
      .bind(space, uid, b.ver, chunks).first();
    if (have.c !== chunks) return json({ error: 'missing chunks' }, 409);
    const cap = Date.now() + FUTURE_MS;
    if ((Number(b.updatedAt) || 0) > cap) return json({ error: 'date dans le futur (horloge de la machine en avance ?)' }, 400);
    const out = await env.DB.prepare(
      `INSERT INTO csm_transcripts (space, uid, cid, ver, chunks, size, updatedAt, origin) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(space, uid) DO UPDATE SET cid = excluded.cid, ver = excluded.ver, chunks = excluded.chunks, size = excluded.size,
         updatedAt = excluded.updatedAt, origin = excluded.origin
       WHERE excluded.updatedAt >= csm_transcripts.updatedAt OR csm_transcripts.updatedAt > ?9`,
    ).bind(space, uid, b.cid, b.ver, chunks, have.size, Number(b.updatedAt) || 0, String(b.origin || '').slice(0, 80), cap).run();
    const applied = !!out.meta?.changes;
    if (applied) notify(env, ctx, space, req);
    const cur = await env.DB.prepare('SELECT ver FROM csm_transcripts WHERE space = ? AND uid = ?').bind(space, uid).first();
    if (cur) await env.DB.prepare('UPDATE csm_parts SET ok = 1 WHERE space = ? AND uid = ? AND ver = ?').bind(space, uid, cur.ver).run();
    // anciennes versions validées, et celle-ci si elle a été refusée (plus ancienne) ; les envois en cours
    // d'une autre version restent (le ménage nocturne retire ceux qui ne sont jamais validés)
    const old = (await env.DB.prepare(
      'SELECT space, uid, ver, n, size FROM csm_parts WHERE space = ? AND uid = ? AND ver <> ? AND (ok = 1 OR ver = ?)',
    ).bind(space, uid, cur?.ver || '', b.ver).all()).results;
    try { await dropParts(env, old); } catch { } // version validée quoi qu'il arrive ; le ménage nocturne finira
    return json({ applied });
  }
  return json({ error: 'method not allowed' }, 405);
}

async function spaceOf(req, env) {
  const key = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (key.length < 16) return null;
  const h = await sha256(key);
  const linked = await env.DB.prepare('SELECT space FROM csm_auth WHERE auth = ?').bind(h).first();
  if (linked) return linked.space;
  const allowed = String(env.SYNC_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.some(k => sameString(k, key))) return h;
  const row = await env.DB.prepare('SELECT 1 FROM csm_spaces WHERE space = ?').bind(h).first();
  return row ? h : null;
}

async function createSpace(req, env) {
  let body = {};
  try { body = await req.json(); } catch { }
  const since = Date.now() - DAY;
  const ipHash = await sha256('csm-ip:' + ipKey(req));
  const counts = await env.DB.prepare(
    'SELECT COUNT(*) AS total, SUM(ipHash = ?) AS mine FROM csm_spaces WHERE createdAt > ?',
  ).bind(ipHash, since).first();
  if ((counts.mine || 0) >= PER_IP_PER_DAY || (counts.total || 0) >= PER_DAY) {
    return json({ error: 'trop de codes créés aujourd’hui, réessaie demain' }, 429);
  }
  if (typeof body?.auth === 'string') {
    if (!HEX64.test(body.auth)) return json({ error: 'bad auth' }, 400);
    const out = await env.DB.prepare('INSERT INTO csm_spaces (space, createdAt, ipHash) VALUES (?, ?, ?) ON CONFLICT(space) DO NOTHING')
      .bind(body.auth, Date.now(), ipHash).run();
    return out.meta?.changes ? json({ ok: true }) : json({ error: 'espace déjà existant' }, 409);
  }
  // création d'un code par le serveur (applis < 3.8) : retirée, le serveur ne doit jamais connaître le code
  return json({ error: 'mets à jour Claude Sessions (3.8 ou plus récent) pour créer un code' }, 410);
}

// Rattache une clé d'accès (empreinte) à l'espace d'un code créé avant la 3.8, sur preuve de l'ancien accès.
async function linkSpace(req, env) {
  const space = await spaceOf(req, env);
  if (!space) return json({ error: 'unauthorized' }, 401);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (!HEX64.test(body?.auth || '')) return json({ error: 'bad auth' }, 400);
  await env.DB.prepare('INSERT INTO csm_auth (auth, space) VALUES (?, ?) ON CONFLICT(auth) DO NOTHING').bind(body.auth, space).run();
  return json({ ok: true });
}

// Accès web (pilotage à distance) : publié par la machine pilotée, authentifiée par la clé de son espace.
async function webAccess(req, env, space, w) {
  if (req.method === 'DELETE') {
    if (!w) return json({ error: 'lien manquant' }, 400);
    const row = await env.DB.prepare('SELECT dev FROM csm_web WHERE w = ? AND space = ?').bind(w, space).first();
    await env.DB.prepare('DELETE FROM csm_web WHERE w = ? AND space = ?').bind(w, space).run();
    if (row && env.HUB) await env.HUB.get(env.HUB.idFromName(space)).fetch(`https://hub/webgen?dev=${row.dev}&gen=0`);
    return json({ ok: true });
  }
  if (req.method !== 'PUT') return json({ error: 'method not allowed' }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (!WID.test(b?.w || '') || !DEV.test(b?.dev || '') || !HEX64.test(b?.verifier || '') || !Number.isInteger(b?.iter) || b.iter < 100000
    || typeof b.salt !== 'string' || b.salt.length > 64 || typeof b.envelope !== 'string' || b.envelope.length > 256) return json({ error: 'accès invalide' }, 400);
  const cur = await env.DB.prepare('SELECT space, gen FROM csm_web WHERE w = ?').bind(b.w).first();
  if (cur && cur.space !== space) return json({ error: 'lien déjà pris' }, 409);
  const gen = (cur?.gen || 0) + 1;
  await env.DB.prepare(`INSERT INTO csm_web (w, space, dev, salt, iter, verifier, envelope, fails, failAt, gen, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
    ON CONFLICT(w) DO UPDATE SET dev = excluded.dev, salt = excluded.salt, iter = excluded.iter, verifier = excluded.verifier, envelope = excluded.envelope, fails = 0, failAt = 0, gen = excluded.gen, updatedAt = excluded.updatedAt`)
    .bind(b.w, space, b.dev, b.salt, b.iter, b.verifier, b.envelope, gen, Date.now()).run();
  if (env.HUB) await env.HUB.get(env.HUB.idFromName(space)).fetch(`https://hub/webgen?dev=${b.dev}&gen=${gen}`);
  return json({ ok: true, gen });
}

// Routes publiques de l'accès web : paramètres du mot de passe, déverrouillage (essais limités), relais.
async function webPublic(req, env, url) {
  const w = url.searchParams.get('w') || '';
  if (url.pathname === '/web/info' || url.pathname === '/web/unlock' || url.pathname === '/web/relay') {
    if (!WID.test(w) && url.pathname !== '/web/unlock') return json({ error: 'lien invalide' }, 404);
  }
  if (url.pathname === '/web/info') {
    const row = await env.DB.prepare('SELECT salt, iter FROM csm_web WHERE w = ?').bind(w).first();
    return row ? json({ salt: row.salt, iter: row.iter }) : json({ error: 'lien inconnu' }, 404);
  }
  if (url.pathname === '/web/unlock') {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    let b; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
    if (!WID.test(b?.w || '') || !HEX64.test(b?.proof || '')) return json({ error: 'requête invalide' }, 400);
    const row = await env.DB.prepare('SELECT * FROM csm_web WHERE w = ?').bind(b.w).first();
    if (!row) return json({ error: 'lien inconnu' }, 404);
    const now = Date.now(), inWindow = now - row.failAt < WEB_WINDOW;
    if (inWindow && row.fails >= WEB_TRIES) return json({ error: 'trop d’essais, réessaie dans une heure' }, 429);
    if (!sameString(await sha256Hex(b.proof), row.verifier)) {
      await env.DB.prepare('UPDATE csm_web SET fails = ?, failAt = ? WHERE w = ?').bind(inWindow ? row.fails + 1 : 1, inWindow ? row.failAt : now, b.w).run();
      return json({ error: 'mot de passe incorrect' }, 403);
    }
    await env.DB.prepare('UPDATE csm_web SET fails = 0, failAt = 0 WHERE w = ?').bind(b.w).run();
    const t = await (await env.HUB.get(env.HUB.idFromName(row.space)).fetch(`https://hub/ticket?dev=${row.dev}&gen=${row.gen}`)).json();
    return json({ envelope: row.envelope, ticket: t.ticket, dev: row.dev });
  }
  if (url.pathname === '/web/relay') {
    const row = await env.DB.prepare('SELECT space, dev FROM csm_web WHERE w = ?').bind(w).first();
    if (!row) return json({ error: 'lien inconnu' }, 404);
    const q = new URLSearchParams({ role: 'pilot', to: row.dev, c: url.searchParams.get('c') || '', ticket: url.searchParams.get('ticket') || '' });
    return env.HUB.get(env.HUB.idFromName(row.space)).fetch(new Request('https://hub/relay?' + q, req));
  }
  return json({ error: 'not found' }, 404);
}
// SHA-256 d'une preuve donnée en hexadécimal (octets, comme côté app : public/remote-crypto.js sha)
async function sha256Hex(h) {
  const bytes = new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function currentRev(env, space) {
  const row = await env.DB.prepare('SELECT COALESCE(MAX(rev), 0) AS rev FROM csm_sessions WHERE space = ?').bind(space).first();
  return row.rev;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ ok: true });
    if (url.pathname === '/spaces') return req.method === 'POST' ? createSpace(req, env) : json({ error: 'method not allowed' }, 405);
    if (url.pathname === '/spaces/link') return req.method === 'POST' ? linkSpace(req, env) : json({ error: 'method not allowed' }, 405);
    if (url.pathname.startsWith('/web/')) return webPublic(req, env, url);
    const tx = url.pathname.match(/^\/transcripts(?:\/([^/]+)(?:\/([^/]+)\/([^/]+))?)?$/);
    const wa = url.pathname.match(/^\/web-access(?:\/([0-9a-f]{32}))?$/);
    if (!['/sessions', '/usage', '/space', '/live', '/relay'].includes(url.pathname) && !tx && !wa) return json({ error: 'not found' }, 404);
    const space = await spaceOf(req, env);
    if (!space) return json({ error: 'unauthorized' }, 401);
    if (url.pathname === '/live') return env.HUB ? env.HUB.get(env.HUB.idFromName(space)).fetch(new Request('https://hub/live', req)) : json({ error: 'not found' }, 404);
    if (url.pathname === '/relay') return env.HUB ? env.HUB.get(env.HUB.idFromName(space)).fetch(new Request('https://hub/relay' + url.search, req)) : json({ error: 'not found' }, 404);
    if (wa) return webAccess(req, env, space, wa[1]);
    if (tx) return transcripts(req, env, space, tx.slice(1).filter(x => x !== undefined), ctx);
    if (url.pathname === '/usage') {
      if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      const c = await env.DB.prepare(
        'SELECT (SELECT COUNT(*) FROM csm_sessions WHERE space = ?1 AND deleted = 0) AS sessions, (SELECT COUNT(*) FROM csm_transcripts WHERE space = ?1) AS transcripts',
      ).bind(space).first();
      // détail par catégorie, d'après le préfixe des éléments (cf- configuration, nm- et ob- mémoire intégrée, mem- claude-mem)
      const { results } = await env.DB.prepare(
        `SELECT CASE WHEN uid LIKE 'cf-%' THEN 'config' WHEN uid LIKE 'nm-%' OR uid LIKE 'ob-%' THEN 'memory' WHEN uid LIKE 'sec-%' THEN 'vault' WHEN uid LIKE 'mem-%' THEN 'claudemem' ELSE 'conversations' END AS k,
           COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM csm_transcripts WHERE space = ? GROUP BY k`,
      ).bind(space).all();
      const parts = Object.fromEntries(results.map(r => [r.k, { n: r.n, bytes: r.bytes }]));
      return json({ bytes: await usedBytes(env, space), max: SPACE_MAX, sessions: c.sessions, transcripts: c.transcripts, parts });
    }
    if (url.pathname === '/space') {
      if (req.method !== 'DELETE') return json({ error: 'method not allowed' }, 405);
      // morceaux R2 (listés par préfixe : y compris ceux qu'aucune ligne ne référence), puis toutes les lignes
      let cursor;
      do {
        const page = await env.BUCKET.list({ prefix: space + '/', cursor, limit: 1000 });
        if (page.objects.length) await env.BUCKET.delete(page.objects.map(o => o.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      await env.DB.batch(['csm_parts', 'csm_transcripts', 'csm_sessions', 'csm_usage', 'csm_web', 'csm_auth', 'csm_spaces']
        .map(t => env.DB.prepare(`DELETE FROM ${t} WHERE space = ?`).bind(space)));
      return json({ ok: true });
    }

    if (req.method === 'GET') {
      const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
      const { results } = await env.DB.prepare(
        'SELECT uid, data, updatedAt, deleted, origin, rev FROM csm_sessions WHERE space = ? AND rev > ? ORDER BY rev LIMIT 1000',
      ).bind(space, since).all();
      // page pleine : le curseur s'arrête à la dernière ligne lue, la suite viendra au prochain appel
      const rev = results.length === 1000 ? results[results.length - 1].rev : await currentRev(env, space);
      return json({ rev, items: results.map(r => ({ ...r, data: JSON.parse(r.data), deleted: !!r.deleted })) });
    }

    if (req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      const items = Array.isArray(body?.items) ? body.items.slice(0, 500) : [];
      // plafond : lignes en vigueur seulement (les suppressions ne comptent pas)
      const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM csm_sessions WHERE space = ? AND deleted = 0').bind(space).first();
      if (count.c + items.length > ROWS_MAX) {
        // au-delà : seules les mises à jour de lignes en vigueur et les suppressions passent
        const known = new Set((await env.DB.prepare('SELECT uid FROM csm_sessions WHERE space = ? AND deleted = 0').bind(space).all()).results.map(r => r.uid));
        const fresh = new Set(items.filter(it => !it?.deleted).map(it => it?.uid).filter(u => typeof u === 'string' && !known.has(u)));
        if (count.c + fresh.size > ROWS_MAX) return json({ error: 'space full' }, 413);
      }
      const next = '(SELECT COALESCE(MAX(rev), 0) + 1 FROM csm_sessions WHERE space = ?1)';
      const cap = Date.now() + FUTURE_MS;
      const stmts = [], dels = []; // dels[i] : uid si la ligne i est une suppression
      for (const it of items) {
        if (typeof it?.uid !== 'string' || !/^[\w-]{6,64}$/.test(it.uid)) continue;
        const data = JSON.stringify(it.data || {});
        if (data.length > 20000) continue;
        if ((Number(it.updatedAt) || 0) > cap) continue; // date dans le futur : refusée (voir FUTURE_MS)
        stmts.push(env.DB.prepare(
          `INSERT INTO csm_sessions (space, uid, data, updatedAt, deleted, origin, rev) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ${next})
           ON CONFLICT(space, uid) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt, deleted = excluded.deleted,
             origin = excluded.origin, rev = ${next}
           WHERE excluded.updatedAt > csm_sessions.updatedAt OR csm_sessions.updatedAt > ?7`,
        ).bind(space, it.uid, data, Number(it.updatedAt) || 0, it.deleted ? 1 : 0, String(it.origin || '').slice(0, 80), cap));
        dels.push(it.deleted ? it.uid : null);
      }
      const out = stmts.length ? (await env.DB.batch(stmts)).slice(0, stmts.length) : [];
      // conversation d'une session supprimée : liste, morceaux (R2) et place occupée libérés — seulement si la
      // suppression a été appliquée (une suppression plus ancienne que la ligne en vigueur ne touche à rien)
      const gone = dels.filter((u, i) => u && out[i]?.meta?.changes);
      for (const u of gone) {
        const parts = (await env.DB.prepare('SELECT space, uid, ver, n, size FROM csm_parts WHERE space = ? AND uid = ?').bind(space, u).all()).results;
        await env.DB.prepare('DELETE FROM csm_transcripts WHERE space = ? AND uid = ?').bind(space, u).run();
        await dropParts(env, parts);
      }
      const applied = out.filter(r => r.meta?.changes).length;
      if (applied) notify(env, ctx, space, req);
      return json({ rev: await currentRev(env, space), applied });
    }
    return json({ error: 'method not allowed' }, 405);
  },

  // Ménage quotidien : conversations dont la session n'existe plus, morceaux jamais validés (envoi interrompu)
  // ou d'une version qui n'est plus celle en vigueur (plus d'une heure), suppressions de plus de 90 jours, puis
  // recalcul de la place occupée. Par lots (suppressions groupées) pour rester sous la limite d'appels d'une exécution.
  async scheduled(event, env) {
    const hourAgo = Date.now() - 3600e3;
    // conversation sans ligne de session (cf- configuration, nm-, ob- et mem- mémoires, sec- coffre : jamais de session)
    await env.DB.prepare(
      `DELETE FROM csm_transcripts WHERE updatedAt < ?1 AND uid NOT LIKE 'cf-%' AND uid NOT LIKE 'nm-%' AND uid NOT LIKE 'ob-%' AND uid NOT LIKE 'sec-%' AND uid NOT LIKE 'mem-%'
         AND NOT EXISTS (SELECT 1 FROM csm_sessions s WHERE s.space = csm_transcripts.space AND s.uid = csm_transcripts.uid)`,
    ).bind(hourAgo).run();
    for (let round = 0; round < 10; round++) {
      const stale = (await env.DB.prepare(
        `SELECT space, uid, ver, n, size FROM csm_parts p WHERE p.at < ?1 AND (p.ok = 0
           OR NOT EXISTS (SELECT 1 FROM csm_transcripts t WHERE t.space = p.space AND t.uid = p.uid AND t.ver = p.ver)) LIMIT 1000`,
      ).bind(hourAgo).all()).results;
      await dropParts(env, stale);
      if (stale.length < 1000) break;
    }
    await env.DB.prepare('DELETE FROM csm_sessions WHERE deleted = 1 AND updatedAt < ?').bind(Date.now() - TOMBSTONE_DAYS * DAY).run();
    await env.DB.batch([
      env.DB.prepare('UPDATE csm_usage SET bytes = (SELECT COALESCE(SUM(size), 0) FROM csm_parts WHERE csm_parts.space = csm_usage.space)'),
      env.DB.prepare('INSERT INTO csm_usage (space, bytes) SELECT space, SUM(size) FROM csm_parts GROUP BY space ON CONFLICT(space) DO NOTHING'),
    ]);
  },
};
