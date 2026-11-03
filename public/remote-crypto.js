'use strict';
// Pilotage à distance : chiffrement de bout en bout du tunnel entre la machine qui pilote et la machine pilotée.
// Même code dans le navigateur (window.csmRemoteCrypto) et dans Node (require), avec WebCrypto seulement.
// Le relais (Worker) ne voit que des trames opaques.
//
// - pilotKey : clé de pilotage d'une machine, dérivée de la clé de synchro (HKDF, comme lib/sync.js derive) ;
//   distincte des clés de la synchro : elle n'ouvre aucune donnée synchronisée.
// - openConnection : deux clés par connexion (une par sens), tirées de la clé de base et des deux nonces de la
//   poignée de main ; chaque trame porte un numéro strictement croissant (rejeu refusé), lié au chiffré (AAD) avec
//   la connexion et le sens. Chiffrement et envoi d'un côté, réception de l'autre, se font un par un dans l'ordre
//   (file par connexion) : une grosse trame ne peut pas être doublée par une petite, ni une trame rejouée passer
//   deux fois pendant un déchiffrement.
// - webEnvelope / webUnlock : accès web par mot de passe. PBKDF2-SHA256, 600 000 tours, 32 octets, puis HKDF en deux
//   clés indépendantes : une pour chiffrer l'enveloppe (la clé web), une de preuve, dont le relais ne garde que
//   l'empreinte (tester un mot de passe coûte les 600 000 tours entiers, quelle que soit la clé visée).
(function (root) {
  const C = (typeof globalThis !== 'undefined' && globalThis.crypto) || require('crypto').webcrypto;
  const S = C.subtle;
  const te = new TextEncoder(), td = new TextDecoder();
  const ITER = 600000;
  const b64 = u => { let s = ''; const a = new Uint8Array(u); for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const hex = u => [...new Uint8Array(u)].map(b => b.toString(16).padStart(2, '0')).join('');
  const rand = n => C.getRandomValues(new Uint8Array(n));
  const cat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

  async function hkdf(ikm, salt, info, bytes) {
    const k = await S.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await S.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8));
  }
  const aes = (raw, use) => S.importKey('raw', raw, 'AES-GCM', false, use);

  // clé de synchro (texte du code) → clé de pilotage de la machine hostDev
  const pilotKey = (syncKey, hostDev) => hkdf(te.encode(String(syncKey)), te.encode('csm-remote'), te.encode(String(hostDev)), 32);

  async function openConnection(baseKey, nonceP, nonceH, role) {
    const k = await hkdf(baseKey, cat(nonceP, nonceH), te.encode('csm-tunnel-v1'), 64);
    const p2h = await aes(k.subarray(0, 32), ['encrypt', 'decrypt']), h2p = await aes(k.subarray(32), ['encrypt', 'decrypt']);
    const cid = hex(nonceP.subarray(0, 8)) + hex(nonceH.subarray(0, 8));
    const out = role === 'pilot' ? { key: p2h, dir: 'p' } : { key: h2p, dir: 'h' };
    const inn = role === 'pilot' ? { key: h2p, dir: 'h' } : { key: p2h, dir: 'p' };
    let sent = 0, seen = 0, outQ = Promise.resolve(), inQ = Promise.resolve();
    const seal1 = async obj => {
      const n = ++sent, iv = rand(12);
      const ct = await S.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(`${cid}|${out.dir}|${n}`) }, out.key, te.encode(JSON.stringify(obj)));
      return JSON.stringify({ n, i: b64(iv), d: b64(ct) });
    };
    const open1 = async str => {
      let f; try { f = JSON.parse(str); } catch { return null; }
      if (!f || !Number.isInteger(f.n) || f.n <= seen || typeof f.i !== 'string' || typeof f.d !== 'string') return null;
      try {
        const pt = await S.decrypt({ name: 'AES-GCM', iv: unb64(f.i), additionalData: te.encode(`${cid}|${inn.dir}|${f.n}`) }, inn.key, unb64(f.d));
        seen = f.n;
        return JSON.parse(td.decode(pt));
      } catch { return null; }
    };
    const queue = (q, fn) => { const r = q.then(fn, fn); return [r, r.catch(() => { })]; };
    return {
      cid,
      // chiffre et envoie (send(texte)) dans l'ordre des appels
      push(obj, send) { const [r, next] = queue(outQ, async () => send(await seal1(obj))); outQ = next; return r; },
      seal(obj) { const [r, next] = queue(outQ, () => seal1(obj)); outQ = next; return r; },
      open(str) { const [r, next] = queue(inQ, () => open1(str)); inQ = next; return r; },
    };
  }

  async function stretch(password, salt, iter) {
    const k = await S.importKey('raw', te.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
    const base = new Uint8Array(await S.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, k, 256));
    return { enc: await hkdf(base, salt, te.encode('csm-web-enveloppe'), 32), proof: await hkdf(base, salt, te.encode('csm-web-preuve'), 32) };
  }
  const sha = async u => hex(await S.digest('SHA-256', u));
  async function webEnvelope(password, webKey) {
    const salt = rand(16), { enc, proof } = await stretch(password, salt, ITER), iv = rand(12);
    const ct = await S.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode('csm-web-v1') }, await aes(enc, ['encrypt']), webKey);
    return { salt: b64(salt), iter: ITER, verifier: await sha(proof), envelope: b64(cat(iv, new Uint8Array(ct))) };
  }
  async function webUnlock(password, { salt, iter }) {
    const { enc, proof } = await stretch(password, unb64(salt), iter);
    return {
      proof: hex(proof),
      async open(envelope) {
        try { const e = unb64(envelope); return new Uint8Array(await S.decrypt({ name: 'AES-GCM', iv: e.subarray(0, 12), additionalData: te.encode('csm-web-v1') }, await aes(enc, ['decrypt']), e.subarray(12))); } catch { return null; }
      },
    };
  }

  const api = { pilotKey, openConnection, webEnvelope, webUnlock, rand, b64, unb64, hex, sha, ITER };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.csmRemoteCrypto = api;
})(typeof window !== 'undefined' ? window : globalThis);
