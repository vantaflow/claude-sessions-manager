'use strict';
// Mémoire IA des sessions : à la fin d'une session lancée par l'app (SessionEnd, arrêt de claude, ou session
// inactive depuis CSM_MEMAI_IDLE après sa dernière réponse), la partie nouvelle du transcript est réduite
// (reduce.js) puis donnée à Haiku (`claude -p`, abonnement de l'utilisateur), qui écrit un résumé fiable et des
// observations typées (prompt.js), gardés dans DATA/memory/ai (store.js) et partagés chiffrés par la synchro.
//
// Sobriété : une analyse à la fois ; sessions triviales ignorées ; reportée si le quota est presque atteint ;
// après 3 échecs d'affilée (ou claude introuvable), suspendue jusqu'au redémarrage ou « Analyser maintenant ».
// Pas de boucle : claude est lancé sans CSM_ID (le hook ne fait rien), sans hooks, sans plugins ni outils, dans
// un dossier à part, sans conversation enregistrée (--no-session-persistence).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { reduce, usefulExchanges } = require('./reduce');
const { SCHEMA, PROMPT_VERSION, buildPrompt, clean } = require('./prompt');
const storeLib = require('./store');

const IDLE = () => Number(process.env.CSM_MEMAI_IDLE) || 25 * 60e3;
const END_DELAY = () => Number(process.env.CSM_MEMAI_END_DELAY) || 5000;
const MAX_INPUT = () => Number(process.env.CSM_MEMAI_MAX_INPUT) || 60000;
const RUN_TIMEOUT = () => Number(process.env.CSM_MEMAI_TIMEOUT) || 180e3;
const QUOTA_RETRY = () => Number(process.env.CSM_MEMAI_QUOTA_RETRY) || 15 * 60e3;
const MAX_FAILS = 3, QUOTA_LIMIT = 90;
const ID = /^[\w-]{6,60}$/;

// lignes complètes du transcript à partir de l'octet off, avec l'octet de fin de chacune
function readLines(file, off) {
  const size = fs.statSync(file).size;
  if (size < off) off = 0; // transcript réécrit : tout relire
  if (size === off) return { lines: [], off };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - off);
    fs.readSync(fd, buf, 0, buf.length, off);
    const lines = []; let start = 0;
    for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, start)) {
      const raw = buf.subarray(start, i).toString('utf8'); start = i + 1;
      if (!raw) continue;
      try { lines.push({ o: JSON.parse(raw), end: off + start }); } catch { }
    }
    return { lines, off };
  } finally { fs.closeSync(fd); }
}

module.exports = function (ctx) {
  const { route, json, readBody, DATA } = ctx;
  const dir = path.join(DATA, 'memory', 'ai'), runDir = path.join(DATA, 'memory', 'ai-run'), stateFile = path.join(DATA, 'memory', 'ai-state.json');
  fs.mkdirSync(runDir, { recursive: true });
  const store = storeLib.open(dir);
  const settings = () => ctx.getSettings?.() || {};
  const on = () => settings().memoryAI !== false;
  const machine = () => String(settings().syncMachine || '').trim() || os.hostname();

  // état local (jamais synchronisé) : avancement par conversation, échecs, analyses en attente
  let state = { off: {}, pending: [] };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch { }
  const status = { running: '', fails: 0, suspended: false, lastError: '', done: 0, last: 0 };
  const saveState = () => { try { fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state), { mode: 0o600 }); fs.renameSync(stateFile + '.tmp', stateFile); } catch { } };

  const timers = new Map();
  const queue = [];
  function schedule(cid, ms) {
    if (!on() || !ID.test(cid || '')) return;
    clearTimeout(timers.get(cid));
    timers.set(cid, setTimeout(() => { timers.delete(cid); enqueue(cid); }, ms));
  }
  function enqueue(cid) {
    if (!queue.includes(cid)) queue.push(cid);
    if (!state.pending.includes(cid)) { state.pending.push(cid); saveState(); }
    pump();
  }
  const done = cid => { state.pending = state.pending.filter(x => x !== cid); saveState(); };

  async function pump() {
    if (status.running || !queue.length) return;
    const cid = queue.shift();
    status.running = cid;
    let again = false;
    try { again = await analyze(cid); } catch (e) { fail(e); } finally { status.running = ''; }
    if (again) setTimeout(() => enqueue(cid), 1000).unref?.();
    setImmediate(pump);
  }
  function fail(e) {
    status.fails++; status.lastError = String(e && e.message || e).slice(0, 300);
    if (status.fails >= MAX_FAILS || e?.code === 'ENOENT') status.suspended = true;
    console.error('mémoire IA :', status.lastError);
  }
  const quotaFull = () => { const Q = ctx.quota || {}; return (Q.blockedUntil || 0) > Date.now() || (Number.isFinite(Q.pct) && Q.pct >= QUOTA_LIMIT); };

  function runClaude(prompt) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      for (const k of Object.keys(env)) if (/^(CSM_ID|CSM_PORT|CSM_TOKEN|CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID$|AI_AGENT$|ELECTRON_RUN_AS_NODE$)/i.test(k)) delete env[k];
      const args = [...ctx.splitArgs(process.env.CSM_CLAUDE_ARGS || ''), '-p', '--model', process.env.CSM_MEMAI_MODEL || 'haiku',
        '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA), '--no-session-persistence', '--tools', '', '--strict-mcp-config',
        '--settings', JSON.stringify({ disableAllHooks: true, enabledPlugins: { 'claude-mem@thedotmack': false } })];
      let out = '', err = '', settled = false;
      const p = spawn(ctx.CLAUDE, args, { cwd: runDir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const t = setTimeout(() => { p.kill(); end(new Error('analyse trop longue')); }, RUN_TIMEOUT());
      const end = (e, v) => { if (settled) return; settled = true; clearTimeout(t); e ? reject(e) : resolve(v); };
      p.on('error', end);
      p.stdout.on('data', d => { out += d; });
      p.stderr.on('data', d => { err += d; });
      p.on('close', code => {
        let r = null;
        try { r = JSON.parse(out.trim().split('\n').pop()); } catch { }
        if (!r) return end(new Error(`réponse illisible (code ${code}) ${err.slice(0, 200)}`));
        if (r.is_error) return end(new Error(String(r.result || 'erreur').slice(0, 200)));
        end(null, r.structured_output);
      });
      p.stdin.on('error', () => { });
      p.stdin.end(prompt);
    });
  }

  // renvoie vrai s'il reste une suite à analyser tout de suite (transcript trop long pour un seul passage)
  async function analyze(cid, { force = false } = {}) {
    if (!on() || (status.suspended && !force)) return false;
    if (quotaFull()) { schedule(cid, QUOTA_RETRY()); return false; } // reste dans pending
    const file = ctx.transcriptPath(cid);
    if (!file) { done(cid); return false; }
    const cur = store.get(cid);
    if (cur?.forgotten) { done(cid); return false; }
    const { lines } = readLines(file, state.off[cid] || 0);
    const objs = lines.map(l => l.o);
    if (!objs.length || usefulExchanges(objs) + (cur ? 2 : 0) < 2) { done(cid); return false; } // rien de neuf, ou session triviale
    const r = reduce(objs, { maxInput: MAX_INPUT() });
    if (!r.chunks.length) { state.off[cid] = lines[r.used - 1]?.end ?? state.off[cid]; done(cid); return false; }
    const last = objs.slice(0, r.used).reverse();
    const cwd = (last.find(o => o.cwd) || {}).cwd || '';
    const project = cwd ? (ctx.memoryPortable?.(cwd) || cwd) : cur?.project || '';
    let summary = cur?.summary || null;
    const obs = [];
    for (let i = 0; i < r.chunks.length; i++) {
      const c = clean(await runClaude(buildPrompt({ text: r.chunks[i], previous: summary, project, part: i + 1, parts: r.chunks.length })));
      if (!c) throw new Error('réponse de Haiku refusée (hors format ou message d’erreur)');
      summary = c.summary; obs.push(...c.observations);
    }
    const now = Date.now();
    let n = cur?.nextObs || 0;
    const times = objs.map(o => Date.parse(o.timestamp) || 0).filter(Boolean);
    const e = {
      v: 1, id: cid, summary, project, machine: machine(), branch: (last.find(o => o.gitBranch) || {}).gitBranch || cur?.branch || '',
      created: cur?.created || times[0] || now, updated: Math.max(now, (cur?.updated || 0) + 1), analyzedAt: now, promptVersion: PROMPT_VERSION,
      obs: [...(cur?.obs || []), ...obs.map(o => ({ ...o, id: `${cid}:${n++}`, createdAt: now }))], nextObs: n,
      ...(cur?.titleFixed ? { titleFixed: true } : {}),
    };
    if (cur?.titleFixed) e.summary = { ...summary, title: cur.summary.title };
    store.save(e);
    state.off[cid] = lines[r.used - 1].end;
    status.fails = 0; status.lastError = ''; status.done++; status.last = now;
    if (!r.rest) done(cid); else saveState();
    ctx.memaiChanged?.(cid);
    return r.rest;
  }

  ctx.on('idle', s => s.claudeSessionId && schedule(s.claudeSessionId, IDLE()));
  ctx.on('working', s => { if (s.claudeSessionId) { clearTimeout(timers.get(s.claudeSessionId)); timers.delete(s.claudeSessionId); } });
  ctx.on('end', s => s.claudeSessionId && schedule(s.claudeSessionId, END_DELAY()));
  ctx.on('exit', s => s.claudeSessionId && schedule(s.claudeSessionId, END_DELAY()));
  // analyses en attente au dernier arrêt : reprises (suspension levée par le redémarrage)
  setTimeout(() => { for (const cid of state.pending) queue.includes(cid) || queue.push(cid); pump(); }, 5000).unref?.();

  ctx.memai = {
    on, list: () => store.list(), live: () => store.live(), get: id => store.get(id), search: (q, o) => store.search(q, o), item: id => store.item(id),
    status: () => ({ enabled: on(), ...status, pending: state.pending.length + (status.running && !state.pending.includes(status.running) ? 1 : 0),
      welcome: on() && settings().memoryAIWelcomed !== true && settings().onboarded === true, claudeMemOn: claudeMemOn() }),
    // fiche reçue d'une autre machine : gardée si plus récente (l'avancement local reste : seule la suite sera analysée)
    put(e) {
      if (!storeLib.valid(e)) return false;
      const cur = store.get(e.id);
      if (cur && cur.updated >= e.updated) return false;
      store.save({ ...e });
      return true;
    },
    save: e => store.save(e),
    analyzeNow: cid => { status.suspended = false; status.fails = 0; clearTimeout(timers.get(cid)); enqueue(cid); },
  };

  route('GET', /^\/api\/memory\/ai\/status$/, async ({ res }) => json(res, 200, ctx.memai.status()));

  // ---------------------------------------------------------------- Réglages › Mémoire (fiches IA)
  const cardOf = e => ({ id: e.id, title: e.summary.title, state: e.summary.state, next: e.summary.next, project: e.project, machine: e.machine, updated: e.updated, obs: e.obs.length });
  route('GET', /^\/api\/memory\/ai\/cards$/, async ({ req, res }) => {
    const u = new URL(req.url, 'http://x').searchParams, q = (u.get('q') || '').trim(), project = u.get('project') || '';
    const ids = q ? new Set(store.search(q, { project, limit: 50 }).map(h => h.id.split(':')[0])) : null;
    const items = store.live().filter(e => (!project || e.project === project) && (!ids || ids.has(e.id))).sort((a, b) => b.updated - a.updated).slice(0, 300).map(cardOf);
    json(res, 200, { ...ctx.memai.status(), items, projects: [...new Set(store.live().map(e => e.project).filter(Boolean))].sort() });
  });
  route('GET', /^\/api\/memory\/ai\/cards\/([\w-]{6,60})$/, async ({ res, m }) => {
    const e = store.get(m[1]);
    if (!e || e.forgotten) return json(res, 404, { error: 'fiche inconnue' });
    json(res, 200, { ...cardOf(e), request: e.summary.request, branch: e.branch, created: e.created, obs: e.obs });
  });
  // corrections : { title?, dropObs?: id, forget?: true } ; la fiche devient la plus récente (elle repart vers les autres machines)
  route('PATCH', /^\/api\/memory\/ai\/cards\/([\w-]{6,60})$/, async ({ req, res, m }) => {
    const cur = store.get(m[1]);
    if (!cur || cur.forgotten) return json(res, 404, { error: 'fiche inconnue' });
    const b = await readBody(req) || {};
    let e = { ...cur, summary: { ...cur.summary }, obs: [...cur.obs] };
    if (typeof b.title === 'string' && b.title.trim()) { e.summary.title = b.title.trim().slice(0, 120); e.titleFixed = true; }
    if (typeof b.dropObs === 'string') e.obs = e.obs.filter(o => o.id !== b.dropObs);
    if (b.forget === true) e = { v: 1, id: cur.id, forgotten: true };
    e.updated = Math.max(Date.now(), (cur.updated || 0) + 1);
    store.save(e);
    json(res, 200, { ok: true });
  });
  // analyses suspendues (échecs) : reprises, avec celles en attente
  route('POST', /^\/api\/memory\/ai\/resume$/, async ({ res }) => {
    status.suspended = false; status.fails = 0;
    for (const cid of state.pending) if (!queue.includes(cid)) queue.push(cid);
    pump();
    json(res, 200, ctx.memai.status());
  });
  route('POST', /^\/api\/memory\/ai\/analyze\/([\w-]{6,60})$/, async ({ res, m }) => {
    if (!ctx.transcriptPath(m[1])) return json(res, 404, { error: 'conversation introuvable' });
    ctx.memai.analyzeNow(m[1]);
    json(res, 200, { ok: true });
  });

  // claude-mem activé dans Claude Code (~/.claude/settings.json) : l'app propose de le couper (avec confirmation),
  // une copie du fichier est gardée avant
  const userSettings = path.join(os.homedir(), '.claude', 'settings.json');
  const claudeMemInstalled = () => { try { return !!JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins?.['claude-mem@thedotmack']; } catch { return false; } };
  function claudeMemOn() {
    if (!claudeMemInstalled()) return false;
    try { return JSON.parse(fs.readFileSync(userSettings, 'utf8')).enabledPlugins?.['claude-mem@thedotmack'] !== false; } catch { return true; }
  }
  route('POST', /^\/api\/memory\/ai\/claude-mem-off$/, async ({ res }) => {
    if (!claudeMemOn()) return json(res, 200, { ok: true, changed: false });
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(userSettings, 'utf8')); } catch (e) { if (fs.existsSync(userSettings)) return json(res, 500, { error: 'settings.json illisible : ' + e.message }); }
    if (fs.existsSync(userSettings)) {
      const to = path.join(DATA, 'claude-sync-backup', new Date().toISOString().replace(/[:.]/g, '-') + '-claude-mem-off', 'settings.json');
      fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(userSettings, to);
    }
    cur.enabledPlugins = { ...(cur.enabledPlugins || {}), 'claude-mem@thedotmack': false };
    fs.mkdirSync(path.dirname(userSettings), { recursive: true });
    fs.writeFileSync(userSettings + '.csm-tmp', JSON.stringify(cur, null, 2)); fs.renameSync(userSettings + '.csm-tmp', userSettings);
    json(res, 200, { ok: true, changed: true });
  });

  // ---------------------------------------------------------------- recherche (MCP csm-memoire, Réglages)
  // Ces trois routes acceptent aussi le jeton des hooks (lecture seule, server.js) : le serveur MCP lancé avec
  // une session n'a que celui-là.
  const day = t => t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : '?';
  const resumeText = e => [`# ${e.summary.title}`, `Session ${e.id} · ${e.project || '?'} · ${e.machine || '?'}${e.branch ? ' · ' + e.branch : ''} · ${day(e.updated)}`,
    `Demande : ${e.summary.request}`, `État : ${e.summary.state}`, `Ensuite : ${e.summary.next}`,
    ...(e.obs.length ? ['Observations :', ...e.obs.map(o => `- [${o.type}] ${o.title} (${o.id})`)] : [])].join('\n');
  const obsText = (e, o) => [`# [${o.type}] ${o.title}`, o.body, ...(o.files?.length ? [`Fichiers : ${o.files.join(', ')}`] : []),
    `Session ${e.id} — ${e.summary.title} · ${e.project || '?'} · ${e.machine || '?'} · ${day(o.createdAt || e.updated)}`].join('\n');
  route('GET', /^\/api\/memory\/ai\/search$/, async ({ req, res }) => {
    const u = new URL(req.url, 'http://x').searchParams;
    json(res, 200, store.search(u.get('q') || '', { project: u.get('project') || '', type: u.get('type') || '', since: Number(u.get('since')) || 0, limit: Number(u.get('limit')) || 10 })
      .map(({ score, ...h }) => h));
  });
  route('GET', /^\/api\/memory\/ai\/item\/([\w-]{6,60}(?::\d{1,6})?)$/, async ({ res, m }) => {
    const it = store.item(decodeURIComponent(m[1]));
    if (!it) return json(res, 404, { error: 'introuvable' });
    json(res, 200, { text: it.kind === 'resume' ? resumeText(it.entry) : obsText(it.entry, it.obs) });
  });
  route('GET', /^\/api\/memory\/ai\/timeline\/([\w-]{6,60}(?::\d{1,6})?)$/, async ({ res, m }) => {
    const it = store.item(decodeURIComponent(m[1]));
    if (!it) return json(res, 404, { error: 'introuvable' });
    const e = it.entry;
    const prev = store.live().filter(x => x.id !== e.id && x.project === e.project && x.updated < (e.created || e.updated)).sort((a, b) => b.updated - a.updated)[0];
    json(res, 200, { text: [resumeText(e), ...e.obs.map(o => '\n' + obsText(e, o)), ...(prev ? ['\n## Session précédente du dossier', resumeText(prev)] : [])].join('\n') });
  });

  // MCP passé aux sessions : fichier réécrit à chaque démarrage (le jeton des hooks change), lisible par moi seul
  const mcpFile = path.join(DATA, 'memory', 'mcp.json');
  try {
    const env = { CSM_PORT: String(ctx.PORT), CSM_TOKEN: ctx.HOOK_TOKEN, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { 'csm-memoire': { command: process.execPath, args: [path.join(__dirname, 'mcp.js')], env } } }, null, 2), { mode: 0o600 });
    fs.chmodSync(mcpFile, 0o600);
  } catch (e) { console.error('mémoire IA : MCP', e.message); }
  ctx.mcpArgs = () => (on() && fs.existsSync(mcpFile) ? ['--mcp-config', mcpFile] : []);
};

module.exports.readLines = readLines;
