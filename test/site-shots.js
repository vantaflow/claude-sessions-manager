'use strict';
// Captures du site (docs/img) : node test/site-shots.js
// Instance isolée (port, profil, données temporaires) avec le faux claude ; terminaux remplis d'un contenu de
// démonstration réaliste (aucune donnée réelle). Ne touche à aucune autre instance.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'img');
const PORT = 19800 + Math.floor(Math.random() * 90);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-site-'));
const HOME = path.join(TMP, 'home'), DATA = path.join(TMP, 'data'), WORK = path.join(HOME, 'projets');
for (const d of [HOME, DATA, OUT]) fs.mkdirSync(d, { recursive: true });
for (const p of ['api-paiements', 'refonte-front', 'migration-sql', 'docs']) fs.mkdirSync(path.join(WORK, p), { recursive: true });
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ onboarded: true, lang: 'fr', autoUpdate: false, theme: 'dark', groupList: 'Travail\nPerso', syncMachine: 'MacBook-Air', memoryAIWelcomed: true }));
fs.writeFileSync(path.join(DATA, 'templates.json'), JSON.stringify([
  { id: 'revue', name: 'Revue de PR', cwd: path.join(WORK, 'api-paiements'), model: 'opus', mode: 'plan', prompt: 'Relis la PR en cours.', group: 'Travail' },
  { id: 'feature', name: 'Nouvelle fonction', cwd: path.join(WORK, 'refonte-front'), model: 'opus', worktree: true, prompt: 'Propose un plan avant de coder.', group: 'Travail' },
]));
fs.mkdirSync(path.join(DATA, 'extensions'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'extensions', 'revue-de-code.csm.json'), path.join(DATA, 'extensions', 'revue-de-code.csm.json'));
const env = {
  ...process.env, CSM_PORT: String(PORT), CSM_DATA: DATA, HOME, USERPROFILE: HOME,
  CSM_HIDE_WINDOW: '1', CSM_CLAUDE: process.execPath, CSM_CLAUDE_ARGS: `"${path.join(__dirname, 'fake-claude.js')}"`,
};
for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|ELECTRON_RUN_AS_NODE)/.test(k)) delete env[k];

// contenu de démonstration des terminaux (séquences ANSI)
const E = '\x1b[', R = `${E}0m`, DIM = `${E}38;2;140;143;150m`, OK = `${E}38;2;63;184;165m`, AMB = `${E}38;2;227;163;59m`, CLAY = `${E}38;2;217;119;87m`, B = `${E}1m`;
const DEMO = {
  'api-paiements': [
    `${CLAY}❯${R} Ajoute la validation des montants négatifs et les tests`, '',
    `${OK}●${R} Je regarde d'abord le service de paiement.`, '',
    `${OK}●${R} ${B}Read${R}(src/payments/service.ts)`, `  ${DIM}⎿  Read 184 lines${R}`, '',
    `${OK}●${R} ${B}Edit${R}(src/payments/service.ts)`, `  ${DIM}⎿  Updated with 6 additions${R}`, '',
    `${OK}●${R} ${B}Write${R}(src/payments/service.test.ts)`, `  ${DIM}⎿  Wrote 42 lines${R}`, '',
    `${AMB}✻ Exécution des tests… ${DIM}(12 s · échap pour interrompre)${R}`],
  'refonte-front': [
    `${CLAY}❯${R} Publie la branche feat/atelier`, '',
    `${OK}●${R} Les tests passent (51/51). Je pousse la branche.`, '',
    `${OK}●${R} ${B}Bash${R}(git push origin feat/atelier)`, '',
    ` Do you want to proceed?`, ` ${CLAY}❯ 1. Yes${R}`, `   2. Yes, and don't ask again for git push`, `   3. No, and tell Claude what to do differently ${DIM}(esc)${R}`],
  'migration-sql': [
    `${CLAY}❯${R} Écris la migration pour la colonne plafond_mensuel`, '',
    `${OK}●${R} ${B}Write${R}(db/migrations/0042_plafond_mensuel.sql)`, `  ${DIM}⎿  Wrote 18 lines${R}`, '',
    `${OK}●${R} Migration prête : ajout de la colonne, valeur par défaut et index.`, `  Tests de migration : ${OK}3/3${R}.`],
  'docs': [
    `  ${DIM}⎿${R}  SessionStart:resume says: ${E}1;35mMémoire IA — cette session (2 sujets)${R}`,
    `     • ${E}1;36mDocumentation de l'API de paiement${R}${E}2m (en cours · 04/11 18:42 · MacBook-Air)${R}`,
    `       README à jour (section « Paiements », exemples curl). Reste la page des erreurs.`,
    `       ${E}33m→ Documenter les codes d'erreur 4xx et ajouter un exemple de remboursement.${R}`,
    `     • ${E}1;36mGuide de démarrage${R}${E}2m (terminé · 03/11 16:10 · PC-Bureau)${R}`,
    `       Guide relu et publié sur le site.`,
    `     ${E}1;35mÀ faire :${R}`, `       ${E}32m☐ Page des codes d'erreur${R}`, `       ${E}32m☐ Exemple de remboursement${R}`,
    `     ${E}1;35mDécisions :${R}`, `       ${E}34m◆ Exemples en curl plutôt qu'en SDK${R}`, '',
    `${CLAY}❯${R} Continue avec la page des erreurs`, '', `${OK}●${R} Je reprends : les codes 400, 402 et 409, avec un exemple pour chacun.`],
};

(async () => {
  const app = await electron.launch({ args: [ROOT], env, timeout: 60000 });
  const win = await app.firstWindow();
  const shot1 = async name => { await new Promise(r => setTimeout(r, 900));
    await win.evaluate(() => { const b = document.querySelector('#curCwd bdi'); if (b) b.textContent = b.textContent.replace(/^.*[\\/]home[\\/]/, '~/'); }); // dossier temporaire de la démo → ~/projets/…
    await win.screenshot({ path: path.join(OUT, `${name}.png`) }); console.log('•', name); };
  // chaque écran en sombre puis en clair (le site suit le thème choisi)
  const shot = async name => {
    await shot1(name);
    await win.evaluate(() => saveSettings({ theme: 'light' })); await shot1(`${name}-light`);
    await win.evaluate(() => saveSettings({ theme: 'dark' }));
  };
  try {
    await win.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 60000 });
    await win.setViewportSize({ width: 1440, height: 900 });
    const ids = {};
    for (const [name, group] of [['api-paiements', 'Travail'], ['refonte-front', 'Travail'], ['migration-sql', 'Travail'], ['docs', 'Perso']]) {
      ids[name] = (await win.evaluate(([cwd, name, group]) => api('POST', '/api/sessions', { cwd, name, group, args: '--model opus' }), [path.join(WORK, name), name, group])).id;
    }
    await win.waitForFunction(() => [...sessions.values()].filter(s => s.status === 'idle').length >= 4, null, { timeout: 120000 });
    // états : travaille, attend une autorisation, terminé, prêt
    await win.evaluate(id => send({ t: 'input', id, d: 'longue\r' }), ids['api-paiements']);
    await win.evaluate(id => send({ t: 'input', id, d: 'demande\r' }), ids['refonte-front']);
    await win.evaluate(id => send({ t: 'input', id, d: 'migration prête\r' }), ids['migration-sql']);
    await win.evaluate(id => api('POST', '/api/hook', { csm: id, event: 'quota', data: { pct: 34, resetAt: Date.now() + 2 * 3600e3 + 9 * 60e3, seven: { pct: 61, resetAt: Date.now() + 2 * 86400e3 } } }), ids.docs);
    await new Promise(r => setTimeout(r, 3000));
    await win.evaluate(() => window.dispatchEvent(new CustomEvent('csm:quota')));
    await win.evaluate(id => select(id), ids['api-paiements']);
    await win.evaluate(() => fitAll(true)); await new Promise(r => setTimeout(r, 1500));
    // terminaux : contenu de démonstration
    await win.evaluate(demo => {
      for (const s of sessions.values()) {
        const lines = demo[s.name]; if (!lines) continue;
        ensureTerm(s.id); const tt = terms.get(s.id);
        const w = tt.term.write.bind(tt.term); tt.term.write = () => { }; // fige la démo : la sortie réelle est ignorée
        tt.redraw = () => { const f = tt.term.options.fontSize; tt.term.options.fontSize = f + 1; tt.term.options.fontSize = f; fitAll(true); tt.term.reset(); w(lines.join('\r\n') + '\r\n'); }; // réécrite une fois affichée (taille et rendu justes)
        tt.redraw();
      }
    }, DEMO);
    await win.evaluate(id => select(id), ids['api-paiements']);
    await win.evaluate(() => fitAll(true));
    await win.evaluate(() => saveSettings({ theme: 'light' })); await shot1('app-light');
    await win.evaluate(() => saveSettings({ theme: 'dark' })); await shot1('app-dark');
    // vue partagée 2×2 avec la barre d'envoi groupé
    await win.evaluate(() => { setLayout('4'); document.querySelector('#sbText').value = 'Lance les tests et résume les échecs'; });
    await win.evaluate(() => fitAll(true)); await shot('split');
    await win.evaluate(() => setLayout('1'));
    // centre d'attention
    await win.evaluate(() => window.csmFeatures.openAttention()); await shot('attention');
    await win.evaluate(() => document.querySelector('#dlgAttention').close());
    // usage de Claude
    await win.evaluate(() => { // chiffres de démonstration (historique du quota, temps de travail, coût)
      const real = window.api, now = Date.now();
      const hist = Array.from({ length: 30 }, (_, i) => ({ t: now - (29 - i) * 6e5, pct: Math.round(4 + i * 1.03) }));
      window.api = async (m, u, b) => {
        if (m === 'GET' && u === '/api/quota') { const q = await real(m, u, b); return { ...q, hist, forecast: { limitAt: now + 3.4 * 3600e3 } }; }
        if (m === 'GET' && u === '/api/worktime') return { today: { total: 3 * 3600 + 25 * 60, queued: 48 * 60, sessions: {} } };
        if (m === 'GET' && u === '/api/usage') { const x = await real(m, u, b); return { ...x, today: { cost: 7.42 }, d7: { cost: 38.9 }, top: [['api-paiements', 412e3, 3.1], ['refonte-front', 268e3, 2.2], ['migration-sql', 96e3, 0.8], ['docs', 41e3, 0.3]].map(([name, t, cost]) => ({ id: name, name, in: t * 0.7, out: t * 0.3, cost })) }; }
        return real(m, u, b);
      };
    });
    await win.evaluate(() => window.csmFeatures.openUsage()); await new Promise(r => setTimeout(r, 1200)); await shot('usage');
    await win.evaluate(() => document.querySelector('#dlgUsage').close());
    // nouvelle session
    await win.click('#btnNew');
    await win.evaluate(() => { const i = document.querySelector('#dlgNew [name=cwd]'); i.value = 'C:\\Users\\moi\\projets\\api-paiements'; i.blur(); getSelection().removeAllRanges(); });
    await shot('new-session');
    await win.keyboard.press('Escape');
    // mémoire IA : résumé au démarrage dans le terminal, et onglet Mémoire du panneau (fiches de démonstration)
    await win.evaluate(() => {
      const real = window.api, now = Date.now();
      const o = (type, title, body) => ({ type, title, body, files: [], keywords: [] });
      window.api = async (m, u, b) => {
        if (m === 'GET' && u.startsWith('/api/memory/ai/session/')) return { enabled: true, project: '{home}/projets/docs', analysis: { running: false, waiting: false },
          topics: [
            { id: 'a', current: true, title: 'Documentation de l\'API de paiement', updated: now - 20 * 60e3, machine: 'MacBook-Air', branch: 'main', request: 'Mettre à jour le README avec la nouvelle API de paiement et ses exemples.', state: 'README à jour : section « Paiements » et exemples curl. Reste la page des codes d\'erreur.', next: 'Documenter les codes d\'erreur 4xx et ajouter un exemple de remboursement.',
              obs: [o('todo', 'Page des codes d\'erreur', 'Les codes 400, 402 et 409 ne sont pas encore décrits.'), o('decision', 'Exemples en curl', 'Plus lisibles que le SDK pour un premier contact, et sans dépendance.'), o('change', 'Section Paiements', 'Ajoutée au README avec trois exemples.')] },
            { id: 'b', current: false, title: 'Guide de démarrage', updated: now - 26 * 3600e3, machine: 'PC-Bureau', request: 'Relire le guide de démarrage.', state: 'Guide relu et publié sur le site.', next: 'rien', obs: [] },
          ],
          others: [{ id: 'c', title: 'Captures du site', updated: now - 3 * 86400e3, machine: 'MacBook-Air', state: 'Captures refaites en thème clair et sombre.', next: 'rien' }] };
        return real(m, u, b);
      };
    });
    await win.evaluate(id => select(id), ids.docs);
    await win.evaluate(() => window.csmFeatures.showPanel('memory'));
    await new Promise(r => setTimeout(r, 800));
    await win.evaluate(id => { fitAll(true); terms.get(id).redraw(); }, ids.docs);
    await shot('memory');
    await win.evaluate(() => document.querySelector('#panelClose').click());
    // version mobile (pilotage depuis le navigateur d'un téléphone)
    await win.setViewportSize({ width: 390, height: 844 });
    await win.evaluate(id => select(id), ids['api-paiements']);
    await new Promise(r => setTimeout(r, 800));
    await win.evaluate(id => { fitAll(true); terms.get(id).redraw(); }, ids['api-paiements']);
    await shot('mobile');
    await win.setViewportSize({ width: 1440, height: 900 });
    await win.evaluate(id => { fitAll(true); terms.get(id).redraw(); }, ids['api-paiements']);
    // extension : session « Revue de code » avec son affichage dédié
    const rev = (await win.evaluate(cwd => api('POST', '/api/sessions', { cwd, name: 'Revue · PR 42', group: 'Travail', type: 'revue-de-code/revue' }), path.join(WORK, 'api-paiements'))).id;
    fs.mkdirSync(path.join(DATA, 'views'), { recursive: true });
    fs.writeFileSync(path.join(DATA, 'views', `${rev}.json`), JSON.stringify({
      title: 'PR 42 · validation des montants', subtitle: 'Revue des modifications en cours (git diff)',
      meta: [{ label: 'Fichiers', value: '4' }, { label: 'Problèmes', value: '3' }, { label: 'Branche', value: 'feat/montants' }],
      sections: [
        { kind: 'text', title: 'Résumé', text: 'La validation des montants est correcte pour les cas nominaux. Deux cas limites ne sont pas couverts et un message d\'erreur expose un détail interne.' },
        { kind: 'table', title: 'Problèmes', columns: ['Gravité', 'Fichier', 'Problème'], rows: [['Haute', 'service.ts:88', 'Montant nul accepté'], ['Moyenne', 'service.ts:102', 'Arrondi avant la comparaison'], ['Basse', 'errors.ts:14', 'Message d\'erreur trop détaillé']] },
        { kind: 'checklist', title: 'À vérifier', items: [{ label: 'Montant à zéro refusé', done: false }, { label: 'Devise inconnue rejetée', done: true }, { label: 'Tests sur les arrondis', done: false }] },
      ],
    }));
    await win.waitForFunction(id => sessions.get(id)?.status === 'idle', rev, { timeout: 60000 });
    await win.evaluate(id => select(id), rev);
    await new Promise(r => setTimeout(r, 2500));
    await shot('extension');
  } finally {
    try { app.process().kill(); } catch { }
    try { process.kill(Number(fs.readFileSync(path.join(DATA, 'server.pid'), 'utf8'))); } catch { }
    await new Promise(r => setTimeout(r, 800));
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
