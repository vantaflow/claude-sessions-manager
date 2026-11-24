'use strict';
// Accès depuis l'app Claude (téléphone) / claude.ai/code : fonction Remote Control de Claude Code (#28).
// Claude Code s'en charge entièrement (connexion sortante HTTPS via Anthropic, aucun port ouvert) :
// ici on la demande au lancement (--remote-control "<nom>") ou on la bascule dans une session ouverte
// (/remote-control). Nécessite un abonnement claude.ai (Pro, Max, Team, Enterprise), pas une clé API.
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = function (ctx) {
  const { route, json, readBody, sessions, publicView, persist, broadcast } = ctx;

  // Arguments ajoutés au lancement d'une session (lu par spawnSession).
  // Remote Control pour toutes les sessions (réglage remoteAll, activé par défaut depuis 3.77) : seulement avec un
  // compte claude.ai connecté (Remote Control n'existe pas avec une clé API). Sert aussi aux messages entre
  // sessions de machines différentes : Claude Code ne joint une session d'une autre machine que par Remote Control.
  const claudeAiAccount = () => {
    try { return !!JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json'), 'utf8')).oauthAccount?.accountUuid; } catch { return false; }
  };
  ctx.remoteArgs = s => {
    const all = ctx.getSettings?.().remoteAll && s.remote !== false && claudeAiAccount();
    if (!(s.remote || all)) return [];
    // nom commençant par « - » : lu par Claude Code comme une option (session qui s'arrête aussitôt)
    return ['--remote-control', String(s.name || '').replace(/^[\s-]+/, '').slice(0, 60).trim() || 'csm'];
  };

  route('POST', /^\/api\/sessions\/(\w+)\/remote$/, async ({ req, res, m }) => {
    const s = sessions.get(m[1]); if (!s) return json(res, 404, { error: 'session inconnue' });
    const { on } = await readBody(req);
    const want = !!on;
    const was = !!(s.remote || (ctx.getSettings?.().remoteAll && s.remote !== false));
    s.remote = want;
    persist(); broadcast({ t: 'session', s: publicView(s) });
    // Session ouverte : /remote-control bascule l'état sans relancer (la conversation continue).
    if (s.pty && want !== was) {
      s.pty.write('\x1b[200~/remote-control\x1b[201~');
      setTimeout(() => { if (s.pty) s.pty.write('\r'); }, 150);
    }
    json(res, 200, publicView(s));
  });
};
