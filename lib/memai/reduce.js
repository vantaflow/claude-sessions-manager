'use strict';
// Mémoire IA : transcript Claude Code (lignes JSON) réduit à ce qui sert à le comprendre, pour Haiku :
// demandes de l'utilisateur, réponses de Claude, outils utilisés (fichier ou commande visés), erreurs. Les
// sorties d'outils sont écourtées, les rappels système et les sous-agents ignorés. Découpé en morceaux de
// maxInput caractères au plus (coupure entre deux lignes), maxChunks morceaux par analyse : le reste attend
// l'analyse suivante (rest, used = nombre de lignes du transcript traitées).
const { noise, textOf } = require('../memory');

const ERR_LEN = 300, RESULT_LEN = 150, TEXT_LEN = 4000;
const one = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const resultText = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && p.type === 'text' ? p.text : '')).join(' ') : '';

function target(input) {
  if (!input || typeof input !== 'object') return '';
  return input.file_path || input.notebook_path || input.path || input.pattern || input.command || input.url || input.description || '';
}

// une ligne de transcript → lignes de texte (vide si rien d'utile)
function render(o) {
  if (!o || typeof o !== 'object' || o.isSidechain) return { lines: [], prompt: false, answer: false };
  const c = o.message && o.message.content;
  if (o.type === 'user') {
    if (Array.isArray(c) && c.some(p => p && p.type === 'tool_result')) {
      const out = [];
      for (const p of c) {
        if (!p || p.type !== 'tool_result') continue;
        const t = resultText(p.content);
        if (p.is_error) out.push('Erreur : ' + one(t, ERR_LEN));
        else if (t.trim()) out.push('Résultat : ' + one(t, RESULT_LEN));
      }
      return { lines: out, prompt: false, answer: false };
    }
    if (o.isMeta || o.isCompactSummary) return { lines: [], prompt: false, answer: false };
    const t = textOf(c);
    if (noise(t)) return { lines: [], prompt: false, answer: false };
    return { lines: ['Demande : ' + one(t, TEXT_LEN)], prompt: true, answer: false };
  }
  if (o.type === 'assistant') {
    const out = []; let answer = false;
    for (const p of Array.isArray(c) ? c : []) {
      if (p && p.type === 'text' && p.text && p.text.trim()) { out.push('Claude : ' + one(p.text, TEXT_LEN)); answer = true; }
      else if (p && p.type === 'tool_use' && p.name) out.push(`Outil ${p.name}${target(p.input) ? ' : ' + one(target(p.input), 200) : ''}`);
    }
    return { lines: out, prompt: false, answer };
  }
  return { lines: [], prompt: false, answer: false };
}

// échanges utiles : demandes suivies d'au moins une réponse texte de Claude
function usefulExchanges(lines) {
  let n = 0, open = false;
  for (const o of lines) {
    const r = render(o);
    if (r.prompt) open = true;
    else if (r.answer && open) { n++; open = false; }
  }
  return n;
}

function reduce(lines, { maxInput = 60000, maxChunks = 3 } = {}) {
  const chunks = []; let cur = '', used = 0, rest = false;
  for (let i = 0; i < lines.length; i++) {
    const { lines: out } = render(lines[i]);
    const add = out.map(l => l.slice(0, maxInput - 1)).join('\n');
    if (add) {
      if (cur && cur.length + 1 + add.length > maxInput) {
        chunks.push(cur); cur = '';
        if (chunks.length >= maxChunks) { rest = true; break; }
      }
      cur = cur ? cur + '\n' + add : add.slice(0, maxInput);
    }
    used = i + 1;
  }
  if (!rest && cur) chunks.push(cur);
  return { chunks, exchanges: usefulExchanges(lines.slice(0, used)), rest, used };
}

module.exports = { reduce, usefulExchanges };
