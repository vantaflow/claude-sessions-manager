'use strict';
// Discussion d'avant la dernière compaction d'une conversation Claude Code, mise en forme pour le terminal.
// À la reprise d'une conversation compactée, Claude Code n'affiche que ce qui suit la compaction
// (« Conversation compacted ») : l'app affiche le reste au-dessus, depuis le transcript (synchronisé entre les
// machines, donc aussi ailleurs). Lu en flux : un transcript dépasse parfois 100 Mo.
const fs = require('fs');
const readline = require('readline');

const DIM = '\x1b[90m', BOLD = '\x1b[1m', RST = '\x1b[0m';
const MAX = 300 * 1024; // texte gardé (la fin de la discussion d'avant la compaction)
const clip = (t, n) => (t.length > n ? t.slice(0, n) + '…' : t);
const nl = t => t.replace(/\r?\n/g, '\r\n');
// message de l'utilisateur affichable : pas les retours d'outils, rappels, notifications ni commandes
function userText(o) {
  if (o.isMeta || o.isCompactSummary || o.message?.role !== 'user') return '';
  const c = o.message.content;
  const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x?.type === 'text').map(x => x.text).join('\n') : '';
  const s = String(t || '').trim();
  return !s || s.startsWith('<') ? '' : s;
}
function toolLine(x) {
  const i = x.input || {};
  const arg = i.command || i.file_path || i.path || i.pattern || i.url || i.description || i.prompt || '';
  return `${DIM}  ⎿ ${x.name}${arg ? ` : ${clip(String(arg).replace(/\s+/g, ' '), 100)}` : ''}${RST}`;
}

// Texte à afficher ('' si la conversation n'a jamais été compactée : Claude Code l'affiche alors en entier)
async function beforeLastCompaction(file) {
  if (!file || !fs.existsSync(file)) return '';
  let out = '', snap = '';
  const push = t => { out += t + '\r\n'; if (out.length > 2 * MAX) out = out.slice(out.length - MAX); };
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line.length > 4e6) continue;
    if (line.includes('"compact_boundary"')) { snap = out; push(`${DIM}── conversation compactée ──${RST}`); continue; }
    if (!line.includes('"user"') && !line.includes('"assistant"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;
    if (o.type === 'user') { const t = userText(o); if (t) push(`\r\n${BOLD}❯ ${nl(clip(t, 4000))}${RST}`); }
    else if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      for (const x of o.message.content) {
        if (x?.type === 'text' && x.text?.trim()) push(`\r\n● ${nl(clip(x.text.trim(), 8000))}`);
        else if (x?.type === 'tool_use') push(toolLine(x));
      }
    }
  }
  if (!snap) return '';
  if (snap.length > MAX) { const i = snap.indexOf('\r\n', snap.length - MAX); snap = snap.slice(i > 0 ? i + 2 : snap.length - MAX); }
  return `${DIM}[csm] Discussion d'avant la compaction (lue dans la conversation) :${RST}\r\n${snap}\r\n${DIM}── fin de la discussion compactée : la suite est reprise par Claude Code ──${RST}\r\n`;
}
module.exports = { beforeLastCompaction };
