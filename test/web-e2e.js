'use strict';
// Essai de bout en bout du pilotage depuis un navigateur sans CSM (hors npm test : node test/web-e2e.js).
// Worker local (wrangler dev, D1 local), une instance CSM pilotée (faux claude) reliée à ce Worker, et Chrome
// (playwright-core) sur la page /web : mot de passe, interface de la machine chargée par le tunnel, frappe relayée.
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), http = require('http');
const { spawn, execFileSync } = require('child_process');
const { chromium } = require('playwright-core');
const { encodeCode, authKey } = require('../lib/sync');

const ROOT = process.env.E2E_ROOT || path.join(__dirname, '..'), WDIR = path.join(__dirname, '..', 'sync-worker'), W = path.join(WDIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-web-e2e-'));
const WPORT = 9300 + Math.floor(Math.random() * 200), CPORT = 19500 + Math.floor(Math.random() * 200);
const U = `http://127.0.0.1:${WPORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms, what) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(250); } throw new Error('délai dépassé : ' + what + ' ' + (last?.message || '')); };
const procs = [];

(async () => {
  const state = path.join(TMP, 'wrangler');
  execFileSync(process.execPath, [W, 'd1', 'execute', 'csm-sync', '--local', '--persist-to', state, '--file', 'schema.sql'], { cwd: WDIR, stdio: 'ignore' });
  procs.push(spawn(process.execPath, [W, 'dev', '--local', '--port', String(WPORT), '--ip', '127.0.0.1', '--persist-to', state, '--show-interactive-dev-session=false'], { cwd: WDIR, stdio: 'ignore' }));
  await until(async () => (await fetch(U + '/health')).ok, 60000, 'wrangler dev');
  const key = crypto.randomBytes(16).toString('hex');
  await fetch(U + '/spaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auth: crypto.createHash('sha256').update(authKey(key)).digest('hex') }) });

  const data = path.join(TMP, 'data'), home = path.join(TMP, 'home'), work = path.join(TMP, 'work');
  for (const d of [data, home, work]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env, CSM_PORT: String(CPORT), CSM_DATA: data, HOME: home, USERPROFILE: home, CSM_SECRETS_FILE_ONLY: '1', CSM_NO_PLUGIN_INSTALL: '1', CSM_CLAUDE: process.execPath, CSM_CLAUDE_ARGS: `"${path.join(__dirname, 'fake-claude.js')}"` };
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_)/.test(k)) delete env[k];
  procs.push(spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: 'ignore' }));
  const api = (method, p, body) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: CPORT, path: p, method, headers: { Host: `127.0.0.1:${CPORT}`, 'Content-Type': 'application/json', 'X-CSM-Token': fs.readFileSync(path.join(data, 'token'), 'utf8').trim() } }, res => { let t = ''; res.on('data', c => t += c); res.on('end', () => resolve(t ? JSON.parse(t) : {})); });
    r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end();
  });
  await until(() => fs.existsSync(path.join(data, 'token')) && api('GET', '/api/version'), 20000, 'serveur CSM');
  await api('PUT', '/api/settings', { syncCode: encodeCode(U, key), syncMachine: 'pc-maison', remoteControl: !process.env.E2E_NO_REMOTE, onboarded: true, lang: 'fr' });
  if (!process.env.E2E_NO_REMOTE) await until(async () => (await api('GET', '/api/remote/status')).host.connected, 20000, 'hôte connecté au relais');
  const S = await api('POST', '/api/sessions', { cwd: work, name: 'session-web' });
  if (process.env.E2E_SYNC_ONLY) { await sleep(12000); console.log('sessions (synchro seule) :', JSON.stringify((await api('GET', '/api/sessions')).map(x => ({ name: x.name, syncId: x.syncId || '', msg: x.message })))); return; }
  const web = await api('POST', '/api/remote/web', { password: 'mot-de-passe-de-test-1' });
  if (!web.url) throw new Error('accès web : ' + JSON.stringify(web));
  console.log('lien :', web.url);

  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const page = await browser.newPage();
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log('[console]', m.text()); });
    page.on('response', r => { if (r.status() >= 400) console.log('[404]', r.status(), r.url()); });
    page.on('pageerror', e => console.log('[erreur page]', e.message));
    await page.goto(web.url);
    await page.fill('#pw', 'mauvais-mot-de-passe');
    await page.click('#go');
    await page.waitForFunction(() => /incorrect|Refusé/i.test(document.querySelector('#msg').textContent), null, { timeout: 30000 });
    console.log('mauvais mot de passe : refusé');
    await page.fill('#pw', 'mot-de-passe-de-test-1');
    await page.click('#go');
    const frame = await until(async () => { const f = page.frames().find(x => x !== page.mainFrame()); return f && await f.evaluate(() => document.documentElement.dataset.ready === '1').catch(() => false) ? f : null; }, 60000, 'interface chargée dans le cadre');
    try { await until(() => frame.evaluate(() => [...document.querySelectorAll('#list .name, #list li')].some(e => e.textContent.includes('session-web'))), 20000, 'session listée'); }
    catch (e) { console.log('état du cadre :', JSON.stringify(await frame.evaluate(() => ({ sessions: typeof sessions !== 'undefined' && sessions.size, ws: typeof ws !== 'undefined' && ws && ws.readyState, list: document.querySelector('#list')?.innerHTML.slice(0, 300), remote: window.csmRemote })))); await page.screenshot({ path: path.join(ROOT, '..', 'csm-shots-ia', 'web-e2e-echec.png') }); throw e; }
    console.log('interface de la machine pilotée affichée');
    await page.screenshot({ path: path.join(TMP, 'web.png') });
    fs.copyFileSync(path.join(TMP, 'web.png'), path.join(ROOT, '..', 'csm-shots-ia', 'web-e2e.png'));
    // frappe depuis le navigateur → session de la machine pilotée
    await until(async () => (await api('GET', '/api/sessions')).find(x => x.id === S.id)?.status === 'idle', 20000, 'session prête');
    await frame.evaluate(id => send({ t: 'input', id, d: 'depuis-le-navigateur\r' }), S.id);
    await until(async () => (await api('GET', '/api/sessions')).find(x => x.id === S.id)?.typedBy === 'navigateur', 15000, 'frappe reçue');
    await until(() => frame.evaluate(id => { const t = terms.get(id); if (!t) return false; const b = t.term.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i)?.translateToString() || ''; return s.includes('echo: depuis-le-navigateur'); }, S.id), 15000, 'sortie affichée dans le navigateur');
    console.log('frappe et sortie relayées : OK');
    console.log('sessions de la machine :', JSON.stringify((await api('GET', '/api/sessions')).map(x => ({ name: x.name, origin: x.origin || '', syncId: x.syncId || '' }))));
  } finally {
    await browser.close();
  }
})().then(() => { console.log('ESSAI RÉUSSI'); }, e => { console.error('ÉCHEC :', e.message); process.exitCode = 1; }).finally(() => {
  for (const p of procs) try { p.kill('SIGTERM'); } catch { }
  setTimeout(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { } process.exit(); }, 1500);
});
