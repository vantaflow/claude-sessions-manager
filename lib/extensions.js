'use strict';
// Extensions : un fichier `*.csm.json` qui ajoute à l'app des modèles de session, des prompts et des types de
// session (un affichage dédié + des actions), sans toucher au code. Un fichier se partage en privé et s'importe
// dans Réglages › Extensions ; un plugin Claude Code peut aussi en fournir (dossier `csm/` du plugin).
//
// Purement déclaratif : aucune extension n'exécute de code dans l'app. Une session d'un type donné reçoit des
// consignes (ajoutées au prompt système de Claude) et l'adresse d'un fichier où Claude écrit l'état de son
// affichage (JSON « vue », voir VIEW_FORMAT) ; l'app l'affiche tel quel, en texte, jamais en HTML. Une action
// ne fait qu'envoyer un message à la session. Format complet : docs/extensions.md.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fetchExtensions } = require('./extfetch');

const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const MAX_FILE = 256 * 1024;
const KINDS = ['text', 'list', 'kv', 'timeline', 'table', 'checklist', 'draft', 'alert'];

const str = (v, n) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, n);
const color = v => (/^#[0-9a-fA-F]{6}$/.test(v || '') ? v : '');
const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
// Variables d'environnement qu'une extension ne peut pas faire poser (secrets) : elles changeraient ce que
// lancent l'app, Claude ou les outils (chemins, chargeurs, options d'interpréteurs, dossiers du compte, proxys…).
const DANGEROUS_ENV = /^(PATH\w*|PATHEXT|LIBPATH|SHLIB_PATH|CDPATH|NODE_\w*|NPM_\w*|YARN_\w*|LD_\w*|DYLD_\w*|BASH_\w*|BASHOPTS|SHELLOPTS|ENV|IFS|PS\d|PROMPT_COMMAND|ZDOTDIR|SHELL|COMSPEC|PYTHON\w*|PERL\w*|RUBY\w*|GEM_\w*|JAVA_\w*|JDK_\w*|CLASSPATH|DOTNET_\w*|COR_\w*|CORECLR_\w*|GIT_\w*|SSH_\w*|GNUPGHOME|\w*_OPTIONS|\w*_OPTS|HOME|HOMEDRIVE|HOMEPATH|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES\w*|SYSTEMROOT|SYSTEMDRIVE|WINDIR|TEMP|TMP|TMPDIR|USER|USERNAME|LOGNAME|LANG|LANGUAGE|LC_\w*|TZ|TERM\w*|EDITOR|VISUAL|PAGER|BROWSER|XDG_\w*|CLAUDE\w*|CSM_\w*|ANTHROPIC_\w*|ELECTRON_\w*|(HTTPS?|FTP|ALL|NO)_PROXY|SSL_\w*|OPENSSL_\w*|CURL_\w*|REQUESTS_CA_BUNDLE|AWS_\w*|GOOGLE_APPLICATION_CREDENTIALS)$/i;
const safeEnvName = v => /^[A-Z][A-Z0-9_]{1,63}$/.test(v || '') && !DANGEROUS_ENV.test(v);
// Texte envoyé au terminal : ni échappement (\x1b, qui sortirait du collage encadré) ni caractère de contrôle,
// sauf retour à la ligne et tabulation.
const termText = v => String(v).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

// ---------------------------------------------------------------- validation d'une extension
function cleanExtension(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('fichier invalide (objet JSON attendu)');
  if (o.csm !== 1) throw new Error('format non reconnu : « "csm": 1 » attendu');
  if (!ID.test(o.id || '')) throw new Error('identifiant invalide : minuscules, chiffres et tirets (2 à 40)');
  const ext = {
    csm: 1, id: o.id, name: str(o.name, 80) || o.id, version: str(o.version, 20) || '1.0.0',
    description: str(o.description, 500), author: str(o.author, 80),
    templates: [], prompts: [], sessionTypes: [], secrets: [],
  };
  // secrets demandés à l'utilisateur (jeton d'accès…) : rangés dans le trousseau du système (macOS) ou une
  // variable d'environnement de l'utilisateur, là où les outils de l'extension les lisent ; jamais dans l'app
  const KC = /^[\w.-]{1,64}$/;
  const seenSecrets = new Set();
  for (const x of arr(o.secrets, 10)) {
    if (!x || !ID.test(x.id || '') || seenSecrets.has(x.id) || !safeEnvName(x.env)) continue;
    seenSecrets.add(x.id);
    ext.secrets.push({
      id: x.id, name: str(x.name, 80) || x.id, description: str(x.description, 600),
      url: /^https:\/\/[^\s]+$/.test(x.url || '') ? str(x.url, 400) : '',
      env: x.env, keychain: KC.test(x.keychain || '') ? x.keychain : '',
      // autres emplacements acceptés comme « déjà configuré » (ex. un jeton en lecture seule)
      alsoEnv: arr(x.alsoEnv, 4).filter(safeEnvName), alsoKeychain: arr(x.alsoKeychain, 4).filter(v => KC.test(v || '')),
    });
  }
  const types = new Set();
  for (const t of arr(o.sessionTypes, 20)) {
    if (!t || !ID.test(t.id || '') || types.has(t.id)) continue;
    types.add(t.id);
    ext.sessionTypes.push({
      id: t.id, name: str(t.name, 60) || t.id, badge: str(t.badge, 24), color: color(t.color),
      instructions: str(t.instructions, 20000),
      actions: arr(t.actions, 12).filter(a => a && ID.test(a.id || '') && a.send).map(a => ({
        id: a.id, label: str(a.label, 60) || a.id, send: str(a.send, 8000), confirm: !!a.confirm, primary: !!a.primary,
      })),
      // champ de l'affichage (ex. numéros de tickets) : son bouton envoie `send`, {input} remplacé par la saisie
      input: t.input?.send && String(t.input.send).includes('{input}') ? {
        label: str(t.input.label, 60), placeholder: str(t.input.placeholder, 120), button: str(t.input.button, 40), send: str(t.input.send, 8000),
      } : null,
    });
  }
  for (const t of arr(o.templates, 50)) {
    if (!t || !ID.test(t.id || '')) continue;
    ext.templates.push({
      id: t.id, name: str(t.name, 80) || t.id, description: str(t.description, 200), cwd: str(t.cwd, 1000),
      model: str(t.model, 40), mode: ['', 'acceptEdits', 'plan', 'default'].includes(t.mode) ? t.mode || '' : '',
      group: str(t.group, 60), worktree: !!t.worktree, prompt: str(t.prompt, 8000),
      type: types.has(t.type) ? t.type : '',
      // champ affiché dans Nouvelle session ; sa valeur remplace {input} dans le premier message
      input: t.input && typeof t.input === 'object' ? { label: str(t.input.label, 60), placeholder: str(t.input.placeholder, 120) } : null,
    });
  }
  for (const p of arr(o.prompts, 200)) {
    if (!p || !ID.test(p.id || '') || !p.text) continue;
    ext.prompts.push({ id: p.id, title: str(p.title, 100) || p.id, text: str(p.text, 20000), tags: str(p.tags, 200) });
  }
  return ext;
}

// ---------------------------------------------------------------- vue écrite par Claude (fichier JSON)
function cleanSections(list, max) {
  const out = [];
  for (const s of arr(list, max)) {
    if (!s || !KINDS.includes(s.kind)) continue;
    const c = { kind: s.kind, title: str(s.title, 120), badge: str(s.badge, 40), fold: s.fold === true };
    if (s.kind === 'text' || s.kind === 'alert') { c.text = str(s.text, 8000); c.level = s.level === 'warn' ? 'warn' : 'info'; }
    if (s.kind === 'list') c.items = arr(s.items, 50).map(x => str(x, 1000));
    if (s.kind === 'kv') c.items = arr(s.items, 50).map(x => ({ label: str(x?.label, 80), value: str(x?.value, 1000) }));
    if (s.kind === 'timeline') c.items = arr(s.items, 50).map(x => ({ at: str(x?.at, 40), text: str(x?.text, 1000) }));
    if (s.kind === 'table') {
      c.columns = arr(s.columns, 8).map(x => str(x, 60));
      c.rows = arr(s.rows, 100).map(r => arr(r, 8).map(x => str(x, 500)));
    }
    if (s.kind === 'checklist') c.items = arr(s.items, 30).map(x => ({ label: str(x?.label, 200), hint: str(x?.hint, 300), done: !!x?.done }));
    if (s.kind === 'draft') {
      c.text = str(s.text, 20000);
      c.actions = arr(s.actions, 4).map(a => ({ label: str(a?.label, 60), send: str(a?.send, 8000) })).filter(a => a.label && a.send);
    }
    out.push(c);
  }
  return out;
}
// verdict (phrase mise en avant), avancement (étapes), prochaine étape (bouton qui envoie un message)
function cleanVerdict(o) {
  const text = str(o?.text, 300);
  return text ? { text, sub: str(o?.sub, 200), level: ['ok', 'warn', 'info'].includes(o?.level) ? o.level : 'info' } : null;
}
function cleanSteps(o) {
  const items = arr(o?.items, 8).map(x => str(x, 40)).filter(Boolean);
  if (!items.length) return null;
  const cur = Math.round(Number(o?.current));
  return { items, current: Number.isFinite(cur) ? Math.max(0, Math.min(items.length, cur)) : 0 };
}
function cleanNext(o) {
  const label = str(o?.label, 200);
  return label ? { label, button: str(o?.button, 60), send: str(o?.send, 8000) } : null;
}
function cleanView(o) {
  if (!o || typeof o !== 'object') return null;
  const v = {
    title: str(o.title, 200), subtitle: str(o.subtitle, 300), updatedAt: str(o.updatedAt, 40),
    meta: arr(o.meta, 12).map(m => ({ label: str(m?.label, 40), value: str(m?.value, 200) })).filter(m => m.label || m.value),
    verdict: cleanVerdict(o.verdict), steps: cleanSteps(o.steps), next: cleanNext(o.next),
    sections: cleanSections(o.sections, 30),
    // lot (plusieurs tickets, fichiers…) : une ligne par élément, le détail de l'élément choisi à côté
    items: arr(o.items, 20).filter(x => x && typeof x === 'object').map(x => ({
      id: str(x.id, 24), title: str(x.title, 120), state: str(x.state, 30), risk: x.risk === true,
      verdict: cleanVerdict(typeof x.verdict === 'string' ? { text: x.verdict } : x.verdict), next: cleanNext(x.next),
      sections: cleanSections(x.sections, 12),
    })).filter(x => x.id || x.title),
  };
  return v;
}

// Consignes ajoutées à toute session d'un type : où et comment écrire la vue.
const VIEW_FORMAT = `
--- Affichage Claude Sessions ---
Cette session a un affichage dédié dans l'application Claude Sessions. Tiens-le à jour : écris (en remplaçant tout le fichier) un JSON UTF-8 dans le fichier dont le chemin est dans la variable d'environnement CSM_VIEW_FILE, à chaque étape importante.
Format : {"title": "…", "subtitle": "…", "meta": [{"label": "…", "value": "…"}], "sections": [ … ]}
Chaque section a "kind" et un "title" facultatif :
- {"kind": "text", "text": "…"} · {"kind": "alert", "level": "info" ou "warn", "text": "…"}
- {"kind": "list", "items": ["…"]} · {"kind": "kv", "items": [{"label": "…", "value": "…"}]}
- {"kind": "timeline", "items": [{"at": "…", "text": "…"}]} · {"kind": "table", "columns": ["…"], "rows": [["…"]]}
- {"kind": "checklist", "items": [{"label": "…", "hint": "…", "done": false}]}
- {"kind": "draft", "text": "texte à relire", "actions": [{"label": "…", "send": "message envoyé quand l'utilisateur clique ; {draft} = le texte relu"}]}
En tête de l'affichage, facultatifs : "verdict": {"text": "la conclusion en une phrase", "sub": "confiance, date…", "level": "ok" | "warn" | "info"} ; "steps": {"items": ["Analysé", "…"], "current": index de l'étape en cours} ; "next": {"label": "la prochaine étape pour l'utilisateur", "button": "texte du bouton", "send": "message envoyé à la session au clic"}.
Plusieurs éléments à traiter (lot) : "items": [{"id": "…", "title": "…", "state": "à publier", "risk": false, "verdict": "une phrase", "next": {…}, "sections": [ … ]}] — une ligne par élément à gauche, le détail de l'élément choisi à droite ; les "sections" de premier niveau restent communes.
Toute section accepte "fold": true : elle s'affiche repliée (titre seul, ouverte d'un clic) — pour les détails.
Après toute action qui change l'état (publication, envoi, réassignation, pièce jointe ajoutée…), réécris aussitôt l'affichage pour refléter le nouvel état : "state" de l'élément, brouillon déjà publié retiré, nouvelle prochaine étape, risque retiré s'il n'existe plus.
L'affichage se lit en quelques secondes : l'essentiel d'abord, en phrases courtes ; le détail (preuves, chronologie, longues listes) dans des sections repliées. Pas de section vide ni de redite.
Texte brut uniquement (pas de HTML ni de Markdown).`;

module.exports = function (ctx) {
  const { route, json, readBody, sessions, broadcast, DATA } = ctx;
  const DIR = path.join(DATA, 'extensions');
  const VIEWS = path.join(DATA, 'views');
  const STATE = path.join(DATA, 'extensions-state.json');
  fs.mkdirSync(DIR, { recursive: true });
  // 3.27 gardait des copies d'extensions de plugin reçues seules : retirées (une extension de plugin ne vient
  // qu'avec son plugin, dont elle utilise les skills ; la synchro des plugins propose de l'installer)
  try { fs.rmSync(path.join(DATA, 'extensions-synced'), { recursive: true, force: true }); } catch { }
  fs.mkdirSync(VIEWS, { recursive: true });

  let state = { disabled: {} };
  try { state = { disabled: {}, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) }; } catch { }
  const saveState = () => fs.writeFileSync(STATE, JSON.stringify(state), { mode: 0o600 });

  // Plugins Claude Code installés qui fournissent des extensions (dossier csm/ du plugin).
  function pluginDirs() {
    const out = [];
    try {
      const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
      const inst = JSON.parse(fs.readFileSync(path.join(base, 'plugins', 'installed_plugins.json'), 'utf8'));
      for (const [name, e] of Object.entries(inst.plugins || inst)) {
        const p = (Array.isArray(e) ? e[0] : e)?.installPath;
        if (p && fs.existsSync(path.join(p, 'csm'))) out.push({ dir: path.join(p, 'csm'), source: 'plugin ' + name.split('@')[0], plugin: name.split('@')[0] });
      }
    } catch { }
    return out;
  }

  // relu au plus toutes les 30 s : un plugin installé ou mis à jour est pris en compte sans redémarrer
  // (et tout de suite quand la liste des plugins installés change)
  let cache = null, cacheAt = 0, pluginsAt = 0;
  const pluginsMtime = () => { try { return fs.statSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plugins', 'installed_plugins.json')).mtimeMs; } catch { return 0; } };
  function all() {
    const pm = pluginsMtime();
    if (cache && Date.now() - cacheAt < 30e3 && pm === pluginsAt) return cache;
    cacheAt = Date.now(); pluginsAt = pm;
    const list = [], seen = new Set();
    // priorité : importée ici > fournie par un plugin installé ici
    for (const { dir, source, plugin } of [{ dir: DIR, source: 'importée' }, ...pluginDirs()]) {
      let files = [];
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.csm.json')); } catch { }
      for (const f of files) {
        const file = path.join(dir, f);
        try {
          if (fs.statSync(file).size > MAX_FILE) throw new Error('fichier trop gros');
          const ext = cleanExtension(JSON.parse(fs.readFileSync(file, 'utf8')));
          if (seen.has(ext.id)) continue; // une extension importée prime sur celle d'un plugin
          seen.add(ext.id);
          list.push({ ...ext, source, file, plugin, kind: dir === DIR ? 'imported' : 'plugin', removable: dir === DIR, enabled: !state.disabled[ext.id] });
        } catch (e) { list.push({ id: f, name: f, source, file, error: e.message, enabled: false, templates: [], prompts: [], sessionTypes: [] }); }
      }
    }
    return (cache = list);
  }
  ctx.enabledExtensions = () => all().filter(e => !e.error && e.enabled);
  const reload = () => { cache = null; broadcast({ t: 'extensions' }); ctx.syncChanged?.(); };
  const keys = ['csm', 'id', 'name', 'version', 'description', 'author', 'templates', 'prompts', 'sessionTypes', 'secrets'];
  const plain = e => Object.fromEntries(keys.map(k => [k, e[k]]));
  const origins = () => state.from || (state.from = {});

  // Synchro (lib/sync.js) : toutes les extensions valides d'ici, avec leur provenance
  // (kind : imported = importée ici, plugin = d'un plugin installé ici — celles-ci ne voyagent qu'avec le plugin)
  ctx.listSyncExtensions = () => all().filter(e => !e.error).map(e => ({ id: e.id, ext: plain(e), enabled: e.enabled, kind: e.kind, plugin: e.plugin || '' }));
  // importée sur une autre machine : installée ici comme importée, mais DÉSACTIVÉE (ses consignes et secrets
  // n'agissent qu'une fois activée dans Réglages › Extensions), sauf si déjà installée et activée ici à l'identique
  const received = () => state.received || (state.received = {});
  ctx.putExtension = (o, on, from) => {
    const ext = cleanExtension(o);
    const file = path.join(DIR, `${ext.id}.csm.json`), content = JSON.stringify(ext, null, 2);
    let same = false;
    try { same = fs.readFileSync(file, 'utf8') === content; } catch { }
    const keep = same && !state.disabled[ext.id];
    if (!same) fs.writeFileSync(file, content);
    if (!keep) {
      state.disabled[ext.id] = true;
      if (on !== false) received()[ext.id] = true; else delete received()[ext.id]; // active là-bas : à activer ici
    }
    if (from) origins()[ext.id] = String(from).slice(0, 80);
    saveState(); cache = null; broadcast({ t: 'extensions' });
    return true;
  };
  ctx.dropExtension = id => {
    if (!ID.test(id || '')) return;
    fs.rmSync(path.join(DIR, `${id}.csm.json`), { force: true });
    delete state.disabled[id]; delete origins()[id]; delete received()[id];
    saveState(); cache = null; broadcast({ t: 'extensions' });
  };
  const enabled = () => all().filter(e => e.enabled && !e.error);

  // « ext/type » → type de session (ou null : extension retirée ou désactivée)
  function typeOf(s) {
    const m = String(s?.type || '').match(/^([a-z0-9-]+)\/([a-z0-9-]+)$/);
    if (!m) return null;
    const ext = enabled().find(e => e.id === m[1]);
    const t = ext?.sessionTypes.find(x => x.id === m[2]);
    return t ? { ext, type: t } : null;
  }
  const viewFile = s => path.join(VIEWS, `${s.id}.json`);

  // Lancement d'une session typée : consignes + fichier de vue (lus par spawnSession).
  ctx.typeArgs = s => {
    const k = typeOf(s);
    return k ? ['--append-system-prompt', `${k.type.instructions}\n${VIEW_FORMAT}`] : [];
  };
  ctx.typeEnv = s => (typeOf(s) ? { CSM_VIEW_FILE: viewFile(s) } : {});
  ctx.typeInfo = s => {
    const k = typeOf(s);
    return k ? { ext: k.ext.id, id: k.type.id, name: k.type.name, badge: k.type.badge, color: k.type.color, actions: k.type.actions.map(({ id, label, confirm, primary }) => ({ id, label, confirm, primary })),
      input: k.type.input ? { label: k.type.input.label, placeholder: k.type.input.placeholder, button: k.type.input.button } : null } : null;
  };

  // Vue mise à jour par Claude : relue quand le fichier change.
  const seenAt = new Map();
  function readView(s) {
    try { return cleanView(JSON.parse(fs.readFileSync(viewFile(s), 'utf8'))); } catch { return null; }
  }
  setInterval(() => {
    for (const s of sessions.values()) {
      if (!s.type) continue;
      let m = 0; try { m = fs.statSync(viewFile(s)).mtimeMs; } catch { }
      if (m && m !== seenAt.get(s.id)) { seenAt.set(s.id, m); broadcast({ t: 'view', id: s.id }); }
    }
  }, 1500).unref?.();

  // ---------------------------------------------------------------- routes
  const pub = e => ({
    id: e.id, name: e.name, version: e.version, description: e.description, author: e.author, source: e.source,
    removable: e.removable, enabled: e.enabled, error: e.error || '', from: origins()[e.id] || '',
    toEnable: !e.enabled && !!(state.received || {})[e.id], // reçue d'une autre machine, à activer ici
    url: e.removable ? (state.urls || {})[e.id] || '' : '',
    counts: { templates: e.templates.length, prompts: e.prompts.length, sessionTypes: e.sessionTypes.length },
  });
  route('GET', /^\/api\/extensions$/, async ({ res }) => json(res, 200, all().map(pub)));
  // import : { content } (fichier choisi) ou { url } (lien GitHub, gist ou https : lib/extfetch.js)
  function install(content, url) {
    if (typeof content !== 'string' || content.length > MAX_FILE) throw new Error('fichier manquant ou trop gros (256 Ko au plus)');
    let ext;
    try { ext = cleanExtension(JSON.parse(content)); } catch (e) { throw new Error(e instanceof SyntaxError ? 'JSON invalide' : e.message); }
    const replaced = all().some(e => e.id === ext.id && e.removable);
    fs.writeFileSync(path.join(DIR, `${ext.id}.csm.json`), JSON.stringify(ext, null, 2));
    delete state.disabled[ext.id]; delete origins()[ext.id]; delete received()[ext.id];
    const urls = state.urls || (state.urls = {});
    if (url) urls[ext.id] = url; else delete urls[ext.id];
    saveState(); cache = null;
    return { id: ext.id, name: ext.name, replaced };
  }
  route('POST', /^\/api\/extensions$/, async ({ req, res }) => {
    const { content, url } = await readBody(req);
    if (url) {
      let files;
      try { files = await fetchExtensions(url); } catch (e) { return json(res, 400, { error: e.message }); }
      const imported = [], errors = [];
      for (const f of files) { try { imported.push(install(f.content, String(url).trim().slice(0, 500))); } catch (e) { errors.push(`${f.name} : ${e.message}`); } }
      if (!imported.length) return json(res, 400, { error: errors[0] || 'aucun fichier .csm.json à cette adresse' });
      reload();
      return json(res, 200, { imported, errors });
    }
    let r;
    try { r = install(content); } catch (e) { return json(res, 400, { error: e.message }); }
    reload();
    json(res, 200, { ...pub(all().find(e => e.id === r.id)), replaced: r.replaced });
  });
  route('DELETE', /^\/api\/extensions\/([a-z0-9-]+)$/, async ({ res, m }) => {
    const e = all().find(x => x.id === m[1] && x.removable);
    if (!e) return json(res, 404, { error: 'extension inconnue (ou fournie par un plugin : désinstaller le plugin)' });
    fs.rmSync(e.file, { force: true });
    reload();
    json(res, 200, { ok: true });
  });
  route('POST', /^\/api\/extensions\/([a-z0-9-]+)\/enabled$/, async ({ req, res, m }) => {
    const { on } = await readBody(req);
    if (on) delete state.disabled[m[1]]; else state.disabled[m[1]] = true;
    delete received()[m[1]];
    saveState(); reload();
    json(res, 200, { ok: true });
  });
  // Modèles et prompts des extensions actives (lecture seule, préfixés par l'extension)
  route('GET', /^\/api\/extensions\/templates$/, async ({ res }) => json(res, 200, enabled().flatMap(e => e.templates.map(t => ({
    ...t, id: `${e.id}/${t.id}`, ext: e.id, extName: e.name, type: t.type ? `${e.id}/${t.type}` : '',
  })))));
  route('GET', /^\/api\/extensions\/prompts$/, async ({ res }) => json(res, 200, enabled().flatMap(e => e.prompts.map(p => ({
    ...p, id: `${e.id}/${p.id}`, ext: e.id, extName: e.name,
  })))));

  // Vue d'une session typée, et ses actions
  route('GET', /^\/api\/sessions\/(\w+)\/view$/, async ({ res, m }) => {
    const s = sessions.get(m[1]); if (!s) return json(res, 404, { error: 'session inconnue' });
    json(res, 200, { type: ctx.typeInfo(s), view: readView(s) });
  });
  route('POST', /^\/api\/sessions\/(\w+)\/view-action$/, async ({ req, res, m }) => {
    const s = sessions.get(m[1]); if (!s) return json(res, 404, { error: 'session inconnue' });
    const { action, section, index, draft, item, next, input } = await readBody(req);
    let text = '';
    if (input != null) {
      const v = str(input, 2000).trim(), k = typeOf(s);
      if (!v) return json(res, 400, { error: 'champ vide' });
      text = k?.type.input ? k.type.input.send.replace(/\{input\}/g, () => v) : '';
    } else if (action) {
      const k = typeOf(s);
      text = k?.type.actions.find(a => a.id === action)?.send || '';
    } else {
      // action d'une section « draft » de la vue (ou d'un élément du lot), ou bouton « prochaine étape »
      const v = readView(s), it = item != null ? v?.items?.[Number(item)] : null, src = item != null ? it : v;
      if (next) text = src?.next?.send || '';
      else {
        const sec = src?.sections?.[Number(section)];
        text = sec?.kind === 'draft' ? sec.actions[Number(index)]?.send || '' : '';
      }
    }
    if (!text) return json(res, 404, { error: 'action inconnue' });
    // fonction de remplacement : un « $& » ou « $' » du brouillon reste tel quel
    text = termText(text.replace(/\{draft\}/g, () => str(draft, 20000)));
    if (!text.trim()) return json(res, 400, { error: 'texte vide' });
    if (!s.pty) return json(res, 409, { error: 'session arrêtée : relance-la d’abord' });
    s.pty.write(`\x1b[200~${text}\x1b[201~`);
    setTimeout(() => { if (s.pty) s.pty.write('\r'); }, 150);
    actedAt.set(s.id, { at: Date.now(), worked: false });
    json(res, 200, { ok: true });
  });
  // Action lancée depuis l'affichage (publier, réassigner…) : si Claude finit son tour sans avoir réécrit
  // l'affichage, il lui est demandé une fois de le mettre à jour (l'affichage ne reste pas sur « à publier »).
  const actedAt = new Map();
  const VIEW_REFRESH = "[Claude Sessions] Mets à jour l'affichage de cette session (fichier CSM_VIEW_FILE) pour refléter ce qui vient d'être fait : état, brouillon déjà publié retiré, prochaine étape, risque. Ne fais aucune autre action.";
  ctx.on('working', s => { const a = actedAt.get(s.id); if (a) a.worked = true; });
  ctx.on('idle', s => {
    const a = actedAt.get(s.id);
    if (!a?.worked) return; // fin d'un tour commencé avant l'action
    actedAt.delete(s.id);
    const at = a.at;
    let m = 0; try { m = fs.statSync(viewFile(s)).mtimeMs; } catch { }
    if (m >= at || !s.pty || !typeOf(s)) return;
    setTimeout(() => {
      if (!s.pty) return;
      s.pty.write(`\x1b[200~${VIEW_REFRESH}\x1b[201~`);
      setTimeout(() => { if (s.pty) s.pty.write('\r'); }, 150);
    }, 600);
  });
};

module.exports.cleanExtension = cleanExtension;
module.exports.cleanView = cleanView;
module.exports.safeEnvName = safeEnvName;
module.exports.termText = termText;
module.exports.VIEW_FORMAT = VIEW_FORMAT;
