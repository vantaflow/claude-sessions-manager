'use strict';
// Hook Claude Code -> Claude Sessions Manager. Ne doit jamais bloquer ni échouer la session.
const http = require('http');
const [, , event] = process.argv;
const { CSM_ID, CSM_PORT, CSM_TOKEN } = process.env;
if (!CSM_ID || !CSM_PORT) process.exit(0);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', send);
setTimeout(send, 4000); // Claude envoie normalement tout de suite ; filet si stdin ne se ferme pas

let sent = false;
function send() {
  if (sent) return; sent = true;
  let data = {};
  try { data = JSON.parse(input || '{}'); } catch { }
  const body = JSON.stringify({
    csm: CSM_ID, event,
    data: { session_id: data.session_id, message: data.message, tool_name: data.tool_name, source: data.source,
      // début du message envoyé (UserPromptSubmit) : reconnaît la demande du plafond de quota (lib/quotastop.js) ; local seulement
      ...(typeof data.prompt === 'string' ? { prompt: data.prompt.slice(0, 200) } : {}) },
  });
  const req = http.request({
    host: '127.0.0.1', port: Number(CSM_PORT), path: '/api/hook', method: 'POST', timeout: 8000,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-CSM-Token': CSM_TOKEN, Host: `127.0.0.1:${CSM_PORT}` },
  }, res => {
    // SessionStart : le serveur renvoie la mémoire des sessions précédentes, donnée à Claude comme contexte
    let out = '';
    res.setEncoding('utf8');
    res.on('data', c => { if (event === 'start') out += c; });
    res.on('end', () => {
      try {
        // display : résumé de la mémoire IA montré à l'utilisateur dans le terminal (systemMessage)
        const { context, display } = JSON.parse(out || '{}');
        if (context || display) process.stdout.write(JSON.stringify({ ...(display ? { systemMessage: display } : {}), ...(context ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } } : {}) }));
      } catch { }
      process.exit(0);
    });
  });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(body);
}
