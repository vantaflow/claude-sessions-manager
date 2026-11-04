'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tidyCopy } = require('../public/copytext');

test('copie du terminal : paragraphe coupé par Claude Code recollé', () => {
  const t = '● La 3.66.3 est publiée pour Mac et Windows. CSM la proposera tout   \n  seul ; pour l\'installer, va dans Réglages › À propos › « Rechercher\n  des mises à jour ».\n\n  Une fois installée.';
  assert.equal(tidyCopy(t, 60), '● La 3.66.3 est publiée pour Mac et Windows. CSM la proposera tout seul ; pour l\'installer, va dans Réglages › À propos › « Rechercher des mises à jour ».\n\nUne fois installée.');
});

test('copie du terminal : code et listes gardent leurs lignes, retrait commun retiré', () => {
  assert.equal(tidyCopy('  const a = 1;\n  if (a) {\n    go();\n  }', 60), 'const a = 1;\nif (a) {\n  go();\n}');
  assert.equal(tidyCopy('  - un élément qui remplit presque toute la ligne du terminal ici\n  - deux', 60), '- un élément qui remplit presque toute la ligne du terminal ici\n- deux');
  assert.equal(tidyCopy('ligne seule   ', 60), 'ligne seule');
  assert.equal(tidyCopy('a\r\nb', 60), 'a\nb');
});

test('copie du terminal : lignes courtes jamais recollées', () => {
  assert.equal(tidyCopy('Bonjour\nmonde', 60), 'Bonjour\nmonde');
});
