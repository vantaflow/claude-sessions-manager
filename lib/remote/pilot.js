'use strict';
// Pilotage à distance, côté machine qui pilote. POST /api/remote/open { dev } ouvre un tunnel chiffré vers une
// machine de l'espace qui l'autorise (fiche machine remote: true), puis un mandataire local sur 127.0.0.1 (port
// aléatoire) qui présente le CSM de cette machine comme un site local : la fenêtre y navigue, et l'interface de la
// machine pilotée tourne telle quelle (ses fichiers, ses routes, son WebSocket passent par le tunnel).
// Le mandataire n'obéit qu'à la fenêtre qui a reçu le ticket (cookie HttpOnly posé par /__csm-pilot?t=…) : un autre
// programme de cette machine ne peut pas s'en servir. Coupure du relais : reconnexion seule (l'interface distante
// rouvre son WebSocket et reçoit l'état complet).
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const R = require('../../public/remote-crypto');
const { wsFrames, assembler } = require('./frames');

const PART = 256 * 1024, MAX_BODY = 64 * 1024 * 1024, REQ_MS = 60e3;

module.exports = function (ctx) {
  const { route, json, readBody, ROOT } = ctx;
  const settings = () => ctx.getSettings?.() || {};
  const myName = () => String(settings().syncMachine || '').trim() || os.hostname();
  const tunnels = new Map(); // dev → tunnel

  function machines() {
    const out = [];
    for (const m of Object.values(ctx.syncMachines?.() || {})) if (m.dev) out.push({ dev: m.dev, name: m.name, platform: m.platform, version: m.version, remote: !!m.remote, seen: m.seen });
    return out;
  }

  // ---------------------------------------------------------------- tunnel
  function makeTunnel(dev, name) {
    const T = { dev, name, ws: null, conn: null, ready: null, pending: new Map(), socks: new Map(), seq: 0, closed: false, server: null, port: 0, cookie: crypto.randomBytes(24).toString('hex'), tickets: new Set(), retry: 2000, asm: assembler(), wsp: assembler() };
    T.open = () => {
      if (T.closed) return Promise.reject(new Error('fermé'));
      if (T.ready) return T.ready;
      T.ready = new Promise((resolve, reject) => {
        const info = ctx.syncInfo?.();
        if (!info) return reject(new Error('synchro non configurée'));
        const c = crypto.randomBytes(8).toString('hex');
        const ws = new WebSocket(`${info.url.replace(/^http/, 'ws')}/relay?role=pilot&to=${dev}&c=${c}`, { headers: { authorization: `Bearer ${info.auth}` }, handshakeTimeout: 15000 });
        T.ws = ws;
        const nP = R.rand(16);
        let done = false;
        const fail = e => { if (!done) { done = true; reject(e); } };
        const t = setTimeout(() => { fail(new Error('la machine ne répond pas')); try { ws.close(); } catch { } }, 15000);
        ws.on('open', () => ws.send(JSON.stringify({ hello: 1, n: R.b64(nP) })));
        ws.on('unexpected-response', (rq, res) => fail(new Error(res.statusCode === 404 ? 'machine hors ligne ou pilotage non autorisé' : `relais : ${res.statusCode}`)));
        ws.on('message', async raw => {
          const d = String(raw);
          if (!T.conn) {
            let h; try { h = JSON.parse(d); } catch { return; }
            if (h?.hello !== 1) return;
            T.conn = await R.openConnection(await R.pilotKey(info.key, dev), nP, R.unb64(h.n), 'pilot');
            await T.conn.push({ k: 'auth', name: myName() }, s => ws.send(s));
            clearTimeout(t); done = true; T.retry = 2000; resolve(T);
            // signe de vie toutes les 30 s : la machine pilotée retire un pilote resté muet (avis de fermeture perdu)
            // aucune fenêtre ne s'en sert depuis une minute (fenêtre fermée, revenue sur cette machine) : tunnel fermé
            clearInterval(T.ping); T.ping = setInterval(() => {
              if (!T.socks.size && Date.now() - (T.used || 0) > (Number(process.env.CSM_PILOT_UNUSED) || 60e3)) return T.close();
              if (T.ws === ws && T.conn) T.conn.push({ k: 'ping' }, s => ws.send(s)).catch(() => { });
            }, Number(process.env.CSM_PILOT_PING) || 30e3);
            return;
          }
          const m = await T.conn.open(d);
          if (m) onMsg(T, m);
        });
        ws.on('close', code => {
          clearTimeout(t); fail(new Error('connexion fermée'));
          if (code === 4000) T.cut = true; // « Couper » sur la machine pilotée : pas de reconnexion
          if (T.ws !== ws) return;
          T.ws = null; T.conn = null; T.ready = null;
          for (const p of T.pending.values()) p.reject(new Error('connexion coupée'));
          T.pending.clear();
          for (const s of T.socks.values()) try { s.close(1012, 'reconnexion'); } catch { }
          T.socks.clear();
          if (T.cut) { T.close(); return; }
          // reconnexion, de plus en plus espacée si la machine reste injoignable (2 s → 1 min)
          if (!T.closed) { setTimeout(() => T.open().catch(() => { }), T.retry); T.retry = Math.min(T.retry * 2, 60e3); }
        });
        ws.on('error', () => { });
      });
      T.ready.catch(() => { T.ready = null; });
      return T.ready;
    };
    T.send = async obj => { await T.open(); const ws = T.ws; await T.conn.push(obj, s => ws.send(s)); };
    // le mandataire reste joignable un moment après une coupure (le bandeau l'annonce), puis s'arrête
    T.close = () => { T.closed = true; clearInterval(T.ping); try { T.ws?.close(); } catch { } for (const s of T.socks.values()) try { s.close(); } catch { } if (tunnels.get(dev) === T) tunnels.delete(dev); setTimeout(() => { try { T.server?.close(); } catch { } }, T.cut ? 60e3 : 0).unref?.(); };
    return T;
  }
  function onMsg(T, m) {
    if (m.k === 'res') {
      const p = T.pending.get(m.id);
      if (!p) return;
      const whole = T.asm.add(m.id, m.i, m.n, m.data);
      if (whole === null) return;
      T.pending.delete(m.id);
      if (whole === false) return p.reject(new Error('réponse invalide'));
      const status = Number.isInteger(m.status) && m.status >= 100 && m.status < 600 ? m.status : 502;
      p.resolve({ status, headers: { 'content-type': String(m.headers?.['content-type'] || ''), 'cache-control': String(m.headers?.['cache-control'] || '') }, body: Buffer.from(whole, 'base64') });
    } else if (m.k === 'ws') { const s = T.socks.get(m.id); if (s && s.readyState === 1) for (const x of Array.isArray(m.m) ? m.m : []) s.send(String(x)); }
    else if (m.k === 'wsp') { const s = T.socks.get(m.id), whole = T.wsp.add(m.id, m.i, m.n, m.data); if (whole && s && s.readyState === 1) s.send(whole); }
    else if (m.k === 'ws-close') { const s = T.socks.get(m.id); if (s) try { s.close(); } catch { } T.socks.delete(m.id); }
  }
  async function request(T, method, p, headers, body) {
    await T.open();
    const id = ++T.seq;
    const res = new Promise((resolve, reject) => { T.pending.set(id, { resolve, reject }); setTimeout(() => { if (T.pending.delete(id)) { T.asm.drop(id); reject(new Error('délai dépassé')); } }, REQ_MS); });
    const b64 = body && body.length ? body.toString('base64') : '';
    const n = Math.max(1, Math.ceil(b64.length / PART));
    if (n === 1) await T.send({ k: 'http', id, method, path: p, headers, body: b64 || null });
    else { await T.send({ k: 'http', id, method, path: p, headers, parts: n }); for (let i = 0; i < n; i++) await T.send({ k: 'part', id, i, data: b64.slice(i * PART, (i + 1) * PART) }); }
    return res;
  }

  // ---------------------------------------------------------------- mandataire local
  // cookie propre à chaque mandataire (les cookies de 127.0.0.1 sont partagés entre tous ses ports)
  const cookieOf = (req, T) => (String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)csmpilot${T.port}=([0-9a-f]{48})`)) || [])[1];
  function startProxy(T) {
    const bar = fs.readFileSync(path.join(ROOT, 'public', 'pilot-bar.js'), 'utf8');
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://x');
      if (req.headers.host !== `127.0.0.1:${T.port}`) { res.writeHead(403); return res.end(); }
      if (u.pathname === '/__csm-pilot') { // entrée par le ticket (usage unique) : cookie de la fenêtre
        const t = u.searchParams.get('t');
        if (!t || !T.tickets.delete(t)) { res.writeHead(403); return res.end('ticket'); }
        res.writeHead(302, { 'Set-Cookie': `csmpilot${T.port}=${T.cookie}; HttpOnly; SameSite=Strict; Path=/`, Location: '/' });
        return res.end();
      }
      if (cookieOf(req, T) !== T.cookie) { res.writeHead(403); return res.end('accès refusé'); }
      if (u.pathname === '/__pilot-bar.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(bar); }
      // « Revenir sur cette machine » : le tunnel est fermé (la machine pilotée n'affiche plus qu'elle est pilotée)
      if (u.pathname === '/__pilot-close') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); T.close(); return; }
      T.used = Date.now();
      if (u.pathname === '/__pilot-info') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ machine: T.name, back: `http://127.0.0.1:${ctx.PORT}/`, connected: !!T.conn, cut: !!T.cut })); }
      const chunks = []; let size = 0;
      req.on('data', c => { size += c.length; if (size > MAX_BODY) req.destroy(); else chunks.push(c); });
      req.on('end', async () => {
        try {
          const h = {};
          for (const k of ['content-type', 'x-csm-unlock', 'x-filename']) if (req.headers[k]) h[k] = req.headers[k];
          const r = await request(T, req.method, req.url, h, Buffer.concat(chunks));
          let body = r.body;
          if ((u.pathname === '/' || u.pathname === '/index.html') && /text\/html/.test(r.headers['content-type'] || '')) {
            body = Buffer.from(body.toString('utf8').replace('<head>', '<head><script src="/__pilot-bar.js"></script>'));
          }
          res.writeHead(r.status, { 'Content-Type': r.headers['content-type'] || 'application/octet-stream', 'Cache-Control': r.headers['cache-control'] || 'no-store' });
          res.end(body);
        } catch (e) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
      });
    });
    const wss = new WebSocket.Server({ noServer: true });
    srv.on('upgrade', (req, sock, head) => {
      if (req.headers.host !== `127.0.0.1:${T.port}` || cookieOf(req, T) !== T.cookie || !req.url.startsWith('/ws')) { sock.destroy(); return; }
      wss.handleUpgrade(req, sock, head, async ws => {
        const id = ++T.seq;
        T.socks.set(id, ws); clearTimeout(T.leave);
        ws.on('message', d => { for (const f of wsFrames(id, [String(d)])) T.send(f).catch(() => { }); });
        ws.on('close', () => {
          if (T.socks.delete(id)) T.send({ k: 'ws-close', id }).catch(() => { });
          // plus aucune fenêtre sur la machine pilotée (revenue ici, autre page, fenêtre fermée) : tunnel fermé
          // aussitôt, après 3 s de grâce (un simple rechargement de la page rouvre sa connexion entre-temps)
          clearTimeout(T.leave);
          if (!T.socks.size) T.leave = setTimeout(() => { if (!T.socks.size) T.close(); }, Number(process.env.CSM_PILOT_LEAVE) || 3000);
        });
        try { await T.send({ k: 'ws-open', id }); } catch { try { ws.close(1012, 'machine injoignable'); } catch { } }
      });
    });
    return new Promise(resolve => srv.listen(0, '127.0.0.1', () => { T.server = srv; T.port = srv.address().port; resolve(); }));
  }

  ctx.remote = { ...(ctx.remote || {}), pilotStatus: () => [...tunnels.values()].map(T => ({ dev: T.dev, name: T.name, connected: !!T.conn })) };
  route('GET', /^\/api\/remote\/machines$/, async ({ res }) => json(res, 200, machines()));
  route('POST', /^\/api\/remote\/open$/, async ({ req, res }) => {
    const b = await readBody(req) || {};
    const m = machines().find(x => x.dev === b.dev);
    if (!m) return json(res, 404, { error: 'machine inconnue' });
    if (!m.remote) return json(res, 409, { error: `${m.name} n’autorise pas le pilotage à distance (Réglages › Synchronisation sur cette machine)` });
    let T = tunnels.get(m.dev);
    if (!T) { T = makeTunnel(m.dev, m.name); tunnels.set(m.dev, T); }
    // deux ouvertures simultanées : un seul mandataire
    try { await T.open(); if (!T.server) await (T.starting || (T.starting = startProxy(T))); } catch (e) { T.close(); return json(res, 502, { error: e.message }); }
    T.used = Date.now(); // ouvert à l'instant : compté comme utilisé (fermé s'il ne sert pas dans la minute)
    const t = crypto.randomBytes(16).toString('hex'); T.tickets.add(t);
    setTimeout(() => T.tickets.delete(t), 60e3).unref?.();
    json(res, 200, { url: `http://127.0.0.1:${T.port}/__csm-pilot?t=${t}`, machine: m.name });
  });
  route('POST', /^\/api\/remote\/close$/, async ({ req, res }) => {
    const b = await readBody(req) || {};
    tunnels.get(b.dev)?.close();
    json(res, 200, { ok: true });
  });
};
