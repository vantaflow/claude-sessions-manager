'use strict';
// Export / import de toutes les sessions dans un fichier (.csmx), pour changer d'ordinateur sans synchronisation :
// liste des sessions (noms, dossiers, groupes, options), leurs conversations Claude Code, groupes, modèles,
// extensions importées et mémoire des sessions. Rien n'est envoyé nulle part : le fichier se copie à la main.
//
// Format : « CSMX1\n », une ligne JSON d'en-tête ({ enc, salt, iv, N }), puis un flux gzip (chiffré en
// AES-256-GCM si un mot de passe est donné, clé scrypt ; les 16 derniers octets du fichier = étiquette GCM).
// Le flux est une suite d'enregistrements : une ligne JSON { k, len, … } suivie de `len` octets (conversation,
// fichier de mémoire). Le dernier enregistrement, « end », prouve que le fichier est complet.
// Lu en flux, jamais entièrement en mémoire (les conversations pèsent vite des centaines de Mo).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { once } = require('events');
const { parseRoots, toPortable, fromPortable, safeArgs, cleanMeta } = require('./sync');

const MAGIC = 'CSMX1\n';
const SCRYPT_N = 2 ** 15;
const FIELDS = ['name', 'args', 'group', 'pinned', 'color', 'remote', 'named', 'type', 'paused'];
const CID = /^[\w-]{1,64}$/, UID = /^[\w-]{1,64}$/;
const MAX_UPLOAD = 4 * 1024 ** 3;

const scrypt = (pw, salt) => new Promise((ok, ko) => crypto.scrypt(String(pw), salt, 32, { N: SCRYPT_N, r: 8, p: 1, maxmem: 64 * 1024 ** 2 }, (e, k) => (e ? ko(e) : ok(k))));

// ---------------------------------------------------------------- écriture
// records : itérable asynchrone de { h, data? } ; écrit dans `file` (via un fichier temporaire renommé à la fin).
// data : octets, ou { fd, size, onShort } (fichier lu en flux, jamais chargé d'un bloc : `size` premiers octets ;
// fichier raccourci pendant la lecture : complété de sauts de ligne pour garder l'archive lisible, onShort appelé).
async function writeArchive(file, password, records) {
  const enc = !!password;
  const head = { enc };
  let cipher = null;
  if (enc) {
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    Object.assign(head, { salt: salt.toString('base64'), iv: iv.toString('base64'), N: SCRYPT_N });
    cipher = crypto.createCipheriv('aes-256-gcm', await scrypt(password, salt), iv);
  }
  const tmp = file + '.part';
  fs.writeFileSync(tmp, MAGIC + JSON.stringify(head) + '\n', { mode: 0o600 });
  const out = fs.createWriteStream(tmp, { flags: 'a' });
  const gz = zlib.createGzip({ level: 6 });
  const done = pipeline(gz, ...(cipher ? [cipher] : []), out);
  const put = async b => { if (!gz.write(b)) await once(gz, 'drain'); };
  try {
    for await (const { h, data } of records) {
      const len = !data ? 0 : Buffer.isBuffer(data) ? data.length : data.size;
      await put(Buffer.from(JSON.stringify({ ...h, len }) + '\n'));
      if (Buffer.isBuffer(data)) { if (len) await put(data); continue; }
      if (!data) continue;
      let n = 0;
      try { for await (const c of fs.createReadStream(null, { fd: data.fd, start: 0, end: len - 1 })) { n += c.length; await put(c); } } catch { }
      if (n < len) {
        data.onShort?.();
        while (n < len) { const k = Math.min(65536, len - n); await put(Buffer.alloc(k, 10)); n += k; }
      }
    }
    gz.end();
    await done;
    if (cipher) fs.appendFileSync(tmp, cipher.getAuthTag());
    fs.renameSync(tmp, file);
  } catch (e) {
    gz.destroy(); try { fs.rmSync(tmp, { force: true }); } catch { }
    throw e;
  }
  return fs.statSync(file).size;
}

// ---------------------------------------------------------------- lecture
// onRec(h, data) pour chaque enregistrement ; data = null si keep est faux (aperçu : rien n'est gardé en mémoire).
// keep peut aussi être une fonction (h) → true (octets gardés en mémoire), false, ou un récepteur
// { write(b), close(), abort() } qui reçoit les octets au fil de la lecture (conversation : jamais d'un bloc) ;
// onRec reçoit alors le récepteur, fermé.
async function readArchive(file, password, onRec, keep) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  const first = Buffer.alloc(Math.min(size, 4096));
  fs.readSync(fd, first, 0, first.length, 0); fs.closeSync(fd);
  if (first.subarray(0, MAGIC.length).toString() !== MAGIC) throw new Error('ce fichier n’est pas un export de Claude Sessions');
  const nl = first.indexOf(10, MAGIC.length);
  if (nl < 0) throw new Error('fichier d’export abîmé');
  let head;
  try { head = JSON.parse(first.subarray(MAGIC.length, nl).toString()); } catch { throw new Error('fichier d’export abîmé'); }
  const start = nl + 1;
  let decipher = null, end = size;
  if (head.enc) {
    if (!password) { const e = new Error('mot de passe requis'); e.code = 'PASSWORD'; throw e; }
    if (size - start < 16) throw new Error('fichier d’export abîmé');
    end = size - 16;
    const tag = Buffer.alloc(16), f2 = fs.openSync(file, 'r');
    fs.readSync(f2, tag, 0, 16, end); fs.closeSync(f2);
    decipher = crypto.createDecipheriv('aes-256-gcm', await scrypt(password, Buffer.from(head.salt, 'base64')), Buffer.from(head.iv, 'base64'));
    decipher.setAuthTag(tag);
  }
  let ended = false, sink = null;
  const src = end > start ? fs.createReadStream(file, { start, end: end - 1 }) : require('stream').Readable.from([]);
  try {
    await pipeline(src, ...(decipher ? [decipher] : []), zlib.createGunzip(), async source => {
      let pending = null, cur = null, need = 0, parts = [], buffered = false;
      const emit = async () => {
        const h = cur, out = sink; cur = null; sink = null;
        if (h.k === 'end') ended = true;
        if (out) await out.close?.();
        const data = out || (buffered ? Buffer.concat(parts) : null); parts = [];
        await onRec(h, data);
      };
      for await (const c of source) {
        let b = pending ? Buffer.concat([pending, c]) : c; pending = null;
        while (b.length) {
          if (!cur) {
            const i = b.indexOf(10);
            if (i < 0) { if (b.length > 1e6) throw new Error('fichier d’export abîmé'); pending = b; break; }
            cur = JSON.parse(b.subarray(0, i).toString());
            need = Number(cur.len) || 0; b = b.subarray(i + 1);
            const k = typeof keep === 'function' ? await keep(cur) : keep;
            sink = k && typeof k === 'object' ? k : null; buffered = k === true;
            if (!need) await emit();
            continue;
          }
          const take = Math.min(need, b.length);
          if (sink) await sink.write(b.subarray(0, take));
          else if (buffered) parts.push(b.subarray(0, take));
          need -= take; b = b.subarray(take);
          if (!need) await emit();
        }
      }
      if (cur || pending) throw new Error('fichier d’export incomplet');
    });
  } catch (e) {
    try { sink?.abort?.(); } catch { }
    if (e.code === 'PASSWORD') throw e;
    // mauvais mot de passe : le flux déchiffré n'est pas du gzip, ou l'étiquette GCM ne correspond pas
    throw new Error(head.enc ? 'mot de passe incorrect, ou fichier abîmé' : `fichier d’export abîmé (${e.message})`);
  }
  if (!ended) throw new Error('fichier d’export incomplet');
  return head;
}

// chemin de mémoire relatif, sans sortie du dossier (fichier venu d'ailleurs)
const safeRel = r => {
  const s = String(r || '').replace(/\\/g, '/');
  if (!s || s.length > 300 || s.startsWith('/') || /^[a-z]:/i.test(s) || s.split('/').some(p => !p || p === '.' || p === '..')) return null;
  return s;
};

module.exports = function (ctx) {
  const { route, json, readBody, sessions, publicView, persist, broadcast, DATA, IS_WIN } = ctx;
  const home = os.homedir();
  const MEM = path.join(DATA, 'memory');
  const UPLOAD = path.join(DATA, 'transfer-import.csmx');
  const settings = () => ctx.getSettings?.() || {};
  const roots = () => parseRoots(settings().syncRoots, home, IS_WIN);
  const machine = () => String(settings().syncMachine || '').trim() || os.hostname();
  // dossier où Claude Code range les conversations d'un dossier de travail (même règle que lib/sync.js)
  const projectFile = (cwd, cid) => {
    let real = cwd; try { real = fs.realpathSync(cwd); } catch { }
    return path.join(home, '.claude', 'projects', real.replace(/[^a-zA-Z0-9]/g, '-'), `${cid}.jsonl`);
  };
  const memFiles = (dir = MEM, base = '') => {
    let out = [];
    let list = []; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { }
    for (const e of list) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) out = out.concat(memFiles(path.join(dir, e.name), rel));
      else if (e.isFile()) out.push(rel);
    }
    return out;
  };

  async function* exportRecords(opts, stats) {
    yield { h: { k: 'meta', machine: machine(), platform: process.platform, version: ctx.VERSION || '', exportedAt: Date.now() } };
    const list = [...sessions.values()].filter(s => !/^csm(cfg|tpl|ext|plug)-/.test(s.syncId || '')).sort((a, b) => (a.order || 0) - (b.order || 0));
    for (const s of list) {
      const d = { cwd: s.syncCwd || toPortable(s.cwd, roots()) };
      for (const k of FIELDS) if (s[k] !== undefined && s[k] !== null && s[k] !== '') d[k] = s[k];
      let data = null, mtime = 0;
      const cid = s.claudeSessionId && CID.test(s.claudeSessionId) ? s.claudeSessionId : '';
      // session verrouillée par mot de passe : sa conversation ne sort pas de l'app (à déverrouiller d'abord)
      if (s.lock && cid && opts.transcripts) stats.locked++;
      else if (cid && opts.transcripts) {
        // lue en flux par writeArchive (une conversation pèse vite des centaines de Mo) ; illisible : comptée
        const f = ctx.transcriptPath(cid);
        if (f) {
          let fd = null;
          try {
            fd = fs.openSync(f, 'r');
            const st = fs.fstatSync(fd);
            mtime = Math.round(st.mtimeMs);
            if (st.size > 0) { data = { fd, size: st.size, onShort: () => { stats.failed++; } }; fd = null; stats.transcripts++; }
          } catch (e) { if (e.code !== 'ENOENT') stats.failed++; } finally { if (fd !== null) fs.closeSync(fd); }
        }
      }
      stats.sessions++;
      // mtime : date de la conversation, rendue à l'import (sinon « maintenant » : elle passerait devant les autres)
      yield { h: { k: 'session', d: cleanMeta(d), cid, syncId: s.syncId || '', origin: s.origin || machine(), createdAt: s.createdAt || 0, lastActivity: s.lastActivity || 0, mtime }, data };
    }
    const groups = String(settings().groupList || '').split('\n').map(x => x.trim()).filter(Boolean);
    if (groups.length) yield { h: { k: 'groups', list: groups } };
    for (const t of ctx.getTemplates?.() || []) yield { h: { k: 'template', t: { ...t, cwd: t.cwd ? toPortable(t.cwd, roots()) : '' } } };
    for (const e of ctx.listSyncExtensions?.() || []) if (e.kind === 'imported') yield { h: { k: 'extension', ext: e.ext, enabled: e.enabled } };
    if (opts.memory !== false) for (const rel of memFiles()) {
      let data; try { data = fs.readFileSync(path.join(MEM, ...rel.split('/'))); } catch { stats.failed++; continue; }
      stats.memory++;
      yield { h: { k: 'memory', rel }, data };
    }
    yield { h: { k: 'end', sessions: stats.sessions } };
  }

  // ce qui existe déjà ici (même session = même identifiant de synchro ou même conversation)
  const sameHere = h => [...sessions.values()].find(s => (h.syncId && s.syncId === h.syncId) || (h.cid && s.claudeSessionId === h.cid));

  async function preview(file, password) {
    const r = { machine: '', platform: '', version: '', exportedAt: 0, sessions: [], groups: 0, templates: 0, extensions: 0, memory: 0, transcripts: 0 };
    await readArchive(file, password, h => {
      if (h.k === 'meta') Object.assign(r, { machine: String(h.machine || '').slice(0, 80), platform: String(h.platform || '').slice(0, 20), version: String(h.version || '').slice(0, 20), exportedAt: Number(h.exportedAt) || 0 });
      else if (h.k === 'session') {
        const d = cleanMeta(h.d), found = d.cwd ? fromPortable(d.cwd, roots(), IS_WIN) : null;
        r.sessions.push({ name: d.name || path.basename(found || d.cwd || '') || 'session', cwd: found || d.cwd, found: !!(found && fs.existsSync(found)), here: !!sameHere(h), conversation: h.len > 0, group: d.group || '' });
        if (h.len > 0) r.transcripts++;
      } else if (h.k === 'groups') r.groups = (h.list || []).length;
      else if (h.k === 'template') r.templates++;
      else if (h.k === 'extension') r.extensions++;
      else if (h.k === 'memory') r.memory++;
    }, false);
    return r;
  }

  async function importFile(file, password) {
    const res = { sessions: 0, skipped: 0, transcripts: 0, keptLocal: 0, groups: 0, templates: 0, extensions: 0, memory: 0, failed: 0, from: '' };
    // conversation reçue en flux dans un fichier temporaire, placée ensuite à côté des autres
    const IN = path.join(DATA, 'transfer-conv.csm-in');
    const keep = h => {
      if (h.k !== 'session' || !(Number(h.len) > 0)) return true;
      const fd = fs.openSync(IN, 'w', 0o600);
      let open = true;
      const close = () => { if (open) { open = false; fs.closeSync(fd); } };
      return {
        file: IN, close,
        write: b => { for (let o = 0; o < b.length;) o += fs.writeSync(fd, b, o, b.length - o); },
        abort: () => { try { close(); } catch { } fs.rmSync(IN, { force: true }); },
      };
    };
    const move = (from, to) => {
      try { fs.renameSync(from, to); } catch (e) { if (e.code !== 'EXDEV') throw e; fs.copyFileSync(from, to); fs.rmSync(from, { force: true }); }
    };
    const templates = [...(ctx.getTemplates?.() || [])];
    const exts = new Set((ctx.listSyncExtensions?.() || []).map(e => e.id));
    let tplChanged = false;
    try { await readArchive(file, password, (h, data) => {
      if (h.k === 'meta') { res.from = String(h.machine || '').slice(0, 80); return; }
      if (h.k === 'session') {
        const conv = data?.file ? data : null;
        const cid = CID.test(h.cid || '') ? h.cid : '';
        const syncId = UID.test(h.syncId || '') && !/^csm(cfg|tpl|ext|plug)-/.test(h.syncId) ? h.syncId : '';
        const d = cleanMeta(h.d);
        let s = sameHere({ cid, syncId });
        if (s) res.skipped++;
        else {
          const found = d.cwd ? fromPortable(d.cwd, roots(), IS_WIN) : null;
          const cwd = found && fs.existsSync(found) ? found : home;
          const from = res.from || 'une autre machine';
          const note = cwd === found ? '' : ` Dossier « ${d.cwd} » introuvable ici : ouverte dans le dossier personnel.`;
          const order = Math.max(0, ...[...sessions.values()].map(x => x.order || 0)) + 1;
          s = {
            id: crypto.randomBytes(6).toString('hex'), name: d.name || path.basename(cwd) || 'session', cwd, args: safeArgs(d.args || ''),
            claudeSessionId: cid || null, createdAt: Number(h.createdAt) || Date.now(), lastActivity: Number(h.lastActivity) || Date.now(),
            status: 'exited', message: `importée de ${from}`, statusSince: Date.now(), pty: null, order, wantRun: false, named: !!d.named,
            syncId: syncId || undefined, origin: String(h.origin || from).slice(0, 80), syncCwd: d.cwd || '',
            buf: `\x1b[90m[csm] Session importée depuis « ${from} ». « Reprendre » ${cid && conv ? 'continue sa conversation' : 'ouvre une nouvelle conversation'} dans ${cwd}.${note}\x1b[0m\r\n`,
          };
          for (const k of ['group', 'pinned', 'color', 'remote', 'type', 'paused']) if (d[k] !== undefined) s[k] = d[k];
          if (s.paused) s.message = 'en pause';
          sessions.set(s.id, s);
          res.sessions++;
        }
        // conversation : écrite si elle manque ici ; une conversation déjà présente n'est jamais remplacée
        if (cid && conv) {
          const existing = ctx.transcriptPath(cid);
          if (existing && fs.existsSync(existing)) res.keptLocal++;
          else {
            try {
              const f = projectFile(s.cwd, cid);
              fs.mkdirSync(path.dirname(f), { recursive: true });
              move(conv.file, f + '.csm-tmp'); fs.renameSync(f + '.csm-tmp', f);
              // sa date d'origine (sinon celle de l'import : plus récente que tout, elle l'emporterait à la synchro)
              const t = Number(h.mtime) || Number(h.lastActivity) || 0;
              if (t > 0) fs.utimesSync(f, new Date(t), new Date(t));
              res.transcripts++;
            } catch { res.failed++; }
          }
        }
        if (conv) fs.rmSync(conv.file, { force: true });
        broadcast({ t: 'session', s: publicView(s) });
      } else if (h.k === 'groups') {
        const cur = String(settings().groupList || '').split('\n').map(x => x.trim()).filter(Boolean);
        const add = (Array.isArray(h.list) ? h.list : []).map(x => String(x).trim().slice(0, 60)).filter(x => x && !cur.includes(x));
        if (add.length) { ctx.patchSettings?.({ groupList: [...cur, ...add].join('\n').slice(0, 4000) }); res.groups = add.length; }
      } else if (h.k === 'template') {
        const t = h.t && typeof h.t === 'object' ? h.t : null;
        if (!t || !t.id || templates.some(x => x.id === t.id)) return;
        const found = typeof t.cwd === 'string' && t.cwd ? fromPortable(t.cwd, roots(), IS_WIN) : '';
        templates.push({ ...t, cwd: found || '', extra: safeArgs(t.extra) });
        tplChanged = true; res.templates++;
      } else if (h.k === 'extension') {
        const id = h.ext?.id;
        if (!id || exts.has(id)) return;
        try { ctx.putExtension?.(h.ext, h.enabled !== false, `export de ${res.from || 'une autre machine'}`); exts.add(id); res.extensions++; } catch { } // fichier invalide : ignoré
      } else if (h.k === 'memory') {
        const rel = safeRel(h.rel);
        if (!rel || !data) return;
        const f = path.join(MEM, ...rel.split('/'));
        if (fs.existsSync(f)) return; // mémoire d'ici gardée
        try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); res.memory++; } catch { res.failed++; }
      }
    }, keep); } finally { fs.rmSync(IN, { force: true }); }
    if (tplChanged) ctx.setTemplates?.(templates);
    persist();
    return res;
  }

  // ---------------------------------------------------------------- routes
  const defaultName = () => `claude-sessions-${machine().replace(/[^\w.-]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.csmx`;
  route('GET', /^\/api\/transfer\/default$/, async ({ res }) => {
    const dl = path.join(home, 'Downloads');
    json(res, 200, { path: path.join(fs.existsSync(dl) ? dl : home, defaultName()), name: defaultName() });
  });
  let busy = false;
  route('POST', /^\/api\/transfer\/export$/, async ({ req, res }) => {
    const b = await readBody(req);
    let file = String(b.path || '').trim();
    if (!file) { const dl = path.join(home, 'Downloads'); file = path.join(fs.existsSync(dl) ? dl : home, defaultName()); }
    if (!path.isAbsolute(file)) return json(res, 400, { error: 'chemin absolu attendu' });
    if (!/\.csmx$/i.test(file)) file += '.csmx';
    if (!fs.existsSync(path.dirname(file))) return json(res, 400, { error: 'dossier introuvable' });
    if (busy) return json(res, 409, { error: 'un export ou un import est déjà en cours' });
    busy = true;
    const stats = { sessions: 0, transcripts: 0, memory: 0, locked: 0, failed: 0 };
    try {
      const size = await writeArchive(file, b.password ? String(b.password) : '', exportRecords({ transcripts: b.transcripts !== false, memory: b.memory !== false }, stats));
      json(res, 200, { path: file, size, ...stats, encrypted: !!b.password });
    } catch (e) { json(res, 500, { error: e.message }); } finally { busy = false; }
  });
  // fichier choisi dans la page : reçu en flux, gardé le temps de l'aperçu et de l'import
  route('POST', /^\/api\/transfer\/upload$/, async ({ req, res }) => {
    if (busy) return json(res, 409, { error: 'un export ou un import est déjà en cours' });
    let n = 0;
    const out = fs.createWriteStream(UPLOAD + '.part', { mode: 0o600 });
    try {
      await pipeline(req, async function* (src) { for await (const c of src) { n += c.length; if (n > MAX_UPLOAD) throw new Error('fichier trop gros'); yield c; } }, out);
      fs.renameSync(UPLOAD + '.part', UPLOAD);
      json(res, 200, { size: n });
    } catch (e) { fs.rmSync(UPLOAD + '.part', { force: true }); json(res, 400, { error: e.message }); }
  });
  route('POST', /^\/api\/transfer\/preview$/, async ({ req, res }) => {
    const b = await readBody(req);
    if (!fs.existsSync(UPLOAD)) return json(res, 404, { error: 'aucun fichier reçu' });
    try { json(res, 200, await preview(UPLOAD, b.password ? String(b.password) : '')); }
    catch (e) { json(res, e.code === 'PASSWORD' ? 401 : 400, { error: e.message, password: e.code === 'PASSWORD' }); }
  });
  route('POST', /^\/api\/transfer\/import$/, async ({ req, res }) => {
    const b = await readBody(req);
    if (!fs.existsSync(UPLOAD)) return json(res, 404, { error: 'aucun fichier reçu' });
    if (busy) return json(res, 409, { error: 'un export ou un import est déjà en cours' });
    busy = true;
    try {
      // vérifié en entier (mot de passe, fichier complet) avant d'écrire quoi que ce soit
      await preview(UPLOAD, b.password ? String(b.password) : '');
      const r = await importFile(UPLOAD, b.password ? String(b.password) : '');
      fs.rmSync(UPLOAD, { force: true });
      json(res, 200, r);
    } catch (e) { json(res, 400, { error: e.message }); } finally { busy = false; }
  });
  route('DELETE', /^\/api\/transfer\/upload$/, async ({ res }) => { fs.rmSync(UPLOAD, { force: true }); json(res, 200, {}); });
};

module.exports.writeArchive = writeArchive;
module.exports.readArchive = readArchive;
