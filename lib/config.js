'use strict';
// Emplacements et réglages communs au serveur et à la CLI, par OS.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// --port=N (utilisé par la tâche planifiée / le LaunchAgent, qui ne transmettent pas d'environnement) ou CSM_PORT.
const argPort = (process.argv.find(a => a.startsWith('--port=')) || '').slice(7);
const PORT = Number(argPort || process.env.CSM_PORT || 7890);
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

function defaultDataDir() {
  if (IS_WIN) return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'claude-sessions');
  if (IS_MAC) return path.join(os.homedir(), 'Library', 'Application Support', 'claude-sessions');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'claude-sessions');
}
// Un port non standard a ses propres données (permet de tester sans toucher l'instance principale).
const DATA = process.env.CSM_DATA || (PORT === 7890 ? defaultDataDir() : `${defaultDataDir()}-${PORT}`);
const LEGACY_DATA = path.join(ROOT, 'data'); // v1 : données dans le dossier du code

// Même nom d'instance pour la tâche planifiée / le LaunchAgent / le raccourci.
const SUFFIX = PORT === 7890 ? '' : ` ${PORT}`;
const TASK_NAME = `Claude Sessions Manager${SUFFIX}`;
const LAUNCHD_LABEL = PORT === 7890 ? 'com.claude-sessions.server' : `com.claude-sessions.server.${PORT}`;
const APP_NAME = `Claude Sessions${SUFFIX}`;

// Lancé depuis le Finder/Dock ou launchd, le PATH peut être minimal (/usr/bin:/bin…) si le shell de connexion
// n'a pas répondu à temps : claude (script « #!/usr/bin/env node ») échoue alors en « env: node: No such file
// or directory » (code 127). On complète le PATH avec les emplacements usuels de node/claude, sans rien retirer.
function extraPathDirs() {
  if (IS_WIN) return [];
  const home = os.homedir();
  // Gestionnaires de versions de node d'abord (comme dans le shell) : Homebrew peut porter un claude périmé.
  const dirs = [path.join(home, '.local', 'bin'), path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    path.join(home, '.volta', 'bin')];
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  try { for (const v of fs.readdirSync(nvm).sort().reverse()) dirs.push(path.join(nvm, v, 'bin')); } catch {}
  return [...dirs, path.join(home, '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
}
function addToPath(dirs) {
  const cur = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) if (d && !cur.includes(d) && fs.existsSync(d)) cur.push(d);
  process.env.PATH = cur.join(path.delimiter);
}
addToPath(extraPathDirs());
// Dossier réel d'un exécutable (ex. …/fnm/node-versions/<v>/installation/bin) : contient le node qui l'accompagne.
function addBinDirToPath(bin) {
  if (!bin || !path.isAbsolute(bin)) return;
  const dirs = [path.dirname(bin)];
  try { dirs.push(path.dirname(fs.realpathSync(bin))); } catch {}
  addToPath(dirs);
}

function which(cmd) {
  try {
    const out = execFileSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map(s => s.trim()).find(Boolean) || null;
  } catch { return null; }
}

// fnm expose des dossiers temporaires par shell (…/fnm_multishells/<pid>_…/bin) : on remplace le dossier par
// son emplacement réel (…/node-versions/<v>/installation/bin), en gardant le nom du lien (qui suit les mises à jour).
// Les autres chemins (liens stables comme ~/.local/bin/claude ou /opt/homebrew/bin/node) sont laissés tels quels.
function stablePath(p) {
  if (!p || !/fnm_multishells/.test(p)) return p;
  try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return p; }
}

// claude peut ne pas être dans le PATH d'un service (launchd a un PATH minimal) : emplacements usuels en secours.
// Windows : `where claude` peut renvoyer d'abord le script sans extension d'une installation npm (pour bash),
// que Windows ne sait pas lancer (« Cannot create process, error code: 193 ») ; seuls .exe, .cmd et .bat sont
// exécutables. Une installation npm seule (claude.cmd) est lancée par node avec le script de Claude Code
// (arguments transmis tels quels, sans passer par cmd.exe), via CSM_CLAUDE_ARGS comme les autres lancements.
function whichAll(cmd) {
  try {
    const out = execFileSync(IS_WIN ? 'where' : 'which', IS_WIN ? [cmd] : ['-a', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}
function winClaude(list) {
  const exe = list.find(p => /\.exe$/i.test(p));
  if (exe) return exe;
  const shim = list.find(p => /\.(cmd|bat)$/i.test(p));
  if (!shim) return null;
  const cli = path.join(path.dirname(shim), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  const node = whichAll('node').find(p => /\.exe$/i.test(p));
  if (node && fs.existsSync(cli)) {
    if (!(process.env.CSM_CLAUDE_ARGS || '').includes(cli)) process.env.CSM_CLAUDE_ARGS =`"${cli}"${process.env.CSM_CLAUDE_ARGS ? ' ' + process.env.CSM_CLAUDE_ARGS : ''}`;
    return node;
  }
  return shim;
}

function resolveClaude() {
  if (process.env.CSM_CLAUDE) return process.env.CSM_CLAUDE;
  if (IS_WIN) {
    const native = path.join(os.homedir(), '.local', 'bin', 'claude.exe'); // installeur officiel
    const found = winClaude([...whichAll('claude'), ...(fs.existsSync(native) ? [native] : []),
      path.join(process.env.APPDATA || '', 'npm', 'claude.cmd')].filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }));
    return found || 'claude';
  }
  // Plusieurs Claude Code possibles (installeur, fnm/nvm, Homebrew…) : le plus récent, pas le premier du PATH.
  // Un claude Homebrew périmé, pris pendant une mise à jour de l'autre (fichier absent un instant), lançait des
  // sessions qui s'arrêtaient aussitôt (option inconnue : Remote Control) et ne proposaient que d'anciens modèles.
  const home = os.homedir();
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  let nvmBins = []; try { nvmBins = fs.readdirSync(nvm).map(v => path.join(nvm, v, 'bin', 'claude')); } catch {}
  const list = [...new Set([...whichAll('claude').map(stablePath), path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'claude'), ...nvmBins, path.join(home, '.volta', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'])]
    .filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  return pickNewest(list, claudeVersion) || 'claude';
}
// « 2.1.310 (Claude Code) » → [2, 1, 310] ; null si illisible
function claudeVersion(bin) {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? m.slice(1).map(Number) : null;
  } catch { return null; }
}
// le plus récent d'une liste (à version égale ou illisible : l'ordre de la liste, donc celui du PATH)
function pickNewest(list, versionOf) {
  if (list.length < 2) return list[0] || null;
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  let best = null, bestV = null;
  for (const p of list) {
    const v = versionOf(p);
    if (v && (!bestV || cmp(v, bestV) > 0)) { best = p; bestV = v; }
  }
  return best || list[0];
}

module.exports = { winClaude, addBinDirToPath, stablePath, ROOT, PORT, IS_WIN, IS_MAC, DATA, LEGACY_DATA, TASK_NAME, LAUNCHD_LABEL, APP_NAME, which, resolveClaude, pickNewest };
