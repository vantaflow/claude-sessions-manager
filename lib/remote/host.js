'use strict';
// Pilotage à distance, côté machine pilotée (hôte). Réglage remoteControl (Réglages › Synchronisation), faux par
// défaut, jamais changé à distance ni par la synchro. Coché, le serveur se connecte au relais du Worker
// (/relay?role=host, connexion sortante : aucun port ouvert) et accepte des pilotes :
// - poignée de main : nonces des deux côtés, clé de connexion tirée de la clé de pilotage de cette machine
//   (pilote CSM) ou de la clé web (navigateur) — public/remote-crypto.js ; trame refusée = connexion fermée ;
// - requête HTTP du pilote → rejouée sur le serveur local (127.0.0.1, jeton local, en-tête X-CSM-Remote) : toutes
//   les routes et tous leurs contrôles s'appliquent ; celles réservées à la machine elle-même sont refusées
//   (server.js remoteForbidden) ; le jeton local n'est jamais renvoyé (remplacé par « remote ») ;
// - WebSocket de l'interface → client local /ws relayé, messages regroupés par paquets de 50 ms.
// Les fenêtres de cette machine voient qui pilote ({ t: 'remote', pilots }) et peuvent couper.
const http = require('http');
const WebSocket = require('ws');
const R = require('../../public/remote-crypto');

const PART = 256 * 1024, BATCH_MS = 50, HELLO_MS = 10000;
const CID = /^[0-9a-f]{8,32}$/;

module.exports = function (ctx) {
  const { route, json, broadcast, PORT } = ctx;
  const settings = () => ctx.getSettings?.() || {};
  const on = () => settings().remoteControl === true;
  const pilots = new Map(); // c → { conn, name, kind, since, socks: Map(id → ws local), bodies: Map }
  let relay = null, relayFor = '', retry = 1000, timer = null, connected = false;

  const view = () => [...pilots.values()].filter(p => p.conn).map(p => ({ c: p.c, name: p.name, kind: p.kind, since: p.since }));
  const tell = () => broadcast({ t: 'remote', pilots: view() });

  // ---------------------------------------------------------------- relais
  function connect() {
    clearTimeout(timer); timer = null;
    const info = ctx.syncInfo?.();
    const want = on() && info ? `${info.url}|${info.dev}|${info.auth}` : '';
    if (want === relayFor && relay) return;
    if (relay) { try { relay.close(); } catch { } relay = null; connected = false; }
    relayFor = want;
    dropAll();
    if (!want) return;
    const ws = new WebSocket(`${info.url.replace(/^http/, 'ws')}/relay?role=host&dev=${info.dev}`, { headers: { authorization: `Bearer ${info.auth}` }, handshakeTimeout: 15000 });
    relay = ws;
    ws.on('open', () => { connected = true; retry = 1000; });
    ws.on('message', raw => { let f; try { f = JSON.parse(String(raw)); } catch { return; } if (f && CID.test(f.c || '')) onFrame(f).catch(e => console.error('pilotage :', e.message)); });
    ws.on('close', () => { if (relay !== ws) return; relay = null; connected = false; dropAll(); if (relayFor) { relayFor = ''; timer = setTimeout(connect, retry); retry = Math.min(retry * 2, 60e3); } });
    ws.on('error', () => { });
  }
  const send = (c, d) => { if (relay && relay.readyState === 1) relay.send(JSON.stringify({ c, d })); };
  const close = c => { if (relay && relay.readyState === 1) relay.send(JSON.stringify({ c, ev: 'close' })); drop(c); };
  function drop(c) {
    const p = pilots.get(c);
    if (!p) return;
    pilots.delete(c);
    clearTimeout(p.helloTimer);
    for (const s of p.socks.values()) try { s.close(); } catch { }
    if (p.conn) tell();
  }
  function dropAll() { const had = pilots.size; for (const c of [...pilots.keys()]) drop(c); if (had) tell(); }

  async function onFrame(f) {
    if (f.ev === 'open') { pilots.set(f.c, { c: f.c, web: !!f.web, socks: new Map(), bodies: new Map(), helloTimer: setTimeout(() => close(f.c), HELLO_MS) }); return; }
    if (f.ev === 'close') { drop(f.c); return; }
    const p = pilots.get(f.c);
    if (!p || typeof f.d !== 'string') return;
    if (!p.conn) return hello(p, f.d);
    const m = await p.conn.open(f.d);
    if (!m) return close(f.c); // trame refusée (clé fausse, rejeu, altération) : connexion coupée
    if (!p.name) { // première trame chiffrée : identité du pilote (authentifiée par la clé)
      if (m.k !== 'auth') return close(f.c);
      p.name = String(m.name || (p.web ? 'navigateur' : 'machine')).slice(0, 80); p.kind = p.web ? 'web' : 'csm'; p.since = Date.now();
      clearTimeout(p.helloTimer); tell();
      return;
    }
    if (m.k === 'http') return onHttp(p, m);
    if (m.k === 'part') { const b = p.bodies.get(m.id); if (b) { b.parts[m.i] = m.data; if (b.parts.filter(x => x !== undefined).length === b.n) { p.bodies.delete(m.id); onHttp(p, { ...b.req, body: b.parts.join('') }); } } return; }
    if (m.k === 'ws-open') return openWs(p, m.id);
    if (m.k === 'ws') { const s = p.socks.get(m.id); if (s && s.readyState === 1) for (const x of m.m || []) s.send(String(x)); return; }
    if (m.k === 'ws-close') { const s = p.socks.get(m.id); if (s) try { s.close(); } catch { } }
  }

  async function hello(p, d) {
    let h; try { h = JSON.parse(d); } catch { return close(p.c); }
    if (!h || h.hello !== 1 || typeof h.n !== 'string') return close(p.c);
    const info = ctx.syncInfo?.();
    if (!info) return close(p.c);
    let base;
    if (p.web) base = await ctx.remoteWebKey?.();
    else base = await R.pilotKey(info.key, info.dev);
    if (!base) return close(p.c);
    const nH = R.rand(16);
    p.conn = await R.openConnection(base, R.unb64(h.n), nH, 'host');
    send(p.c, JSON.stringify({ hello: 1, n: R.b64(nH) }));
  }
  const reply = async (p, obj) => { if (pilots.get(p.c) === p) send(p.c, await p.conn.seal(obj)); };

  // ---------------------------------------------------------------- HTTP rejoué localement
  function onHttp(p, m) {
    if (m.parts > 1 && m.body === undefined) { p.bodies.set(m.id, { req: m, n: m.parts, parts: [] }); return; }
    const body = m.body ? Buffer.from(m.body, 'base64') : null;
    const headers = { host: `127.0.0.1:${PORT}`, 'x-csm-token': ctx.TOKEN, 'x-csm-remote': encodeURIComponent(p.name), ...(body ? { 'content-length': body.length } : {}) };
    for (const k of ['content-type', 'x-csm-unlock', 'x-csm-filename']) if (m.headers?.[k]) headers[k] = String(m.headers[k]).slice(0, 2000);
    const rq = http.request({ host: '127.0.0.1', port: PORT, method: String(m.method || 'GET').toUpperCase(), path: String(m.path || '/'), headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', async () => {
        let buf = Buffer.concat(chunks);
        const type = String(res.headers['content-type'] || '');
        // jeton local : jamais renvoyé (page, réponses texte)
        if (/^(text\/|application\/(json|javascript))/.test(type) && buf.includes(ctx.TOKEN)) buf = Buffer.from(buf.toString('utf8').split(ctx.TOKEN).join('remote'));
        const b64 = buf.toString('base64'), n = Math.max(1, Math.ceil(b64.length / PART));
        for (let i = 0; i < n; i++) await reply(p, { k: 'res', id: m.id, status: res.statusCode, headers: { 'content-type': type, 'cache-control': res.headers['cache-control'] || '' }, i, n, data: b64.slice(i * PART, (i + 1) * PART) });
      });
    });
    rq.on('error', e => reply(p, { k: 'res', id: m.id, status: 502, headers: { 'content-type': 'application/json' }, i: 0, n: 1, data: Buffer.from(JSON.stringify({ error: e.message })).toString('base64') }));
    rq.end(body || undefined);
  }

  // ---------------------------------------------------------------- WebSocket de l'interface, regroupé par 50 ms
  function openWs(p, id) {
    const s = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${ctx.TOKEN}&remote=${encodeURIComponent(p.name)}`, { headers: { host: `127.0.0.1:${PORT}` } });
    p.socks.set(id, s);
    let queue = [], t = null;
    const flush = () => { t = null; const m = queue; queue = []; if (m.length) reply(p, { k: 'ws', id, m }); };
    s.on('message', d => { queue.push(String(d)); if (!t) t = setTimeout(flush, BATCH_MS); });
    s.on('close', () => { flush(); p.socks.delete(id); reply(p, { k: 'ws-close', id }).catch(() => { }); });
    s.on('error', () => { });
  }

  // ---------------------------------------------------------------- état, couper
  ctx.remote = { ...(ctx.remote || {}), hostStatus: () => ({ on: on(), connected, pilots: view() }), cut: () => { for (const c of [...pilots.keys()]) close(c); tell(); }, reconnect: connect };
  route('GET', /^\/api\/remote\/status$/, async ({ res }) => json(res, 200, { host: ctx.remote.hostStatus(), ...(ctx.remote.pilotStatus ? { pilot: ctx.remote.pilotStatus() } : {}) }));
  route('POST', /^\/api\/remote\/cut$/, async ({ res }) => { ctx.remote.cut(); json(res, 200, { ok: true }); });
  // réglage ou code de synchro changé : connexion ouverte, fermée ou refaite
  const prev = ctx.syncChanged;
  ctx.syncChanged = () => { try { prev?.(); } catch { } setTimeout(connect, 200); };
  setInterval(() => { if (on() !== !!relayFor || (on() && !relay && !timer)) connect(); }, 5000).unref?.();
  setTimeout(connect, 1500).unref?.();
};
