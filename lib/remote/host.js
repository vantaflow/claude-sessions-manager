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
const { wsFrames, assembler } = require('./frames');

const PART = 256 * 1024, BATCH_MS = 50, HELLO_MS = 10000;
const CID = /^[0-9a-f]{8,32}$/;

module.exports = function (ctx) {
  const { route, json, broadcast, PORT } = ctx;
  const settings = () => ctx.getSettings?.() || {};
  const on = () => settings().remoteControl === true;
  const pilots = new Map(); // c → { conn, name, kind, since, socks: Map(id → ws local), bodies: Map }
  let relay = null, relayFor = '', retry = 1000, timer = null, connected = false, stable = null, quietUntil = 0;

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
    // délai de reconnexion remis à zéro seulement après 30 s de connexion stable
    ws.on('open', () => { connected = true; clearTimeout(stable); stable = setTimeout(() => { retry = 1000; }, 30e3); });
    ws.on('message', raw => { let f; try { f = JSON.parse(String(raw)); } catch { return; } if (f && CID.test(f.c || '')) onFrame(f).catch(e => console.error('pilotage :', e.message)); });
    ws.on('close', code => {
      clearTimeout(stable);
      if (relay !== ws) return;
      relay = null; connected = false; dropAll();
      // 4409 : une autre instance de CSM de cette machine a pris la place (redémarrage, double lancement) : on
      // la laisse, nouvel essai dans 2 minutes seulement
      if (code === 4409) quietUntil = Date.now() + 120e3;
      if (relayFor) { relayFor = ''; timer = setTimeout(connect, code === 4409 ? 120e3 : retry); retry = Math.min(retry * 2, 60e3); }
    });
    ws.on('error', () => { });
  }
  const send = (c, d) => { if (relay && relay.readyState === 1) relay.send(JSON.stringify({ c, d })); };
  // code : 4000 = « Couper » (le pilote ne se reconnecte pas), 4001 = trame refusée (le pilote peut se reconnecter)
  const close = (c, code = 4001) => { if (relay && relay.readyState === 1) relay.send(JSON.stringify({ c, ev: 'close', code })); drop(c); };
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
    if (f.ev === 'open') { drop(f.c); pilots.set(f.c, { c: f.c, web: !!f.web, socks: new Map(), bodies: new Map(), asm: assembler(), wsp: assembler(), helloTimer: setTimeout(() => close(f.c), HELLO_MS) }); return; }
    if (f.ev === 'close') { drop(f.c); return; }
    const p = pilots.get(f.c);
    if (!p || typeof f.d !== 'string') return;
    if (!p.conn) return hello(p, f.d);
    const m = await p.conn.open(f.d);
    if (!m) return close(f.c); // trame refusée (clé fausse, rejeu, altération) : connexion coupée
    if (!p.name) { // première trame chiffrée : identité du pilote (authentifiée par la clé)
      if (m.k !== 'auth') return close(f.c);
      // navigateur : nom imposé (le mot de passe ne dit pas qui c'est) ; machine CSM : son nom de synchro
      p.kind = p.web ? 'web' : 'csm'; p.since = Date.now();
      p.name = p.web ? 'navigateur web' : String(m.name || 'machine').replace(/[\r\n]+/g, ' ').slice(0, 60);
      clearTimeout(p.helloTimer); tell();
      return;
    }
    if (m.k === 'http') return onHttp(p, m);
    if (m.k === 'part') { const b = p.bodies.get(m.id); if (!b) return; const body = p.asm.add(m.id, m.i, b.n, m.data); if (body === false) { p.bodies.delete(m.id); return; } if (body !== null) { p.bodies.delete(m.id); onHttp(p, { ...b.req, body }); } return; }
    if (m.k === 'ws-open') { if (p.socks.size >= 8) return; return openWs(p, m.id); }
    if (m.k === 'ws') { const s = p.socks.get(m.id); if (s && s.readyState === 1) for (const x of Array.isArray(m.m) ? m.m : []) s.send(String(x)); return; }
    if (m.k === 'wsp') { const s = p.socks.get(m.id), whole = p.wsp.add(m.id, m.i, m.n, m.data); if (whole && s && s.readyState === 1) s.send(whole); return; }
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
  const reply = (p, obj) => (pilots.get(p.c) === p ? p.conn.push(obj, d => send(p.c, d)) : Promise.resolve());

  // ---------------------------------------------------------------- HTTP rejoué localement
  function onHttp(p, m) {
    if (m.body === undefined && m.parts !== undefined) {
      if (!Number.isInteger(m.parts) || m.parts < 2 || m.parts > 400 || p.bodies.size >= 16) return;
      p.bodies.set(m.id, { req: m, n: m.parts }); return;
    }
    const body = m.body ? Buffer.from(m.body, 'base64') : null;
    const headers = { host: `127.0.0.1:${PORT}`, 'x-csm-token': ctx.TOKEN, 'x-csm-remote': encodeURIComponent(p.name), 'x-csm-remote-kind': p.kind, ...(body ? { 'content-length': body.length } : {}) };
    for (const k of ['content-type', 'x-csm-unlock', 'x-filename']) if (m.headers?.[k]) headers[k] = String(m.headers[k]).replace(/[\r\n]/g, '').slice(0, 2000);
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
    const s = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${ctx.TOKEN}&remote=${encodeURIComponent(p.name)}&kind=${p.kind}`, { headers: { host: `127.0.0.1:${PORT}` } });
    p.socks.set(id, s);
    let queue = [], t = null;
    const flush = () => { t = null; const m = queue; queue = []; for (const f of wsFrames(id, m)) reply(p, f); };
    s.on('message', d => { queue.push(String(d)); if (!t) t = setTimeout(flush, BATCH_MS); });
    s.on('close', () => { flush(); p.socks.delete(id); reply(p, { k: 'ws-close', id }).catch(() => { }); });
    s.on('error', () => { });
  }

  // ---------------------------------------------------------------- accès web (navigateur sans CSM)
  // Mot de passe choisi ici → clé web tirée au hasard (gardée protégée par le système, comme le coffre), enveloppe
  // chiffrée par le mot de passe publiée sur le relais (PUT /web-access) ; le relais n'apprend ni l'un ni l'autre.
  const fs = require('fs'), path = require('path'), crypto = require('crypto');
  const WEBFILE = path.join(ctx.DATA, 'remote-web.json');
  const backend = require('../vault/backend').open(ctx.DATA, { fileOnly: !!process.env.CSM_SECRETS_FILE_ONLY, isMac: ctx.IS_MAC, isWin: ctx.IS_WIN });
  let web = {}; try { web = JSON.parse(fs.readFileSync(WEBFILE, 'utf8')) || {}; } catch { }
  let webKey = null;
  const webReady = web.w ? backend.load(['csmremoteweb']).then(m => { const v = m.get('csmremoteweb'); if (v) webKey = R.unb64(v); }).catch(() => { }) : Promise.resolve();
  ctx.remoteWebKey = async () => { await webReady; return webKey; };
  const relayCall = async (method, p, body) => {
    const info = ctx.syncInfo?.();
    if (!info) throw new Error('code de synchro requis');
    const r = await fetch(info.url + p, { method, headers: { authorization: `Bearer ${info.auth}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`serveur de synchro : ${(await r.json().catch(() => ({}))).error || r.status}`);
    return r.json();
  };
  const webUrl = () => { const info = ctx.syncInfo?.(); return web.w && info ? `${info.url}/web#${web.w}` : ''; };
  route('POST', /^\/api\/remote\/web$/, async ({ req, res }) => {
    const b = await ctx.readBody(req) || {};
    if (typeof b.password !== 'string' || b.password.length < 12 || b.password.length > 200) return json(res, 400, { error: 'mot de passe de 12 caractères au moins' });
    const info = ctx.syncInfo?.();
    if (!info) return json(res, 409, { error: 'code de synchro requis' });
    const key = R.rand(32), w = web.w || crypto.randomBytes(16).toString('hex');
    const env = await R.webEnvelope(b.password, key);
    const oldKey = webKey;
    try { await backend.put('csmremoteweb', R.b64(key)); } catch (e) { return json(res, 500, { error: 'clé web : ' + e.message }); }
    try { await relayCall('PUT', '/web-access', { w, dev: info.dev, ...env }); } catch (e) { if (oldKey) await backend.put('csmremoteweb', R.b64(oldKey)).catch(() => { }); return json(res, 502, { error: e.message }); }
    webKey = key;
    web = { w }; fs.writeFileSync(WEBFILE, JSON.stringify(web), { mode: 0o600 });
    for (const p of pilots.values()) if (p.web) close(p.c); // ancien mot de passe : navigateurs déconnectés
    json(res, 200, { url: webUrl() });
  });
  route('DELETE', /^\/api\/remote\/web$/, async ({ res }) => {
    if (web.w) { try { await relayCall('DELETE', '/web-access/' + web.w); } catch { } }
    await backend.drop('csmremoteweb'); webKey = null; web = {}; try { fs.rmSync(WEBFILE, { force: true }); } catch { }
    for (const p of pilots.values()) if (p.web) close(p.c);
    json(res, 200, { ok: true });
  });

  // ---------------------------------------------------------------- état, couper
  ctx.remote = { ...(ctx.remote || {}), hostStatus: () => ({ on: on(), connected, pilots: view() }), cut: () => { for (const c of [...pilots.keys()]) close(c, 4000); tell(); }, reconnect: connect };
  route('GET', /^\/api\/remote\/status$/, async ({ res }) => json(res, 200, { host: ctx.remote.hostStatus(), web: { url: webUrl() }, ...(ctx.remote.pilotStatus ? { pilot: ctx.remote.pilotStatus() } : {}) }));
  route('POST', /^\/api\/remote\/cut$/, async ({ res }) => { ctx.remote.cut(); json(res, 200, { ok: true }); });
  // réglage ou code de synchro changé : connexion ouverte, fermée ou refaite
  const prev = ctx.syncChanged;
  ctx.syncChanged = () => { try { prev?.(); } catch { } setTimeout(connect, 200); };
  setInterval(() => { if (Date.now() < quietUntil) return; if (on() !== !!relayFor || (on() && !relay && !timer)) connect(); }, 5000).unref?.();
  setTimeout(connect, 1500).unref?.();
};
