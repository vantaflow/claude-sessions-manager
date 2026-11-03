'use strict';
// Coffre : organisation Azure DevOps d'un dossier (remote « origin » de son dépôt git, lu dans .git/config, sans
// lancer git : le lancement d'une session n'attend jamais), et vérification en lecture seule qu'un PAT y marche.
const fs = require('fs');
const path = require('path');

const ORG = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;

// dossier du dépôt (.git) au-dessus de cwd ; worktree : .git est un fichier « gitdir: … », la config est dans le
// dépôt commun (commondir)
function gitDir(cwd) {
  let d = path.resolve(cwd || '.');
  for (let i = 0; i < 40; i++) {
    const g = path.join(d, '.git');
    try {
      const st = fs.statSync(g);
      if (st.isDirectory()) return g;
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(g, 'utf8'));
      if (!m) return '';
      const wt = path.resolve(d, m[1].trim());
      try { return path.resolve(wt, fs.readFileSync(path.join(wt, 'commondir'), 'utf8').trim()); } catch { return wt; }
    } catch { }
    const up = path.dirname(d);
    if (up === d) return '';
    d = up;
  }
  return '';
}

function remoteUrl(cwd) {
  const g = gitDir(cwd);
  if (!g) return '';
  let txt; try { txt = fs.readFileSync(path.join(g, 'config'), 'utf8'); } catch { return ''; }
  let inOrigin = false, first = '';
  for (const line of txt.split(/\r?\n/)) {
    const sec = /^\s*\[remote\s+"([^"]+)"\]/.exec(line);
    if (sec) { inOrigin = sec[1] === 'origin'; continue; }
    if (/^\s*\[/.test(line)) { inOrigin = false; continue; }
    const u = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (u) { if (inOrigin) return u[1]; if (!first) first = u[1]; }
  }
  return first;
}

function orgFromUrl(url) {
  const u = String(url || '');
  const m = /dev\.azure\.com[:/](?:v3\/)?([^/@\s]+)\//i.exec(u) || /([A-Za-z0-9-]+)\.visualstudio\.com/i.exec(u.replace(/@vs-ssh\.visualstudio\.com.*/i, '.visualstudio.com'));
  const org = m ? decodeURIComponent(m[1]) : '';
  return ORG.test(org) && org.toLowerCase() !== 'vs-ssh' ? org : '';
}
const orgOf = cwd => orgFromUrl(remoteUrl(cwd));

// 'ok' | 'refused' | 'error'. Azure DevOps répond 200 même à un PAT invalide, en connexion anonyme
// (authenticatedUser « System:PublicAccess », id aaaaaaaa-…) : seul un utilisateur identifié compte comme accepté.
// 203, 302, 401, 403 : refusé (page de connexion, ou accès interdit).
async function verify(org, pat, { fetch = globalThis.fetch, timeout = 8000, base = process.env.CSM_AZDO_BASE || 'https://dev.azure.com' } = {}) {
  if (!ORG.test(org || '') || !pat) return 'error';
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(`${base}/${encodeURIComponent(org)}/_apis/connectionData`, { headers: { Authorization: 'Basic ' + Buffer.from(':' + pat).toString('base64'), Accept: 'application/json' }, redirect: 'manual', signal: ac.signal });
    if (r.status === 200) {
      let d = null; try { d = await r.json(); } catch { return 'error'; }
      const u = d && d.authenticatedUser;
      if (!u || !u.id) return 'error';
      return /^System:PublicAccess/i.test(u.descriptor || '') || /^a{8}-a{4}-/.test(u.id) ? 'refused' : 'ok';
    }
    if ([203, 302, 401, 403].includes(r.status)) return 'refused';
    return 'error';
  } catch { return 'error'; } finally { clearTimeout(t); }
}

module.exports = { orgOf, orgFromUrl, remoteUrl, verify, ORG };
