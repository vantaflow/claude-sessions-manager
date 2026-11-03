'use strict';
// Mémoire IA : fiches de session écrites par Haiku (résumé + observations), une par conversation, dans
// DATA/memory/ai/<id>.json. Ce dossier réunit les fiches de cette machine et celles reçues des autres (synchro).
// Recherche plein texte : mots sans accents ni casse, tous présents ; classement titre > mots-clés > texte, puis
// récence. Une fiche oubliée (forgotten) n'est plus ni listée ni cherchée, et n'est jamais recréée.
const fs = require('fs');
const path = require('path');

const ID = /^[\w-]{6,60}$/;
const MAX_OBS = 200; // observations gardées par session (les plus récentes)

const norm = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = q => norm(q).split(/[^\p{L}\p{N}_./-]+/u).filter(w => w.length > 1);

function valid(e) {
  return !!e && typeof e === 'object' && e.v === 1 && ID.test(e.id || '') && Number.isFinite(e.updated)
    && (e.forgotten || (e.summary && typeof e.summary === 'object' && Array.isArray(e.obs)));
}

function open(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const cache = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try { const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (valid(e)) cache.set(e.id, e); } catch { }
  }
  function save(e) {
    if (e.obs && e.obs.length > MAX_OBS) e.obs = e.obs.slice(-MAX_OBS);
    cache.set(e.id, e);
    const tmp = path.join(dir, e.id + '.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(e), { mode: 0o600 });
    fs.renameSync(tmp, path.join(dir, e.id + '.json'));
    return e;
  }
  const live = () => [...cache.values()].filter(e => !e.forgotten);

  // résultats : résumés de session (kind resume) et observations (kind observation, id <session>:<n>)
  function search(q, { project, type, since = 0, limit = 10 } = {}) {
    const ws = words(q);
    const hits = [];
    for (const e of live()) {
      if (project && e.project !== project) continue;
      if (e.updated < since) continue;
      const s = e.summary;
      if (!type || type === 'resume') {
        const t = norm(s.title), k = norm([s.request, s.state, s.next].join(' '));
        if (ws.every(w => t.includes(w) || k.includes(w))) hits.push({ id: e.id, kind: 'resume', title: s.title, date: e.updated, machine: e.machine, project: e.project, score: ws.reduce((n, w) => n + (t.includes(w) ? 3 : 1), 0) });
      }
      for (const o of e.obs) {
        if (type && type !== 'resume' && o.type !== type) continue;
        if (type === 'resume') continue;
        const t = norm(o.title), k = norm(o.keywords.join(' ')), b = norm([o.body, ...(o.files || [])].join(' '));
        if (!ws.every(w => t.includes(w) || k.includes(w) || b.includes(w))) continue;
        hits.push({ id: o.id, kind: 'observation', type: o.type, title: o.title, date: o.createdAt || e.updated, machine: e.machine, project: e.project,
          score: ws.reduce((n, w) => n + (t.includes(w) ? 3 : k.includes(w) ? 2 : 1), 0) });
      }
    }
    // sans mots : les plus récents ; sinon le score, puis la récence (un point par semaine d'écart au plus)
    const now = Date.now();
    return hits.sort((a, b) => (b.score - Math.min(4, (now - b.date) / 6048e5)) - (a.score - Math.min(4, (now - a.date) / 6048e5)) || b.date - a.date).slice(0, Math.max(1, Math.min(50, limit)));
  }
  function item(id) {
    const [cid, n] = String(id).split(':');
    const e = cache.get(cid);
    if (!e || e.forgotten) return null;
    if (n === undefined) return { kind: 'resume', entry: e };
    const o = e.obs.find(x => x.id === id);
    return o ? { kind: 'observation', entry: e, obs: o } : null;
  }
  return { list: () => [...cache.values()], live, get: id => cache.get(id), save, search, item };
}

module.exports = { open, valid, norm, words };
