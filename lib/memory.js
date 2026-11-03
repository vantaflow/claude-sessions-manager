'use strict';
// Mémoire native des sessions (sans claude-mem) : à chaque fin de tour (hook Stop / SessionEnd), le transcript
// de la session est relu depuis là où on s'était arrêté et résumé dans une fiche : première demande, demandes
// suivantes, dernière réponse de chaque tour, fichiers modifiés, outils utilisés. Les fiches sont gardées dans
// DATA/memory/sessions/<id>.json et rassemblées par dossier dans DATA/memory/projects/*.md (lisibles et
// cherchables). Au démarrage d'une session (hook SessionStart), les fiches récentes du même dossier sont
// données à Claude comme contexte. Avec un code de synchro, les fiches sont partagées chiffrées entre les
// machines (lib/sync.js, préfixe « nm- ») : le dossier est comparé sous sa forme portable ({home}/…).
//
// Réglages : memoryEngine = native (capture + contexte), syncSessionMemory (partage par la synchro).
// Réglages › Mémoire (routes /api/memory*) : chercher, renommer une fiche, ajouter une note « À retenir »
// (donnée à Claude en premier), supprimer une demande ou une réponse, oublier une fiche (forgotten : plus
// jamais donnée à Claude ni recréée, partagé par la synchro) ; notes de Claude Code (~/.claude/projects/*/memory)
// lues, modifiées, supprimées (copie avant) ; claude-mem : recherche en lecture seule.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_PROMPTS = 40, MAX_ANSWERS = 12, MAX_FILES = 80;
const PROMPT_LEN = 600, ANSWER_LEN = 1500;
const CONTEXT_BUDGET = 9000, CONTEXT_SESSIONS = 6, OTHER_PROJECTS = 5;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const ID = /^[\w-]{6,60}$/;

const clip = (s, n) => { s = String(s || '').replace(/\s+\n/g, '\n').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(p => p && p.type === 'text').map(p => p.text).join('\n') : '';
// Messages « utilisateur » qui n'en sont pas : sorties de commandes, rappels système, interruptions.
const noise = t => !t || /^\s*<(command-|local-command|system-reminder|bash-|user-memory|task-notification)/.test(t) || /^\[Request interrupted/.test(t);

function blank(id) {
  return { v: 1, id, title: '', project: '', cwd: '', machine: '', branch: '', created: 0, updated: 0, first: '', prompts: [], answers: [], last: '', files: [], tools: {} };
}

// Ajoute à la fiche les lignes (objets JSON du transcript) lues depuis la dernière fois.
function digest(e, lines) {
  for (const o of lines) {
    if (!o || typeof o !== 'object') continue;
    const ts = Date.parse(o.timestamp) || 0;
    if (o.type === 'ai-title' || o.type === 'custom-title' || o.type === 'summary') {
      const t = o.customTitle || o.aiTitle || o.title || (o.type === 'summary' && o.summary);
      if (t && (o.type === 'custom-title' || !e.titleFixed)) { e.title = clip(t, 120); if (o.type === 'custom-title') e.titleFixed = true; }
      continue;
    }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (o.isSidechain) continue; // sous-agents
    if (ts) { e.created = e.created || ts; e.updated = Math.max(e.updated, ts); }
    if (o.cwd) e.cwd = o.cwd;
    if (o.gitBranch) e.branch = o.gitBranch;
    const c = o.message && o.message.content;
    if (o.type === 'user') {
      if (o.isMeta || o.isCompactSummary || o.toolUseResult) continue;
      const t = textOf(c);
      if (noise(t)) continue;
      if (e.last) { e.answers.push(e.last); e.last = ''; }
      const p = clip(t, PROMPT_LEN);
      if (!e.first) e.first = p;
      e.prompts.push({ t: ts, text: p });
    } else {
      for (const part of Array.isArray(c) ? c : []) {
        if (part.type === 'text' && part.text && part.text.trim()) e.last = clip(part.text, ANSWER_LEN);
        else if (part.type === 'tool_use' && part.name) {
          e.tools[part.name] = (e.tools[part.name] || 0) + 1;
          const f = part.input && (part.input.file_path || part.input.notebook_path);
          if (EDIT_TOOLS.has(part.name) && f && !e.files.includes(f)) e.files.push(f);
        }
      }
    }
  }
  if (e.prompts.length > MAX_PROMPTS) e.prompts = e.prompts.slice(-MAX_PROMPTS);
  if (e.answers.length > MAX_ANSWERS) e.answers = e.answers.slice(-MAX_ANSWERS);
  if (e.files.length > MAX_FILES) e.files = e.files.slice(-MAX_FILES);
  return e;
}

// Lit le transcript à partir de l'octet off ; renvoie les lignes complètes et le nouvel offset.
function readFrom(file, off) {
  const size = fs.statSync(file).size;
  if (size < off) return null; // transcript réécrit : tout relire
  if (size === off) return { lines: [], off };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - off);
    fs.readSync(fd, buf, 0, buf.length, off);
    const end = buf.lastIndexOf(10);
    if (end < 0) return { lines: [], off };
    const lines = [];
    for (const l of buf.subarray(0, end).toString('utf8').split('\n')) { if (l) try { lines.push(JSON.parse(l)); } catch { } }
    return { lines, off: off + end + 1 };
  } finally { fs.closeSync(fd); }
}

const rel = (f, cwd) => cwd && f.startsWith(cwd + path.sep) ? f.slice(cwd.length + 1) : f;
const day = t => t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : '?';
const titleOf = e => e.title || clip(e.first, 80) || e.id.slice(0, 8);

function section(e, full) {
  const out = [`## ${titleOf(e)} — ${day(e.updated)} · ${e.machine || '?'}${e.branch ? ' · ' + e.branch : ''}`];
  if (full && e.note) out.push(`À retenir : ${e.note}`);
  if (e.first) out.push(`Demande : ${full ? e.first : clip(e.first, 300)}`);
  const later = e.prompts.slice(1).slice(full ? 0 : -3);
  if (later.length) out.push((full ? 'Demandes suivantes :' : 'Dernières demandes :') + '\n' + later.map(p => '- ' + (full ? p.text : clip(p.text, 200))).join('\n'));
  const answers = [...e.answers, e.last].filter(Boolean);
  if (full && answers.length > 1) out.push('Réponses (fin de tour) :\n' + answers.slice(0, -1).map(a => '- ' + clip(a, 400).replace(/\n+/g, ' ')).join('\n'));
  // dernière réponse qui n'est qu'un message d'erreur (API surchargée, interruption) : pas présentée comme un état
  const lastAnswer = answers[answers.length - 1];
  if (lastAnswer && !BAD_ANSWER.test(lastAnswer)) out.push(`Où on en est : ${full ? lastAnswer : clip(lastAnswer, 700)}`);
  if (e.files.length) out.push(`Fichiers modifiés : ${e.files.slice(full ? 0 : -15).map(f => rel(f, e.cwd)).join(', ')}`);
  if (full) out.push(`Session : ${e.id}`);
  return out.join('\n');
}

const BAD_ANSWER = /^\s*(API Error|Error:|\[?Request interrupted)/i;
const sameProject = (a, b, isWin) => !!a && !!b && (isWin ? a.toLowerCase() === b.toLowerCase() : a === b);
const slug = p => (String(p || 'sans-dossier').replace(/^\{(\w+)\}/, '$1').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'racine').slice(-100);

// Contexte donné à Claude au démarrage : sessions récentes du même dossier, puis autres dossiers récents.
// Avec des fiches de la mémoire IA (lib/memai) pour ce dossier : forme courte (aiContext).
function buildContext(entries, project, { exclude, dir, isWin, ai = [] } = {}) {
  entries = entries.filter(e => !e.forgotten);
  const aiMine = ai.filter(e => !e.forgotten && e.summary && e.id !== exclude && sameProject(e.project, project, isWin));
  if (aiMine.length) return aiContext(entries, aiMine, project, { exclude, isWin });
  const mine = entries.filter(e => e.id !== exclude && sameProject(e.project, project, isWin) && (e.first || e.last)).sort((a, b) => b.updated - a.updated);
  // notes « À retenir » du dossier : toujours données, en premier
  const notes = entries.filter(e => e.note && sameProject(e.project, project, isWin)).sort((a, b) => b.updated - a.updated);
  const others = new Map();
  for (const e of entries.slice().sort((a, b) => b.updated - a.updated)) {
    if (e.id === exclude || sameProject(e.project, project, isWin) || !e.project || others.has(e.project)) continue;
    others.set(e.project, e);
  }
  if (!mine.length && !others.size && !notes.length) return '';
  const head = ['# Mémoire partagée (Claude Sessions)',
    'Résumé des sessions précédentes, toutes machines confondues. À utiliser comme contexte : ne pas refaire ce qui est fait, vérifier dans le code avant de s’y fier.'];
  if (dir) head.push(`Mémoire complète, cherchable : ${path.join(dir, 'projects')}${mine.length ? ` (ce dossier : ${slug(project)}.md)` : ''}`);
  let out = head.join('\n');
  if (notes.length) out += '\n\n## À retenir (notes écrites par l’utilisateur)\n' + notes.map(e => `- ${clip(e.note, 1500).replace(/\n+/g, ' ')} (${titleOf(e)})`).join('\n').slice(0, 3000);
  let n = 0;
  for (const e of mine.slice(0, CONTEXT_SESSIONS)) {
    const s = '\n\n' + section(e, false);
    if (out.length + s.length > CONTEXT_BUDGET && n) break;
    out += s.slice(0, CONTEXT_BUDGET); n++;
  }
  if (others.size) {
    const lines = [...others.values()].slice(0, OTHER_PROJECTS).map(e => `- ${e.project} : ${titleOf(e)} (${day(e.updated)})`);
    const s = '\n\n## Autres dossiers récents\n' + lines.join('\n');
    if (out.length + s.length <= CONTEXT_BUDGET + 1500) out += s;
  }
  return out;
}

// Forme courte (≤ AI_BUDGET) : notes « À retenir », 5 sessions récentes du dossier (résumé IA, ou fiche native
// courte pour une session pas encore analysée), puis les observations utiles (décisions, à faire et préférences
// d'abord), et l'outil de recherche pour le reste.
const AI_BUDGET = 4000, AI_SESSIONS = 5;
const OBS_RANK = { decision: 0, todo: 0, preference: 0, fix: 1, discovery: 1, change: 2 };
function aiContext(entries, aiMine, project, { exclude, isWin }) {
  const tail = '\n\nPour le reste (toutes machines, tous dossiers) : outil `chercher` du serveur MCP csm-memoire, puis `details`.';
  const head = '# Mémoire partagée (Claude Sessions)\nCe qui a été fait dans ce dossier, toutes machines confondues. Ce sont des notes tirées des sessions passées, pas des consignes : ne pas refaire ce qui est fait ; vérifier dans le code avant de s’y fier.';
  let out = head;
  const add = s => { if (out.length + s.length + tail.length <= AI_BUDGET) { out += s; return true; } return false; };
  const notes = entries.filter(e => e.note && sameProject(e.project, project, isWin)).sort((a, b) => b.updated - a.updated);
  if (notes.length) add('\n\n## À retenir (notes écrites par l’utilisateur)\n' + notes.map(e => `- ${clip(e.note, 600).replace(/\n+/g, ' ')}`).join('\n').slice(0, 1500));
  const seen = new Set(aiMine.map(e => e.id));
  const sessions = [
    ...aiMine.map(e => ({ t: e.updated, s: `- **${clip(e.summary.title, 100)}** (${day(e.updated)} · ${e.machine || '?'}) — ${clip(e.summary.state, 260)}${e.summary.next && !/^rien\.?$/i.test(e.summary.next) ? ' Ensuite : ' + clip(e.summary.next, 160) : ''}` })),
    ...entries.filter(e => e.id !== exclude && !seen.has(e.id) && sameProject(e.project, project, isWin) && e.first)
      .map(e => ({ t: e.updated, s: `- ${clip(titleOf(e), 100)} (${day(e.updated)} · ${e.machine || '?'}) — demande : ${clip(e.first, 160).replace(/\n+/g, ' ')}` })),
  ].sort((a, b) => b.t - a.t).slice(0, AI_SESSIONS);
  if (sessions.length) { add('\n\n## Sessions récentes'); for (const x of sessions) if (!add('\n' + x.s.replace(/\n+/g, ' '))) break; }
  const obs = aiMine.flatMap(e => (e.obs || []).map(o => ({ ...o, t: o.createdAt || e.updated })))
    .sort((a, b) => (OBS_RANK[a.type] ?? 3) - (OBS_RANK[b.type] ?? 3) || b.t - a.t);
  if (obs.length && add('\n\n## À savoir')) for (const o of obs) if (!add(`\n- [${o.type}] ${clip(o.title, 80)} : ${clip(o.body, 220).replace(/\n+/g, ' ')}`)) break;
  return out + tail;
}

function renderProject(project, entries) {
  entries = entries.filter(e => !e.forgotten);
  return `# Mémoire — ${project || 'sans dossier'}\n\n` + entries.slice().sort((a, b) => b.updated - a.updated).map(e => section(e, true)).join('\n\n---\n\n') + '\n';
}

// Demandes et réponses retirées à la main (Réglages › Mémoire) : jamais remises par une relecture du transcript.
const hash = t => require('crypto').createHash('sha1').update(String(t)).digest('hex').slice(0, 12);
function applyDrop(e) {
  const d = e.drop;
  if (!d) return e;
  const P = new Set(d.p || []), A = new Set(d.a || []);
  e.prompts = e.prompts.filter(p => !P.has(hash(p.text)));
  if (e.first && P.has(hash(e.first))) e.first = e.prompts[0]?.text || '';
  e.answers = e.answers.filter(a => !A.has(hash(a)));
  if (e.last && A.has(hash(e.last))) e.last = '';
  return e;
}

// Fiche telle qu'elle est partagée (sans les champs propres à cette machine).
const shared = e => { const { off, file, ...rest } = e; return rest; };
function valid(e) {
  return !!e && typeof e === 'object' && e.v === 1 && ID.test(e.id || '') && Array.isArray(e.prompts) && Array.isArray(e.answers) &&
    Array.isArray(e.files) && e.tools && typeof e.tools === 'object' && Number.isFinite(e.updated);
}

module.exports = function (ctx) {
  const { route, json, readBody, sessions, transcriptPath, DATA, IS_WIN } = ctx;
  const dir = path.join(DATA, 'memory'), sdir = path.join(dir, 'sessions'), pdir = path.join(dir, 'projects');
  fs.mkdirSync(sdir, { recursive: true }); fs.mkdirSync(pdir, { recursive: true });
  const settings = () => ctx.getSettings?.() || {};
  const on = () => (settings().memoryEngine || 'native') === 'native';
  const machine = () => String(settings().syncMachine || '').trim() || os.hostname();
  const { parseRoots, toPortable } = require('./sync');
  // chemin réel (un même dossier atteint par un lien, ex. /var → /private/var sur macOS, est le même projet)
  const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
  const portable = cwd => {
    const roots = parseRoots(settings().syncRoots, os.homedir(), IS_WIN), raw = toPortable(cwd, roots);
    if (!cwd || /^\{/.test(raw)) return raw; // déjà traduit ({home}/…) : gardé tel quel
    return toPortable(real(cwd), roots);
  };

  ctx.memoryPortable = portable; // dossier sous sa forme portable ({home}/…), aussi pour lib/memai
  const cache = new Map();
  for (const f of fs.readdirSync(sdir)) {
    if (!f.endsWith('.json')) continue;
    try { const e = JSON.parse(fs.readFileSync(path.join(sdir, f), 'utf8')); if (valid(e)) cache.set(e.id, e); } catch { }
  }
  const save = e => {
    cache.set(e.id, e);
    const tmp = path.join(sdir, e.id + '.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(e), { mode: 0o600 });
    fs.renameSync(tmp, path.join(sdir, e.id + '.json'));
    dirty.add(e.project);
    clearTimeout(renderTimer); renderTimer = setTimeout(render, 500);
  };
  const dirty = new Set();
  let renderTimer = null;
  function render() {
    for (const p of dirty) {
      const list = [...cache.values()].filter(e => !e.forgotten && sameProject(e.project, p, IS_WIN));
      const f = path.join(pdir, slug(p) + '.md');
      try { list.length ? fs.writeFileSync(f, renderProject(p, list), { mode: 0o600 }) : fs.rmSync(f, { force: true }); } catch { }
    }
    dirty.clear();
  }

  function capture(id) {
    if (!on() || !ID.test(id || '')) return;
    const file = transcriptPath(id);
    if (!file) return;
    let e = cache.get(id);
    if (e?.forgotten) return; // oubliée : jamais recréée
    e = e ? { ...e } : blank(id);
    let r = e.file === file && Number.isInteger(e.off) ? readFrom(file, e.off) : null;
    if (!r) { // première lecture, ou fiche reçue d'une autre machine : on repart du transcript entier
      e = { ...blank(id), title: e.title, titleFixed: e.titleFixed, created: e.created, note: e.note, drop: e.drop };
      r = readFrom(file, 0);
    }
    if (!r.lines.length && e.off === r.off) return;
    const before = e.project;
    digest(e, r.lines);
    applyDrop(e);
    e.off = r.off; e.file = file;
    e.project = portable(e.cwd); e.machine = machine();
    if (before && before !== e.project) dirty.add(before);
    save(e);
  }
  const timers = new Map();
  const later = (id, ms = 1500) => { clearTimeout(timers.get(id)); timers.set(id, setTimeout(() => { timers.delete(id); try { capture(id); } catch (e) { console.error('mémoire', e.message); } }, ms)); };
  ctx.on('idle', s => s.claudeSessionId && later(s.claudeSessionId));
  ctx.on('end', s => s.claudeSessionId && later(s.claudeSessionId, 300));
  ctx.on('exit', s => s.claudeSessionId && later(s.claudeSessionId, 300));

  // Contexte injecté par le hook SessionStart (voir hook.js).
  ctx.memoryContext = (s, claudeId) => {
    if (!on() || !s.cwd) return '';
    try { return buildContext([...cache.values()], portable(s.cwd), { exclude: claudeId, dir, isWin: IS_WIN, ai: ctx.memai?.on() ? ctx.memai.list() : [] }); } catch { return ''; }
  };

  // Pour lib/sync.js
  ctx.memory = {
    on, list: () => [...cache.values()], shared,
    // tout de suite (mise en pause) : fiche à jour avant la synchro
    captureNow: id => { clearTimeout(timers.get(id)); timers.delete(id); try { capture(id); return true; } catch (e) { console.error('mémoire', e.message); return false; } },
    get: id => cache.get(id),
    // fiche reçue : gardée si plus récente ; l'offset local est oublié (la prochaine capture relit tout)
    put(e) {
      if (!valid(e)) return false;
      const cur = cache.get(e.id);
      if (cur && cur.updated >= e.updated) return false;
      if (cur && cur.project !== e.project) dirty.add(cur.project);
      save({ ...e });
      return true;
    },
  };

  route('GET', /^\/api\/memory$/, async ({ res }) => json(res, 200, {
    enabled: on(), dir, items: [...cache.values()].sort((a, b) => b.updated - a.updated).slice(0, 500)
      .map(e => ({ id: e.id, title: titleOf(e), project: e.project, machine: e.machine, updated: e.updated, first: clip(e.first, 200), last: clip(e.last, 300), prompts: e.prompts.length, files: e.files.length })),
  }));

  // ---------------------------------------------------------------- Réglages › Mémoire
  const hay = e => [e.title, e.note, e.first, e.last, ...e.prompts.map(p => p.text), ...e.answers, ...e.files, e.project, e.machine].join('\n').toLowerCase();
  route('GET', /^\/api\/memory\/cards$/, async ({ req, res }) => {
    const u = new URL(req.url, 'http://x'), q = (u.searchParams.get('q') || '').toLowerCase().trim();
    const project = u.searchParams.get('project') || '', mach = u.searchParams.get('machine') || '';
    const words = q.split(/\s+/).filter(Boolean);
    const all = [...cache.values()].filter(e => !e.forgotten);
    const items = all.filter(e => (!project || e.project === project) && (!mach || e.machine === mach) && (!words.length || words.every(w => hay(e).includes(w))))
      .sort((a, b) => b.updated - a.updated).slice(0, 300)
      .map(e => ({ id: e.id, title: titleOf(e), note: e.note || '', project: e.project, machine: e.machine, updated: e.updated, first: clip(e.first, 200), last: clip(e.last, 300), prompts: e.prompts.length, files: e.files.length }));
    json(res, 200, { enabled: on(), items, projects: [...new Set(all.map(e => e.project).filter(Boolean))].sort(), machines: [...new Set(all.map(e => e.machine).filter(Boolean))].sort(), here: machine() });
  });
  route('GET', /^\/api\/memory\/cards\/([\w-]{6,60})$/, async ({ res, m }) => {
    const e = cache.get(m[1]);
    if (!e || e.forgotten) return json(res, 404, { error: 'fiche inconnue' });
    json(res, 200, { id: e.id, title: titleOf(e), note: e.note || '', project: e.project, machine: e.machine, branch: e.branch, created: e.created, updated: e.updated,
      prompts: e.prompts.map(p => ({ t: p.t, text: p.text })), answers: [...e.answers, ...(e.last ? [e.last] : [])], files: e.files });
  });
  // corrections : { title?, note?, dropPrompt?: texte, dropAnswer?: texte, forget?: true } ; la fiche devient la plus
  // récente (elle repart vers les autres machines)
  route('PATCH', /^\/api\/memory\/cards\/([\w-]{6,60})$/, async ({ req, res, m }) => {
    const cur = cache.get(m[1]);
    if (!cur || cur.forgotten) return json(res, 404, { error: 'fiche inconnue' });
    const b = await readBody(req) || {}, e = { ...cur, drop: { p: [...(cur.drop?.p || [])], a: [...(cur.drop?.a || [])] } };
    if (typeof b.title === 'string') { e.title = clip(b.title, 120); e.titleFixed = true; }
    if (typeof b.note === 'string') e.note = clip(b.note, 4000);
    if (typeof b.dropPrompt === 'string') e.drop.p.push(hash(b.dropPrompt));
    if (typeof b.dropAnswer === 'string') e.drop.a.push(hash(b.dropAnswer));
    e.drop.p = e.drop.p.slice(-200); e.drop.a = e.drop.a.slice(-200);
    applyDrop(e);
    if (b.forget === true) Object.assign(e, { forgotten: true, prompts: [], answers: [], files: [], first: '', last: '', note: '', title: '' });
    e.updated = Math.max(Date.now(), (cur.updated || 0) + 1);
    if (cur.project) dirty.add(cur.project);
    save(e);
    json(res, 200, { ok: true });
  });

  // notes de Claude Code : ~/.claude/projects/<home encodé>*/memory/**.md (chemin portable comme pour la synchro)
  const claudesync = require('./claudesync');
  function notesList() {
    const { files } = claudesync.scan(k => k === 'memory');
    return [...files.entries()].filter(([p]) => /\.md$/i.test(p)).map(([p, f]) => ({ p, project: p.split('/')[1].replace(/^~/, '{home}').replace(/-/g, '/'), size: f.data.length, mtime: f.mtime, text: f.data.toString('utf8') }));
  }
  const noteBackup = (p, abs) => {
    try {
      const to = path.join(DATA, 'claude-sync-backup', new Date().toISOString().replace(/[:.]/g, '-') + '-edit', ...p.split('/'));
      fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(abs, to); return true;
    } catch { return false; }
  };
  route('GET', /^\/api\/memory\/notes$/, async ({ req, res }) => {
    const q = (new URL(req.url, 'http://x').searchParams.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
    json(res, 200, notesList().filter(n => q.every(w => (n.p + '\n' + n.text).toLowerCase().includes(w))).sort((a, b) => b.mtime - a.mtime).slice(0, 300));
  });
  route('PUT', /^\/api\/memory\/notes$/, async ({ req, res }) => {
    const b = await readBody(req) || {};
    const abs = claudesync.toLocal(String(b.p || ''));
    if (!abs || !/\.md$/i.test(abs) || !/^projects\/~[^/]*\/memory\//.test(b.p) || !claudesync.writable(abs)) return json(res, 400, { error: 'chemin refusé' });
    if (!fs.existsSync(abs)) return json(res, 404, { error: 'note introuvable' });
    if (!noteBackup(b.p, abs)) return json(res, 500, { error: 'copie impossible' });
    if (b.delete === true) fs.rmSync(abs, { force: true });
    else { fs.writeFileSync(abs + '.csm-tmp', String(b.text ?? '').slice(0, 2 * 1024 * 1024)); fs.renameSync(abs + '.csm-tmp', abs); }
    json(res, 200, { ok: true });
  });

  // claude-mem (mémoire de l'app, s'il est choisi) : recherche en lecture seule
  route('GET', /^\/api\/memory\/claude-mem$/, async ({ req, res }) => {
    const q = (new URL(req.url, 'http://x').searchParams.get('q') || '').trim();
    let M = null;
    try { M = require('./memsync').open(DATA); } catch (e) { return json(res, 200, { available: false, error: e.message, items: [] }); }
    if (!M) return json(res, 200, { available: false, items: [] });
    try {
      const like = '%' + q.replace(/[%_]/g, c => '\\' + c) + '%';
      const has = c => M.cols.observations.includes(c);
      const fields = ['title', 'narrative', 'text'].filter(has);
      const rows = M.db.prepare(`SELECT id, project, type, ${fields.join(', ')}, created_at_epoch AS at FROM observations
        ${q ? `WHERE ${fields.map(f => `${f} LIKE ? ESCAPE '\\'`).join(' OR ')}` : ''} ORDER BY created_at_epoch DESC LIMIT 200`).all(...(q ? fields.map(() => like) : []));
      json(res, 200, { available: true, items: rows.map(r => ({ id: Number(r.id), project: r.project, type: r.type, title: clip(r.title, 160), text: clip(r.narrative || r.text, 600), at: Number(r.at) })) });
    } finally { M.db.close(); }
  });

  // Rattrapage : sessions de l'app déjà utilisées sans fiche (première version, ou mémoire réactivée).
  setTimeout(() => {
    let n = 0;
    for (const s of sessions.values()) if (s.claudeSessionId && !cache.has(s.claudeSessionId)) later(s.claudeSessionId, 3000 + 400 * n++);
  }, 2000).unref?.();
};

module.exports.digest = digest;
module.exports.noise = noise;
module.exports.textOf = textOf;
module.exports.blank = blank;
module.exports.buildContext = buildContext;
module.exports.renderProject = renderProject;
module.exports.slug = slug;
module.exports.valid = valid;
