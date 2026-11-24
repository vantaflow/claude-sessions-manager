'use strict';
// Dossier de la session approuvé d'avance pour Claude Code (réglage trustFolders, activé par défaut) : plus de
// question « Do you trust the files in this folder? » au lancement d'une session, quel que soit le dossier.
// Claude Code garde ce choix dans ~/.claude.json (ou $CLAUDE_CONFIG_DIR/.claude.json) :
// projects[<dossier>].hasTrustDialogAccepted, clé en barres obliques (C:/Users/… sous Windows).
const fs = require('fs');
const os = require('os');
const path = require('path');

const configFile = (env = process.env) => path.join(env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
const keyOf = dir => path.resolve(dir).replace(/\\/g, '/');

// true si le dossier est déjà approuvé, ou vient de l'être (le dossier lui-même : un parent approuvé ne suffit
// pas à toutes les versions de Claude Code)
function trustFolder(dir, file = configFile()) {
  if (!dir) return false;
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') return false; }
  let cfg;
  try { cfg = raw.trim() ? JSON.parse(raw) : {}; } catch { return false; } // illisible : jamais réécrit
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false;
  const projects = cfg.projects && typeof cfg.projects === 'object' ? cfg.projects : (cfg.projects = {});
  const key = keyOf(dir);
  if (projects[key]?.hasTrustDialogAccepted === true) return true;
  projects[key] = { ...(projects[key] || {}), hasTrustDialogAccepted: true };
  // écriture atomique (fichier temporaire puis renommage) : Claude Code ne lit jamais un fichier à moitié écrit
  const tmp = `${file}.csm-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { }
    return false;
  }
}

module.exports = { trustFolder, configFile, keyOf };
