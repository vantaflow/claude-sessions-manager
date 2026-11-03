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
    status: () => ({ enabled: on(), ...status, pending: state.pending.length + (status.running && !state.pending.includes(status.running) ? 1 : 0) }),
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
};

module.exports.readLines = readLines;
