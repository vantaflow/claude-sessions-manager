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

// Quasi en temps réel (une session de l'app reste souvent ouverte des heures) : analyse IDLE après la dernière
// réponse de Claude, et au plus MAX_WAIT après le premier échange pas encore analysé, même si la session ne
// s'arrête jamais de travailler. Seule la partie nouvelle part chez Haiku à chaque fois.
const IDLE = () => Number(process.env.CSM_MEMAI_IDLE) || 3 * 60e3;
const MAX_WAIT = () => Number(process.env.CSM_MEMAI_MAX_WAIT) || 20 * 60e3;
const END_DELAY = () => Number(process.env.CSM_MEMAI_END_DELAY) || 5000;
const MAX_INPUT = () => Number(process.env.CSM_MEMAI_MAX_INPUT) || 60000;
const RUN_TIMEOUT = () => Number(process.env.CSM_MEMAI_TIMEOUT) || 180e3;
const QUOTA_RETRY = () => Number(process.env.CSM_MEMAI_QUOTA_RETRY) || 15 * 60e3;
const MAX_FAILS = 3, QUOTA_LIMIT = 90;
const ID = /^[\w-]{6,60}$/;

// lignes complètes du transcript à partir de l'octet off, avec l'octet de fin de chacune ; WINDOW octets au plus
// par lecture (un transcript de centaines de Mo n'est jamais chargé d'un bloc : more = il reste de quoi lire).
// Les lignes énormes (images en base64 dans une sortie d'outil) ne sont pas analysées : rien d'utile pour Haiku.
const WINDOW = () => Number(process.env.CSM_MEMAI_WINDOW) || 32 * 1024 * 1024;
const HUGE_LINE = 512 * 1024;
function readLines(file, off) {
  const size = fs.statSync(file).size;
  if (size < off) off = 0; // transcript réécrit : tout relire
  if (size === off) return { lines: [], off, end: off, more: false };
  const len = Math.min(size - off, WINDOW());
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, off);
    const lines = []; let start = 0;
    for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, start)) {
      const n = i - start, s0 = start; start = i + 1;
      if (!n || n > HUGE_LINE) continue;
      try { lines.push({ o: JSON.parse(buf.subarray(s0, i).toString('utf8')), end: off + start }); } catch { }
    }
    // fenêtre pleine sans fin de ligne (ligne de plus de WINDOW octets) : passée, pour ne pas rester bloqué dessus
    const end = start ? off + start : (off + len < size ? off + len : off);
    return { lines, off, end, more: off + len < size };
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
  // session verrouillée par mot de passe (lib/lock.js) : jamais analysée, et sa fiche n'est ni cherchable par Claude
  // (MCP), ni donnée au démarrage, ni listée dans Réglages tant qu'elle reste verrouillée
  const hidden = id => !!ctx.lockedByConversation?.(String(id).split(':')[0].replace(/-p\d+$/, '')); // sujets « <id>-p<n> » compris

  // état local (jamais synchronisé) : avancement par conversation, échecs, analyses en attente
  let state = { off: {}, pending: [], backlog: [], local: {} };
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
  // quota presque atteint ; une valeur dont la fenêtre est déjà réinitialisée ne compte plus (aucune session ouverte
  // pour la rafraîchir : sinon l'analyse serait reportée sans fin)
  // anciennes sessions (fiches de la mémoire intégrée d'avant la mémoire IA), analysées à la demande : une à la fois,
  // seulement quand rien d'autre n'attend, espacées (CSM_MEMAI_BACKLOG_GAP, 60 s), et arrêtées dès que le quota 5 h
  // dépasse 70 % (de la place reste pour le travail) ; la liste est gardée d'un lancement à l'autre
  const BACKLOG_GAP = () => Number(process.env.CSM_MEMAI_BACKLOG_GAP) || 60e3, BACKLOG_QUOTA = 70;
  const quotaHigh = () => { const Q = ctx.quota || {}, now = Date.now(); return (Q.blockedUntil || 0) > now || (Number.isFinite(Q.pct) && Q.pct >= BACKLOG_QUOTA && !(Q.resetAt && Q.resetAt < now)); };
  function backlogCandidates() {
    const out = [];
    for (const e of ctx.memory?.list?.() || []) {
      if (!e || e.forgotten || !ID.test(e.id || '') || hidden(e.id)) continue;
      if (store.get(e.id)) continue; // déjà dans la mémoire IA (ici ou reçue d'une autre machine)
      if (e.machine && e.machine !== machine()) continue; // fiche écrite sur une autre machine : analysée là-bas
      if (!ctx.transcriptPath(e.id)) continue; // conversation d'une autre machine : analysée là-bas
      out.push({ id: e.id, updated: e.updated || 0 });
    }
    return out.sort((a, b) => b.updated - a.updated).map(x => x.id); // les plus récentes d'abord
  }
  let availCache = { at: 0, n: 0 };
  const available = () => { if (Date.now() - availCache.at > 60e3) availCache = { at: Date.now(), n: backlogCandidates().length }; return availCache.n; };
  setInterval(() => {
    if (!state.backlog?.length || !on() || status.suspended || status.running || queue.length || quotaHigh()) return;
    const cid = state.backlog.shift(); saveState();
    if (!store.get(cid) && ctx.transcriptPath(cid)) enqueue(cid);
  }, BACKLOG_GAP()).unref?.();
  const quotaFull = () => {
    const Q = ctx.quota || {}, now = Date.now();
    if ((Q.blockedUntil || 0) > now) return true;
    return Number.isFinite(Q.pct) && Q.pct >= QUOTA_LIMIT && !(Q.resetAt && Q.resetAt < now);
  };

  // Commande de claude : sous Windows, l'installation npm donne claude.cmd, qu'on ne peut pas lancer sans
  // cmd.exe (et cmd.exe citerait mal les arguments JSON) : on lance directement son cli.js avec Node.
  function claudeCommand() {
    const bin = ctx.CLAUDE;
    if (!/\.(cmd|bat)$/i.test(bin || '')) return { cmd: bin, pre: [], env: {} };
    const cli = path.join(path.dirname(bin), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (!fs.existsSync(cli)) { const e = new Error('claude installé par npm introuvable (' + bin + ') : installe Claude Code avec l’installateur officiel'); e.code = 'ENOENT'; throw e; }
    return { cmd: process.execPath, pre: [cli], env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
  }
  function runClaude(prompt) {
    return new Promise((resolve, reject) => {
      let cc; try { cc = claudeCommand(); } catch (e) { return reject(e); }
      const env = { ...process.env };
      for (const k of Object.keys(env)) if (/^(CSM_ID|CSM_PORT|CSM_TOKEN|CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID$|AI_AGENT$|ELECTRON_RUN_AS_NODE$)/i.test(k)) delete env[k];
      Object.assign(env, cc.env);
      const args = [...cc.pre, ...ctx.splitArgs(process.env.CSM_CLAUDE_ARGS || ''), '-p', '--model', process.env.CSM_MEMAI_MODEL || 'haiku',
        '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA), '--no-session-persistence', '--tools', '', '--strict-mcp-config',
        '--settings', JSON.stringify({ disableAllHooks: true, enabledPlugins: { 'claude-mem@thedotmack': false } })];
      let out = '', err = '', settled = false;
      const p = spawn(cc.cmd, args, { cwd: runDir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
    if (!on() || hidden(cid)) { done(cid); return false; }
    if (status.suspended && !force) return false;
    if (quotaFull()) { schedule(cid, QUOTA_RETRY()); return false; } // reste dans pending
    const file = ctx.transcriptPath(cid);
    if (!file) { done(cid); return false; }
    const cur = store.get(cid);
    if (cur?.forgotten) { done(cid); return false; }
    const read = readLines(file, state.off[cid] || 0);
    let lines = read.lines;
    // fiche reçue d'une autre machine (pas d'avancement ici) : ce qu'elle a déjà analysé est passé, d'après la date
    // de la dernière ligne analysée (analyzedUntil), pour ne pas tout résumer de nouveau ni doubler les observations
    if (state.off[cid] === undefined && cur?.analyzedUntil) {
      const k = lines.findIndex(l => (Date.parse(l.o.timestamp) || 0) > cur.analyzedUntil);
      lines = k < 0 ? [] : lines.slice(k);
      if (k < 0 && read.lines.length) state.off[cid] = read.lines[read.lines.length - 1].end;
    }
    const objs = lines.map(l => l.o);
    // rien de neuf, ou session triviale : deux échanges pour une première fiche, un nouvel échange pour la suite
    if (!objs.length || usefulExchanges(objs) < (cur ? 1 : 2)) {
      if (read.more) { state.off[cid] = read.end; saveState(); return true; } // fenêtre sans échange : la suivante
      done(cid); return false;
    }
    const r = reduce(objs, { maxInput: MAX_INPUT() });
    if (!r.chunks.length) { state.off[cid] = lines[r.used - 1]?.end ?? state.off[cid]; done(cid); return false; }
    const last = objs.slice(0, r.used).reverse();
    const cwd = (last.find(o => o.cwd) || {}).cwd || '';
    const project = cwd ? (ctx.memoryPortable?.(cwd) || cwd) : cur?.project || '';
    // Sujets : une session de l'app dure souvent des heures et passe d'un sujet à l'autre. Quand Haiku signale un
    // nouveau sujet (newTopic), le sujet en cours devient une fiche à part (« <id>-p<n> »), avec son résumé et ses
    // observations ; la fiche de la session suit le sujet le plus récent.
    let summary = cur?.summary || null;
    const done1 = []; // sujets terminés pendant cette analyse : { summary, obs, keepOld }
    let obs = [], keepOld = true; // observations du sujet en cours ; keepOld : celles déjà dans la fiche en font partie
    for (let i = 0; i < r.chunks.length; i++) {
      const c = clean(await runClaude(buildPrompt({ text: r.chunks[i], previous: summary, project, part: i + 1, parts: r.chunks.length })));
      if (!c) throw new Error('réponse de Haiku refusée (hors format ou message d’erreur)');
      if (c.newTopic && summary) { done1.push({ summary, obs, keepOld }); obs = []; keepOld = false; }
      summary = c.summary; obs.push(...c.observations);
    }
    // la fiche a pu changer pendant l'analyse (oubliée, titre corrigé, observation retirée, version reçue) : relue
    const fresh = store.get(cid);
    if (fresh?.forgotten) { done(cid); return false; }
    const now = Date.now();
    const times = objs.slice(0, r.used).map(o => Date.parse(o.timestamp) || 0).filter(Boolean);
    const branch = (last.find(o => o.gitBranch) || {}).gitBranch || fresh?.branch || '';
    // sujets terminés : chacun sa fiche, numérotée à la suite des précédentes
    let parts = fresh?.parts || 0;
    for (const t of done1) {
      const pid = `${cid}-p${++parts}`;
      const old = t.keepOld ? (fresh?.obs || []) : [];
      let k = 0;
      store.save({ v: 1, id: pid, of: cid, summary: t.keepOld && fresh?.titleFixed ? { ...t.summary, title: fresh.summary.title } : t.summary, project, machine: machine(), branch,
        created: t.keepOld ? (fresh?.created || times[0] || now) : (times[0] || now), updated: now, analyzedAt: now, promptVersion: PROMPT_VERSION,
        obs: [...old.map(o => ({ ...o, id: `${pid}:${k++}` })), ...t.obs.map(o => ({ ...o, id: `${pid}:${k++}`, createdAt: now }))], nextObs: k });
    }
    const keepFresh = keepOld; // aucun nouveau sujet : la fiche garde ses observations
    let n = keepFresh ? (fresh?.nextObs || 0) : 0;
    const e = {
      v: 1, id: cid, summary, project, machine: machine(), branch: (last.find(o => o.gitBranch) || {}).gitBranch || fresh?.branch || '',
      created: fresh?.created || times[0] || now, updated: Math.max(now, (fresh?.updated || 0) + 1), analyzedAt: now, promptVersion: PROMPT_VERSION,
      analyzedUntil: Math.max(fresh?.analyzedUntil || 0, ...times),
      obs: [...(keepFresh ? fresh?.obs || [] : []), ...obs.map(o => ({ ...o, id: `${cid}:${n++}`, createdAt: now }))], nextObs: n, parts,
      ...(keepFresh && fresh?.titleFixed ? { titleFixed: true } : {}),
    };
    if (keepFresh && fresh?.titleFixed) e.summary = { ...summary, title: fresh.summary.title };
    store.save(e);
    state.off[cid] = lines[r.used - 1].end;
    status.fails = 0; status.lastError = ''; status.done++; status.last = now;
    const again = r.rest || read.more;
    if (!again) done(cid); else saveState();
    ctx.memaiChanged?.(cid);
    if (!again) since.delete(cid); // tout le nouveau est analysé : le délai maximal repart du prochain échange
    return again;
  }

  const since = new Map(); // conversation → date du premier échange pas encore analysé
  // Une conversation n'est analysée que par la machine où Claude la fait tourner (repérée ici à ses événements) :
  // la synchro en apporte une copie aux autres machines, qui ne l'analysent pas (quota compté deux fois sinon).
  const markLocal = cid => { if (cid && !state.local?.[cid]) { state.local = { ...(state.local || {}), [cid]: Date.now() }; saveState(); } };
  for (const ev of ['idle', 'working', 'end', 'exit']) ctx.on(ev, s => markLocal(s.claudeSessionId));
  ctx.on('idle', s => {
    const cid = s.claudeSessionId;
    if (!cid) return;
    if (!since.has(cid)) since.set(cid, Date.now());
    // déjà en attente depuis MAX_WAIT : tout de suite ; sinon après IDLE sans nouvelle activité
    schedule(cid, Math.max(0, Math.min(IDLE(), since.get(cid) + MAX_WAIT() - Date.now())));
  });
  ctx.on('working', s => {
    const cid = s.claudeSessionId;
    if (!cid) return;
    if (!since.has(cid)) since.set(cid, Date.now());
    if (Date.now() - since.get(cid) >= MAX_WAIT()) { if (!timers.has(cid) && !queue.includes(cid) && status.running !== cid) schedule(cid, 0); return; } // session qui ne s'arrête jamais
    clearTimeout(timers.get(cid)); timers.delete(cid);
  });
  ctx.on('end', s => s.claudeSessionId && schedule(s.claudeSessionId, END_DELAY()));
  ctx.on('exit', s => s.claudeSessionId && schedule(s.claudeSessionId, END_DELAY()));
  // analyses en attente au dernier arrêt : reprises (suspension levée par le redémarrage). Sessions de l'app dont la
  // conversation a avancé depuis la dernière analyse (minuteur d'inactivité perdu à l'arrêt) : reprogrammées, mais
  // seulement pour ce qui a été écrit depuis l'arrivée de la mémoire IA (pas de ré-analyse de tout l'historique).
  if (!state.since) { state.since = Date.now(); saveState(); }
  setTimeout(() => {
    for (const cid of state.pending) queue.includes(cid) || queue.push(cid);
    pump();
    for (const s of ctx.sessions?.values?.() || []) {
      const cid = s.claudeSessionId, f = cid && state.local?.[cid] && ctx.transcriptPath(cid);
      if (!f || state.pending.includes(cid)) continue;
      try { const st = fs.statSync(f); if (st.mtimeMs > state.since && st.size > (state.off[cid] || 0)) schedule(cid, IDLE()); } catch { }
    }
  }, 5000).unref?.();

  ctx.memai = {
    on, list: () => store.list().filter(e => !hidden(e.id)), live: () => store.live().filter(e => !hidden(e.id)), get: id => store.get(id),
    search: (q, o) => store.search(q, o).filter(h => !hidden(h.id)), item: id => (hidden(id) ? null : store.item(id)),
    status: () => ({ enabled: on(), ...status, pending: state.pending.length + (status.running && !state.pending.includes(status.running) ? 1 : 0), backlog: state.backlog?.length || 0, backlogAvailable: available(),
      welcome: on() && settings().memoryAIWelcomed !== true && settings().onboarded === true, claudeMemOn: claudeMemOn() }),
    // fiche reçue d'une autre machine : gardée si plus récente (seule la suite de ce qu'elle a analysé le sera ici :
    // avancement local, sinon sa date analyzedUntil)
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
    const ids = q ? new Set(ctx.memai.search(q, { project, limit: 50 }).map(h => h.id.split(':')[0])) : null;
    const items = ctx.memai.live().filter(e => (!project || e.project === project) && (!ids || ids.has(e.id))).sort((a, b) => b.updated - a.updated).slice(0, 300).map(cardOf);
    json(res, 200, { ...ctx.memai.status(), items, projects: [...new Set(store.live().map(e => e.project).filter(Boolean))].sort() });
  });
  route('GET', /^\/api\/memory\/ai\/cards\/([\w-]{6,60})$/, async ({ res, m }) => {
    const e = store.get(m[1]);
    if (!e || e.forgotten || hidden(e.id)) return json(res, 404, { error: 'fiche inconnue' });
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
  // anciennes sessions : toutes mises dans la liste (POST), ou la liste vidée (DELETE)
  route('POST', /^\/api\/memory\/ai\/backfill$/, async ({ res }) => {
    const c = backlogCandidates();
    state.backlog = [...new Set([...(state.backlog || []), ...c])]; saveState(); availCache.at = 0;
    json(res, 200, { added: c.length, backlog: state.backlog.length });
  });
  route('DELETE', /^\/api\/memory\/ai\/backfill$/, async ({ res }) => { state.backlog = []; saveState(); json(res, 200, { backlog: 0 }); });
  route('POST', /^\/api\/memory\/ai\/resume$/, async ({ res }) => {
    status.suspended = false; status.fails = 0;
    for (const cid of state.pending) if (!queue.includes(cid)) queue.push(cid);
    pump();
    json(res, 200, ctx.memai.status());
  });
  // réanalyser depuis le début, découpé par sujets : les anciennes fiches de sujets sont oubliées (partout), la fiche
  // de la session est réécrite (sa nouvelle version, plus récente, remplace l'ancienne sur les autres machines)
  route('POST', /^\/api\/memory\/ai\/reanalyze\/([\w-]{6,60})$/, async ({ res, m }) => {
    const cid = m[1];
    if (!ctx.transcriptPath(cid)) return json(res, 404, { error: 'conversation introuvable sur cette machine' });
    const cur = store.get(cid);
    for (const e of store.list()) if (e.of === cid && !e.forgotten) store.save({ v: 1, id: e.id, forgotten: true, updated: Math.max(Date.now(), (e.updated || 0) + 1) });
    if (cur && !cur.forgotten) store.remove(cid);
    delete state.off[cid]; saveState();
    ctx.memai.analyzeNow(cid);
    json(res, 200, { ok: true });
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
    json(res, 200, ctx.memai.search(u.get('q') || '', { project: u.get('project') || '', type: u.get('type') || '', since: Number(u.get('since')) || 0, limit: Number(u.get('limit')) || 10 })
      .map(({ score, ...h }) => h));
  });
  route('GET', /^\/api\/memory\/ai\/item\/([\w-]{6,60}(?::\d{1,6})?)$/, async ({ res, m }) => {
    const it = ctx.memai.item(decodeURIComponent(m[1]));
    if (!it) return json(res, 404, { error: 'introuvable' });
    json(res, 200, { text: it.kind === 'resume' ? resumeText(it.entry) : obsText(it.entry, it.obs) });
  });
  route('GET', /^\/api\/memory\/ai\/timeline\/([\w-]{6,60}(?::\d{1,6})?)$/, async ({ res, m }) => {
    const it = ctx.memai.item(decodeURIComponent(m[1]));
    if (!it) return json(res, 404, { error: 'introuvable' });
    const e = it.entry;
    const prev = ctx.memai.live().filter(x => x.id !== e.id && x.project === e.project && x.updated < (e.created || e.updated)).sort((a, b) => b.updated - a.updated)[0];
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
