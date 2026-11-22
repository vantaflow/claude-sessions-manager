'use strict';
// Veille des sessions : une session au repos depuis « sleepMinutes » minutes est arrêtée (son claude libère sa
// mémoire), sa carte reste là, « en veille ». Elle se réveille dans sa conversation (claude --resume) dès qu'on
// l'affiche, qu'on lui envoie un message (file, envoi groupé, tâche planifiée) ou qu'on la reprend.
// Mémoire de l'ordinateur presque pleine (sleepOnPressure) : les sessions au repos depuis le plus longtemps sont
// mises en veille sans attendre le délai (au moins 5 min de repos).
// Jamais mises en veille : session qui travaille, attend une réponse ou démarre ; file non vide ; affichée dans
// une fenêtre (ici ou chez un pilote) ; verrouillée ; accès Remote Control ; « ne jamais mettre en veille » ;
// commande encore en cours en arrière-plan (shell lancé par Claude Code).
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const TICK = Number(process.env.CSM_SLEEP_TICK_MS) || 60e3;
const MIN_PRESSURE_IDLE = Number(process.env.CSM_SLEEP_PRESSURE_IDLE_MS) || 5 * 60e3;
const run = (file, args, timeout = 15e3) => new Promise(res => execFile(file, args, { timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 16 << 20 },
  (err, out) => res(err ? '' : String(out || ''))));

// Mémoire presque pleine ? (macOS : niveau de mémoire libre du noyau ou swap plus grand que la moitié de la
// mémoire ; Linux : MemAvailable ; Windows : mémoire libre). CSM_SLEEP_PRESSURE=1|0 force la réponse (tests).
async function underPressure() {
  if (process.env.CSM_SLEEP_PRESSURE) return process.env.CSM_SLEEP_PRESSURE === '1';
  try {
    if (process.platform === 'darwin') {
      const level = Number((await run('sysctl', ['-n', 'kern.memorystatus_level'])).trim());
      if (level > 0 && level < 20) return true;
      const m = (await run('sysctl', ['-n', 'vm.swapusage'])).match(/used = ([\d.]+)M/);
      return !!m && Number(m[1]) * 1048576 > os.totalmem() / 2;
    }
    if (process.platform === 'linux') {
      const t = fs.readFileSync('/proc/meminfo', 'utf8');
      const v = k => Number((t.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1] || 0);
      return v('MemTotal') > 0 && v('MemAvailable') / v('MemTotal') < 0.12;
    }
    return os.freemem() / os.totalmem() < 0.1;
  } catch { return false; }
}

// pid des processus dont un ancêtre est dans « roots », avec leur commande
async function processTable() {
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }'], 30e3);
    return out.split(/\r?\n/).map(l => l.split('\t')).filter(a => a.length >= 3).map(([p, pp, ...c]) => ({ pid: +p, ppid: +pp, cmd: c.join('\t') }));
  }
  const out = await run('ps', ['-axo', 'pid=,ppid=,command=']);
  return out.split('\n').map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(m => ({ pid: +m[1], ppid: +m[2], cmd: m[3] }));
}
// commande lancée par Claude Code (outil Bash, souvent en arrière-plan) encore en cours sous ce pid
const SHELL_CMD = /shell-snapshots|CSM_FAKE_BG/;
function busyBelow(table, rootPid) {
  const kids = new Map();
  for (const p of table) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const stack = [...(kids.get(rootPid) || [])], seen = new Set();
  while (stack.length) {
    const p = stack.pop(); if (seen.has(p.pid)) continue; seen.add(p.pid);
    if (SHELL_CMD.test(p.cmd)) return true;
    stack.push(...(kids.get(p.pid) || []));
  }
  return false;
}

module.exports = function (ctx) {
  const { sessions, persist, broadcast, publicView, route, json, on } = ctx;
  const settings = () => ctx.getSettings?.() || {};
  const views = new Map(); // fenêtre (WebSocket) -> ids affichés
  const viewed = () => { const all = new Set(); for (const ids of views.values()) for (const id of ids) all.add(id); return all; };
  const idleSince = new Map(); // id -> repos depuis (statut « prêt » et pas affichée)

  function wake(s) {
    if (!s || !s.sleeping || s.pty) return false;
    idleSince.set(s.id, Date.now()); // compté depuis le réveil : la file a le temps de partir
    ctx.restartSession(s).catch(e => console.error('[veille] réveil', s.name, e.message));
    return true;
  }
  ctx.wakeSession = wake;

  function sleep(s, why) {
    if (!s.pty || s.sleeping) return false;
    s.sleeping = true; s.wantRun = false; persist();
    ctx.appendNote?.(s, `[csm] Mise en veille (${why}) : la session se réveille quand tu l'affiches ou lui envoies un message.`);
    ctx.killSession(s);
    broadcast({ t: 'session', s: publicView(s) });
    console.log(`[veille] ${s.name} (${why})`);
    return true;
  }

  // fenêtres : sessions affichées ; une session en veille affichée se réveille
  const prevMsg = ctx.onWsMessage, prevClose = ctx.onWsClose;
  ctx.onWsMessage = (ws, m) => {
    if (m.t === 'shown' && Array.isArray(m.ids)) {
      const ids = m.ids.filter(id => typeof id === 'string').slice(0, 8);
      views.set(ws, ids);
      for (const id of ids) { idleSince.delete(id); wake(sessions.get(id)); }
      return true;
    }
    return prevMsg ? prevMsg(ws, m) : false;
  };
  ctx.onWsClose = ws => { const ids = views.get(ws) || []; views.delete(ws); for (const id of ids) if (sessions.get(id)?.status === 'idle') idleSince.set(id, Date.now()); prevClose?.(ws); };

  on('idle', s => idleSince.set(s.id, Date.now()));
  on('removed', s => idleSince.delete(s.id));

  function candidate(s, shown) {
    return s.pty && !s.sleeping && s.status === 'idle' && !s.queue?.length && !s.noSleep && !s.lock && !s.remote
      && !s.quotaWait && !s.limitHit && !s.initialPrompt && !shown.has(s.id);
  }
  let ticking = false;
  async function tick() {
    if (ticking) return; ticking = true;
    try {
      const st = settings(), now = Date.now(), shown = viewed();
      const delay = Number(st.sleepMinutes) * 60e3;
      const list = [...sessions.values()].filter(s => candidate(s, shown))
        .map(s => ({ s, since: Math.max(idleSince.get(s.id) || 0, s.statusSince || 0, s.promptAt || 0) }))
        .sort((a, b) => a.since - b.since);
      // file à envoyer à une session en veille (tâche planifiée…) : réveil
      for (const s of sessions.values()) if (s.sleeping && !s.pty && s.queue?.length) wake(s);
      if (!list.length) return;
      let due = delay > 0 ? list.filter(x => now - x.since >= delay) : [];
      let why = 'au repos';
      if (st.sleepOnPressure !== false && due.length < list.length && await underPressure()) {
        const more = list.filter(x => !due.includes(x) && now - x.since >= MIN_PRESSURE_IDLE).slice(0, 3);
        if (more.length) { due = [...due, ...more]; why = 'mémoire presque pleine'; }
      }
      if (!due.length) return;
      const table = await processTable();
      for (const { s } of due) {
        if (!candidate(s, viewed())) continue; // a changé pendant la lecture des processus
        if (table.length && busyBelow(table, s.pty.pid)) continue; // commande encore en cours
        sleep(s, delay > 0 && now - Math.max(idleSince.get(s.id) || 0, s.statusSince || 0) >= delay ? 'au repos' : why);
      }
    } catch (e) { console.error('[veille]', e.message); } finally { ticking = false; }
  }
  setInterval(tick, TICK).unref?.();

  // mise en veille à la main, et « ne jamais mettre en veille »
  route('POST', /^\/api\/sessions\/(\w+)\/sleep$/, async ({ res, m }) => {
    const s = sessions.get(m[1]); if (!s) return json(res, 404, { error: 'session inconnue' });
    if (!s.pty) return json(res, 409, { error: 'session arrêtée' });
    if (s.status === 'working' || s.status === 'attention') return json(res, 409, { error: 'session au travail' });
    sleep(s, 'à la main');
    json(res, 200, publicView(s));
  });
  route('POST', /^\/api\/sessions\/(\w+)\/wake$/, async ({ res, m }) => {
    const s = sessions.get(m[1]); if (!s) return json(res, 404, { error: 'session inconnue' });
    json(res, 200, { woken: wake(s) });
  });
  ctx.sleepTick = tick;
};
module.exports.busyBelow = busyBelow;
