'use strict';
// Faux Claude Code pour les tests : même interface que claude pour ce qu'utilise Claude Sessions
// (--settings avec hooks, --resume, transcript .jsonl, invite interactive, collage entre crochets).
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');

const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
if (argv.includes('--version')) { console.log('0.0.0 (faux claude)'); process.exit(0); }
// FAKE_NO_NAME=1 : ancienne version de Claude Code, sans --name
if (argv.includes('--help')) { console.log(`Usage: claude [options]\n  -r, --resume [value]  Resume a conversation${process.env.FAKE_NO_NAME ? '' : '\n  -n, --name <name>  Set a display name for this session'}`); process.exit(0); }
if (process.env.FAKE_NO_NAME && (argv.includes('--name') || argv.includes('-n'))) { console.error("error: unknown option '--name'"); process.exit(1); }
// `claude plugin marketplace add <repo>` / `plugin install|uninstall <nom@marketplace>` : registres de Claude Code
if (argv[0] === 'plugin') {
  const dir = path.join(os.homedir(), '.claude', 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  const rd = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return {}; } };
  const wr = (f, v) => fs.writeFileSync(path.join(dir, f), JSON.stringify(v));
  if (argv[1] === 'marketplace' && argv[2] === 'add') {
    if (/introuvable/.test(argv[3])) { console.error('Failed to add marketplace'); process.exit(1); }
    const m = rd('known_marketplaces.json'); m[argv[3].split('/')[1]] = { source: { source: 'github', repo: argv[3] } }; wr('known_marketplaces.json', m);
  } else if (argv[1] === 'install' || argv[1] === 'uninstall') {
    const i = rd('installed_plugins.json'); i.version = 2; i.plugins = i.plugins || {};
    if (argv[1] === 'install') i.plugins[argv[2]] = [{ scope: 'user', installPath: path.join(dir, 'cache', argv[2]), version: '1.0.0' }];
    else delete i.plugins[argv[2]];
    wr('installed_plugins.json', i);
  }
  console.log('ok'); process.exit(0);
}
// `claude auth status --json` : connecté si le fichier de connexion existe (code 1 sinon, comme Claude Code)
if (argv[0] === 'auth' && argv[1] === 'status') {
  const on = fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json'));
  console.log(JSON.stringify({ loggedIn: on, authMethod: on ? 'claude.ai' : 'none' }));
  process.exit(on ? 0 : 1);
}
// `claude auth login` : lien de connexion, attend le code collé, puis écrit une connexion valable 30 jours
if (argv[0] === 'auth' && argv[1] === 'login') {
  process.stdout.write('Opening browser to sign in…\r\nIf the browser didn\'t open, visit: \x1b]8;id=1;https://claude.com/cai/oauth/authorize?code=true&state=test\x07https://claude.com/cai/oauth/authorize?code=true&state=test\x1b]8;;\x07\r\nPaste code here if prompted > ');
  let b = '';
  process.stdin.setRawMode?.(true);
  process.stdin.on('data', d => {
    b += d;
    if (!b.includes('\r')) return;
    if (b.trim() !== 'CODE-OK') { process.stdout.write('\r\nInvalid code\r\n'); process.exit(1); }
    const f = path.join(os.homedir(), '.claude', '.credentials.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + 8 * 3600e3, refreshTokenExpiresAt: Date.now() + 30 * 86400e3 } }));
    process.stdout.write('\r\nLogin successful.\r\n');
    process.exit(0);
  });
  return;
}
// `claude -p` (analyse de la mémoire IA, lib/memai) : appel noté dans ~/.fake-ai-calls.jsonl ; réponse JSON
// avec structured_output (FAKE_AI_OUT : fichier de la réponse ; FAKE_AI_FAIL=1 : erreur d'API)
if (argv.includes('-p')) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { input += d; });
  process.stdin.on('end', async () => {
    if (process.env.FAKE_AI_DELAY) await new Promise(r => setTimeout(r, Number(process.env.FAKE_AI_DELAY))); // analyse lente (test)
    fs.appendFileSync(path.join(os.homedir(), '.fake-ai-calls.jsonl'), JSON.stringify({ args: argv, env: { CSM_ID: process.env.CSM_ID, CSM_PORT: process.env.CSM_PORT }, cwd: process.cwd(), input }) + '\n');
    if (process.env.FAKE_AI_FAIL === '1') { console.log(JSON.stringify({ type: 'result', is_error: true, result: 'API Error: 529 overloaded' })); process.exit(0); }
    const first = (input.match(/Demande : (.*)/) || [, 'inconnu'])[1].slice(0, 40);
    const out = process.env.FAKE_AI_OUT ? JSON.parse(fs.readFileSync(process.env.FAKE_AI_OUT, 'utf8')) : {
      summary: { title: 'Sujet : ' + first, request: 'La demande.', state: 'Fait.', next: 'rien' },
      observations: [{ type: 'decision', title: 'Choix fait', body: 'Parce que.', files: [], keywords: ['choix', 'choice'] }],
    };
    console.log(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(out), structured_output: out }));
    process.exit(0);
  });
  return;
}

const settings = JSON.parse(fs.readFileSync(opt('--settings'), 'utf8'));
const resume = opt('--resume');
const fork = argv.includes('--fork-session');
const sessionId = resume && !fork ? resume : crypto.randomUUID();
const cwd = process.cwd();
const dir = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, `${sessionId}.jsonl`);
// comme Claude Code : --resume ne cherche la conversation que dans le dossier de travail ; rangée sous un autre
// dossier, « No conversation found » et arrêt (une conversation absente partout reste acceptée : session neuve)
if (resume && !fork && !fs.existsSync(transcript) && fs.readdirSync(path.dirname(dir)).some(d => fs.existsSync(path.join(path.dirname(dir), d, `${resume}.jsonl`)))) {
  process.stdout.write(`No conversation found with session ID: ${resume}\r\n`);
  process.exit(1);
}
if (resume && fork) { const src = fs.readdirSync(path.dirname(dir)).map(d => path.join(path.dirname(dir), d, `${resume}.jsonl`)).find(fs.existsSync); if (src) fs.copyFileSync(src, transcript); }
// variables claude-mem reçues (test de la mémoire synchronisée)
if (process.env.CSM_ID && process.env.CLAUDE_MEM_DATA_DIR) fs.writeFileSync(path.join(process.env.CLAUDE_MEM_DATA_DIR, `env-${process.env.CSM_ID}.json`), JSON.stringify({ CLAUDE_MEM_DATA_DIR: process.env.CLAUDE_MEM_DATA_DIR, CLAUDE_MEM_WORKER_PORT: process.env.CLAUDE_MEM_WORKER_PORT }));
fs.writeFileSync(path.join(dir, `${sessionId}.settings.json`), JSON.stringify(settings)); // réglages reçus par --settings (test)
fs.writeFileSync(path.join(dir, `${sessionId}.args.json`), JSON.stringify(argv)); // arguments reçus (test : --mcp-config)
// processus en cours par session (~/.fake-pids/<CSM_ID>-<pid>) : repère un claude laissé orphelin (test)
if (process.env.CSM_ID) { const pd = path.join(os.homedir(), '.fake-pids'); fs.mkdirSync(pd, { recursive: true }); fs.writeFileSync(path.join(pd, `${process.env.CSM_ID}-${process.pid}`), ''); }
const log = o => fs.appendFileSync(transcript, JSON.stringify({ ...o, sessionId, cwd, timestamp: new Date().toISOString() }) + '\n');

function hook(ev, data = {}) {
  return Promise.all((settings.hooks[ev] || []).flatMap(h => h.hooks).map(h => new Promise(res => {
    // comme Claude Code : le contexte renvoyé par le hook SessionStart est donné à Claude (ici, gardé dans un fichier)
    const p = exec(h.command, { env: process.env }, (err, stdout) => {
      try { const c = ev === 'SessionStart' && stdout.trim() && JSON.parse(stdout).hookSpecificOutput?.additionalContext; if (c) fs.writeFileSync(path.join(dir, `${sessionId}.context.txt`), c); } catch { }
      res();
    });
    p.stdin.end(JSON.stringify({ session_id: sessionId, hook_event_name: ev, cwd, ...data }));
  })));
}

const out = s => process.stdout.write(s);
let turn = 0;
const queued = []; // comme Claude Code : un message tapé pendant un tour part au tour suivant
let pending = null; // 'busy' : long tour qui finit seul ; 'long' : réponse en cours (Ctrl+C l'interrompt) ; 'ask' : attend une permission (Entrée répond)
async function prompt(text) {
  turn++;
  log({ type: 'user', message: { role: 'user', content: text }, uuid: crypto.randomUUID() });
  await hook('UserPromptSubmit', { prompt: text });
  await hook('PreToolUse', { tool_name: 'Read' });
  // comme Claude Code : Ctrl+C n'appelle aucun hook, seule une ligne est ajoutée au transcript
  if (/longue/.test(text)) { pending = 'long'; out('\r\n✻ réfléchit…'); return; }
  if (/travail-long/.test(text)) { // long tour qui se termine seul ; les messages reçus entre-temps partent ensuite
    pending = 'busy'; out('\r\n✻ travaille…');
    for (let k = 0; k < 6; k++) { await new Promise(r => setTimeout(r, 400)); await hook('PreToolUse', { tool_name: 'Bash' }); }
    out(`\r\n● echo: ${text}\r\n`); await hook('Stop'); out('\r\n❯ ');
    pending = null;
    for (const l of queued.splice(0)) await prompt(l);
    return;
  }
  // compactage automatique en plein tour : SessionStart (source compact) du même processus, puis le tour continue
  if (/compacte/.test(text)) { await hook('SessionStart', { source: 'compact' }); out('\r\nCOMPACTÉ\r\n'); await new Promise(r => setTimeout(r, 1500)); }
  if (/demande/.test(text)) { pending = 'ask'; await hook('Notification', { message: 'Claude needs your permission' }); out('\r\nDo you want to proceed? ❯ 1. Yes'); return; }
  const images = (text.match(/\S+\.(png|jpe?g|gif|webp)/gi) || []).length;
  const reply = `echo: ${text.replace(/\S+\.(png|jpe?g|gif|webp)/gi, m => `[Image #${images}]`)}`;
  log({ type: 'assistant', message: { id: `msg_${turn}_${sessionId.slice(0, 6)}`, model: 'claude-haiku-4-5', role: 'assistant',
    content: [{ type: 'text', text: reply }, { type: 'tool_use', name: 'Read', input: { file_path: path.join(cwd, 'README.md') } }],
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } });
  // session d'un type d'extension : consignes reçues (--append-system-prompt) et vue écrite dans CSM_VIEW_FILE
  if (/montre-consignes/.test(text)) out(`\r\nCONSIGNES:${(opt('--append-system-prompt') || '').split('\n')[0]}|VUE:${process.env.CSM_VIEW_FILE ? 'oui' : 'non'}\r\n`);
  if (/ecris-vue/.test(text) && process.env.CSM_VIEW_FILE) {
    fs.writeFileSync(process.env.CSM_VIEW_FILE, JSON.stringify({
      title: 'Analyse <b>test</b>', meta: [{ label: 'État', value: 'Active' }],
      sections: [
        { kind: 'text', title: 'Constat', text: 'Tout <script>alert(1)</script> va bien' },
        { kind: 'checklist', title: 'Actions', items: [{ label: 'Publier', done: false }] },
        { kind: 'draft', title: 'Commentaire', text: 'Bonjour', actions: [{ label: 'Publier', send: 'publie : {draft}' }] },
        { kind: 'inconnu', text: 'ignoré' },
      ],
    }));
  }
  // publication : l'affichage est réécrit (état « publié »)
  if (/publie :/.test(text) && process.env.CSM_VIEW_FILE) fs.writeFileSync(process.env.CSM_VIEW_FILE, JSON.stringify({ title: 'Publié', sections: [{ kind: 'text', text: 'publié' }] }));
  if (/montre-jeton/.test(text)) out(`\r\nJETON:${process.env.CSM_TOKEN}\r\n`);
  if (/touch (\S+)/.test(text)) fs.writeFileSync(path.join(cwd, RegExp.$1), `créé par le faux claude (${turn})\n`);
  out(`\r\n● ${reply}\r\n`);
  if (/attends/.test(text)) await hook('Notification', { message: 'Claude attend ta permission' });
  if (/quota-limite/.test(text)) out('\r\n  ⎿  5-hour limit reached ∙ resets 3am\r\n'); // message de Claude Code à la limite
  await hook('Stop');
  out('\r\n❯ ');
}

(async () => {
  await hook('SessionStart', { source: resume ? 'resume' : 'startup' });
  if (argv.includes('--remote-control')) out(`REMOTE:${opt('--remote-control')}\r\n`);
  if (settings.language) out(`LANGUE:${settings.language}\r\n`);
  // nom de la session pour les autres sessions : --name, sinon la dernière entrée agent-name de la conversation
  const agentName = opt('--name') || (fs.existsSync(transcript) ? fs.readFileSync(transcript, 'utf8').split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(o => o && o.type === 'agent-name').map(o => o.agentName).pop() : undefined);
  if (agentName) out(`NOM:${agentName}\r\n`);
  out(`AFFICHAGE:${process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN === '1' ? 'classique' : 'plein-ecran'}\r\n`);
  out(`SIGNATURE:${settings.attribution ? JSON.stringify(settings.attribution) + '|' + settings.includeCoAuthoredBy : 'claude'}\r\n`);
  out(`FAUX CLAUDE prêt${resume ? '(reprise ' + resume.slice(0, 8) + ')' : ''} — session ${sessionId}\r\n❯ `);
  let buf = '';
  process.stdin.setRawMode?.(true);
  process.stdin.on('data', d => {
    buf += d.toString('utf8');
    buf = buf.replace(/\x1b\[20[01]~/g, '');
    if (pending === 'long' && buf.includes('\x03')) {
      buf = ''; pending = null;
      log({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, uuid: crypto.randomUUID() });
      out('\r\n  ⎿ Interrupted · What should Claude do instead?\r\n❯ ');
      return;
    }
    // comme Claude Code : 1 / 2 / Échap répondent directement à une demande d'autorisation (Entrée = choix courant)
    if (pending === 'ask' && /[\r\n12\x1b]/.test(buf)) {
      const r = (buf.match(/[12\x1b]/) || ['1'])[0];
      buf = ''; pending = null;
      out(`\r\nAUTORISATION:${r === '\x1b' ? 'non' : r === '2' ? 'toujours' : 'oui'}`);
      hook('Stop').then(() => out('\r\n❯ '));
      return;
    }
    let i;
    while ((i = buf.search(/[\r\n]/)) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line === '/exit') { hook('SessionEnd').then(() => process.exit(0)); return; }
      if (line.startsWith('/rename ')) { log({ type: 'agent-name', agentName: line.slice(8) }); out(`\r\nRENOMMÉE:${line.slice(8)}\r\n❯ `); continue; }
      if (line && pending === 'busy') queued.push(line);
      else if (line) prompt(line);
    }
  });
})();
