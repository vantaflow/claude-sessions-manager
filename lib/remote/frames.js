'use strict';
// Pilotage à distance : découpage des gros messages du tunnel et réassemblage borné (lib/remote/host.js, pilot.js ;
// même logique dans sync-worker/web/loader.html). Le relais refuse les trames de plus de 1,5 Mo : corps HTTP et
// messages du WebSocket de l'interface (replay d'un terminal : jusqu'à 2 Mo) partent en morceaux de 256 Ko.
// Côté réception, rien n'est cru sur parole : numéros de morceaux bornés, taille totale plafonnée.
const PART = 256 * 1024, MAX_PARTS = 400, MAX_TOTAL = 64 * 1024 * 1024;

// messages WebSocket (textes) → trames : lots d'au plus PART caractères ; un message plus long, en morceaux « wsp »
function wsFrames(id, msgs) {
  const out = []; let lot = [], size = 0;
  const flush = () => { if (lot.length) out.push({ k: 'ws', id, m: lot }); lot = []; size = 0; };
  for (const m of msgs) {
    if (m.length > PART) {
      flush();
      const n = Math.ceil(m.length / PART);
      for (let i = 0; i < n; i++) out.push({ k: 'wsp', id, i, n, data: m.slice(i * PART, (i + 1) * PART) });
      continue;
    }
    if (size + m.length > PART) flush();
    lot.push(m); size += m.length;
  }
  flush();
  return out;
}

// réassemblage d'un message en n morceaux (dans l'ordre ou non) ; null tant qu'il en manque, false si invalide
function assembler() {
  const parts = new Map(); // clé → { n, got, size, chunks }
  return {
    add(key, i, n, data) {
      if (!Number.isInteger(n) || n < 1 || n > MAX_PARTS || !Number.isInteger(i) || i < 0 || i >= n || typeof data !== 'string') { parts.delete(key); return false; }
      let p = parts.get(key);
      if (!p) { if (parts.size > 64) return false; p = { n, got: 0, size: 0, chunks: new Array(n) }; parts.set(key, p); }
      if (p.n !== n) { parts.delete(key); return false; }
      if (p.chunks[i] === undefined) { p.got++; p.size += data.length; }
      p.chunks[i] = data;
      if (p.size > MAX_TOTAL) { parts.delete(key); return false; }
      if (p.got < n) return null;
      parts.delete(key);
      return p.chunks.join('');
    },
    drop(key) { parts.delete(key); },
  };
}

module.exports = { wsFrames, assembler, PART, MAX_PARTS, MAX_TOTAL };
