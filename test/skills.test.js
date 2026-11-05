'use strict';
// Liste des skills d'une session (pas les commandes) (lib/skills.js) : sources, noms d'appel, descriptions, plugins coupés.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-skills-'));
const CLAUDE = path.join(TMP, 'claude'), WORK = path.join(TMP, 'work');
process.env.CLAUDE_CONFIG_DIR = CLAUDE;
const { listSkills, frontmatter } = require('../lib/skills');

const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const skill = (root, dir, fm, body = '# Titre\n\nCorps') => put(path.join(root, 'skills', dir, 'SKILL.md'), `---\n${fm}\n---\n${body}`);

// personnels
skill(CLAUDE, 'revue', 'name: revue\ndescription: "Relit le diff, \\"sans\\" pitié"');
skill(CLAUDE, 'plie', 'name: plie\ndescription: >\n  Première ligne\n  et la suite\nargument-hint: <fichier>');
skill(CLAUDE, 'interne', 'name: interne\ndescription: réservé à Claude\nuser-invocable: false');
skill(CLAUDE, 'commun', 'name: commun\ndescription: version personnelle');
put(path.join(CLAUDE, 'commands', 'deploie.md'), '---\ndescription: Déploie en recette\n---\nÉtapes');
put(path.join(CLAUDE, 'commands', 'git', 'nettoie.md'), 'Nettoie les branches fusionnées\n');
// dossier de la session : passe avant le personnel
skill(path.join(WORK, '.claude'), 'commun', 'name: commun\ndescription: version du dossier');
// plugins : un actif, un coupé dans les réglages, claude-mem coupé par l'app
const P1 = path.join(CLAUDE, 'plugins', 'cache', 'm', 'outils', '1.0.0'), P2 = path.join(CLAUDE, 'plugins', 'cache', 'm', 'coupe', '1.0.0'), P3 = path.join(CLAUDE, 'plugins', 'cache', 'thedotmack', 'claude-mem', '1.0.0');
put(path.join(P1, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'outils' }));
skill(P1, 'mesure', 'name: mesure\ndescription: Mesure les performances');
put(path.join(P1, 'commands', 'rapport.md'), '---\ndescription: Rapport hebdo\nargument-hint: [semaine]\n---\n');
skill(P2, 'cache', 'name: cache\ndescription: ne doit pas apparaître');
skill(P3, 'mem-search', 'name: mem-search\ndescription: claude-mem');
put(path.join(CLAUDE, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
  'outils@m': [{ scope: 'user', installPath: P1 }], 'coupe@m': [{ scope: 'user', installPath: P2 }], 'claude-mem@thedotmack': [{ scope: 'user', installPath: P3 }],
} }));
put(path.join(CLAUDE, 'settings.json'), JSON.stringify({ enabledPlugins: { 'coupe@m': false, 'claude-mem@thedotmack': true } }));

test('en-tête YAML : guillemets échappés et bloc replié', () => {
  assert.equal(frontmatter('---\ndescription: "a \\"b\\""\n---\n').description, 'a "b"');
  assert.equal(frontmatter('---\ndescription: >\n  un\n  deux\nname: x\n---\n').description, 'un deux');
  assert.deepEqual(frontmatter('pas d’en-tête'), {});
});

test('sources, commandes d’appel et descriptions', () => {
  const l = listSkills(WORK, { 'claude-mem@thedotmack': false });
  const by = Object.fromEntries(l.map(s => [s.command, s]));
  assert.equal(by['/revue'].description, 'Relit le diff, "sans" pitié');
  assert.equal(by['/revue'].source, 'user');
  assert.equal(by['/plie'].description, 'Première ligne et la suite');
  assert.equal(by['/plie'].args, '<fichier>');
  assert.ok(!by['/deploie'] && !by['/git:nettoie'] && !by['/outils:rapport'], 'les commandes (commands/*.md) ne sont pas listées');
  assert.ok(l.every(s => s.kind === 'skill'));
  assert.equal(by['/outils:mesure'].plugin, 'outils');
  assert.equal(by['/commun'].description, 'version du dossier', 'le dossier passe avant le personnel');
  assert.equal(l.filter(s => s.command === '/commun').length, 1);
  assert.ok(!by['/interne'], 'user-invocable: false → pas appelable par /');
  assert.ok(!by['/coupe:cache'], 'plugin désactivé dans les réglages');
  assert.ok(!by['/claude-mem:mem-search'], 'claude-mem coupé par l’app dans ses sessions');
});

test('sans dossier, et plugin réactivé par les réglages du dossier', () => {
  assert.ok(!listSkills('').some(s => s.source === 'project'));
  put(path.join(WORK, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'coupe@m': true } }));
  assert.ok(listSkills(WORK).some(s => s.command === '/coupe:cache'));
  assert.ok(listSkills(WORK).some(s => s.command === '/claude-mem:mem-search'), 'sans réglage de l’app : celui de l’utilisateur');
  fs.rmSync(path.join(WORK, '.claude', 'settings.json'));
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { } });
