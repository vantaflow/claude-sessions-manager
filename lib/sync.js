'use strict';
// Synchronisation des sessions entre machines (#27) : nom, dossier, modèle et mode, groupe, épinglage, couleur,
// Remote Control, et leurs conversations (chiffrées de bout en bout, réglage syncTranscripts) ; aussi la liste
// des groupes (vides compris, dans l'ordre) et les modèles de session, chiffrés eux aussi.
//
// Désactivée tant qu'aucun code de synchro n'est saisi dans Réglages › Synchronisation. Le code est tiré sur
// cette machine et ne quitte jamais les machines : le serveur (Worker Cloudflare, voir sync-worker/) ne reçoit
// qu'une clé d'accès dérivée du code et n'en garde que l'empreinte. Tout le contenu (sessions, groupes, modèles,
// conversations) est chiffré avec une autre clé dérivée du code : le serveur ne peut ni le lire ni le modifier.
// Seules les machines qui partagent le même code se voient, chaque code est un espace isolé.
//
// Fusion par session, la modification la plus récente gagne. Une session venue d'une autre machine est
// ajoutée arrêtée : « Reprendre » continue sa conversation dans le dossier correspondant ici.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const memsync = require('./memsync');
const claudesync = require('./claudesync');
const pluginsync = require('./pluginsync');
const usagelib = require('./usage');
const WebSocket = require('ws');
// Identifiant de ce processus auprès du serveur : il ne nous prévient pas de nos propres écritures (/live)
const CLIENT = crypto.randomBytes(8).toString('hex');

const SYNCED = ['name', 'args', 'group', 'pinned', 'color', 'remote', 'named', 'type', 'paused'];
// Intervalle entre deux synchronisations (réglage syncMinutes : 5, 10, 30 ou 60 min) ; les
// changements faits sur cette machine partent tout de suite (schedulePush), sans attendre.
const interval = minutes => Number(process.env.CSM_SYNC_INTERVAL) || (Number(minutes) || 5) * 60e3;
const CHUNK = 1024 * 1024, MAX_CHUNKS = 40; // conversation chiffrée : morceaux de 1 Mo, 40 Mo au plus
const SYNC_MAX_MS = Number(process.env.CSM_SYNC_MAX_MS) || 10 * 60e3; // durée maximale d'un tour de synchro
const MAX_RAW = Number(process.env.CSM_SYNC_MAX_RAW) || 200 * 1024 * 1024; // au-delà, même compressée (~40 %), elle dépasse 40 Mo : pas relue

// ---------------------------------------------------------------- code de synchro
// Code court « XXXX-XXXX-XXXX-XXXX-XXXX » (base32 de Crockford, 100 bits), tiré localement.
// L'ancien format « csm1.… » (adresse + clé encodées) reste accepté.
const DEFAULT_SERVER = process.env.CSM_DEFAULT_SYNC_SERVER || 'https://csm-sync.khalilbenaz.workers.dev'; // tests : jamais le serveur public
// HTTPS obligatoire, sauf serveur local (tests, serveur auto-hébergé sur la machine).
const okUrl = u => /^https:\/\/[^\s/]+\S*$/.test(u) || /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/\S*)?$/.test(u);
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const newCode = () => [...crypto.randomBytes(20)].map(b => ALPHABET[b & 31]).join('');
const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{20}$/;
function shortKey(code) {
  const k = String(code || '').toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CROCKFORD.test(k) ? k : null;
}
const formatCode = k => k.match(/.{4}/g).join('-');
const CODE_PREFIX = 'csm1.';
function encodeCode(url, key) {
  return CODE_PREFIX + Buffer.from(JSON.stringify({ u: url, k: key })).toString('base64url');
}
function decodeCode(code, server = DEFAULT_SERVER) {
  const c = String(code || '').trim();
  const short = shortKey(c);
  if (short) return okUrl(server) ? { url: server.replace(/\/+$/, ''), key: short, code: formatCode(short) } : null;
  if (!c.startsWith(CODE_PREFIX)) return null;
  try {
    const { u, k } = JSON.parse(Buffer.from(c.slice(CODE_PREFIX.length), 'base64url').toString('utf8'));
    if (!okUrl(u) || typeof k !== 'string' || k.length < 16) return null;
    return { url: u.replace(/\/+$/, ''), key: k, code: c };
  } catch { return null; }
}

// ---------------------------------------------------------------- dossiers portables
// « {home}/Projets/app » est le même dossier sur Mac (/Users/x/Projets/app) et Windows (C:\Users\x\Projets\app).
// Réglage syncRoots : une racine par ligne « alias=chemin » (ex. code=D:\dev sur le PC, code=~/dev sur le Mac).
function parseRoots(text, home, isWin) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([\w-]{1,30})\s*=\s*(.+?)\s*$/);
    if (!m || m[1] === 'home') continue;
    out.push({ alias: m[1], dir: m[2].replace(/^~(?=$|[\\/])/, home) });
  }
  out.push({ alias: 'home', dir: home });
  return out.map(r => ({ ...r, dir: r.dir.replace(/[\\/]+$/, '') || r.dir, isWin }));
}
const norm = (p, isWin) => {
  const s = p.replace(/[\\/]+/g, '/').replace(/\/$/, '');
  return isWin ? s.toLowerCase() : s;
};
function toPortable(cwd, roots) {
  if (!cwd) return '';
  let best = null;
  for (const r of roots) {
    const base = norm(r.dir, r.isWin), full = norm(cwd, r.isWin);
    if ((full === base || full.startsWith(base + '/')) && (!best || base.length > best.base.length)) best = { r, base };
  }
  if (!best) return cwd.replace(/\\/g, '/');
  const rest = cwd.replace(/[\\/]+/g, '/').replace(/\/$/, '').slice(best.base.length).replace(/^\//, '');
  return `{${best.r.alias}}` + (rest ? '/' + rest : '');
}
// null = dossier inconnu sur cette machine (alias non déclaré, chemin absolu d'un autre système).
function fromPortable(p, roots, isWin) {
  const m = String(p || '').match(/^\{([\w-]+)\}(?:\/(.*))?$/);
  const join = isWin ? path.win32.join : path.posix.join;
  if (m) {
    const r = roots.find(x => x.alias === m[1]);
    if (!r) return null;
    return m[2] ? join(r.dir, ...m[2].split('/')) : r.dir;
  }
  const absHere = isWin ? /^[a-z]:\//i.test(p) || p.startsWith('//') : p.startsWith('/');
  return absHere ? (isWin ? p.replace(/\//g, '\\') : p) : null;
}

// ---------------------------------------------------------------- clés et chiffrement
// Deux clés indépendantes dérivées du code : la clé d'accès (envoyée au serveur, qui n'en garde que l'empreinte)
// et les clés de chiffrement (jamais envoyées). Connaître la première ne permet pas de retrouver les autres.
// clés dérivées gardées par code (recalculées sinon à chaque requête, chaque morceau, chaque empreinte)
const derived = new Map();
const derive = (code, info, salt, len) => {
  const k = `${info}|${code}`;
  if (!derived.has(k)) { if (derived.size > 16) derived.clear(); derived.set(k, Buffer.from(crypto.hkdfSync('sha256', code, info, salt, len))); }
  return derived.get(k);
};
const authKey = code => derive(code, 'csm-auth', 'v2', 32).toString('hex');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
function txKeys(key) {
  const k = derive(key, 'csm-transcripts', 'aes-256-gcm-v2', 64);
  return { enc: k.subarray(0, 32), mac: k.subarray(32) };
}
const txVersion = (key, raw) => crypto.createHmac('sha256', txKeys(key).mac).update(raw).digest('hex').slice(0, 32);
// aad : identité de l'élément (session, version, date) liée au chiffré — le serveur ne peut ni échanger deux
// éléments, ni remettre une ancienne version sous une date récente.
// morceaux d'une conversation transférés 4 à la fois (au lieu d'un par un), résultats dans l'ordre
async function pool(count, fn, width = 4) {
  const out = new Array(count); let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, count) }, async () => { while (next < count) { const i = next++; out[i] = await fn(i); } }));
  return out;
}
function seal(key, raw, aad = '') {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', txKeys(key).enc, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(zlib.gzipSync(raw)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function unseal(key, blob, aad = '') {
  const d = crypto.createDecipheriv('aes-256-gcm', txKeys(key).enc, blob.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(blob.subarray(12, 28));
  return zlib.gunzipSync(Buffer.concat([d.update(blob.subarray(28)), d.final()]), { maxOutputLength: 512 * 1024 * 1024 }); // borne contre une bombe de décompression
}
// Conversations en flux, morceau par morceau : une conversation de 100-200 Mo n'est jamais chargée d'un bloc (chez
// un utilisateur, la compression d'un bloc a échoué faute de mémoire, « Failed to allocate memory », et l'erreur,
// hors de portée de la synchro, la laissait bloquée). Même format que seal / unseal : iv, étiquette, chiffré.
const { pipeline } = require('stream/promises');
const { Readable, Writable, Transform } = require('stream');
// version (HMAC) des `size` premiers octets d'un fichier
async function fileVersion(key, file, size) {
  const h = crypto.createHmac('sha256', txKeys(key).mac);
  if (size > 0) for await (const b of fs.createReadStream(file, { start: 0, end: size - 1 })) h.update(b);
  return h.digest('hex').slice(0, 32);
}
// compressé puis chiffré, découpé en morceaux de `chunk` octets ; null si le résultat dépasse `max`
async function sealFileParts(key, file, size, aad, chunk, max) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', txKeys(key).enc, iv);
  c.setAAD(Buffer.from(aad));
  const pieces = []; let total = 28, tooBig = false;
  const src = size > 0 ? fs.createReadStream(file, { start: 0, end: size - 1 }) : Readable.from([]);
  await pipeline(src, zlib.createGzip(), c, new Writable({
    write(b, e, cb) { total += b.length; if (total > max) { tooBig = true; return cb(new Error('trop grosse')); } pieces.push(b); cb(); },
  })).catch(e => { if (!tooBig) throw e; });
  if (tooBig) return null;
  const parts = []; let cur = [], len = 0;
  for (let b of [iv, c.getAuthTag(), ...pieces]) {
    while (b.length) {
      const take = Math.min(chunk - len, b.length);
      cur.push(b.subarray(0, take)); len += take; b = b.subarray(take);
      if (len === chunk) { parts.push(Buffer.concat(cur)); cur = []; len = 0; }
    }
  }
  if (len) parts.push(Buffer.concat(cur));
  return { parts, size: total };
}
// morceaux reçus : déchiffrés et décompressés vers `out` ; renvoie la version (HMAC) du contenu écrit
async function openPartsTo(key, parts, aad, out, maxOut) {
  const head = parts[0];
  if (!head || head.length < 28) throw new Error('incomplète');
  const d = crypto.createDecipheriv('aes-256-gcm', txKeys(key).enc, head.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(head.subarray(12, 28));
  const h = crypto.createHmac('sha256', txKeys(key).mac); let n = 0;
  await pipeline(Readable.from([head.subarray(28), ...parts.slice(1)]), d, zlib.createGunzip(), new Transform({
    transform(b, e, cb) { n += b.length; if (n > maxOut) return cb(new Error('trop grosse')); h.update(b); cb(null, b); }, // borne contre une bombe de décompression
  }), fs.createWriteStream(out, { mode: 0o600 }));
  return h.digest('hex').slice(0, 32);
}
const sealJson = (key, obj, aad) => ({ e: seal(key, Buffer.from(JSON.stringify(obj)), aad).toString('base64') });
const openJson = (key, data, aad) => JSON.parse(unseal(key, Buffer.from(String(data?.e || ''), 'base64'), aad).toString('utf8'));
const metaAad = (uid, updatedAt) => `s|${uid}|${updatedAt}`;
const txAad = (uid, cid, ver, updatedAt) => `t|${uid}|${cid}|${ver}|${updatedAt}`;

// ---------------------------------------------------------------- données reçues : validées
// Arguments de claude repris d'une autre machine : seulement le modèle, le mode (hors bypassPermissions)
// et l'effort. Tout le reste (--settings, --dangerously-skip-permissions, --mcp-config…) pourrait exécuter
// des commandes ici ; il n'est ni envoyé ni appliqué.
const MODES = ['default', 'acceptEdits', 'plan'];
function safeArgs(args) {
  const t = String(args || '').match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const out = [];
  for (let i = 0; i < t.length; i++) {
    const inline = /^--[\w-]+=/.test(t[i]);
    const [k, v] = inline ? [t[i].slice(0, t[i].indexOf('=')), t[i].slice(t[i].indexOf('=') + 1)] : [t[i], t[i + 1]];
    if (k === '--model' || k === '--fallback-model') { if (/^[\w.[][\w.:[\]-]{0,59}$/.test(v || '')) out.push(k, v); } // jamais « -… » (autre option)
    else if (k === '--permission-mode') { if (MODES.includes(v)) out.push(k, v); }
    else if (k === '--effort') { if (/^(low|medium|high|xhigh|max)$/.test(v || '')) out.push(k, v); }
    else continue;
    if (!inline) i++;
  }
  return out.join(' ');
}
function cleanMeta(d) {
  d = d && typeof d === 'object' ? d : {};
  const o = { cwd: typeof d.cwd === 'string' ? d.cwd.slice(0, 1000) : '' };
  if (typeof d.name === 'string' && d.name.trim()) o.name = d.name.slice(0, 80);
  const a = safeArgs(d.args); if (a) o.args = a;
  if (typeof d.group === 'string' && d.group.trim()) o.group = d.group.slice(0, 120);
  if (typeof d.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(d.color)) o.color = d.color;
  for (const k of ['pinned', 'remote', 'named', 'paused']) if (d[k] === true) o[k] = true;
  // type de session d'une extension (« extension/type ») : sans l'extension ici, la session reste ordinaire
  if (typeof d.type === 'string' && /^[a-z0-9][a-z0-9-]{1,39}\/[a-z0-9][a-z0-9-]{1,39}$/.test(d.type)) o.type = d.type;
  return o;
}

module.exports = function (ctx) {
  ctx.safeArgs = safeArgs; // arguments sûrs (aussi pour les demandes programmées, lib/schedule.js)
  const { route, json, readBody, sessions, publicView, persist, persistHooks, broadcast, DATA, IS_WIN } = ctx;
  const STATE = path.join(DATA, 'sync-state.json');
  const home = os.homedir();

  let state = { cursor: 0, known: {}, outbox: {}, tx: {}, docsPulled: false };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) }; } catch { }
  // 3.8 : nouveau format (clés v2, sessions chiffrées) — tout est renvoyé une fois
  if (state.format !== 2) state = { cursor: 0, known: {}, outbox: {}, tx: {}, docsPulled: false, format: 2 };
  const saveState = () => { const tmp = STATE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(tmp, STATE); };
  const status = { enabled: false, lastOk: 0, lastError: '', pulled: 0, pushed: 0, busy: false, txUp: 0, txDown: 0, memUp: 0, memDown: 0, memAvailable: null, nmUp: 0, nmDown: 0, cfUp: 0, cfDown: 0, cfFiles: 0 };

  const settings = () => ctx.getSettings?.() || {};
  const server = () => String(settings().syncServer || '').trim() || DEFAULT_SERVER;
  const config = () => decodeCode(settings().syncCode, server());
  const machine = () => String(settings().syncMachine || '').trim() || os.hostname();
  const roots = () => parseRoots(settings().syncRoots, home, IS_WIN);
  const payload = s => {
    const d = { cwd: s.syncCwd || toPortable(s.cwd, roots()) };
    for (const k of SYNCED) if (s[k] !== undefined && s[k] !== null && s[k] !== '') d[k] = s[k];
    return cleanMeta(d);
  };
  const fp = d => crypto.createHash('sha1').update(JSON.stringify(d)).digest('hex');
  const bySyncId = uid => [...sessions.values()].find(s => s.syncId === uid);
  const stamp = uid => Math.max(Date.now(), (state.known[uid]?.updatedAt || 0) + 1);

  // ---------------------------------------------------------------- changements locaux
  let applying = false, scanTimer = null;
  function scan() {
    scanTimer = null;
    if (!config()) return;
    let changed = false, assigned = false;
    const present = new Set();
    for (const s of [...sessions.values()]) {
      // reçue par erreur d'une ancienne version (un document de synchro pris pour une session) : retirée
      if (s.syncId && isDoc(s.syncId)) { if (!s.pty) { sessions.delete(s.id); broadcast({ t: 'removed', id: s.id }); assigned = true; } continue; }
      if (!s.syncId) { s.syncId = crypto.randomBytes(9).toString('hex'); s.origin = machine(); assigned = true; }
      if (!s.syncCwd) { s.syncCwd = toPortable(s.cwd, roots()); assigned = true; }
      present.add(s.syncId);
      const d = payload(s), f = fp(d), k = state.known[s.syncId];
      if (k && !k.deleted && k.fp === f) continue;
      const updatedAt = stamp(s.syncId);
      state.known[s.syncId] = { fp: f, updatedAt };
      state.outbox[s.syncId] = { uid: s.syncId, data: sealJson(config().key, d, metaAad(s.syncId, updatedAt)), updatedAt, deleted: false, origin: s.origin || machine() };
      changed = true;
    }
    // groupes et modèles : seulement après un premier pull dans cet espace (sinon une machine sans groupes
    // effacerait ceux des autres) ; une liste de groupes vide n'est envoyée que si elle a déjà été partagée.
    if (state.docsPulled) {
      const cfg = config();
      for (const [uid, d] of localDocs()) {
        if (uid === GROUPS_UID && !d.list.length && !state.known[uid]) continue;
        present.add(uid);
        const f = fp(d), k = state.known[uid];
        if (k && !k.deleted && k.fp === f) continue;
        const updatedAt = stamp(uid);
        state.known[uid] = { fp: f, updatedAt };
        state.outbox[uid] = { uid, data: sealJson(cfg.key, d, metaAad(uid, updatedAt)), updatedAt, deleted: false, origin: machine() };
        changed = true;
      }
    }
    for (const [uid, k] of Object.entries(state.known)) {
      // le choix de la mémoire n'est jamais effacé : il n'est simplement publié qu'après un choix fait ici
      // fermée ici seulement (Fermer) : gardée sur les autres machines, aucune suppression envoyée
      if (state.detached?.[uid]) continue;
      if (present.has(uid) || keptExt.has(uid) || k.deleted || k.ignored || uid === MEM_UID || (uid.startsWith(MACHINE) && uid !== myMachineUid()) || (uid.startsWith(USAGE) && uid !== myUsageUid()) || (isDoc(uid) && (!state.docsPulled || !docOn(uid)))) continue;
      const updatedAt = stamp(uid);
      state.known[uid] = { deleted: true, updatedAt };
      state.outbox[uid] = { uid, data: {}, updatedAt, deleted: true, origin: machine() };
      delete state.tx[uid];
      changed = true;
    }
    if (assigned) { applying = true; try { persist(); } finally { applying = false; } }
    if (changed) { saveState(); schedulePush(); }
  }
  persistHooks.push(() => { if (!applying && !scanTimer) scanTimer = setTimeout(scan, 300); });

  // ---------------------------------------------------------------- groupes et modèles
  // Lignes spéciales de la même table que les sessions (uid préfixé), contenu chiffré avec la clé du code.
  // MEM_UID : la mémoire choisie (intégrée ou claude-mem), la même sur toutes les machines.
  // MACHINE : une fiche par machine (nom, système, version, dernière synchro à l'heure près), pour la liste
  // Réglages › Synchronisation › Machines.
  // EXT : extensions importées (lib/extensions.js), installées sur toutes les machines de l'espace (la plus
  // récente modification gagne). Celles d'un plugin ne voyagent qu'avec leur plugin (PLUG, lib/pluginsync.js).
  const GROUPS_UID = 'csmcfg-groups', MEM_UID = 'csmcfg-memory', TPL = 'csmtpl-', MACHINE = 'csmcfg-machine-', EXT = 'csmext-', USAGE = 'csmcfg-usage-';
  const PLUG = pluginsync.PREFIX || 'csmplug-'; // plugins Claude Code installés (lib/pluginsync.js)
  const isDoc = uid => uid === GROUPS_UID || uid === MEM_UID || uid.startsWith(TPL) || uid.startsWith(MACHINE) || uid.startsWith(USAGE) || uid.startsWith(EXT) || uid.startsWith(PLUG);
  const myMachineUid = () => MACHINE + memState().dev;
  const myUsageUid = () => USAGE + memState().dev;
  // Usage de Claude de cette machine (agrégats seulement, lib/usage.js) : recalculé au plus toutes les 10 minutes ;
  // ceux des autres machines sont gardés dans state.usages pour la vue « toutes les machines ».
  let usageCache = null, usageAt = 0;
  const usageDoc = () => {
    // recalcul aussi si la machine a été renommée entre-temps
    if (usageCache && usageCache.name === machine() && Date.now() - usageAt < (Number(process.env.CSM_USAGE_EVERY) || 10 * 60e3)) return usageCache;
    const d = ctx.usageDoc?.();
    if (!d) return usageCache;
    usageCache = { ...d, name: machine(), platform: process.platform }; usageAt = Date.now();
    return usageCache;
  };
  ctx.remoteUsage = () => (!config() || settings().syncUsage === false ? [] : Object.entries(state.usages || {}).filter(([uid]) => uid !== myUsageUid())
    .map(([uid, u]) => ({ id: uid.slice(USAGE.length), ...u })));
  // Réglages › Synchronisation : ce qui est synchronisé en plus de la liste des sessions.
  const docOn = uid => (uid.startsWith(MACHINE) ? true : uid.startsWith(USAGE) ? settings().syncUsage !== false : uid.startsWith(EXT) ? settings().syncExtensions !== false : uid.startsWith(PLUG) ? settings().syncPlugins !== false : uid === GROUPS_UID ? settings().syncGroups !== false
    : uid === MEM_UID ? settings().syncSessionMemory !== false : settings().syncTemplates !== false);
  const groupList = () => String(settings().groupList || '').split('\n').map(x => x.trim()).filter(Boolean);
  let keptExt = new Set(), plugSync = null;
  function localDocs() {
    const out = new Map();
    if (docOn(GROUPS_UID)) out.set(GROUPS_UID, { list: groupList() });
    // choix de la mémoire : publié seulement après un choix fait ici, plus récent que celui déjà partagé
    if (docOn(MEM_UID) && ['native', 'claude-mem'].includes(settings().memoryEngine)
      && (settings().memoryEngineChosenAt || 0) > (state.known[MEM_UID]?.updatedAt || 0)) out.set(MEM_UID, { engine: settings().memoryEngine });
    if (docOn(TPL)) for (const t of ctx.getTemplates?.() || []) out.set(TPL + t.id, { ...t, cwd: t.cwd ? toPortable(t.cwd, roots()) : '' });
    keptExt = new Set();
    if (docOn(EXT)) for (const e of ctx.listSyncExtensions?.() || []) {
      const uid = EXT + e.id;
      if (e.kind === 'imported') out.set(uid, { ext: e.ext, enabled: e.enabled, kind: 'imported' });
      // extension d'un plugin : pas publiée seule (une copie déjà publiée par la 3.27 est effacée)
    }
    // plugins installés ici ; ceux reçus mais absents d'ici ne sont jamais effacés (keptExt)
    if (docOn(PLUG) && plugSync) for (const [uid, d] of plugSync.docs(keptExt)) out.set(uid, d);
    if (docOn(USAGE)) { const u = usageDoc(); if (u) out.set(myUsageUid(), u); }
    out.set(myMachineUid(), { name: machine(), platform: process.platform, version: ctx.VERSION || '', engine: settings().memoryEngine || 'native',
      seen: Math.floor(Date.now() / 3600e3) * 3600e3 });
    return out;
  }
  function applyDoc(it) {
    if (!docOn(it.uid)) return false; // ignoré ici ; relu depuis le début si l'option est réactivée
    const k = state.known[it.uid];
    if (k && k.updatedAt >= it.updatedAt) return false;
    let d = null;
    if (!it.deleted) {
      try { d = openJson(config().key, it.data, metaAad(it.uid, it.updatedAt)); } catch { return false; }
    }
    let f = null;
    if (it.uid === GROUPS_UID) {
      const remote = Array.isArray(d?.list) ? d.list.map(x => String(x).trim().slice(0, 60)).filter(Boolean) : [];
      // première rencontre : on réunit les deux listes (la réunion repart ensuite vers les autres machines)
      const next = k ? remote : [...new Set([...remote, ...groupList()])];
      ctx.patchSettings?.({ groupList: next.join('\n').slice(0, 4000) });
      f = fp({ list: remote });
    } else if (it.uid.startsWith(MACHINE)) {
      const machines = state.machines || (state.machines = {});
      if (it.uid === myMachineUid()) f = d ? fp(d) : null; // la nôtre : republiée au prochain envoi si retirée ailleurs
      else if (d) {
        machines[it.uid] = { name: String(d.name || '?').slice(0, 80), platform: String(d.platform || '').slice(0, 20), version: String(d.version || '').slice(0, 20),
          engine: String(d.engine || '').slice(0, 20), seen: Number(d.seen) || it.updatedAt };
        f = fp(d);
      } else delete machines[it.uid];
    } else if (it.uid.startsWith(USAGE)) {
      const usages = state.usages || (state.usages = {});
      const u = d ? usagelib.cleanDoc(d) : null;
      if (d && !u) return false;
      if (it.uid === myUsageUid()) f = u ? fp(d) : null; // le nôtre : republié au prochain envoi si retiré ailleurs
      else if (u) { usages[it.uid] = { ...u, at: it.updatedAt }; f = fp(d); }
      else delete usages[it.uid];
    } else if (it.uid.startsWith(PLUG)) {
      const p = d ? pluginsync.clean(d) : null;
      if (d && !p) return false;
      plugSync?.receive(it.uid, p, it.origin);
      f = p ? fp(p) : null;
    } else if (it.uid.startsWith(EXT)) {
      const id = it.uid.slice(EXT.length);
      if (d?.kind === 'plugin') {
        // extension d'un plugin publiée par une machine en 3.27 : ignorée (elle viendra avec le plugin)
        state.known[it.uid] = { fp: null, ignored: true, updatedAt: it.updatedAt };
        delete state.outbox[it.uid];
        return true;
      }
      if (d) {
        try { ctx.putExtension?.(d.ext, d.enabled !== false, it.origin); } catch { return false; } // fichier invalide : ignoré
        f = fp(localDocs().get(it.uid) || {});
      } else ctx.dropExtension?.(id); // effacée ailleurs : retirée ici (une extension de plugin installé ici reste)
    } else if (it.uid === MEM_UID) {
      const engine = d?.engine === 'claude-mem' ? 'claude-mem' : 'native';
      status.memSuggest = '';
      // mémoire désactivée ici : elle le reste (seul un choix fait sur cette machine la réactive)
      if (d && settings().memoryEngine !== 'off' && engine !== (settings().memoryEngine || 'native')) {
        // claude-mem pas encore installé ici : on propose (Réglages), sans rien installer sans accord
        if (engine === 'claude-mem' && !memsync.pluginRoot()) status.memSuggest = engine;
        else ctx.patchSettings?.({ memoryEngine: engine });
      }
      f = fp({ engine });
    } else {
      const id = it.uid.slice(TPL.length);
      const list = [...(ctx.getTemplates?.() || [])];
      const i = list.findIndex(t => t.id === id);
      if (d) {
        const found = typeof d.cwd === 'string' && d.cwd ? fromPortable(d.cwd, roots(), IS_WIN) : '';
        // mêmes limites que pour une session : pas d'arguments hors modèle / mode / effort, pas de bypass
        const t = { ...d, id, cwd: found || '', extra: safeArgs(d.extra), mode: MODES.includes(d.mode) ? d.mode : '' };
        if (i >= 0) list[i] = t; else list.push(t);
      } else if (i >= 0) list.splice(i, 1);
      ctx.setTemplates?.(list);
      f = d ? fp(localDocs().get(it.uid) || {}) : null;
    }
    state.known[it.uid] = d ? { fp: f, updatedAt: it.updatedAt } : { deleted: true, updatedAt: it.updatedAt };
    delete state.outbox[it.uid];
    return true;
  }

  // ---------------------------------------------------------------- réseau
  // body Buffer = octets (morceau de conversation) ; raw = réponse en octets.
  // Espace créé avant la 3.8 (le serveur connaissait le code) : on lui rattache une fois la clé d'accès, en
  // prouvant l'ancien accès. Ensuite le code n'est plus jamais envoyé.
  let linkTried = '';
  async function link(cfg) {
    if (linkTried === cfg.key) return false;
    linkTried = cfg.key;
    const r = await fetch(cfg.url + '/spaces/link', {
      method: 'POST', headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ auth: sha256(authKey(cfg.key)) }), signal: AbortSignal.timeout(15000),
    }).catch(() => null);
    return !!r?.ok;
  }
  async function call(method, p, body, raw) {
    const cfg = config();
    if (!cfg) throw new Error('synchronisation non configurée');
    const bin = Buffer.isBuffer(body);
    const go = () => fetch(cfg.url + p, {
      method, headers: { authorization: `Bearer ${authKey(cfg.key)}`, 'x-csm-client': CLIENT, 'content-type': bin ? 'application/octet-stream' : 'application/json' },
      body: bin ? body : body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(bin || raw ? 60000 : 15000),
    });
    let r = await go();
    if (r.status === 401 && await link(cfg)) r = await go();
    if (r.status === 401) throw new Error('code de synchro refusé par le serveur');
    if (r.status === 404 && p === '/transcripts') throw new Error('le serveur de synchro ne gère pas encore les conversations (à mettre à jour)');
    if (r.status === 413) throw new Error('espace de synchro plein');
    if (!r.ok) throw new Error(`serveur de synchro : HTTP ${r.status}`);
    return raw ? Buffer.from(await r.arrayBuffer()) : r.json();
  }

  // ---------------------------------------------------------------- temps réel
  // Connexion WebSocket au serveur (/live) : « changed » = une autre machine vient d'écrire (session, conversation,
  // mémoire, configuration) ; synchro complète aussitôt, sans attendre le relevé de 30 s ni la synchro en minutes.
  // Serveur sans /live (auto-hébergé, ancien) ou hors ligne : nouvel essai de plus en plus espacé (5 s à 5 min),
  // les relevés habituels continuent.
  let liveWs = null, liveId = '', liveRetry = 0, liveTimer = null, livePing = null, liveSync = null;
  function live() {
    const cfg = config(), id = cfg ? cfg.url + ' ' + cfg.key : '';
    if (id === liveId && (liveWs || liveTimer)) return;
    closeLive();
    liveId = id;
    if (!cfg || process.env.CSM_SYNC_LIVE === '0') return;
    let ws;
    try {
      ws = new WebSocket(cfg.url.replace(/^http/, 'ws') + '/live', { headers: { authorization: `Bearer ${authKey(cfg.key)}`, 'x-csm-client': CLIENT }, handshakeTimeout: 15000 });
    } catch { return retryLive(); }
    liveWs = ws;
    ws.on('open', () => {
      liveRetry = 0; status.live = true; broadcast({ t: 'sync', status: view() });
      livePing = setInterval(() => { try { ws.send('ping'); } catch { } }, 45e3); // garde la connexion ouverte (proxys)
      livePing.unref?.();
      kick(); // changements faits pendant la coupure
    });
    ws.on('message', m => { if (String(m) === 'changed') { status.liveAt = Date.now(); kick(); } });
    ws.on('close', () => {
      if (liveWs !== ws) return;
      liveWs = null; clearInterval(livePing);
      if (status.live) { status.live = false; broadcast({ t: 'sync', status: view() }); }
      retryLive();
    });
    ws.on('error', () => { });
  }
  function retryLive() {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { liveTimer = null; liveId = ''; live(); }, Math.min(5 * 60e3, 5000 * 2 ** liveRetry++));
    liveTimer.unref?.();
  }
  function closeLive() {
    clearTimeout(liveTimer); liveTimer = null; clearInterval(livePing);
    const w = liveWs; liveWs = null; status.live = false;
    try { w?.terminate(); } catch { }
  }
  // synchro bientôt (signaux rapprochés regroupés) ; si une synchro tourne déjà, une autre suit
  function kick() {
    clearTimeout(liveSync);
    liveSync = setTimeout(() => { (running || Promise.resolve()).catch(() => { }).finally(() => sync().catch(() => { })); }, 800);
    liveSync.unref?.();
  }

  let pushTimer = null;
  function schedulePush() { if (!pushTimer) pushTimer = setTimeout(() => { pushTimer = null; sync().catch(() => { }); }, 1500); }

  async function push() {
    const items = Object.values(state.outbox);
    if (!items.length) return;
    await call('POST', '/sessions', { items });
    for (const it of items) if (state.outbox[it.uid]?.updatedAt === it.updatedAt) delete state.outbox[it.uid];
    status.pushed += items.length;
    saveState();
  }

  // ---------------------------------------------------------------- changements distants
  function insertRemote(it, d) {
    const found = fromPortable(d.cwd, roots(), IS_WIN);
    const cwd = found && fs.existsSync(found) ? found : home;
    const from = String(it.origin || '').slice(0, 80) || 'une autre machine';
    const note = cwd === found ? '' : ` Dossier « ${d.cwd} » introuvable ici : ouverte dans le dossier personnel (Réglages › Synchronisation › racines).`;
    const order = Math.max(0, ...[...sessions.values()].map(x => x.order || 0)) + 1;
    const s = {
      id: crypto.randomBytes(6).toString('hex'), name: d.name || path.basename(cwd) || 'session', cwd, args: d.args || '',
      claudeSessionId: null, createdAt: Date.now(), lastActivity: Date.now(), status: 'exited', message: `créée sur ${from}`,
      statusSince: Date.now(), pty: null, order, wantRun: false, named: !!d.named,
      syncId: it.uid, origin: from, syncCwd: d.cwd || '',
      buf: `\x1b[90m[csm] Session synchronisée depuis « ${from} ». « Reprendre » ${txOn() ? 'continue sa conversation' : 'ouvre une nouvelle conversation'} dans ${cwd}.${note}\x1b[0m\r\n`,
    };
    for (const k of ['group', 'pinned', 'color', 'remote', 'type', 'paused']) if (d[k] !== undefined) s[k] = d[k];
    if (s.paused) s.message = `en pause sur ${from}`;
    sessions.set(s.id, s);
    return s;
  }

  function apply(it) {
    if (isDoc(it.uid)) return applyDoc(it);
    const k = state.known[it.uid];
    if (k && k.updatedAt >= it.updatedAt) return false; // déjà vu, ou modification locale plus récente en attente
    const local = bySyncId(it.uid);
    if (it.deleted) {
      if (local && local.pty) { // encore ouverte ici : on la garde et on la renvoie
        state.known[it.uid] = { fp: null, updatedAt: it.updatedAt };
        return false;
      }
      state.known[it.uid] = { deleted: true, updatedAt: it.updatedAt };
      delete state.outbox[it.uid];
      if (state.detached?.[it.uid]) delete state.detached[it.uid]; // supprimée partout : plus rien à garder
      if (local) { sessions.delete(local.id); broadcast({ t: 'removed', id: local.id }); return true; }
      return false;
    }
    // chiffré par une autre machine (3.8+), ou en clair (versions précédentes) : validé dans les deux cas
    let d;
    if (it.data?.e) { try { d = openJson(config().key, it.data, metaAad(it.uid, it.updatedAt)); } catch { return false; } }
    else d = it.data;
    d = cleanMeta(d);
    let s = local;
    // fermée ici (Fermer) : elle continue de vivre sur les autres machines, on ne la remet pas dans la liste d'ici
    if (!s && state.detached?.[it.uid]) { state.known[it.uid] = { fp: '', updatedAt: it.updatedAt }; delete state.outbox[it.uid]; return false; }
    if (!s) s = insertRemote(it, d);
    else {
      const renamed = !!d.name && d.name !== s.name;
      if (renamed) s.titleFor = null; // nom repris dans la conversation (claude --resume)
      for (const f of SYNCED) {
        if (f === 'name' && !d.name) continue;
        // arguments : on garde ceux d'ici qui ne se synchronisent pas (ex. bypassPermissions) si le reste est identique
        if (f === 'args' && safeArgs(s.args) === (d.args || '')) continue;
        s[f] = d[f] ?? (f === 'args' ? '' : f === 'named' || f === 'pinned' || f === 'remote' ? false : undefined);
        // en pause sur une autre machine : affichée « en pause » ici aussi (si elle ne tourne pas ici)
        if (f === 'paused' && !s.pty) s.message = s.paused ? 'en pause' : s.message === 'en pause' ? 'arrêtée' : s.message;
      }
      if (d.cwd) s.syncCwd = d.cwd;
      if (renamed) ctx.liveRename?.(s); // ouverte ici : renommée aussitôt pour Claude Code (/rename)
    }
    state.known[it.uid] = { fp: fp(payload(s)), updatedAt: it.updatedAt };
    delete state.outbox[it.uid];
    broadcast({ t: 'session', s: publicView(s) });
    return true;
  }

  async function pull() {
    let changed = false;
    for (let page = 0; page < 20; page++) {
      const r = await call('GET', `/sessions?since=${state.cursor}`);
      for (const it of r.items || []) { if (apply(it)) changed = true; state.cursor = Math.max(state.cursor, it.rev || 0); }
      status.pulled += (r.items || []).length;
      if (!r.items?.length || state.cursor >= r.rev) break;
    }
    if (changed) { applying = true; try { persist(); } finally { applying = false; } }
    state.docsPulled = true;
    saveState();
  }

  // ---------------------------------------------------------------- conversations (#27, chiffrées)
  // Le transcript (~/.claude/projects/…/<id>.jsonl) est compressé puis chiffré (AES-256-GCM, clé dérivée du
  // code de synchro) avant l'envoi : le serveur ne voit que des octets opaques. Découpé en morceaux de 1 Mo.
  // Version = HMAC du contenu : même conversation sur deux machines = même version, rien à transférer.
  // La plus récente gagne ; une session ouverte ici n'est jamais écrasée.
  const txOn = () => settings().syncTranscripts !== false;
  // Dossier où Claude Code cherche les conversations d'un dossier de travail.
  // (Claude Code part du chemin réel : /var → /private/var sur macOS.)
  const projectFile = (cwd, cid) => {
    let real = cwd; try { real = fs.realpathSync(cwd); } catch { }
    return path.join(home, '.claude', 'projects', real.replace(/[^a-zA-Z0-9]/g, '-'), `${cid}.jsonl`);
  };

  async function upload(cfg, s, file, st, R) {
    // déjà trop grosse à cette taille : inutile de la relire et de la recompresser à chaque synchro
    const T = state.tx[s.syncId];
    if (T?.tooBig && T.cid === s.claudeSessionId && st.size >= T.size) return;
    if (st.size > MAX_RAW) { state.tx[s.syncId] = { cid: s.claudeSessionId, ver: null, size: st.size, mtime: st.mtimeMs, at: Date.now(), tooBig: true }; return; }
    // lue en flux, bornée à la taille relevée (Claude peut écrire pendant l'envoi : la suite partira au tour suivant)
    const ver = await fileVersion(cfg.key, file, st.size);
    const rec = { cid: s.claudeSessionId, ver, size: st.size, mtime: st.mtimeMs, at: Date.now() };
    if (R && R.ver === ver) { state.tx[s.syncId] = rec; return; } // identique des deux côtés
    // suite de la version reçue (rien n'a changé ailleurs depuis) : datée après elle, même si l'horloge d'ici
    // retarde sur celle de la machine qui l'a envoyée (sinon le serveur la refusait comme plus ancienne)
    const updatedAt = Math.max(Math.round(st.mtimeMs), R && state.tx[s.syncId]?.ver === R.ver ? (R.updatedAt || 0) + 1 : 0);
    const sealed = await sealFileParts(cfg.key, file, st.size, txAad(s.syncId, s.claudeSessionId, ver, updatedAt), CHUNK, MAX_CHUNKS * CHUNK);
    if (!sealed) { state.tx[s.syncId] = { ...rec, ver: null, tooBig: true }; return; }
    const chunks = sealed.parts.length;
    await pool(chunks, n => call('PUT', `/transcripts/${s.syncId}/${ver}/${n}`, sealed.parts[n]));
    await call('PUT', `/transcripts/${s.syncId}`, { cid: s.claudeSessionId, ver, chunks, size: sealed.size, updatedAt, origin: machine() });
    state.tx[s.syncId] = rec;
    status.txUp++;
  }

  // Copies des conversations remplacées (DATA/transcript-backup/<date>/<heure>-[machine-]<conversation>.jsonl).
  // Jamais deux fois la même version d'une conversation, au plus BACKUP_KEEP par conversation, 30 jours, et
  // BACKUP_MAX en tout (la copie la plus récente de chaque conversation est toujours gardée). Sans ces limites, une
  // conversation qui ne pouvait plus partir (trop grosse) était recopiée en entier à chaque synchro : 50 Go en 3 jours.
  const BACKUP = path.join(DATA, 'transcript-backup');
  const BACKUP_KEEP = 3, BACKUP_MAX = Number(process.env.CSM_BACKUP_MAX) || 1024 ** 3;
  // identifiant de la conversation (fin du nom : <heure>-[machine-]<conversation>.jsonl)
  const backupCid = name => (name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i) || name.match(/^\d{6}-(?:.+-)?([\w]{8,64})\.jsonl$/) || [])[1] || name;
  function backupFiles() {
    const out = [];
    let days = []; try { days = fs.readdirSync(BACKUP); } catch { return out; }
    for (const d of days) {
      const dir = path.join(BACKUP, d);
      let names = []; try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        try { const st = fs.statSync(path.join(dir, n)); out.push({ p: path.join(dir, n), cid: backupCid(n), size: st.size, mtime: st.mtimeMs }); } catch { }
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }
  function pruneBackups() {
    const all = backupFiles(), seen = new Map(), keep = [];
    for (const f of all) {
      const n = (seen.get(f.cid) || 0) + 1; seen.set(f.cid, n);
      const newest = n === 1;
      if (!newest && (n > BACKUP_KEEP || Date.now() - f.mtime > 30 * 86400e3)) { fs.rmSync(f.p, { force: true }); continue; }
      keep.push({ ...f, newest });
    }
    // plafond total : les plus anciennes d'abord, jamais la plus récente d'une conversation
    let total = keep.reduce((n, f) => n + f.size, 0);
    for (const f of [...keep].reverse()) {
      if (total <= BACKUP_MAX) break;
      if (f.newest) continue;
      fs.rmSync(f.p, { force: true }); total -= f.size;
    }
    try { for (const d of fs.readdirSync(BACKUP)) { const dir = path.join(BACKUP, d); if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } } catch { }
  }
  async function sameFile(a, b) {
    const hash = async f => { const h = crypto.createHash('sha256'); for await (const c of fs.createReadStream(f)) h.update(c); return h.digest('hex'); };
    return (await hash(a)) === (await hash(b));
  }
  // garde `src` en copie (move : déplacé au lieu de copié), sauf si la dernière copie de cette conversation est identique
  async function keepBackup(src, label, move) {
    try {
      const cid = backupCid(path.basename(src).replace(/\.csm-dl$/, '')), size = fs.statSync(src).size;
      const last = backupFiles().find(f => f.cid === cid);
      if (last && last.size === size && await sameFile(last.p, src)) { if (move) fs.rmSync(src, { force: true }); return false; }
      const day = new Date().toISOString().slice(0, 10), dir = path.join(BACKUP, day);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const dest = path.join(dir, `${new Date().toISOString().slice(11, 19).replace(/:/g, '')}-${label ? label + '-' : ''}${cid}.jsonl`);
      if (move) fs.renameSync(src, dest); else fs.copyFileSync(src, dest);
      return true;
    } finally { pruneBackups(); }
  }
  setTimeout(() => { try { pruneBackups(); } catch { } }, Number(process.env.CSM_BACKUP_PRUNE_DELAY) || 5000).unref?.(); // copies accumulées par les versions précédentes
  // version d'une autre machine, déchiffrée et vérifiée, écrite dans `dest` (fichier temporaire puis renommage :
  // rien n'est remplacé si elle est incomplète)
  async function fetchRemoteTo(cfg, s, R, dest) {
    // identifiants venus du serveur : vérifiés avant tout usage (le cid devient un nom de fichier)
    if (!/^[\w-]{1,64}$/.test(String(R.cid)) || !/^[0-9a-f]{32}$/.test(String(R.ver)) || !(Number.isInteger(R.chunks) && R.chunks >= 1 && R.chunks <= MAX_CHUNKS)) {
      throw new Error('conversation reçue incomplète');
    }
    const parts = await pool(R.chunks, n => call('GET', `/transcripts/${s.syncId}/${R.ver}/${n}`, undefined, true));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.csm-dl';
    try {
      if (await openPartsTo(cfg.key, parts, txAad(s.syncId, R.cid, R.ver, R.updatedAt), tmp, 512 * 1024 * 1024) !== R.ver) throw new Error('version');
      fs.renameSync(tmp, dest);
    } catch { fs.rmSync(tmp, { force: true }); throw new Error('conversation reçue incomplète'); }
  }
  // Nouveaux messages ici depuis la dernière synchro ? Une relance (reprise, arrêt) ajoute seulement des lignes
  // techniques (titre, mode, coût…) : ce n'est pas un travail à faire passer avant celui d'une autre machine.
  async function realChangeSince(file, st, T, cid) {
    if (!T || T.cid !== cid || !T.size || st.size < T.size) return true;
    if (st.size - T.size > 64 * 1024 * 1024) return true;
    const fh = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - T.size);
      await fh.read(buf, 0, buf.length, T.size);
      return buf.toString('utf8').split('\n').some(l => {
        if (!l.includes('"user"') && !l.includes('"assistant"')) return false;
        try { const o = JSON.parse(l); return o.type === 'user' || o.type === 'assistant'; } catch { return false; }
      });
    } finally { await fh.close(); }
  }
  async function download(cfg, s, R) {
    const targets = [...new Set([projectFile(s.cwd, R.cid), ctx.transcriptPath(R.cid)].filter(Boolean))];
    const got = path.join(DATA, `transcript-${s.syncId}.csm-in`);
    await fetchRemoteTo(cfg, s, R, got); // reçue entière et vérifiée avant de toucher aux fichiers d'ici
    let st;
    const T = state.tx[s.syncId], files = {};
    // état laissé ici par la dernière synchro, pour chaque fichier (une conversation peut être à deux endroits :
    // seul le dernier était retenu, et l'autre était recopié en sauvegarde à chaque téléchargement)
    const syncedHere = (f, cur) => (T?.files?.[f] ? T.files[f][0] === cur.size && T.files[f][1] === cur.mtimeMs : !!T && T.size === cur.size && T.mtime === cur.mtimeMs);
    try {
      for (const f of targets) {
        // conversation qui a aussi avancé ici sans être partie (machine éteinte ou hors ligne) : copiée avant d'être
        // remplacée par la version la plus récente (DATA/transcript-backup)
        try {
          const cur = fs.statSync(f);
          if (!syncedHere(f, cur)) await keepBackup(f, '', false);
        } catch { }
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.copyFileSync(got, f + '.csm-tmp'); fs.renameSync(f + '.csm-tmp', f);
        const now = fs.statSync(f); files[f] = [now.size, now.mtimeMs];
        if (!st || f === ctx.transcriptPath(R.cid)) st = now; // celui que la synchro relira
      }
    } finally { fs.rmSync(got, { force: true }); }
    state.tx[s.syncId] = { cid: R.cid, ver: R.ver, size: st.size, mtime: st.mtimeMs, at: Date.now(), files };
    if (s.claudeSessionId !== R.cid) {
      s.claudeSessionId = R.cid;
      applying = true; try { persist(); } finally { applying = false; }
      broadcast({ t: 'session', s: publicView(s) });
    }
    status.txDown++;
  }

  // Une session : envoie si modifiée ici, télécharge si modifiée ailleurs (et arrêtée ici).
  async function reconcile(cfg, s, R, force) {
    const T = state.tx[s.syncId];
    const file = s.claudeSessionId && ctx.transcriptPath(s.claudeSessionId);
    let st = null; try { st = file && fs.statSync(file); } catch { }
    let localChanged = !!st && !(T && T.cid === s.claudeSessionId && T.size === st.size && T.mtime === st.mtimeMs);
    const remoteChanged = !!R && !(T && T.ver === R.ver);
    // les deux ont changé : des lignes techniques ici (relance) ne l'emportent jamais sur l'autre machine ; de vrais
    // messages des deux côtés : la plus récente gagne, et l'autre version est d'abord copiée (transcript-backup)
    if (localChanged && remoteChanged && T?.ver && !s.pty && !(await realChangeSince(file, st, T, s.claudeSessionId))) localChanged = false;
    // (pas pour sa propre version encore sur le serveur, ni pour une conversation trop grosse pour partir d'ici :
    // rien ne la remplacerait, et elle était recopiée à chaque synchro)
    else if (localChanged && remoteChanged && st.mtimeMs >= R.updatedAt && R.origin !== machine() && !T?.tooBig) {
      try {
        fs.mkdirSync(BACKUP, { recursive: true, mode: 0o700 });
        const tmp = path.join(BACKUP, `${R.cid}.jsonl.csm-dl`);
        await fetchRemoteTo(cfg, s, R, tmp);
        await keepBackup(tmp, String(R.origin || 'autre').replace(/[^\w.-]/g, '_'), true);
        status.lastConflict = { name: s.name, from: R.origin || '', at: Date.now() };
      } catch { }
    }
    if (localChanged && (!remoteChanged || st.mtimeMs >= R.updatedAt)) {
      // pendant que Claude écrit : au plus un envoi toutes les 2 minutes (10 pour une longue conversation)
      if (!force && s.status === 'working' && T && Date.now() - T.at < (st.size > 20 * 1024 * 1024 ? 600000 : 120000)) return;
      await upload(cfg, s, file, st, R);
    } else if (remoteChanged && !s.pty && !(T?.tooBig && st && st.mtimeMs >= R.updatedAt)) await download(cfg, s, R);
  }

  // Liste lue une seule fois par synchro (conversations, mémoires et configuration de Claude la partagent :
  // chaque partie ne touche que ses propres uid) ; hors synchro (« Reprendre »), relue à chaque fois.
  let cycleList = null;
  const fetchList = async () => new Map(((await call('GET', '/transcripts')).items || []).map(x => [x.uid, x]));
  const remoteTranscripts = () => cycleList || (running ? (cycleList = fetchList().catch(e => { cycleList = null; throw e; })) : fetchList());
  async function syncTranscripts() {
    const cfg = config();
    if (!cfg || !txOn()) return;
    const remote = await remoteTranscripts();
    for (const s of [...sessions.values()]) {
      if (!s.syncId) continue;
      // une conversation en échec (introuvable, illisible) n'empêche pas les suivantes
      try { await reconcile(cfg, s, remote.get(s.syncId)); } catch (e) { if (!/conversation reçue/.test(e.message)) status.lastError = 'conversations : ' + e.message; }
    }
    saveState();
  }
  // ---------------------------------------------------------------- mémoire claude-mem (lib/memsync.js)
  const usesMem = () => settings().memoryEngine === 'claude-mem';
  const memOn = () => usesMem() && settings().syncSessionMemory !== false;
  // claude-mem choisi comme moteur de mémoire mais absent : installation automatique, en arrière-plan
  status.memInstall = '';
  let installing = null, installAt = 0;
  function ensureClaudeMem() {
    if (!usesMem() || installing || memsync.pluginRoot() || process.env.CSM_NO_PLUGIN_INSTALL) return installing;
    installAt = Date.now();
    status.memInstall = 'installing'; broadcast({ t: 'sync', status: view() });
    installing = memsync.install(ctx.CLAUDE)
      .then(() => { status.memInstall = 'installed'; })
      .catch(e => { status.memInstall = 'error: ' + e.message; console.error('claude-mem : ' + e.message); })
      .finally(() => { installing = null; broadcast({ t: 'sync', status: view() }); });
    return installing;
  }
  ctx.memoryEngineChanged = ensureClaudeMem;
  setTimeout(ensureClaudeMem, 3000).unref?.();
  const memState = () => {
    const m = state.mem || (state.mem = {});
    if (!/^[0-9a-f]{12}$/.test(m.dev || '')) m.dev = memsync.randomDev();
    m.wm = m.wm || {}; m.applied = m.applied || {}; m.seq = m.seq || 0;
    return m;
  };
  const memAad = (uid, ver, updatedAt) => `m|${uid}|${ver}|${updatedAt}`;
  // variables des sessions lancées par l'application : leur mémoire claude-mem = l'espace synchronisé
  ctx.memEnv = () => {
    if (!config() || !memOn()) return {};
    try { return memsync.prepare(DATA); } catch { return {}; }
  };
  async function syncMemory() {
    const cfg = config();
    if (!cfg || !memOn()) { status.memAvailable = null; return; }
    await memsync.ensureDb(DATA, memsync.prepare(DATA));
    let M;
    try { M = memsync.open(DATA); } catch (e) {
      // base créée par un claude-mem trop ancien : mise à jour et migration automatiques (au plus toutes les 6 h)
      const m = memState();
      if (e.code !== 'CLAUDE_MEM_OLD' || Date.now() - (m.repairAt || 0) < 6 * 3600e3) throw e;
      m.repairAt = Date.now(); saveState();
      const say = msg => { status.lastError = 'mémoire : ' + msg; broadcast({ t: 'sync', status: view() }); };
      await memsync.repair(DATA, ctx.CLAUDE, say);
      M = memsync.open(DATA);
      status.lastError = '';
    }
    status.memAvailable = !!M;
    if (!M) return;
    try {
      const m = memState(), remote = await remoteTranscripts(), mine = memsync.PREFIX + m.dev + '-';
      // d'abord recevoir : une machine qui rejoint l'espace charge la mémoire des autres tout de suite
      for (const [uid, R] of remote) {
        if (!uid.startsWith(memsync.PREFIX) || uid.startsWith(mine) || m.applied[uid] === R.ver) continue;
        const dev = uid.slice(memsync.PREFIX.length).split('-')[0];
        if (!/^[0-9a-f]{12}$/.test(dev) || !/^[0-9a-f]{32}$/.test(String(R.ver)) || !(Number.isInteger(R.chunks) && R.chunks >= 1 && R.chunks <= MAX_CHUNKS)) continue;
        const parts = [];
        for (let n = 0; n < R.chunks; n++) parts.push(await call('GET', `/transcripts/${uid}/${R.ver}/${n}`, undefined, true));
        let raw;
        try { raw = unseal(cfg.key, Buffer.concat(parts), memAad(uid, R.ver, R.updatedAt)); } catch { continue; }
        if (txVersion(cfg.key, raw) !== R.ver) continue;
        let b; try { b = JSON.parse(raw.toString('utf8')); } catch { continue; }
        if (!b || b.v !== 1 || b.dev !== dev) continue;
        status.memDown += memsync.importBatch(M, dev, b);
        m.applied[uid] = R.ver;
        saveState();
      }
      // puis envoyer ce qui est né ici depuis le dernier lot
      for (let i = 0; i < memsync.MAX_BATCHES; i++) {
        const { batch, next, count } = memsync.exportBatch(M, m.wm);
        if (!count) break;
        const uid = `${memsync.PREFIX}${m.dev}-${m.seq + 1}`;
        const raw = Buffer.from(JSON.stringify({ v: 1, dev: m.dev, ...batch })), ver = txVersion(cfg.key, raw), updatedAt = Date.now();
        const blob = seal(cfg.key, raw, memAad(uid, ver, updatedAt));
        const chunks = Math.ceil(blob.length / CHUNK) || 1;
        if (chunks > MAX_CHUNKS) throw new Error('lot trop gros');
        for (let n = 0; n < chunks; n++) await call('PUT', `/transcripts/${uid}/${ver}/${n}`, blob.subarray(n * CHUNK, (n + 1) * CHUNK));
        await call('PUT', `/transcripts/${uid}`, { cid: 'claude-mem', ver, chunks, size: blob.length, updatedAt, origin: machine() });
        m.seq++; m.wm = next; m.applied[uid] = ver;
        status.memUp += count;
        saveState();
      }
    } finally { M.db.close(); }
  }

  // ---------------------------------------------------------------- mémoire native (lib/memory.js)
  // Une fiche par session, uid « nm-<id de la conversation> » : la plus récente (champ updated) gagne.
  // got[uid] = dernière version reçue, put[uid] = version de la fiche locale déjà envoyée (ou reçue).
  const NM = 'nm-';
  const nmOn = () => !!ctx.memory && ctx.memory.on() && settings().syncSessionMemory !== false;
  const nmAad = (uid, ver, updatedAt) => `n|${uid}|${ver}|${updatedAt}`;
  async function syncNativeMemory() {
    const cfg = config();
    if (!cfg || !nmOn()) return;
    const st = state.nm || (state.nm = { got: {}, put: {} });
    const mem = ctx.memory, remote = await remoteTranscripts();
    const local = e => Buffer.from(JSON.stringify(mem.shared(e)));
    for (const [uid, R] of remote) {
      if (!uid.startsWith(NM) || st.got[uid] === R.ver || st.put[uid] === R.ver) continue;
      if (!/^[0-9a-f]{32}$/.test(String(R.ver)) || !(Number.isInteger(R.chunks) && R.chunks >= 1 && R.chunks <= 4)) continue;
      const cur = mem.get(uid.slice(NM.length));
      if (cur && cur.updated >= R.updatedAt) { st.got[uid] = R.ver; continue; } // la nôtre est plus récente : elle partira
      const parts = [];
      for (let n = 0; n < R.chunks; n++) parts.push(await call('GET', `/transcripts/${uid}/${R.ver}/${n}`, undefined, true));
      let e;
      try {
        const raw = zlib.gunzipSync(unseal(cfg.key, Buffer.concat(parts), nmAad(uid, R.ver, R.updatedAt)), { maxOutputLength: 8 * 1024 * 1024 });
        if (txVersion(cfg.key, raw) !== R.ver) continue;
        e = JSON.parse(raw.toString('utf8'));
      } catch { continue; }
      st.got[uid] = R.ver;
      if (!e || NM + e.id !== uid || !mem.put(e)) continue;
      st.put[uid] = txVersion(cfg.key, local(mem.get(e.id)));
      status.nmDown++;
      saveState();
    }
    for (const e of mem.list()) {
      const uid = NM + e.id, raw = local(e), ver = txVersion(cfg.key, raw);
      if (st.put[uid] === ver) continue;
      const updatedAt = e.updated || Date.now();
      const blob = seal(cfg.key, zlib.gzipSync(raw), nmAad(uid, ver, updatedAt));
      const chunks = Math.ceil(blob.length / CHUNK) || 1;
      if (chunks > 4) continue;
      for (let n = 0; n < chunks; n++) await call('PUT', `/transcripts/${uid}/${ver}/${n}`, blob.subarray(n * CHUNK, (n + 1) * CHUNK));
      const res = await call('PUT', `/transcripts/${uid}`, { cid: 'memory', ver, chunks, size: blob.length, updatedAt, origin: machine() });
      if (res && res.applied === false) { delete st.got[uid]; continue; } // version plus récente ailleurs : relue au prochain cycle
      st.put[uid] = ver; st.got[uid] = ver;
      status.nmUp++;
      saveState();
    }
  }

  // ---------------------------------------------------------------- règles, skills, agents, mémoire de Claude (lib/claudesync.js)
  plugSync = pluginsync({ ctx, settings, getState: () => state, saveState, broadcastStatus: () => broadcast({ t: 'sync', status: view() }) });
  route('GET', /^\/api\/sync\/plugins$/, async ({ res }) => json(res, 200, plugSync.view()));
  route('POST', /^\/api\/sync\/plugins\/decide$/, async ({ req, res }) => {
    const { uid, apply } = await ctx.readBody(req);
    const r = await plugSync.decide(String(uid || ''), !!apply);
    json(res, r.error ? 400 : 200, r);
  });
  const syncClaude = claudesync({ DATA, settings, call, seal, unseal, txVersion, remote: () => remoteTranscripts(), machine, getState: () => state, saveState, status });
  const cfOn = () => Object.values(claudesync.KINDS).some(k => settings()[k.setting] !== false);

  // « Reprendre » : récupérer la dernière version de la conversation avant de relancer claude.
  ctx.prepareResume = async s => {
    const cfg = config();
    if (!cfg || !txOn() || !s.syncId || s.pty) return;
    try {
      const R = (await fetchList()).get(s.syncId); // liste fraîche, jamais celle d'un cycle en cours
      await reconcile(cfg, s, R, true);
      saveState();
    } catch (e) { status.lastError = 'conversations : ' + e.message; }
  };

  let running = null;
  function sync() {
    if (running) return running;
    const cycle = (async () => {
      status.enabled = !!config();
      if (!status.enabled) return;
      status.busy = true;
      try {
        // installation de claude-mem en échec : nouvel essai toutes les 30 min
        if (status.memInstall.startsWith('error') && Date.now() - installAt > 30 * 60e3) ensureClaudeMem();
        if (scanTimer) { clearTimeout(scanTimer); scan(); }
        await pull();
        scan(); // groupes et modèles locaux, maintenant que ceux des autres machines sont connus
        await push();
        status.lastOk = Date.now(); status.lastError = '';
        cycleList = null;
        try { await syncTranscripts(); } catch (e) { status.lastError = 'conversations : ' + e.message; }
        try { await syncMemory(); } catch (e) { status.lastError = 'mémoire : ' + e.message; }
        try { await syncNativeMemory(); } catch (e) { status.lastError = 'mémoire partagée : ' + e.message; }
        try { await syncClaude(config()); } catch (e) { status.lastError = 'règles, skills et agents : ' + e.message; }
      } catch (e) {
        status.lastError = e.message;
        throw e;
      } finally { cycleList = null; status.busy = false; broadcast({ t: 'sync', status: view() }); }
    })();
    // garde-fou : un tour qui ne finit jamais (erreur hors de portée, réseau figé) ne bloque plus la synchro
    // jusqu'au redémarrage de l'app ; le tour suivant repart
    let guard;
    const stuck = new Promise(resolve => { guard = setTimeout(resolve, SYNC_MAX_MS); guard.unref?.(); }).then(() => {
      status.lastError = 'synchro interrompue (trop longue), nouvel essai'; status.busy = false; broadcast({ t: 'sync', status: view() });
    });
    running = Promise.race([cycle, stuck]).finally(() => { clearTimeout(guard); running = null; });
    return running;
  }

  // « Synchroniser maintenant », Pause : une synchro complète qui commence maintenant (celle qui tournait, lancée
  // avant, peut avoir manqué les derniers changements ou visé un ancien code)
  async function syncFresh() { if (running) await running.catch(() => { }); return sync(); }

  // Code changé : autre espace, on repart de zéro (les sessions locales seront envoyées au nouvel espace).
  const codeId = () => { const c = config(); return c ? c.url + ' ' + c.key : settings().syncCode || ''; };
  let lastCode = codeId();
  function checkCode() {
    const code = codeId();
    if (code === lastCode) return;
    lastCode = code;
    cycleList = null;
    state = { cursor: 0, known: {}, outbox: {}, tx: {}, docsPulled: false, format: 2, mem: { dev: state.mem?.dev }, nm: { got: {}, put: {} }, cf: { files: {}, got: {}, paths: {}, at: {} } };
    linkTried = '';
    for (const s of sessions.values()) { delete s.syncId; delete s.syncCwd; }
    saveState();
    scan();
  }

  const view = () => ({
    enabled: !!config(), invalid: !!settings().syncCode && !config(), code: config()?.code || '', server: config()?.url || server(), machine: machine(), lastOk: status.lastOk, lastError: status.lastError,
    live: !!status.live, liveAt: status.liveAt || 0,
    pending: Object.keys(state.outbox).length, busy: status.busy, pluginsPending: Object.keys(state.plugins?.pending || {}).length, transcripts: txOn(), groups: docOn(GROUPS_UID), templates: docOn(TPL), sent: status.txUp, received: status.txDown,
    memory: memOn(), memEngine: settings().memoryEngine || 'native', memInstall: status.memInstall || '', memInstalled: !!memsync.pluginRoot(), memAvailable: status.memAvailable ?? null, memSent: status.memUp, memReceived: status.memDown,
    nativeMemory: nmOn(), nmSent: status.nmUp, nmReceived: status.nmDown, memSuggest: status.memSuggest || '',
    cfPending: status.cfPending || 0, cfWarning: status.cfWarning || 0,
    claude: cfOn(), cfSent: status.cfUp, cfReceived: status.cfDown, cfFiles: status.cfFiles,
  });

  route('GET', /^\/api\/sync$/, async ({ res }) => json(res, 200, view()));
  // configuration de Claude reçue : fichiers à valider, journal des changements, restauration d'une copie
  route('GET', /^\/api\/claude-sync$/, async ({ res }) => json(res, 200, { pending: syncClaude.pending(), log: syncClaude.log(), warning: status.cfWarning || 0 }));
  route('POST', /^\/api\/claude-sync\/decide$/, async ({ req, res }) => {
    const b = await readBody(req);
    const uids = Array.isArray(b?.uids) ? b.uids.filter(u => typeof u === 'string' && /^cf-[0-9a-f]{32}$/.test(u)) : [];
    let done;
    try { done = syncClaude.decide(uids, b?.apply === true); } catch (e) { return json(res, 409, { error: e.message }); }
    broadcast({ t: 'sync', status: view() });
    json(res, 200, { done });
  });
  route('POST', /^\/api\/claude-sync\/restore$/, async ({ req, res }) => {
    const b = await readBody(req);
    try { json(res, 200, syncClaude.restore(String(b?.id || ''))); } catch (e) { json(res, 400, { error: e.message }); }
  });
  route('POST', /^\/api\/sync\/now$/, async ({ res }) => {
    checkCode(); live();
    try { await syncFresh(); } catch { }
    json(res, 200, view());
  });
  // ---------------------------------------------------------------- machines de l'espace, place occupée
  route('GET', /^\/api\/sync\/machines$/, async ({ res }) => {
    if (!config()) return json(res, 200, { enabled: false, machines: [] });
    const me = { id: myMachineUid(), name: machine(), platform: process.platform, version: ctx.VERSION || '', engine: settings().memoryEngine || 'native', seen: status.lastOk || 0, me: true };
    const others = Object.entries(state.machines || {}).map(([id, m]) => ({ id, ...m })).sort((a, b) => b.seen - a.seen);
    let usage = null;
    try { usage = await call('GET', '/usage'); } catch { }
    json(res, 200, { enabled: true, machines: [me, ...others], usage });
  });
  // Retirer une machine de la liste (elle y revient si elle se synchronise encore : pour couper son accès,
  // changer de code).
  route('DELETE', /^\/api\/sync\/machines\/(csmcfg-machine-[0-9a-f]{12})$/, async ({ res, m }) => {
    const uid = m[1];
    if (!config() || uid === myMachineUid()) return json(res, 400, { error: 'impossible' });
    delete (state.machines || {})[uid];
    const updatedAt = stamp(uid);
    state.known[uid] = { deleted: true, updatedAt };
    state.outbox[uid] = { uid, data: {}, updatedAt, deleted: true, origin: machine() };
    saveState(); schedulePush();
    json(res, 200, { ok: true });
  });
  // Changer de code : tout est d'abord récupéré ici, puis l'ancien espace est effacé sur le serveur (les machines
  // restées sur l'ancien code reçoivent « code refusé »), et tout repart d'ici vers le nouvel espace. Les autres
  // machines saisissent le nouveau code ; elles y renvoient alors ce qu'elles ont.
  route('POST', /^\/api\/sync\/rotate$/, async ({ req, res }) => {
    const b = await readBody(req) || {};
    const cur = config();
    if (!cur) return json(res, 400, { error: 'synchronisation non configurée' });
    const url = cur.url; // le serveur de l'espace actuel (celui du code, ou du réglage)
    try { await sync(); } catch (e) { return json(res, 502, { error: 'synchronisation impossible avant le changement : ' + e.message }); }
    let code;
    try { code = await createSpace(url); } catch (e) { return json(res, 502, { error: e.message }); }
    if (b.wipe !== false) { try { await call('DELETE', '/space'); } catch (e) { return json(res, 502, { error: 'ancien espace non effacé : ' + e.message }); } }
    // code court si le serveur est celui du réglage, sinon code complet (avec l'adresse du serveur)
    const next = url === server().replace(/\/+$/, '') ? formatCode(code) : encodeCode(url, code);
    ctx.patchSettings?.({ syncCode: next });
    checkCode();
    sync().catch(() => { });
    json(res, 200, { code: next });
  });
  async function createSpace(url) {
    const code = newCode();
    let r;
    try {
      r = await fetch(url + '/spaces', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ auth: sha256(authKey(code)) }), signal: AbortSignal.timeout(15000),
      });
    } catch (e) { throw new Error('serveur de synchro injoignable : ' + e.message); }
    const b = await r.json().catch(() => ({}));
    if (!r.ok || b.ok !== true) throw new Error(b.error || (r.ok ? 'serveur de synchro à mettre à jour' : `serveur de synchro : HTTP ${r.status}`));
    return code;
  }

  // Nouveau code : tiré sur cette machine ; le serveur n'enregistre que l'empreinte de la clé d'accès.
  // L'interface l'enregistre ensuite dans syncCode.
  route('POST', /^\/api\/sync\/code$/, async ({ res }) => {
    const url = server().replace(/\/+$/, '');
    if (!okUrl(url)) return json(res, 400, { error: 'adresse du serveur invalide (https exigé)' });
    try { json(res, 200, { code: formatCode(await createSpace(url)) }); } catch (e) { json(res, 502, { error: e.message }); }
  });

  const optsOf = () => ['syncGroups', 'syncTemplates', 'syncUsage', 'syncExtensions', 'syncPlugins', 'syncTranscripts', 'syncSessionMemory', ...Object.values(claudesync.KINDS).map(k => k.setting)].map(k => settings()[k] !== false);
  let lastOpts = optsOf();
  // synchro complète tout de suite (mise en pause) ; false si la synchro n'est pas configurée ou a échoué
  ctx.syncEnabled = () => !!config();
  ctx.syncDetach = uid => { (state.detached || (state.detached = {}))[uid] = Date.now(); delete state.outbox[uid]; saveState(); };
  ctx.syncNow = async () => { live(); if (!config()) return null; checkCode(); try { await syncFresh(); return !status.lastError; } catch { return false; } };
  ctx.syncChanged = () => {
    live();
    const now = optsOf();
    if (now.some((on, i) => on && !lastOpts[i])) { state.cursor = 0; saveState(); }
    lastOpts = now;
    if (!scanTimer) scanTimer = setTimeout(scan, 300);
    if (settings().syncMinutes !== lastMinutes) planTick();
  };
  let tickTimer = null, lastMinutes;
  const planTick = () => {
    clearTimeout(tickTimer);
    lastMinutes = settings().syncMinutes;
    tickTimer = setTimeout(tick, interval(lastMinutes));
    tickTimer.unref?.();
  };
  const tick = () => { planTick(); checkCode(); live(); sync().catch(() => { }); };
  // Noms, groupes, épinglage… des autres machines : relevés toutes les 30 s (liste des sessions seulement,
  // quelques octets), sans attendre la synchro complète (conversations, mémoire) réglée en minutes.
  const quick = setInterval(() => {
    live(); // code saisi, changé ou retiré : connexion temps réel suivie
    if (running || !config()) return;
    running = (async () => { await pull(); if (Object.keys(state.outbox).length) await push(); })()
      .catch(() => { }).finally(() => { running = null; });
  }, Number(process.env.CSM_SYNC_QUICK) || 30e3);
  quick.unref?.();
  setTimeout(tick, Number(process.env.CSM_SYNC_DELAY) || 2000);
};

module.exports.decodeCode = decodeCode;
module.exports.encodeCode = encodeCode;
module.exports.DEFAULT_SERVER = DEFAULT_SERVER;
module.exports.parseRoots = parseRoots;
module.exports.toPortable = toPortable;
module.exports.fromPortable = fromPortable;
module.exports.seal = seal;
module.exports.unseal = unseal;
module.exports.txVersion = txVersion;
module.exports.fileVersion = fileVersion;
module.exports.sealFileParts = sealFileParts;
module.exports.openPartsTo = openPartsTo;
module.exports.authKey = authKey;
module.exports.sealJson = sealJson;
module.exports.openJson = openJson;
module.exports.safeArgs = safeArgs;
module.exports.cleanMeta = cleanMeta;
