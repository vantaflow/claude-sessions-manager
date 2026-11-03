'use strict';
// Serveur MCP (stdio) « csm-memoire » : donne à Claude la recherche dans la mémoire IA de Claude Sessions,
// toutes machines et tous dossiers. Passé à chaque session lancée par l'app (--mcp-config, voir lib/memai/
// index.js). Il ne lit rien lui-même : il interroge le serveur local de l'app (CSM_PORT) avec le jeton des
// hooks (CSM_TOKEN), qui n'ouvre que la lecture de la mémoire. JSON-RPC 2.0, un message par ligne.
const http = require('http');
const { CSM_PORT, CSM_TOKEN } = process.env;

const TOOLS = [
  { name: 'chercher', description: 'Cherche dans la mémoire des sessions précédentes (résumés et observations : décisions, corrections, découvertes, choses à faire, préférences), toutes machines confondues. Renvoie une liste courte avec des identifiants à passer à `details`.',
    inputSchema: { type: 'object', properties: {
      q: { type: 'string', description: 'Mots à chercher (français ou anglais)' },
      dossier: { type: 'string', description: 'Limiter à un dossier, forme portable ({home}/Projects/x)' },
      type: { type: 'string', enum: ['resume', 'decision', 'fix', 'discovery', 'change', 'todo', 'preference'] },
      depuis: { type: 'string', description: 'Date ISO (AAAA-MM-JJ) : seulement depuis cette date' },
      nombre: { type: 'number', description: 'Nombre de résultats (10 par défaut, 50 au plus)' },
    }, required: ['q'] } },
  { name: 'details', description: 'Contenu complet d’un résumé de session ou d’une observation, par son identifiant (donné par `chercher`).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'chronologie', description: 'Ce qui s’est passé autour d’un résultat : les observations de la même session et le résumé de la session précédente du même dossier.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
];

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: Number(CSM_PORT), path: p, method: 'GET', timeout: 8000,
      headers: { 'X-CSM-Token': CSM_TOKEN || '', Host: `127.0.0.1:${CSM_PORT}` } }, res => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', c => { b += c; });
      res.on('end', () => { try { const o = JSON.parse(b || '{}'); res.statusCode >= 400 ? reject(new Error(o.error || 'erreur ' + res.statusCode)) : resolve(o); } catch { reject(new Error('réponse illisible')); } });
    });
    req.on('error', () => reject(new Error('Claude Sessions ne répond pas (application fermée ?)')));
    req.on('timeout', () => { req.destroy(); reject(new Error('délai dépassé')); });
    req.end();
  });
}

async function call(name, a = {}) {
  if (name === 'chercher') {
    const qs = new URLSearchParams({ q: String(a.q || '') });
    if (a.dossier) qs.set('project', a.dossier);
    if (a.type) qs.set('type', a.type);
    if (a.depuis) qs.set('since', String(Date.parse(a.depuis) || 0));
    if (a.nombre) qs.set('limit', String(a.nombre));
    const hits = await get('/api/memory/ai/search?' + qs);
    if (!hits.length) return 'Rien trouvé.';
    return hits.map(h => `${h.id} · ${h.kind === 'resume' ? 'session' : h.type} · ${new Date(h.date).toISOString().slice(0, 10)} · ${h.machine || '?'} · ${h.project || ''}\n  ${h.title}`).join('\n');
  }
  if (name === 'details' || name === 'chronologie') {
    const id = String(a.id || '').trim();
    if (!/^[\w-]{6,60}(:\d{1,6})?$/.test(id)) throw new Error('identifiant invalide : ' + id);
    return (await get(`/api/memory/ai/${name === 'details' ? 'item' : 'timeline'}/${id}`)).text;
  }
  throw new Error('outil inconnu : ' + name);
}

const send = o => process.stdout.write(JSON.stringify(o) + '\n');
async function handle(m) {
  if (!m || m.jsonrpc !== '2.0' || m.id === undefined) return; // notifications : rien à répondre
  const ok = result => send({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') return ok({ protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'csm-memoire', version: '1' } });
  if (m.method === 'tools/list') return ok({ tools: TOOLS });
  if (m.method === 'ping') return ok({});
  if (m.method === 'tools/call') {
    try { return ok({ content: [{ type: 'text', text: await call(m.params?.name, m.params?.arguments) }] }); } catch (e) { return ok({ content: [{ type: 'text', text: e.message }], isError: true }); }
  }
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'méthode inconnue' } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    handle(m);
  }
});
process.stdin.on('end', () => process.exit(0));
