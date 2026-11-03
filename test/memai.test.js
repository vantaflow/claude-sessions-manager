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

const { clean, buildPrompt, SCHEMA } = require('../lib/memai/prompt');
const okOut = (o = {}) => ({ summary: { title: 'Bouton de connexion', request: 'Ajouter un bouton.', state: 'Bouton ajouté, tests verts.', next: 'rien', ...o.summary }, observations: o.observations || [] });

test('validation : sortie correcte', () => {
  const obs = [];
  for (let i = 0; i < 20; i++) obs.push({ type: i === 0 ? 'inconnu' : 'decision', title: 'T'.repeat(120), body: 'Corps.', files: ['a.js'], keywords: ['Bouton', 'bouton', 'Button'] });
  const r = clean(okOut({ observations: obs }));
  assert.equal(r.observations.length, 15);
  assert.ok(r.observations.every(o => o.type === 'decision' && o.title.length <= 80));
  assert.deepEqual(r.observations[0].keywords, ['bouton', 'button']);
  assert.equal(r.summary.title, 'Bouton de connexion');
  assert.ok(SCHEMA.properties.summary && SCHEMA.properties.observations);
});

test('validation : erreur d’API refusée', () => {
  assert.equal(clean(okOut({ summary: { state: 'API Error: 529 {"type":"error"}' } })), null);
  assert.equal(clean(okOut({ summary: { state: '[Request interrupted by user]' } })), null);
  assert.equal(clean(okOut({ summary: { title: '' } })), null);
  assert.equal(clean(null), null);
  assert.equal(clean({ summary: 'texte' }), null);
});

test('prompt : résumé précédent repris', () => {
  const p = buildPrompt({ text: 'Demande : suite', previous: okOut().summary, project: '{home}/app', part: 2, parts: 3 });
  assert.match(p, /Bouton de connexion/);
  assert.match(p, /mets[- ]le à jour/i);
  assert.match(p, /morceau 2 sur 3/);
  assert.match(p, /Demande : suite/);
});

test('fiches : une fiche mal formée (autre version) ne casse ni la recherche ni le détail', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memai-'));
  fs.writeFileSync(path.join(dir, 'abcdef01.json'), JSON.stringify({ v: 1, id: 'abcdef01', updated: 1, summary: { title: 42 }, obs: [{ type: 'todo', title: 'sans mots-clés' }, null] }));
  const st = require('../lib/memai/store').open(dir);
  assert.equal(st.search('sans').length, 1);
  assert.equal(st.get('abcdef01').summary.state, '');
  assert.deepEqual(st.get('abcdef01').obs[0].keywords, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
