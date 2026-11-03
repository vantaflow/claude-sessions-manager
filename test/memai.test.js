'use strict';
// Tests unitaires de la mémoire IA : réduction du transcript, prompt, validation de la sortie de Haiku.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reduce } = require('../lib/memai/reduce');

const T = n => new Date(Date.UTC(2026, 9, 1, 10, 0, n)).toISOString();
const user = (content, n, extra = {}) => ({ type: 'user', timestamp: T(n), cwd: '/w/app', message: { role: 'user', content }, ...extra });
const said = (parts, n) => ({ type: 'assistant', timestamp: T(n), cwd: '/w/app', message: { role: 'assistant', content: parts } });
const result = (text, n, isError = false) => user([{ type: 'tool_result', tool_use_id: 'x', content: text, is_error: isError }], n, { toolUseResult: {} });

test('réduction : utile seulement', () => {
  const r = reduce([
    user('<system-reminder>rappel</system-reminder>', 0),
    user('ajoute un bouton de connexion', 1),
    said([{ type: 'text', text: 'je regarde le formulaire' }, { type: 'tool_use', name: 'Edit', input: { file_path: '/w/app/a.js' } }], 2),
    result('x'.repeat(5000), 3),
    { type: 'assistant', isSidechain: true, timestamp: T(4), message: { content: [{ type: 'text', text: 'texte du sous-agent' }] } },
    said([{ type: 'text', text: 'bouton ajouté' }], 5),
  ]);
  const txt = r.chunks.join('\n');
  assert.match(txt, /Demande : ajoute un bouton de connexion/);
  assert.match(txt, /Claude : je regarde le formulaire/);
  assert.match(txt, /Outil Edit : \/w\/app\/a\.js/);
  assert.doesNotMatch(txt, /system-reminder|rappel|sous-agent/);
  assert.ok(!txt.includes('x'.repeat(301)), 'sortie d’outil écourtée');
  assert.equal(r.exchanges, 1);
  assert.equal(r.rest, false);
});

test('réduction : erreurs gardées', () => {
  const r = reduce([user('lance les tests', 1), result('npm ERR! test failed', 2, true), said([{ type: 'text', text: 'échec' }], 3)]);
  assert.match(r.chunks.join('\n'), /Erreur : npm ERR! test failed/);
});

test('réduction : plafond et morceaux', () => {
  const lines = [];
  for (let i = 0; i < 2000; i++) { lines.push(user('demande ' + i + ' ' + 'a'.repeat(180), 2 * i)); lines.push(said([{ type: 'text', text: 'réponse ' + i }], 2 * i + 1)); }
  const r = reduce(lines, { maxInput: 50000 });
  assert.equal(r.chunks.length, 3);
  assert.ok(r.chunks.every(c => c.length <= 50000));
  assert.equal(r.rest, true);
  assert.ok(r.used > 0 && r.used < lines.length, 'le reste attend l’analyse suivante');
  assert.ok(r.exchanges > 0 && r.exchanges < 2000, 'échanges comptés sur la partie traitée');
});
