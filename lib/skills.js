'use strict';
// Skills disponibles dans une session (seulement les skills, pas les commandes commands/*.md) : ceux du dossier
// (.claude/skills), les personnels (~/.claude/skills) et ceux des plugins activés. Pour chacun : la commande qui
// l'appelle (/nom ou /plugin:nom), sa description (en-tête du SKILL.md) et d'où il vient.
const fs = require('fs');
const path = require('path');
const os = require('os');

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const NAME = /^[\w.-]{1,80}$/;

// En-tête YAML simple (clé: valeur, valeur entre guillemets, bloc « > » ou « | » sur plusieurs lignes).
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][+-]?$/.test(v) || v === '') {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[i + 1]) && !/^[\w-]+:/.test(lines[i + 1])) block.push(lines[++i].trim());
      v = block.join(' ').trim();
    } else if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1).replace(/\\"/g, '"');
    out[kv[1]] = v;
  }
  return out;
}
// Sans en-tête : première ligne de texte (hors titre vide) comme description.
function firstLine(text) {
  const body = text.replace(/^---[\s\S]*?\n---\r?\n?/, '');
  const l = body.split(/\r?\n/).map(x => x.replace(/^#+\s*/, '').trim()).find(Boolean);
  return l || '';
}
const clip = s => (s.length > 600 ? s.slice(0, 597) + '…' : s);

function read(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
function dirs(d) { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => e.name); } catch { return []; } }

// skills/<nom>/SKILL.md d'une racine.
function scanRoot(root, { source, plugin = '' }) {
  const out = [];
  const pre = plugin ? plugin + ':' : '';
  for (const d of dirs(path.join(root, 'skills'))) {
    const text = read(path.join(root, 'skills', d, 'SKILL.md'));
    if (text == null) continue;
    const fm = frontmatter(text);
    if (String(fm['user-invocable']) === 'false') continue; // réservé à Claude, pas appelable par /
    const name = NAME.test(fm.name || '') ? fm.name : d;
    out.push({ kind: 'skill', name, command: '/' + pre + name, description: clip(fm.description || firstLine(text)), source, plugin, args: fm['argument-hint'] || '' });
  }
  return out;
}

// Plugins activés : installés (installed_plugins.json) et non désactivés dans les réglages personnels ou du dossier.
function plugins(cwd, override = {}) {
  const dir = claudeDir();
  const inst = readJson(path.join(dir, 'plugins', 'installed_plugins.json')) || {};
  const enabled = { ...(readJson(path.join(dir, 'settings.json'))?.enabledPlugins || {}) };
  if (cwd) for (const f of ['settings.json', 'settings.local.json']) Object.assign(enabled, readJson(path.join(cwd, '.claude', f))?.enabledPlugins || {});
  Object.assign(enabled, override); // réglages passés par l'app à ses sessions (--settings)
  const out = [];
  for (const [key, list] of Object.entries(inst.plugins || {})) {
    if (enabled[key] === false) continue;
    const e = (Array.isArray(list) ? list : [list]).find(x => x?.installPath && (x.scope !== 'project' && x.scope !== 'local' || !x.projectPath || (cwd && path.resolve(x.projectPath) === path.resolve(cwd))));
    if (!e) continue;
    const name = readJson(path.join(e.installPath, '.claude-plugin', 'plugin.json'))?.name || key.split('@')[0];
    out.push({ key, name, root: e.installPath });
  }
  return out;
}

function listSkills(cwd, override) {
  const all = [];
  if (cwd) all.push(...scanRoot(path.join(cwd, '.claude'), { source: 'project' }));
  all.push(...scanRoot(claudeDir(), { source: 'user' }));
  for (const p of plugins(cwd, override)) all.push(...scanRoot(p.root, { source: 'plugin', plugin: p.name }));
  // même commande à deux endroits : le dossier passe avant le personnel (comme Claude Code)
  const seen = new Set();
  return all.filter(s => !seen.has(s.command) && seen.add(s.command));
}

module.exports = function (ctx) {
  const { route, json, sessions } = ctx;
  route('GET', /^\/api\/skills$/, async ({ res, url }) => {
    let cwd = url.searchParams.get('cwd') || '';
    const sid = url.searchParams.get('session');
    if (sid && sessions.get(sid)) cwd = sessions.get(sid).cwd || cwd;
    if (cwd && !fs.existsSync(cwd)) cwd = '';
    // comme sessionSettings (server.js) : claude-mem coupé dans les sessions de l'app quand la mémoire IA est active
    const st = ctx.getSettings?.() || {};
    json(res, 200, listSkills(cwd, { 'claude-mem@thedotmack': (st.memoryEngine || 'native') === 'claude-mem' && st.memoryAI === false }));
  });
};
module.exports.listSkills = listSkills;
module.exports.frontmatter = frontmatter;
