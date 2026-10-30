'use strict';
require('../lib/tz').alignTimezone(); // même fuseau que l'app testée (qui suit celui du système)
// Test de bout en bout de l'application Electron (Playwright) avec le faux claude.
// Lancer : npm run test:app
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const PORT = 19000 + Math.floor(Math.random() * 900);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-app-'));
const HOME = path.join(TMP, 'home'), DATA = path.join(TMP, 'data'), WORK = path.join(TMP, 'projet');
for (const d of [HOME, DATA, WORK]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ onboarded: true, lang: 'fr', autoUpdate: false }));

const env = {
  ...process.env, CSM_PORT: String(PORT), CSM_DATA: DATA, CSM_SECRETS_FILE_ONLY: '1', HOME, USERPROFILE: HOME,
  CSM_HIDE_WINDOW: '1', CSM_READY_WATCH_MS: '15000', CSM_CLAUDE: process.execPath, CSM_CLAUDE_ARGS: `"${path.join(__dirname, 'fake-claude.js')}"`,
};
for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|ELECTRON_RUN_AS_NODE)/.test(k)) delete env[k];

let app, win;
before(async () => {
  app = await electron.launch({ args: [ROOT], env, timeout: 60000 });
  win = await app.firstWindow();
  // au 1er lancement, la page peut se recharger une fois (langue du système ≠ réglage) : attendre qu'elle soit prête
  await win.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 60000 });
  await new Promise(r => setTimeout(r, 500));
  await win.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 60000 });
});
after(async () => {
  // l'app reste dans la barre des tâches quand la fenêtre est fermée : on la quitte explicitement
  try { await Promise.race([app.evaluate(({ app: a }) => { a.exit(0); }), new Promise(r => setTimeout(r, 3000))]); } catch { }
  try { app?.process().kill(); } catch { }
  // le serveur est détaché de l'app (il survit volontairement) : on l'arrête ici
  try { process.kill(Number(fs.readFileSync(path.join(DATA, 'server.pid'), 'utf8'))); } catch { }
  await new Promise(r => setTimeout(r, 800));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
});

test('fenêtre isolée : pas d’accès Node dans la page', async () => {
  assert.equal(await win.evaluate(() => typeof require), 'undefined');
  assert.equal(await win.evaluate(() => typeof process), 'undefined');
  assert.equal(await win.evaluate(() => typeof window.csmNative.pickFolder), 'function');
});

test('créer une session depuis l’interface et échanger', async () => {
  await win.click('#btnNew');
  await win.fill('#formNew [name=cwd]', WORK);
  await win.fill('#formNew [name=name]', 'e2e');
  await win.click('#formNew button[value=ok]');
  await win.waitForFunction(() => [...sessions.values()].some(s => s.name === 'e2e' && s.status === 'idle'), null, { timeout: 120000 });
  await win.click('.term.show');
  await win.keyboard.type('bonjour e2e');
  await win.keyboard.press('Enter');
  await win.waitForFunction(() => { const tt = terms.get(active); const b = tt.term.buffer.active; for (let y = 0; y < b.length; y++) if (b.getLine(y).translateToString().includes('echo: bonjour e2e')) return true; return false; }, null, { timeout: 45000 });
});

test('menu clic droit du terminal : tient dans une fenêtre basse et défile', async () => {
  await win.setViewportSize({ width: 900, height: 420 });
  const id = await win.evaluate(() => active);
  await win.evaluate(id => showMenu(terminalItems(id), 300, 200), id);
  const r = await win.evaluate(() => { const m = document.querySelector('#ctx'), b = m.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, scroll: m.scrollHeight > m.clientHeight, full: m.scrollHeight, h: innerHeight }; });
  assert.ok(r.top >= 0 && r.bottom <= r.h, `menu dans la fenêtre (${r.top}-${r.bottom} / ${r.h})`);
  if (r.full > r.h) assert.ok(r.scroll, 'menu défilant'); // contenu plus haut que la fenêtre
  // défilé jusqu'en bas : le dernier élément est dans la zone visible du menu
  const last = await win.evaluate(() => {
    const m = document.querySelector('#ctx'); m.scrollTop = m.scrollHeight;
    const a = m.getBoundingClientRect(), b = m.lastElementChild.getBoundingClientRect();
    return { inside: b.top >= a.top - 1 && b.bottom <= a.bottom + 1, a: [a.top, a.bottom], b: [b.top, b.bottom] };
  });
  assert.ok(last.inside, 'dernier élément atteignable ' + JSON.stringify(last));
  await win.evaluate(() => hideMenu());
  await win.setViewportSize({ width: 1280, height: 800 });
});

test('barre de session : aucun bouton coupé, quelle que soit la largeur', async () => {
  for (const width of [1700, 1500, 1400, 1300, 1180, 1000, 860, 700]) {
    await win.setViewportSize({ width, height: 700 });
    await win.waitForTimeout(100);
    // libellés longs (type de session + Affichage) : le cas qui débordait sur Mac
    await win.evaluate(() => { $('#curType').hidden = false; $('#curType').textContent = 'TICKET WFC'; $('#btnView').hidden = false; $('#btnView .lbl').textContent = 'Affichage'; $('#btnAttention').hidden = false; $('#atCount').textContent = '2'; });
    // fenêtre redimensionnée par étapes (Windows) : on laisse la barre se stabiliser avant de mesurer
    await win.waitForFunction(() => $('#bar').scrollWidth - $('#bar').clientWidth <= 1, null, { timeout: 5000 }).catch(() => { });
    const r = await win.evaluate(() => {
      const bar = $('#bar'), b = bar.getBoundingClientRect(), close = $('#btnClose').getBoundingClientRect();
      return { over: bar.scrollWidth - bar.clientWidth, closeIn: close.right <= b.right + 1 && close.width > 0, cls: bar.className, name: bar.querySelector('.curId').clientWidth };
    });
    assert.ok(r.over <= 1 && r.closeIn, `largeur ${width} : ${JSON.stringify(r)}`);
  }
  // pastille « en cours » : son halo (4 px) n'est pas rogné par la zone du nom
  const halo = await win.evaluate(() => { const d = $('#curDot'); d.className = 'dot working'; const a = $('#curId').getBoundingClientRect(), b = d.getBoundingClientRect(); return b.left - a.left; });
  assert.ok(halo >= 4, `halo de la pastille visible (${halo} px)`);
  await win.evaluate(() => { $('#curType').hidden = true; $('#btnView').hidden = true; $('#btnAttention').hidden = true; });
  await win.setViewportSize({ width: 1280, height: 800 });
});

test('vue partagée et palette', async () => {
  await win.evaluate(() => api('POST', '/api/sessions', { cwd: document.querySelector('#formNew [name=cwd]').value, name: 'deuxième' }));
  await win.waitForFunction(() => sessions.size >= 2);
  await win.click('[data-layout="2c"]');
  await win.waitForFunction(() => visibleIds().length === 2);
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await win.waitForSelector('#dlgPalette[open]');
  await win.keyboard.type('deux');
  const first = await win.textContent('#palList li.sel .pl');
  assert.match(first, /deuxième|Disposition/);
  await win.keyboard.press('Escape');
});

test('palette : sections, surlignage, préfixe > et Ctrl+Entrée dans un panneau', async () => {
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await win.click('[data-layout="1"]');
  await win.keyboard.press(mod + '+K');
  await win.waitForSelector('#dlgPalette[open]');
  await win.waitForSelector('#palList li.palSec');
  const heads = await win.$$eval('#palList li.palSec', l => l.map(x => x.textContent));
  assert.ok(heads.length >= 2 && /Sessions|sessions/i.test(heads[0]) && heads.some(h => /Actions/i.test(h)), heads.join('|'));
  assert.ok(await win.$('#palFoot kbd'));
  await win.keyboard.type('deux');
  await win.waitForSelector('#palList li.sel .pl mark');
  assert.match(await win.textContent('#palList li.sel .pl mark'), /deux/i);
  // Ctrl+Entrée : ouvre la session sélectionnée dans un panneau (passe en 2 colonnes)
  await win.keyboard.press(mod + '+Enter');
  await win.waitForFunction(() => layout === '2c' && visibleIds().length === 2);
  // préfixe > : seulement des actions
  await win.keyboard.press(mod + '+K');
  await win.waitForSelector('#dlgPalette[open]');
  await win.keyboard.type('>');
  await win.waitForSelector('#palList li.palSec');
  const heads2 = await win.$$eval('#palList li.palSec', l => l.map(x => x.textContent));
  assert.equal(heads2.length, 1);
  assert.match(heads2[0], /Actions/i);
  await win.keyboard.press('Escape');
});

test('vue partagée : envoi groupé aux sessions affichées depuis la barre du bas', async () => {
  await win.click('[data-layout="2c"]');
  await win.waitForSelector('#splitBar:not([hidden])');
  const ids = await win.evaluate(() => visibleIds().filter(id => sessions.get(id)?.alive));
  assert.equal(ids.length, 2);
  assert.match(await win.textContent('#sbCount'), /2/);
  await win.fill('#sbText', 'groupe-e2e');
  await win.click('#splitBar button[type=submit]');
  try {
    for (const id of ids) await win.waitForFunction(id => { const b = terms.get(id).term.buffer.active; for (let y = 0; y < b.length; y++) if (b.getLine(y).translateToString().includes('echo: groupe-e2e')) return true; return false; }, id, { timeout: 30000 });
  } catch (e) {
    const diag = await win.evaluate(ids => ids.map(id => { const s = sessions.get(id), b = terms.get(id).term.buffer.active, l = []; for (let y = Math.max(0, b.length - 8); y < b.length; y++) l.push(b.getLine(y).translateToString().trim()); return { name: s.name, status: s.status, queue: s.queue, tail: l.filter(Boolean) }; }), ids);
    throw new Error(e.message + ' — ' + JSON.stringify(diag));
  } finally { await win.click('[data-layout="1"]'); }
  await win.waitForSelector('#splitBar', { state: 'hidden' });
});

test('groupes : créer un groupe vide, y glisser une session, le renommer, le supprimer', async () => {
  await win.click('#btnNewGroup');
  await win.waitForSelector('#dlgRename[open]');
  await win.fill('#renInput', 'Clients');
  await win.click('#dlgRename button[value=ok]');
  // groupe vide visible, avec sa zone de dépôt
  await win.waitForFunction(() => [...document.querySelectorAll('#list li.ghead.empty .gname')].some(x => x.textContent === 'Clients'));
  const src = await win.evaluate(() => [...sessions.values()].find(s => s.name === 'e2e').id);
  // dépôt sur le groupe vide : événements de glisser-déposer envoyés dans la page (le glisser simulé au pointeur
  // est instable dans une fenêtre cachée) ; même gestionnaire que le vrai glisser
  await win.evaluate(id => {
    const dt = new DataTransfer(); dt.setData('text/plain', id); dt.setData('text/csm-session', id);
    const to = document.querySelector('#list li.gempty');
    for (const type of ['dragenter', 'dragover', 'drop']) to.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, src);
  await win.waitForFunction(id => sessions.get(id).group === 'Clients', src, { timeout: 15000 });
  await win.waitForFunction(() => !document.querySelector('#list li.gempty'));
  // menu « Déplacer vers le groupe » : retour dans « Sans groupe »
  await win.evaluate(id => showMenu(moveItems(id), 50, 50), src);
  await win.click('#ctx button:has-text("Sans groupe")');
  await win.waitForFunction(id => !sessions.get(id).group, src);
  // renommer par le bouton ✎ du titre (groupe vide : il reste déclaré sous son nouveau nom)
  const head = n => `#list li.ghead:has(.gname:text-is("${n}"))`;
  await win.hover(head('Clients'));
  await win.click(`${head('Clients')} .gren`);
  await win.waitForSelector('#dlgRename[open]');
  await win.fill('#renInput', 'Clients 2');
  await win.click('#dlgRename button[value=ok]');
  await win.waitForFunction(() => groupNames().includes('Clients 2') && !groupNames().includes('Clients'));
  // Nouvelle session : tous les groupes proposés (même vides), « (aucun) » par défaut = Sans groupe
  await win.evaluate(() => openNew());
  const opts = await win.evaluate(() => { const g = document.querySelector('#formNew').group; return { value: g.value, list: [...g.options].map(o => o.value) }; });
  assert.equal(opts.value, '', 'Sans groupe par défaut');
  assert.ok(opts.list.includes('Clients 2'), 'groupe vide proposé');
  await win.evaluate(() => document.querySelector('#dlgNew').close());
  // supprimer par le bouton ✕ : il disparaît
  await win.hover(head('Clients 2'));
  await win.click(`${head('Clients 2')} .gdel`);
  await win.waitForFunction(() => !groupNames().includes('Clients 2'));
});

test('compaction : l’écran effacé par Claude Code (ESC[2J ESC[3J) reste dans l’historique du terminal', async () => {
  const has = await win.evaluate(async () => {
    const id = [...sessions.values()].find(s => s.name === 'e2e').id, term = ensureTerm(id).term;
    const w = d => new Promise(r => term.write(termData(d), r));
    const text = () => { const b = term.buffer.active, out = []; for (let y = 0; y < b.length; y++) out.push(b.getLine(y).translateToString()); return out.join('\n'); };
    await w('avant-compaction-e2e\r\n');
    await w('\x1b[2J\x1b[3J\x1b[H');
    const kept = text().includes('avant-compaction-e2e');
    // réglage coupé : comportement d'origine, l'historique est effacé
    SETTINGS.keepScrollback = false; applySettings();
    await w('avant-effacement-e2e\r\n');
    await w('\x1b[2J\x1b[3J\x1b[H');
    const erased = !text().includes('avant-effacement-e2e');
    SETTINGS.keepScrollback = true; applySettings();
    return { kept, erased };
  });
  assert.deepEqual(has, { kept: true, erased: true });
});

test('sous-groupes : créer, ranger une session, replier le parent, renommer, supprimer', async () => {
  const head = n => `#list li.ghead:has(.gname:text-is("${n}"))`;
  await win.click('#btnNewGroup');
  await win.waitForSelector('#dlgRename[open]');
  await win.fill('#renInput', 'Projets');
  await win.click('#dlgRename button[value=ok]');
  await win.waitForSelector(head('Projets'));
  // bouton + du titre : sous-groupe, affiché sous son parent avec un retrait
  await win.hover(head('Projets'));
  await win.click(`${head('Projets')} .gsub`);
  await win.waitForSelector('#dlgRename[open]');
  await win.fill('#renInput', 'Alpha');
  await win.click('#dlgRename button[value=ok]');
  await win.waitForFunction(() => groupNames().join('|').includes('Projets|Projets/Alpha'));
  await win.waitForSelector(head('Alpha'));
  assert.equal(await win.$eval(head('Alpha'), h => h.style.getPropertyValue('--gd').trim()), '1');
  const src = await win.evaluate(() => [...sessions.values()].find(s => s.name === 'e2e').id);
  await win.evaluate(id => showMenu(moveItems(id), 50, 50), src);
  await win.click('#ctx button:has-text("Alpha")');
  await win.waitForFunction(id => sessions.get(id).group === 'Projets/Alpha', src, { timeout: 15000 });
  // le parent compte les sessions de ses sous-groupes ; replié, il masque ses sous-groupes
  await win.waitForFunction(() => document.querySelector('#list li.ghead[title="Projets"] .gcount')?.textContent === '1');
  await win.click(head('Projets'));
  await win.waitForFunction(() => !document.querySelector('#list li.ghead[title="Projets › Alpha"]'));
  await win.click(head('Projets'));
  await win.waitForSelector(head('Alpha'));
  // renommer le parent : sous-groupe et session suivent
  await win.hover(head('Projets'));
  await win.click(`${head('Projets')} .gren`);
  await win.waitForSelector('#dlgRename[open]');
  await win.fill('#renInput', 'Clients');
  await win.click('#dlgRename button[value=ok]');
  await win.waitForFunction(id => sessions.get(id).group === 'Clients/Alpha' && !groupNames().some(g => g.startsWith('Projets')), src, { timeout: 15000 });
  // supprimer le sous-groupe : la session remonte dans le parent ; puis le parent : retour dans « Sans groupe »
  await win.evaluate(() => { window.confirm = () => true; });
  await win.evaluate(() => deleteGroup('Clients/Alpha'));
  await win.waitForFunction(id => sessions.get(id).group === 'Clients' && !groupNames().includes('Clients/Alpha'), src, { timeout: 15000 });
  await win.evaluate(() => deleteGroup('Clients'));
  await win.waitForFunction(id => !sessions.get(id).group && !groupNames().length, src, { timeout: 15000 });
  await win.evaluate(() => { delete window.confirm; });
});

test('synchro : créer un code l’affiche en clair, prêt à copier', async () => {
  const http = require('http');
  const auths = new Set(), sha = x => require('crypto').createHash('sha256').update(x).digest('hex');
  const srv = http.createServer((q, r) => {
    const send = (c, v) => { r.writeHead(c, { 'content-type': 'application/json' }); r.end(JSON.stringify(v)); };
    let b = ''; q.on('data', c => { b += c; });
    q.on('end', () => {
      if (q.method === 'POST' && q.url === '/spaces') { auths.add(JSON.parse(b || '{}').auth); return send(200, { ok: true }); }
      if (!auths.has(sha((q.headers.authorization || '').replace(/^Bearer /, '')))) return send(401, {});
      send(200, q.method === 'GET' ? (q.url.startsWith('/transcripts') ? { items: [] } : { rev: 0, items: [] }) : { rev: 0, applied: 0 });
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    await win.evaluate(url => saveSettings({ syncServer: url, syncCode: '' }), `http://127.0.0.1:${srv.address().port}`);
    await win.evaluate(() => window.csmFeatures.openSettings('sync'));
    await win.waitForSelector('#syncSetup:not([hidden])');
    assert.equal(await win.isHidden('#syncOn'), true);
    await win.click('#syncNew');
    await win.waitForSelector('#syncOn:not([hidden])');
    assert.match(await win.textContent('#syncCodeShow'), /^([0-9A-HJKMNP-TV-Z]{4}-){4}[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.equal(await win.isHidden('#syncSetup'), true);
    // carte d'en-tête : code masqué par défaut, bouton Afficher ; options en interrupteurs ; carte « Ajouter une machine »
    assert.equal(await win.evaluate(() => document.querySelector('#syncCodeShow').classList.contains('masked')), true);
    await win.click('#syncReveal');
    assert.equal(await win.evaluate(() => document.querySelector('#syncCodeShow').classList.contains('masked')), false);
    assert.equal(await win.evaluate(() => document.querySelectorAll('.syncWhat input[role=switch][data-set]').length >= 6), true);
    assert.equal(await win.evaluate(() => { const i = document.querySelector('.syncWhat input[role=switch]:not([data-set])'); return i.checked && i.disabled; }), true);
    await win.waitForSelector('#machineList li.me');
    assert.equal(await win.isVisible('#machAdd'), true);
    await win.waitForFunction(() => /✓/.test(document.querySelector('#syncStatus').textContent));
    if (process.env.CSM_SHOT) await win.screenshot({ path: process.env.CSM_SHOT });
    await win.evaluate(() => { window.confirm = () => true; });
    await win.click('#syncOff');
    await win.waitForSelector('#syncSetup:not([hidden])');
  } finally {
    await win.evaluate(() => { saveSettings({ syncServer: '', syncCode: '' }); document.querySelector('#dlgSettings').close(); });
    srv.close();
  }
});

test('réglages : mémoire au choix, demandes programmées, fichiers reçus', async () => {
  try {
    await win.evaluate(() => window.csmFeatures.openSettings('general'));
    await win.waitForSelector('input[name=memoryEngine][value=native]');
    assert.equal(await win.isChecked('input[name=memoryEngine][value=native]'), true, 'mémoire intégrée cochée');
    assert.equal(await win.isChecked('[data-set=queueQuotaPause]'), true);
    await win.click('.setNav [data-st=schedules]');
    await win.waitForSelector('#schForm');
    await win.fill('#schForm [name=name]', 'Revue du matin');
    await win.fill('#schForm [name=text]', 'relis le dépôt');
    await win.fill('#schForm [name=time]', '08:15');
    await win.check('#schForm [name=day][value="1"]');
    assert.equal(await win.isHidden('#schForm [data-for=once]'), true, 'date masquée quand des jours sont choisis');
    await win.click('#schForm button[type=submit]');
    await win.waitForFunction(() => /Revue du matin/.test(document.querySelector('#schList').textContent));
    assert.match(await win.textContent('#schList'), /08:15 · lun/);
    if (process.env.CSM_SHOT) await win.screenshot({ path: process.env.CSM_SHOT.replace(/(\.png)?$/, '-programmees.png') });
    await win.click('#schList [data-a=del]');
    await win.waitForFunction(() => /Aucune demande/.test(document.querySelector('#schList').textContent));
    await win.click('.setNav [data-st=sync]');
    assert.equal(await win.isChecked('[data-set=claudeSyncReview]'), false, 'tout s’applique seul par défaut');
    // mémoire : fiches de la session e2e, recherche, détail
    await win.click('.setNav [data-st=memory]');
    await win.waitForFunction(() => document.querySelectorAll('#memList li').length > 0);
    if (process.env.CSM_SHOT) await win.screenshot({ path: process.env.CSM_SHOT.replace(/(\.png)?$/, '-memoire-liste.png') });
    const card = await win.$('#memList li[data-id]');
    if (card) {
      await card.click();
      await win.waitForSelector('#memEdit:not([hidden]) [name=note]');
      if (process.env.CSM_SHOT) await win.screenshot({ path: process.env.CSM_SHOT.replace(/(\.png)?$/, '-memoire.png') });
    }
    await win.fill('#memQ', 'zzz-introuvable');
    await win.waitForFunction(() => document.querySelector('#memList li.empty'));
    await win.selectOption('#memSrc', 'notes');
    await win.waitForFunction(() => document.querySelector('#memList li'));
  } finally {
    await win.evaluate(() => document.querySelector('#dlgSettings').close());
  }
});

test('pièces jointes : miniature sur la session active seulement, agrandie au clic, retirée à l’envoi', async () => {
  const id = await win.evaluate(() => active);
  await win.evaluate(async id => {
    const c = document.createElement('canvas'); c.width = 120; c.height = 80;
    const g = c.getContext('2d'); g.fillStyle = '#d97757'; g.fillRect(0, 0, 120, 80);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    await attachFiles(id, [new File([blob], 'capture.png', { type: 'image/png' })]);
  }, id);
  const thumb = `.term .thumbs:not([hidden]) .thumb img`;
  await win.waitForSelector(thumb);
  assert.equal(await win.$eval('.term .thumbs:not([hidden]) .thumb', b => b.classList.contains('sent')), false, 'message en cours');
  await win.click('.term .thumbs:not([hidden]) .thumb');
  await win.waitForSelector('#dlgImage[open] img');
  assert.match(await win.textContent('#dlgImage figcaption'), /capture\.png/);
  if (process.env.CSM_SHOT) await win.screenshot({ path: process.env.CSM_SHOT.replace(/(\.png)?$/, '-image.png') });
  await win.keyboard.press('Escape');
  // autre session active : l'aperçu de la première n'apparaît pas
  const other = await win.evaluate(id => [...sessions.keys()].find(x => x !== id), id);
  if (other) {
    await win.evaluate(o => select(o), other);
    await win.waitForFunction(() => !document.querySelector('.term .thumbs:not([hidden])'));
    assert.equal(await win.evaluate(o => terms.get(o)?.el.querySelector('.thumbs:not([hidden])') || null, other), null, 'rien sur l’autre session');
    await win.evaluate(i => select(i), id);
    await win.waitForSelector(thumb);
  }
  // message envoyé : aperçu retiré
  await win.evaluate(id => attachmentsSent(id), id);
  await win.waitForFunction(() => !document.querySelector('.term .thumbs:not([hidden])'));
  // masquer à la main
  await win.evaluate(async id => {
    const c = document.createElement('canvas'); c.width = 10; c.height = 10;
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    addAttachments(id, [new File([blob], 'b.png', { type: 'image/png' })]);
  }, id);
  await win.waitForSelector(thumb);
  await win.click('.term .thumbs:not([hidden]) .thumbsClose');
  assert.equal(await win.$('.term .thumbs:not([hidden])'), null, 'masquée');
});

test('thème clair : le code coloré pour un fond sombre reste lisible (contraste minimal)', async () => {
  await win.evaluate(() => saveSettings({ theme: 'light' }));
  await win.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  const ratio = await win.evaluate(() => [...terms.values()][0].term.options.minimumContrastRatio);
  assert.equal(ratio, 4.5);
  await win.evaluate(() => [...terms.values()][0].term.write('\r\n\x1b[38;2;230;230;230mconst blanc = "texte RVB très clair";\x1b[0m \x1b[38;2;255;214;102mjaune clair\x1b[0m \x1b[97mblanc vif\x1b[0m\r\n'));
  await new Promise(r => setTimeout(r, 300));
  if (process.env.CSM_SHOT) await win.screenshot({ path: process.env.CSM_SHOT.replace(/(\.png)?$/, '-clair.png') });
  await win.evaluate(() => saveSettings({ theme: 'dark' }));
  await win.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await win.evaluate(() => [...terms.values()][0].term.options.minimumContrastRatio), 1);
});

test('affichage tué (mémoire saturée) : la fenêtre est recréée, les sessions continuent', async () => {
  const next = app.waitForEvent('window', { timeout: 30000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
  win = await next;
  await win.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 60000 });
  await win.waitForFunction(() => [...sessions.values()].some(s => s.name === 'e2e'), null, { timeout: 30000 });
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'une seule fenêtre, l’ancienne est détruite');
});

test('page restée inachevée (script jamais chargé, vu après un plantage du GPU) : la fenêtre est recréée', async () => {
  await win.route('**/app.js*', () => { }); // requête jamais servie : squelette affiché, page jamais prête
  const next = app.waitForEvent('window', { timeout: 40000 });
  await win.evaluate(() => location.reload());
  win = await next;
  await win.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 60000 });
  await win.waitForFunction(() => [...sessions.values()].some(s => s.name === 'e2e'), null, { timeout: 30000 });
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'une seule fenêtre, l’ancienne est détruite');
});

test('connexion Claude : bandeau avant expiration, renouvellement dans l’app', async () => {
  const f = path.join(HOME, '.claude', '.credentials.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'b', expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: Date.now() + 2.5 * 86400e3 } }));
  await win.evaluate(() => api('GET', '/api/auth').then(s => window.dispatchEvent(new CustomEvent('csm:auth', { detail: { status: s } }))));
  await win.waitForSelector('#authBanner:not([hidden])');
  assert.match(await win.textContent('#authText'), /expire dans 2 jours/);
  await win.click('#authRenew');
  await win.waitForSelector('#dlgAuth[open] #authCodeRow:not([hidden])', { timeout: 20000 });
  assert.equal(await win.isVisible('#authLink'), true, 'lien de connexion proposé');
  await win.fill('#authCode', 'CODE-OK');
  await win.click('#authCodeSend');
  try {
    await win.waitForFunction(() => !document.querySelector('#dlgAuth').open && document.querySelector('#authBanner').hidden, null, { timeout: 20000 });
  } catch (e) {
    const diag = await win.evaluate(async () => ({ auth: await api('GET', '/api/auth'), open: document.querySelector('#dlgAuth').open, banner: !document.querySelector('#authBanner').hidden, step: document.querySelector('#authStep').textContent, text: document.querySelector('#authText').textContent, ui: window.csmFeatures.authState?.() }));
    throw new Error(e.message + ' — ' + JSON.stringify(diag));
  }
  fs.rmSync(f, { force: true });
});

test('notifications et pastille : test depuis les réglages, nombre sur l’icône', async () => {
  const r = await win.evaluate(() => window.csmNative.notifyTest());
  assert.ok(['native', 'applescript', 'unsupported'].includes(r.how), JSON.stringify(r));
  if (process.platform !== 'darwin') assert.equal(r.how, 'native');
  // pastille : 1, 12 (« 9+ ») puis 0, sans erreur dans le processus principal
  for (const n of [1, 12, 0]) await win.evaluate(n => window.csmNative.setAttention(n), n);
  await new Promise(res => setTimeout(res, 300));
  if (process.platform === 'win32') assert.equal(await app.evaluate(({ BrowserWindow }) => !!BrowserWindow.getAllWindows()[0]), true);
});

test('extensions : modèle dans Nouvelle session, affichage dédié rempli par Claude, action', async () => {
  const ext = { csm: 1, id: 'ext-e2e', name: 'Extension e2e', templates: [{ id: 'rev', name: 'Revue e2e', type: 'rev', prompt: 'analyse-e2e {input}', input: { label: 'Numéros', placeholder: '123 456' } }],
    sessionTypes: [{ id: 'rev', name: 'Revue', badge: 'REVUE', color: '#7A9BEA', instructions: 'mode revue', actions: [{ id: 'go', label: 'Corriger', send: 'corrige-e2e', primary: true }],
      input: { label: 'Points', placeholder: '25077', button: 'Analyser', send: 'points-e2e {input}' } }] };
  await win.evaluate(c => api('POST', '/api/extensions', { content: c }), JSON.stringify(ext));
  // Réglages › Extensions : listée
  await win.evaluate(() => window.csmFeatures.openSettings('extensions')); // ouverture directe : la liste se charge
  await win.waitForFunction(() => {
    // relu toutes les 2 s si besoin (machine lente)
    if (!window.__extT || Date.now() - window.__extT > 2000) { window.__extT = Date.now(); window.csmFeatures.renderExtensions(); }
    return /Extension e2e/.test(document.querySelector('#extsList').textContent);
  }, null, { timeout: 30000 });
  await win.evaluate(() => document.querySelector('#dlgSettings').close());
  // Nouvelle session depuis le modèle de l'extension
  await win.click('#btnNew');
  await win.waitForFunction(() => [...document.querySelectorAll('#formNew [name=template] optgroup option')].some(o => o.textContent === 'Revue e2e'));
  // carte du modèle de l'extension (nouvelle fenêtre) : sélectionnée au clic
  await win.click('#tplCards .tplCard:has-text("Revue e2e")');
  assert.equal(await win.evaluate(() => document.querySelector('#formNew [name=template]').value), 'ext-e2e/rev');
  assert.equal(await win.evaluate(() => document.querySelector('#tplCards .tplCard.on .tn').textContent), 'Revue e2e');
  // champ du modèle : affiché avec son libellé, sa valeur remplace {input} dans le premier message
  assert.equal(await win.isVisible('#nsInputRow'), true);
  assert.equal(await win.textContent('#nsInputLbl'), 'Numéros');
  await win.fill('#formNew [name=input]', 'T-42 $&');
  await win.fill('#formNew [name=cwd]', WORK);
  await win.click('#formNew button[value=ok]');
  const id = await win.waitForFunction(() => [...sessions.values()].find(s => s.typeInfo?.name === 'Revue' && s.status === 'idle')?.id, null, { timeout: 60000 }).then(h => h.jsonValue());
  await win.waitForSelector('#curType:not([hidden])');
  assert.equal(await win.textContent('#curType'), 'REVUE');
  // Claude écrit la vue : affichée en texte (le HTML reste du texte)
  await win.evaluate(id => send({ t: 'input', id, d: 'ecris-vue\r' }), id);
  await win.waitForFunction(id => /Analyse <b>test<\/b>/.test(terms.get(id).el.querySelector('.typeView')?.textContent || ''), id, { timeout: 20000 });
  assert.equal(await win.evaluate(id => terms.get(id).el.querySelector('.typeView script, .typeView b'), id), null, 'aucun HTML interprété');
  // vue plus haute que la fenêtre : elle défile, les sections gardent leur hauteur (contenu jamais coupé)
  assert.ok(await win.evaluate(id => {
    const b = terms.get(id).el.querySelector('.typeView');
    const w = document.createElement('div'); w.className = 'tvDetails'; // sections repliables (bloc en overflow: hidden)
    for (let k = 0; k < 12; k++) { const d = document.createElement('details'); d.className = 'tvSec tvFold'; d.open = true; d.innerHTML = '<summary>s</summary><p>' + 'ligne\n'.repeat(15) + '</p>'; w.append(d); }
    b.append(w);
    const ok = b.scrollHeight > b.clientHeight && [...b.children].every(c => c.offsetHeight >= c.scrollHeight - 1);
    w.remove();
    return ok;
  }, id), 'la vue défile');
  // lot : « Élément suivant » sur le premier, « Élément précédent » sur le dernier
  fs.writeFileSync(path.join(DATA, 'views', `${id}.json`), JSON.stringify({ title: 'Lot', items: [{ id: 'A1', title: 'premier' }, { id: 'B2', title: 'second' }] }));
  await win.waitForSelector('.term.show .typeView .tvLotPager');
  const pager = () => win.$$eval('.term.show .typeView .tvLotPager button', l => l.map(b => b.textContent));
  assert.deepEqual(await pager(), ['Élément suivant ›']);
  await win.click('.term.show .typeView .tvLotPager button');
  await win.waitForFunction(() => /B2/.test(document.querySelector('.term.show .typeView .tvLotHead h3')?.textContent || ''));
  assert.deepEqual(await pager(), ['‹ Élément précédent']);
  await win.click('.term.show .typeView .tvLotPager button');
  await win.waitForFunction(() => /A1/.test(document.querySelector('.term.show .typeView .tvLotHead h3')?.textContent || ''));
  await win.evaluate(id => send({ t: 'input', id, d: 'ecris-vue\r' }), id); // vue d'origine pour la suite
  await win.waitForSelector('.term.show .typeView .tvHead button:has-text("Corriger")');
  const seen = txt => win.waitForFunction(([id, txt]) => { const b = terms.get(id).term.buffer.active; for (let y = 0; y < b.length; y++) if (b.getLine(y).translateToString().includes(txt)) return true; return false; }, [id, txt], { timeout: 20000 });
  await seen('analyse-e2e T-42 $&');
  // champ de l'affichage : envoyé avec son bouton, vidé ensuite
  await win.fill('.term.show .typeView .tvInput input', '25077 36200');
  await win.click('.term.show .typeView .tvInput button:has-text("Analyser")');
  await seen('points-e2e 25077 36200');
  assert.equal(await win.inputValue('.term.show .typeView .tvInput input'), '');
  // action du type : envoyée à la session
  await win.click('.term.show .typeView .tvHead button:has-text("Corriger")');
  await win.waitForFunction(id => { const b = terms.get(id).term.buffer.active; for (let y = 0; y < b.length; y++) if (b.getLine(y).translateToString().includes('echo: corrige-e2e')) return true; return false; }, id, { timeout: 20000 });
  // bascule vers le terminal
  await win.click('#btnView');
  assert.equal(await win.evaluate(id => terms.get(id).el.querySelector('.typeView').hidden, id), true);
  await win.evaluate(() => api('DELETE', '/api/extensions/ext-e2e'));
});

test('export / import : fichier relu, aperçu des sessions, import sans doublon', async () => {
  const file = path.join(TMP, 'app-export');
  const ex = await win.evaluate(p => api('POST', '/api/transfer/export', { path: p, password: 'pw-e2e' }), file);
  assert.ok(ex.sessions >= 1 && ex.encrypted);
  await win.evaluate(() => window.csmFeatures.openSettings('transfer'));
  await win.setInputFiles('#trFile', ex.path);
  await win.waitForSelector('#trPwRow:not([hidden])'); // protégé : mot de passe demandé
  await win.fill('#trInPw', 'faux'); await win.click('#trOpen');
  await win.waitForFunction(() => /mot de passe incorrect/.test(document.querySelector('#trImportMsg').textContent));
  await win.fill('#trInPw', 'pw-e2e'); await win.click('#trOpen');
  await win.waitForSelector('#trGo:not([hidden])');
  assert.match(await win.textContent('#trSummary'), new RegExp(`${ex.sessions} sessions \\(0 nouvelles ici\\)`));
  assert.equal(await win.$$eval('#trList li.dim', l => l.length), ex.sessions, 'toutes « déjà ici »');
  // champs de mot de passe à hauteur normale (pas écrasés)
  assert.ok(await win.evaluate(() => document.querySelector('#trInPw').offsetHeight >= 30));
  const before = await win.evaluate(() => sessions.size);
  await win.click('#trGo');
  await win.waitForFunction(() => /^Importé/.test(document.querySelector('#trImportMsg').textContent));
  assert.equal(await win.evaluate(() => sessions.size), before, 'aucune session en double');
  await win.evaluate(() => document.querySelector('#dlgSettings').close());
});

test('nouvelle session : plafond de quota choisi à la création, repris par un modèle', async () => {
  await win.click('#btnNew');
  await win.waitForSelector('#dlgNew[open]');
  assert.equal(await win.inputValue('#formNew [name=qSeven]'), '', 'aucun plafond par défaut');
  assert.equal(await win.isDisabled('#formNew [name=qResume]'), true, 'reprise grisée sans seuil');
  await win.selectOption('#formNew [name=qSeven]', '95');
  await win.check('#formNew [name=qResume]');
  await win.fill('#formNew [name=cwd]', WORK);
  await win.fill('#formNew [name=name]', 'avec-plafond');
  await win.click('#formNew button[value=ok]');
  const q = await win.waitForFunction(() => [...sessions.values()].find(s => s.name === 'avec-plafond')?.quotaStop, null, { timeout: 30000 }).then(h => h.jsonValue());
  assert.equal(q.seven, 95); assert.equal(q.five, null); assert.equal(q.resume, true);
  // modèle enregistré avec le plafond, réappliqué dans Nouvelle session
  await win.evaluate(() => api('PUT', '/api/templates', [{ id: 'tpl-cap', name: 'Avec plafond', cwd: '', quotaStop: { five: 90, seven: null, resume: false } }]));
  await win.click('#btnNew');
  await win.waitForFunction(() => [...document.querySelectorAll('#formNew [name=template] option')].some(o => o.value === 'tpl-cap'));
  await win.evaluate(() => { const f = document.querySelector('#formNew'); f.template.value = 'tpl-cap'; f.template.dispatchEvent(new Event('change')); });
  assert.equal(await win.inputValue('#formNew [name=qFive]'), '90');
  assert.equal(await win.inputValue('#formNew [name=qSeven]'), '');
  await win.evaluate(() => { document.querySelector('#dlgNew').close(); return api('PUT', '/api/templates', []); });
  const id = await win.evaluate(() => [...sessions.values()].find(s => s.name === 'avec-plafond').id);
  await win.evaluate(id => api('DELETE', '/api/sessions/' + id), id);
  await win.waitForFunction(id => !sessions.has(id), id);
  await win.evaluate(() => select([...sessions.keys()][0])); // une session active pour la suite
});

test('plafond de quota : réglé depuis le menu ⋯, relu, retiré', async () => {
  const id = await win.evaluate(() => active);
  assert.match(await win.evaluate(id => moreItems(id).map(x => x[0]).join('|'), id), /Plafond de quota…/);
  await win.evaluate(id => window.csmFeatures.openQuotaStop(id), id);
  await win.waitForSelector('#dlgQuotaStop[open]');
  assert.match(await win.inputValue('#formQS [name=text]'), /\{pct\} %/, 'message par défaut affiché');
  await win.selectOption('#formQS [name=seven]', '90'); // choisir un seuil coche la case
  assert.equal(await win.isChecked('#formQS [name=sevenOn]'), true);
  await win.check('#formQS [name=resume]');
  await win.click('#formQS button[value=ok]');
  const q = await win.waitForFunction(id => sessions.get(id)?.quotaStop, id).then(h => h.jsonValue());
  assert.equal(q.seven, 90); assert.equal(q.five, null); assert.equal(q.resume, true); assert.equal(q.text, '', 'texte par défaut non recopié');
  assert.match(await win.evaluate(id => moreItems(id).map(x => x[0]).join('|'), id), /Plafond de quota \(7 j ≥ 90 %\)…/);
  await win.evaluate(id => window.csmFeatures.openQuotaStop(id), id);
  await win.waitForSelector('#dlgQuotaStop[open]');
  assert.equal(await win.isChecked('#formQS [name=fiveOn]'), false);
  await win.click('#qsOff');
  await win.waitForFunction(id => !sessions.get(id)?.quotaStop, id);
});

test('barre latérale : état de la synchro sur sa propre ligne, jamais coupé', async () => {
  await win.evaluate(() => { window.csmFeatures.syncMachine = 'MacBook-Air-de-Khalil'; window.dispatchEvent(new CustomEvent('csm:sync', { detail: { enabled: true, lastOk: Date.now() } })); });
  const r = await win.waitForFunction(() => {
    const l = document.querySelector('#sideStatus .syncLine span');
    return l && { text: l.textContent, cut: l.scrollWidth > l.clientWidth + 1, hist: getComputedStyle(document.querySelector('#btnHistory .lbl')).display };
  }).then(h => h.jsonValue());
  assert.equal(r.text, 'Synchronisé · MacBook-Air-de-Khalil');
  assert.equal(r.cut, false, 'texte entier');
  assert.notEqual(r.hist, 'none', 'libellé « Historique » de nouveau visible');
  await win.evaluate(() => { delete window.csmFeatures.syncMachine; window.dispatchEvent(new CustomEvent('csm:sync', { detail: { enabled: false } })); });
  await win.waitForFunction(() => !document.querySelector('#sideStatus .syncLine'));
});

test('synchro : guide de première utilisation, champ du code prêt à la saisie (curseur, collage, bien visible)', async () => {
  await win.evaluate(() => window.csmFeatures.openSettings('general'));
  await win.click('.setNav [data-st=sync]');
  await win.waitForSelector('#syncSetup:not([hidden]) .syncGuide[open] ol li');
  assert.equal(await win.evaluate(() => document.querySelectorAll('.syncGuide ol li').length), 4);
  await win.waitForFunction(() => document.activeElement?.id === 'syncJoinCode', null, { timeout: 3000 });
  await win.keyboard.type('abcd-efgh');
  assert.equal(await win.inputValue('#syncJoinCode'), 'abcd-efgh', 'saisie possible');
  await win.fill('#syncJoinCode', 'AAAA-BBBB-CCCC-DDDD-EEEE');
  assert.equal(await win.inputValue('#syncJoinCode'), 'AAAA-BBBB-CCCC-DDDD-EEEE');
  // thème clair : champ blanc dans la carte, pas grisé comme un champ désactivé
  await win.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  const [bg, disabled] = await win.evaluate(() => [getComputedStyle(document.querySelector('#syncJoinCode')).backgroundColor, document.querySelector('#syncJoinCode').disabled]);
  assert.equal(disabled, false);
  assert.equal(bg, 'rgb(255, 255, 255)', 'fond blanc en thème clair');
  if (process.env.SHOT_DIR) await win.screenshot({ path: path.join(process.env.SHOT_DIR, 'synccode.png') });
  await win.evaluate(() => { delete document.documentElement.dataset.theme; document.querySelector('#syncJoinCode').value = ''; document.querySelector('#dlgSettings').close(); });
});

test('nouvelle session : premier message visible, raccourci, indication du dépôt du dossier', async () => {
  const REPO = path.join(TMP, 'depot');
  fs.mkdirSync(REPO, { recursive: true });
  const gx = a => require('child_process').execFileSync('git', a, { cwd: REPO });
  gx(['init', '-q', '-b', 'principale']); gx(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  await win.click('#btnNew');
  assert.equal(await win.isVisible('#formNew [name=prompt]'), true); // plus caché dans « Options avancées »
  assert.match(await win.textContent('#nsKbd'), /Ctrl Alt N|⌘⌥N/);
  assert.equal((await win.textContent('#formNew button[value=ok]')).trim(), 'Lancer la session');
  await win.fill('#formNew [name=cwd]', REPO);
  await win.waitForFunction(() => /branche principale/.test(document.querySelector('#cwdGit').textContent) && !document.querySelector('#cwdGit').hidden, null, { timeout: 15000 });
  await win.fill('#formNew [name=cwd]', WORK);
  await win.waitForFunction(() => /Pas un dépôt git/.test(document.querySelector('#cwdGit').textContent), null, { timeout: 15000 });
  await win.evaluate(() => document.querySelector('#dlgNew').close());
});

test('centre d’attention : demande d’autorisation affichée et acceptée depuis le centre', async () => {
  const id = await win.evaluate(() => [...sessions.values()].find(s => s.name === 'e2e').id);
  await win.evaluate(id => send({ t: 'input', id, d: 'demande\r' }), id);
  await win.waitForSelector('#btnAttention:not([hidden])', { timeout: 30000 });
  await win.click('#btnAttention'); // bouton « À traiter » de la barre du haut
  await win.waitForSelector('#dlgAttention[open] .atCard.perm', { timeout: 15000 });
  assert.match(await win.textContent('#dlgAttention .atCard.perm .atAsk'), /Do you want to proceed/);
  await win.click('#dlgAttention .atCard.perm button:has-text("Autoriser")');
  await win.waitForFunction(id => { const b = terms.get(id).term.buffer.active; for (let y = 0; y < b.length; y++) if (b.getLine(y).translateToString().includes('AUTORISATION:oui')) return true; return false; }, id, { timeout: 20000 });
  await win.waitForFunction(() => !document.querySelector('#dlgAttention .atCard.perm'), null, { timeout: 15000 });
  await win.evaluate(() => document.querySelector('#dlgAttention').close());
});

test('usage de Claude : indicateurs, quota, sessions (Ctrl+Alt+U)', async () => {
  await win.evaluate(() => window.csmFeatures.openUsage()); // (raccourci Ctrl+Alt+U, palette, quotas de la barre latérale)
  await win.waitForSelector('#dlgUsage[open] #dbKpis .dbKpi', { timeout: 15000 });
  assert.equal(await win.evaluate(() => document.querySelectorAll('#dbKpis .dbKpi').length), 4);
  assert.match(await win.textContent('#dbKpis'), /Sessions actives/);
  await win.waitForFunction(() => document.querySelector('#dbRows').children.length > 0);
  await win.evaluate(() => document.querySelector('#dlgUsage').close());
});

test('en-tête : chemin complet du dossier et état en pastille', async () => {
  await win.waitForFunction(() => document.querySelector('#curCwd bdi')?.textContent.length > 0);
  const r = await win.evaluate(() => ({ cwd: document.querySelector('#curCwd bdi').textContent, full: sessions.get(active)?.cwd, title: document.querySelector('#curCwd').title, msg: document.querySelector('#curMsg').className }));
  assert.equal(r.cwd, r.full); // chemin complet de la session active, non tronqué
  assert.ok(r.title.startsWith(r.cwd));
  assert.match(r.msg, /\bmsg\b/);
});

test('vue partagée : bandeau d’aide masquable et mémorisé', async () => {
  await win.click('[data-layout="2c"]');
  assert.equal(await win.locator('#paneHint').isVisible(), true);
  assert.ok(await win.locator('.pane:not([hidden]) .phead .pnum').count() >= 2);
  await win.click('#paneHintX');
  assert.equal(await win.locator('#paneHint').isVisible(), false);
  assert.equal(await win.evaluate(() => localStorage.getItem('csm.paneHintOff')), 'true');
  await win.click('[data-layout="1"]');
});

test('jeton demandé par une extension : fenêtre au démarrage avec le lien pour l’obtenir', async () => {
  await win.evaluate(() => api('POST', '/api/extensions', { content: JSON.stringify({ csm: 1, id: 'outil-ui', name: 'Outil', secrets: [{ id: 'jeton', name: 'Jeton de l’outil', url: 'https://example.com/tokens', env: 'CSM_UI_TOKEN' }] }) }));
  try {
    await win.evaluate(() => window.csmFeatures.askSecrets(true));
    await win.waitForSelector('#dlgSecrets[open] .secretCard');
    assert.equal(await win.getAttribute('#dlgSecrets .secretCard a', 'href'), 'https://example.com/tokens');
    if (process.env.CSM_SHOT) await win.screenshot({ path: process.env.CSM_SHOT.replace(/(\.png)?$/, '-jeton.png') });
    await win.fill('#dlgSecrets .secretCard input', 'jeton-ui-123456');
    await win.click('#dlgSecrets .secretCard button.primary');
    // fermée, ou un message d'erreur affiché : dans ce cas, l'échec dit pourquoi
    await win.waitForFunction(() => !document.querySelector('#dlgSecrets').open || document.querySelector('#dlgSecrets .secretMsg')?.textContent, null, { timeout: 25000 }).catch(() => { });
    const st = await win.evaluate(async () => ({ open: document.querySelector('#dlgSecrets').open, msgs: document.querySelector('#dlgSecrets .secretMsg')?.textContent || '(aucun message)', list: await api('GET', '/api/secrets') }));
    assert.equal(st.open, false, `fenêtre toujours ouverte : ${st.msgs} · ${JSON.stringify(st.list)}`);
  } finally { await win.evaluate(() => api('DELETE', '/api/extensions/outil-ui')); }
});

test('mes prompts (Ctrl+Alt+P depuis le terminal, une seule fois) et bouton Pause', async () => {
  await win.evaluate(() => select([...sessions.values()].find(s => s.name === 'e2e').id));
  await win.click('.term.show');
  await win.keyboard.press('Control+Alt+KeyP');
  await win.waitForSelector('#tab-prompts:not([hidden]) #promptList li[data-i]');
  assert.equal(await win.isHidden('#panel'), false, 'ouvert (pas ouvert puis refermé)');
  assert.match(await win.textContent('#promptList'), /bonjour e2e/);
  await win.fill('#promptQ', 'zzz');
  await win.waitForSelector('#promptList li.hint');
  await win.fill('#promptQ', '');
  if (process.env.CSM_SHOT) await win.screenshot({ path: process.env.CSM_SHOT.replace(/(\.png)?$/, '-prompts.png') });
  await win.keyboard.press('Control+Alt+KeyP');
  await win.waitForFunction(() => document.querySelector('#panel').hidden);
  // pause : la session s'arrête, reste dans la liste, « Reprendre » apparaît
  assert.equal(await win.isVisible('#btnPause'), true);
  await win.click('#btnPause');
  await win.waitForFunction(() => { const s = [...sessions.values()].find(x => x.name === 'e2e'); return s && !s.alive && s.paused; }, null, { timeout: 20000 });
  assert.equal(await win.isHidden('#btnPause'), true);
  assert.match(await win.textContent('#btnRestart'), /Reprendre/);
  if (process.env.CSM_SHOT) await win.screenshot({ path: process.env.CSM_SHOT.replace(/(\.png)?$/, '-pause.png') });
  await win.click('#btnRestart');
  await win.waitForFunction(() => { const s = [...sessions.values()].find(x => x.name === 'e2e'); return s?.alive && s.status === 'idle'; }, null, { timeout: 30000 });
});

test('Fermer retire la session de la liste', async () => {
  const id = await win.evaluate(async () => { const s = await api('POST', '/api/sessions', { cwd: [...sessions.values()][0].cwd, name: 'a-fermer' }); return s.id; });
  await win.waitForFunction(id => sessions.get(id)?.status === 'idle', id, { timeout: 30000 });
  await win.evaluate(id => select(id), id);
  await win.click('#btnClose');
  await win.waitForFunction(id => !sessions.has(id), id, { timeout: 20000 });
  await win.waitForFunction(id => active !== id, id, { timeout: 10000 }); // passée à une autre session
});

test('zone de notification : choisie depuis un menu, plus d’option « réduire »', async () => {
  assert.equal(await win.evaluate(() => !!document.querySelector('[data-set=minimizeToTray]')), false);
  const labels = await win.evaluate(() => moreItems([...sessions.keys()][0]).filter(Array.isArray).map(x => x[0]));
  assert.ok(labels.includes('Réduire dans la zone de notification') || labels.includes('Réduire dans la barre des menus'), labels.join(' | '));
});

test('bulle de mise à jour : « Plus tard » la ferme', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('csm:update-state', { status: 'ready', version: '99.0.0' }));
  await win.waitForSelector('#updateBar:not([hidden])');
  assert.match(await win.textContent('#updateMsg'), /99\.0\.0/);
  await win.click('#btnUpdateLater');
  await win.waitForSelector('#updateBar', { state: 'hidden' });
  // la même version annoncée de nouveau (vérification suivante) : bulle toujours fermée
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('csm:update-state', { status: 'ready', version: '99.0.0' }));
  await new Promise(r => setTimeout(r, 300));
  assert.equal(await win.isHidden('#updateBar'), true);
  // une version plus récente : reproposée
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('csm:update-state', { status: 'ready', version: '99.0.1' }));
  await win.waitForSelector('#updateBar:not([hidden])');
  await win.click('#btnUpdateLater');
});

test('fermer la fenêtre ne coupe pas les sessions', async () => {
  await win.evaluate(() => window.close());
  await new Promise(r => setTimeout(r, 800));
  const token = fs.readFileSync(path.join(DATA, 'token'), 'utf8').trim();
  const r = await fetch(`http://127.0.0.1:${PORT}/api/sessions`, { headers: { 'X-CSM-Token': token } });
  const list = await r.json();
  assert.ok(list.filter(s => s.alive).length >= 2, 'sessions toujours actives');
});
