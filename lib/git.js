'use strict';
// Git : worktree par session (#10) et panneau « Modifications » (#12).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function git(cwd, args, { input, allowFail } = {}) {
  return new Promise((resolve, reject) => {
    // GIT_OPTIONAL_LOCKS=0 : status et autres lectures ne prennent pas index.lock (sinon un git lancé au même
    // moment par Claude dans la session échoue « Unable to create index.lock »)
    const p = execFile('git', args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        if (err && !allowFail) return reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' ')));
        resolve({ out: stdout, err: stderr, code: err ? err.code : 0 });
      });
    if (input !== undefined) { p.stdin.end(input); }
  });
}

const safeBranch = b => /^[\w./-]{1,120}$/.test(b) && !b.includes('..') && !b.startsWith('-') && !b.endsWith('/') && !b.endsWith('.lock');
// Chemin relatif au dépôt : jamais d'échappement hors du dossier de la session.
function safeRel(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.startsWith('-')) throw new Error('chemin invalide');
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(path.resolve(root) + path.sep) && abs !== path.resolve(root)) throw new Error('chemin hors du dépôt');
  return rel;
}

async function repoInfo(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const r = await git(cwd, ['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD', '--git-common-dir'], { allowFail: true });
  if (r.code) return null;
  const [top, branch, common] = r.out.trim().split(/\r?\n/);
  return { root: path.resolve(top), branch, commonDir: path.resolve(cwd, common) };
}

// git status --porcelain=v1 -z : XY chemin (+ ancien chemin pour les renommages)
function parseStatus(out) {
  const files = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]; if (!e) continue;
    const x = e[0], y = e[1], file = e.slice(3);
    const f = { path: file, index: x, work: y };
    if (x === 'R' || x === 'C') f.from = parts[++i];
    f.state = x === '?' ? 'nouveau' : (x === 'D' || y === 'D') ? 'supprimé' : (x === 'A') ? 'ajouté' : (x === 'R') ? 'renommé' : 'modifié';
    f.staged = x !== ' ' && x !== '?';
    files.push(f);
  }
  return files;
}

module.exports = function (ctx) {
  const { route, json, readBody, sessions, publicView, persist, broadcast, createSession, killSession } = ctx;
  const sess = m => { const s = sessions.get(m[1]); if (!s) throw Object.assign(new Error('session inconnue'), { code: 404 }); return s; };

  // ---------------------------------------------------------------- état / diff / actions
  route('GET', /^\/api\/sessions\/(\w+)\/git$/, async ({ res, m }) => {
    const s = sess(m);
    const info = await repoInfo(s.cwd);
    if (!info) return json(res, 200, { repo: false });
    const st = await git(info.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const files = parseStatus(st.out);
    const ahead = await git(info.root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], { allowFail: true });
    const [behind, aheadN] = ahead.code ? [null, null] : ahead.out.trim().split(/\s+/).map(Number);
    json(res, 200, { repo: true, root: info.root, branch: info.branch, files, ahead: aheadN, behind, worktree: s.worktree || null });
  });

  route('GET', /^\/api\/sessions\/(\w+)\/git\/diff$/, async ({ res, m, url }) => {
    const s = sess(m);
    const info = await repoInfo(s.cwd); if (!info) return json(res, 400, { error: 'pas un dépôt git' });
    const file = safeRel(info.root, url.searchParams.get('path'));
    const st = parseStatus((await git(info.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', file])).out)[0];
    let diff;
    if (st && st.index === '?') {
      // fichier non suivi : diff contre /dev/null
      diff = (await git(info.root, ['diff', '--no-color', '--no-index', '--', '/dev/null', file], { allowFail: true })).out;
    } else {
      diff = (await git(info.root, ['diff', '--no-color', 'HEAD', '--', file], { allowFail: true })).out;
      if (!diff) diff = (await git(info.root, ['diff', '--no-color', '--cached', '--', file], { allowFail: true })).out;
    }
    if (diff.length > 400000) diff = diff.slice(0, 400000) + '\n… (diff tronqué)';
    json(res, 200, { path: file, diff });
  });

  route('POST', /^\/api\/sessions\/(\w+)\/git\/(discard|stage|unstage|commit)$/, async ({ req, res, m }) => {
    const s = sess(m);
    const info = await repoInfo(s.cwd); if (!info) return json(res, 400, { error: 'pas un dépôt git' });
    const b = await readBody(req);
    const files = (Array.isArray(b.paths) ? b.paths : []).map(f => safeRel(info.root, f));
    const act = m[2];
    if (act === 'stage') await git(info.root, ['add', '--', ...(files.length ? files : ['.'])]);
    else if (act === 'unstage') await git(info.root, ['reset', '-q', 'HEAD', '--', ...(files.length ? files : ['.'])], { allowFail: true });
    else if (act === 'discard') {
      if (!files.length) return json(res, 400, { error: 'aucun fichier' });
      // état de tout le dépôt (un renommage n'est reconnu qu'avec ses deux chemins), limité aux fichiers demandés
      const hit = p => files.some(f => p === f || p.startsWith(f.replace(/\/$/, '') + '/'));
      const st = parseStatus((await git(info.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).out)
        .filter(f => hit(f.path) || (f.from && hit(f.from)));
      const untracked = [], added = [], restore = [];
      for (const f of st) {
        if (f.index === '?') untracked.push(f.path);
        // absent de HEAD (ajouté, copié, ou nouveau chemin d'un renommage) : retiré ; l'ancien chemin est rétabli
        else if (f.index === 'A' || f.work === 'A' || f.index === 'C' || f.index === 'R') { added.push(f.path); if (f.index === 'R') restore.push(f.from); }
        else restore.push(f.path); // connu de HEAD : contenu de HEAD (index et dossier)
      }
      if (added.length) await git(info.root, ['rm', '-q', '-f', '--', ...added], { allowFail: true });
      if (restore.length) await git(info.root, ['checkout', 'HEAD', '--', ...restore]);
      for (const f of [...untracked, ...added]) fs.rmSync(path.join(info.root, f), { force: true, recursive: true });
    } else if (act === 'commit') {
      const msg = String(b.message || '').trim();
      if (!msg) return json(res, 400, { error: 'message vide' });
      if (b.all) await git(info.root, ['add', '-A']);
      await git(info.root, ['commit', '-q', '-F', '-'], { input: msg + '\n' });
    }
    json(res, 200, { ok: true });
  });

  // ---------------------------------------------------------------- worktrees
  // Nouvelle session dans un worktree dédié : <dépôt>.worktrees/<branche>, branche créée depuis HEAD.
  route('POST', /^\/api\/worktree\/session$/, async ({ req, res }) => {
    const b = await readBody(req);
    const lk = ctx.lockedResume?.(b);
    if (lk && !ctx.canAccess?.(lk, req)) return json(res, 423, { error: 'conversation d’une session verrouillée' });
    const info = await repoInfo(b.cwd);
    if (!info) return json(res, 400, { error: 'le dossier n’est pas dans un dépôt git' });
    const branch = String(b.branch || '').trim();
    if (!safeBranch(branch)) return json(res, 400, { error: 'nom de branche invalide' });
    const exists = !(await git(info.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })).code;
    if (exists) return json(res, 400, { error: `la branche « ${branch} » existe déjà` });
    const base = info.branch === 'HEAD' ? (await git(info.root, ['rev-parse', 'HEAD'])).out.trim() : info.branch;
    const dir = path.join(`${info.root}.worktrees`, branch.replace(/[\\/]/g, '-'));
    if (fs.existsSync(dir)) return json(res, 400, { error: `le dossier ${dir} existe déjà` });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(info.root, ['worktree', 'add', '-b', branch, dir, base]);
    // même sous-dossier que le dossier demandé (monorepo : cwd = <racine>/packages/x)
    const sub = path.relative(info.root, path.resolve(b.cwd));
    const cwd = sub && !sub.startsWith('..') ? path.join(dir, sub) : dir;
    const s = createSession({ ...b, cwd, name: b.name || branch, worktree: { path: dir, branch, base, repo: info.root } });
    json(res, 200, publicView(s));
  });

  // Fusionne la branche du worktree dans sa branche de base (dans le dépôt principal).
  route('POST', /^\/api\/sessions\/(\w+)\/worktree\/merge$/, async ({ res, m }) => {
    const s = sess(m);
    const wt = s.worktree; if (!wt) return json(res, 400, { error: 'session sans worktree' });
    const dirty = parseStatus((await git(wt.path, ['status', '--porcelain=v1', '-z'])).out);
    if (dirty.length) return json(res, 400, { error: `${dirty.length} fichier(s) non commités dans le worktree : committe-les d'abord (panneau Modifications)` });
    const main = await repoInfo(wt.repo);
    if (!main) return json(res, 400, { error: 'dépôt principal introuvable' });
    if (main.branch !== wt.base) return json(res, 400, { error: `le dépôt principal est sur « ${main.branch} », pas sur « ${wt.base} » : bascule-le d'abord` });
    const mainDirty = parseStatus((await git(wt.repo, ['status', '--porcelain=v1', '-z', '--untracked-files=no'])).out);
    if (mainDirty.length) return json(res, 400, { error: 'le dépôt principal a des modifications non commitées' });
    const r = await git(wt.repo, ['merge', '--no-ff', '--no-edit', '-m', `Fusion de ${wt.branch} (session « ${s.name} »)`, wt.branch], { allowFail: true });
    if (r.code) {
      await git(wt.repo, ['merge', '--abort'], { allowFail: true });
      return json(res, 409, { error: `conflit de fusion — fusion annulée. Détail : ${(r.out + r.err).trim().split('\n').slice(-2).join(' ')}` });
    }
    json(res, 200, { ok: true, into: wt.base });
  });

  // Supprime le worktree (et la branche si demandé) — la session doit être fermée ou le sera.
  route('POST', /^\/api\/sessions\/(\w+)\/worktree\/remove$/, async ({ req, res, m }) => {
    const s = sess(m);
    const wt = s.worktree; if (!wt) return json(res, 400, { error: 'session sans worktree' });
    const b = await readBody(req);
    killSession(s);
    await new Promise(r => setTimeout(r, 600)); // libère le dossier (Windows)
    const rm = await git(wt.repo, ['worktree', 'remove', ...(b.force ? ['--force'] : []), wt.path], { allowFail: true });
    if (rm.code) return json(res, 400, { error: `suppression impossible : ${rm.err.trim()}${b.force ? '' : ' (des modifications non commitées ? utiliser « forcer »)'}` });
    if (b.deleteBranch) await git(wt.repo, ['branch', b.force ? '-D' : '-d', wt.branch], { allowFail: true });
    sessions.delete(s.id); persist();
    broadcast({ t: 'removed', id: s.id }); ctx.emit('removed', s);
    json(res, 200, { ok: true });
  });

  route('GET', /^\/api\/git\/suggest-branch$/, async ({ res, url }) => {
    const info = await repoInfo(url.searchParams.get('cwd'));
    if (!info) return json(res, 200, { repo: false });
    const name = String(url.searchParams.get('name') || 'session').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session';
    let branch = `csm/${name}`, i = 2;
    while (!(await git(info.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })).code) branch = `csm/${name}-${i++}`;
    json(res, 200, { repo: true, root: info.root, base: info.branch, branch });
  });
};

module.exports.repoInfo = repoInfo;
module.exports.parseStatus = parseStatus;
