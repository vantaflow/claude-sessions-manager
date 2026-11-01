'use strict';
// Secrets demandés par les extensions (champ « secrets » d'un *.csm.json : jeton d'accès d'un outil…).
// Au démarrage, l'interface demande ceux qui manquent, avec le lien pour les obtenir. La valeur est rangée là où
// les outils de l'extension la lisent, jamais renvoyée à l'interface ni écrite dans les données de l'app :
// - macOS : trousseau (service « keychain » de la déclaration) ;
// - Windows : variable d'environnement de l'utilisateur (« env »), aussi donnée aux sessions lancées ensuite ;
// - Linux (ou macOS sans trousseau déclaré) : fichier secrets.env (0600) des données de l'app, chargé au démarrage
//   dans l'environnement des sessions.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { safeEnvName } = require('./extensions');

const run = (cmd, args, input) => new Promise((resolve, reject) => {
  const p = execFile(cmd, args, { timeout: 15000, windowsHide: true }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim().slice(0, 200))) : resolve(out)));
  if (input !== undefined) p.stdin.end(input);
});

module.exports = function (ctx) {
  const { route, json, readBody, DATA, IS_MAC, IS_WIN } = ctx;
  const FILE = path.join(DATA, 'secrets.env'), STATE = path.join(DATA, 'secrets-state.json');
  // tests : jamais le trousseau ni les variables du compte, seulement le fichier de l'app
  const FILE_ONLY = !!process.env.CSM_SECRETS_FILE_ONLY;
  let state = { dismissed: {} };
  try { state = { dismissed: {}, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) }; } catch { }
  const saveState = () => fs.writeFileSync(STATE, JSON.stringify(state), { mode: 0o600 });

  // secrets enregistrés ici (Linux, ou macOS sans trousseau déclaré) : donnés aux sessions (process.env est hérité)
  {
    try {
      for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
        const m = /^([A-Z][A-Z0-9_]{1,63})=(.*)$/.exec(line);
        if (m && safeEnvName(m[1]) && !process.env[m[1]]) process.env[m[1]] = Buffer.from(m[2], 'base64').toString('utf8');
      }
    } catch { }
  }

  const keychainHas = svc => { try { execFileSync('security', ['find-generic-password', '-s', svc], { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; } };
  // Windows : une variable posée par setx n'est pas dans l'environnement d'un processus déjà lancé
  const userEnvHas = name => {
    try { return /REG_\w+\s+\S/.test(execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', timeout: 5000, windowsHide: true })); } catch { return false; }
  };
  function present(x) {
    if ([x.env, ...x.alsoEnv].some(e => process.env[e])) return true;
    if (FILE_ONLY) return false;
    if (IS_MAC) return [x.keychain, ...x.alsoKeychain].filter(Boolean).some(keychainHas);
    if (IS_WIN) return [x.env, ...x.alsoEnv].some(userEnvHas);
    return false;
  }

  async function store(x, value) {
    if (!FILE_ONLY && IS_MAC && x.keychain) {
      await run('security', ['add-generic-password', '-U', '-s', x.keychain, '-a', os.userInfo().username, '-w', value]);
    } else if (!FILE_ONLY && IS_WIN) {
      // valeur passée par l'entrée standard (jamais dans la ligne de commande)
      await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `$v = [Console]::In.ReadToEnd(); [Environment]::SetEnvironmentVariable('${x.env}', $v, 'User')`], value);
      process.env[x.env] = value;
    } else {
      const lines = (() => { try { return fs.readFileSync(FILE, 'utf8').split('\n').filter(l => l && !l.startsWith(x.env + '=')); } catch { return []; } })();
      lines.push(`${x.env}=${Buffer.from(value).toString('base64')}`);
      fs.writeFileSync(FILE, lines.join('\n') + '\n', { mode: 0o600 });
      process.env[x.env] = value;
    }
  }

  // revérifié ici : jamais une variable sensible (PATH, NODE_OPTIONS, HOME…), même d'une extension écrite à la main
  const declared = () => (ctx.enabledExtensions?.() || []).flatMap(e => (e.secrets || []).filter(x => safeEnvName(x.env))
    .map(x => ({ ext: e.id, extName: e.name, ...x, alsoEnv: (x.alsoEnv || []).filter(safeEnvName) })));
  const find = (ext, id) => declared().find(x => x.ext === ext && x.id === id);
  const key = x => `${x.ext}/${x.id}`;

  // liste sans aucune valeur : seulement présent / manquant
  route('GET', /^\/api\/secrets$/, async ({ res }) => json(res, 200, declared().map(x => ({
    ext: x.ext, extName: x.extName, id: x.id, name: x.name, description: x.description, url: x.url,
    where: IS_MAC && x.keychain ? `trousseau « ${x.keychain} »` : `variable ${x.env}`, env: x.env,
    present: present(x), dismissed: !!state.dismissed[key(x)],
  }))));
  route('POST', /^\/api\/secrets\/([a-z0-9-]+)\/([a-z0-9-]+)$/, async ({ req, res, m }) => {
    const x = find(m[1], m[2]);
    if (!x) return json(res, 404, { error: 'secret inconnu' });
    const b = await readBody(req) || {};
    const v = typeof b.value === 'string' ? b.value.trim() : '';
    if (v.length < 8 || v.length > 4096 || /[\r\n\0]/.test(v)) return json(res, 400, { error: 'valeur invalide' });
    try { await store(x, v); } catch (e) { return json(res, 500, { error: 'enregistrement impossible : ' + e.message }); }
    delete state.dismissed[key(x)]; saveState();
    json(res, 200, { present: present(x) });
  });
  route('POST', /^\/api\/secrets\/([a-z0-9-]+)\/([a-z0-9-]+)\/dismiss$/, async ({ res, m }) => {
    const x = find(m[1], m[2]);
    if (!x) return json(res, 404, { error: 'secret inconnu' });
    state.dismissed[key(x)] = Date.now(); saveState();
    json(res, 200, { ok: true });
  });
};
