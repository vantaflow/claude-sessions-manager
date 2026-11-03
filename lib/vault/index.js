'use strict';
// Coffre des PAT et secrets (menu « Coffre ») : PAT Azure DevOps et secrets libres, gardés protégés par le système
// (backend.js), partagés chiffrés entre les machines (lib/sync.js, préfixe « sec- »), et donnés aux sessions.
//
// PAT d'une session : organisation Azure DevOps du dossier (azure.js) → PAT associé à cette organisation (vérifié,
// association partagée), sinon PAT choisi pour ce dossier, sinon PAT par défaut. Une organisation sans PAT connu est
// vérifiée en arrière-plan : les PAT du coffre sont essayés, le premier qui marche est gardé. Rien n'attend : le
// lancement d'une session prend ce qui est déjà su.
//
// Une valeur n'est jamais renvoyée à l'interface, sauf « Copier » (route reveal). Conflits de synchro : rien n'est
// écrasé, l'utilisateur choisit (voir receive).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const backendLib = require('./backend');
const azure = require('./azure');
const { safeEnvName } = require('../extensions');

const ID = /^[0-9a-f]{12}$/;
const KINDS = ['azure-pat', 'secret'];
const RECHECK = 24 * 3600e3; // association organisation → PAT revérifiée au plus une fois par jour
const hashOf = v => crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 32);
const cleanName = n => String(n || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
const validValue = v => typeof v === 'string' && v.trim().length >= 4 && v.length <= 4096 && !/[\r\n\0]/.test(v);
function cleanTargets(t) {
  const o = {};
  if (t && typeof t.keychain === 'string' && t.keychain.trim() && backendLib.KEYCHAIN.test(t.keychain.trim())) o.keychain = t.keychain.trim();
  if (t && typeof t.env === 'string' && t.env.trim() && safeEnvName(t.env.trim())) o.env = t.env.trim();
  return o;
}

module.exports = function (ctx) {
  const { route, json, readBody, DATA, IS_MAC, IS_WIN } = ctx;
  const FILE = path.join(DATA, 'vault.json');
  const backend = backendLib.open(DATA, { fileOnly: !!process.env.CSM_SECRETS_FILE_ONLY, isMac: IS_MAC, isWin: IS_WIN });
  const settings = () => ctx.getSettings?.() || {};
  const machine = () => String(settings().syncMachine || '').trim() || os.hostname();

  // items : métadonnées (jamais la valeur) ; map : associations partagées ; deleted : suppressions à propager ;
  // conflicts : versions reçues en conflit (valeur gardée à part, protégée comme les autres, id « <id>.c »)
  let V = { items: [], map: { orgs: {}, folders: {}, def: '', updated: 0 }, deleted: {}, conflicts: {}, importOffered: false };
  try { const r = JSON.parse(fs.readFileSync(FILE, 'utf8')); V = { ...V, ...r, map: { ...V.map, ...(r.map || {}) } }; } catch { }
  const save = () => { fs.writeFileSync(FILE + '.tmp', JSON.stringify(V, null, 1), { mode: 0o600 }); fs.renameSync(FILE + '.tmp', FILE); };
  const values = new Map();
  const warnings = new Map(); // org → { org, cwd, message, url, at }
  const get = id => V.items.find(x => x.id === id);

  const ready = (async () => {
    try {
      const ids = [...V.items.map(x => x.id), ...Object.keys(V.conflicts).map(id => id + '.c')];
      for (const [k, v] of await backend.load(ids)) values.set(k, v);
    } catch (e) { console.error('coffre :', e.message); }
  })();

  async function setValue(it, value, { writeTargets = true } = {}) {
    await backend.put(it.id, value);
    values.set(it.id, value);
    it.hash = hashOf(value);
    if (writeTargets) for (const t of [it.targets || {}]) if (t.keychain || t.env) { try { await backend.writeTarget(t, value); } catch (e) { console.error('coffre : cible', e.message); } }
  }
  const touch = it => { it.updated = Math.max(Date.now(), (it.updated || 0) + 1); it.origin = machine(); };

  // ---------------------------------------------------------------- PAT d'une session
  const portable = cwd => ctx.memoryPortable?.(cwd) || cwd;
  const orgCache = new Map(); // cwd → { org, at }
  function orgFor(cwd) {
    const c = orgCache.get(cwd);
    if (c && Date.now() - c.at < 60e3) return c.org;
    let org = ''; try { org = azure.orgOf(cwd); } catch { }
    orgCache.set(cwd, { org, at: Date.now() });
    return org;
  }
  function pick(cwd) {
    const org = orgFor(cwd);
    const mapped = org && get(V.map.orgs[org]);
    if (mapped && values.has(mapped.id) && mapped.orgs?.[org]?.ok !== false) return { it: mapped, org };
    const folder = get(V.map.folders[portable(cwd)]);
    if (folder && values.has(folder.id)) return { it: folder, org };
    const def = get(V.map.def);
    return { it: def && values.has(def.id) ? def : null, org };
  }
  const resolving = new Map();
  function resolve(org, cwd) {
    if (!azure.ORG.test(org || '')) return Promise.resolve(null);
    if (resolving.has(org)) return resolving.get(org);
    const p = (async () => {
      await ready;
      const pats = V.items.filter(x => x.kind === 'azure-pat' && values.has(x.id));
      const order = [get(V.map.orgs[org]), get(V.map.def), ...pats].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i && x.kind === 'azure-pat' && values.has(x.id));
      let refused = 0;
      for (const it of order) {
        const r = await azure.verify(org, values.get(it.id));
        if (r === 'error') continue; // réseau : rien conclu
        it.orgs = { ...(it.orgs || {}), [org]: { ok: r === 'ok', at: Date.now() } };
        if (r === 'ok') {
          if (V.map.orgs[org] !== it.id) { V.map.orgs = { ...V.map.orgs, [org]: it.id }; V.map.updated = Math.max(Date.now(), V.map.updated + 1); }
          warnings.delete(org); save(); return it.id;
        }
        refused++;
      }
      save();
      if (refused || !order.length) warnings.set(org, { org, cwd: cwd || '', at: Date.now(), url: `https://dev.azure.com/${org}/_usersSettings/tokens`,
        message: order.length ? `Aucun PAT du coffre n’est accepté par l’organisation ${org}.` : `Aucun PAT Azure DevOps dans le coffre pour l’organisation ${org}.` });
      return null;
    })().finally(() => resolving.delete(org));
    resolving.set(org, p);
    return p;
  }
  // variables données à une session au lancement (server.js spawnSession) ; ne bloque jamais
  ctx.vaultEnv = s => {
    if (!s?.cwd) return {};
    const { it, org } = pick(s.cwd);
    if (org) {
      const m = get(V.map.orgs[org]), at = m?.orgs?.[org]?.at || 0;
      if (!m || Date.now() - at > RECHECK) resolve(org, s.cwd).catch(() => { });
    }
    if (!it || it.kind !== 'azure-pat') return it && it.targets?.env ? { [it.targets.env]: values.get(it.id) } : {};
    const v = values.get(it.id);
    return { AZURE_DEVOPS_PAT: v, AZURE_DEVOPS_EXT_PAT: v };
  };
  // au démarrage : organisations des sessions existantes vérifiées (pour leur prochain lancement)
  setTimeout(() => { for (const s of ctx.sessions?.values?.() || []) { const o = orgFor(s.cwd); if (o && !V.map.orgs[o]) resolve(o, s.cwd).catch(() => { }); } }, 8000).unref?.();

  // ---------------------------------------------------------------- vue (jamais de valeur)
  const view = it => ({ id: it.id, name: it.name, kind: it.kind, targets: it.targets || {}, updated: it.updated, origin: it.origin || '', orgs: it.orgs || {},
    isDefault: V.map.def === it.id, hasValue: values.has(it.id), conflict: !!V.conflicts[it.id],
    folders: Object.entries(V.map.folders).filter(([, id]) => id === it.id).map(([f]) => f), mappedOrgs: Object.entries(V.map.orgs).filter(([, id]) => id === it.id).map(([o]) => o) });
  const declared = () => (ctx.enabledExtensions?.() || []).flatMap(e => (e.secrets || []).filter(x => safeEnvName(x.env)).map(x => ({ ext: e.id, extName: e.name, id: x.id, name: x.name, description: x.description || '', url: x.url || '', targets: cleanTargets({ keychain: x.keychain, env: x.env }) })));
  route('GET', /^\/api\/vault$/, async ({ res }) => {
    await ready;
    json(res, 200, { items: V.items.map(view), conflicts: Object.entries(V.conflicts).map(([id, c]) => ({ id, name: get(id)?.name || c.name, from: c.origin, at: c.updated })),
      warnings: [...warnings.values()], declared: declared(), importOffered: V.importOffered, sync: !!settings().syncCode && settings().syncSecrets !== false, platform: IS_MAC ? 'mac' : IS_WIN ? 'win' : 'other' });
  });
  route('POST', /^\/api\/vault$/, async ({ req, res }) => {
    await ready;
    const b = await readBody(req) || {};
    const kind = KINDS.includes(b.kind) ? b.kind : 'secret', name = cleanName(b.name);
    if (!name) return json(res, 400, { error: 'nom manquant' });
    if (!validValue(b.value)) return json(res, 400, { error: 'valeur invalide (4 à 4096 caractères, une seule ligne)' });
    const it = { id: crypto.randomBytes(6).toString('hex'), name, kind, targets: cleanTargets(b.targets), orgs: {} };
    touch(it);
    try { await setValue(it, b.value.trim()); } catch (e) { return json(res, 500, { error: 'enregistrement impossible : ' + e.message }); }
    V.items.push(it);
    if (kind === 'azure-pat' && (b.isDefault === true || !get(V.map.def))) { V.map.def = it.id; V.map.updated = Math.max(Date.now(), V.map.updated + 1); }
    save(); ctx.vaultChanged?.();
    json(res, 200, view(it));
  });
  route('PATCH', /^\/api\/vault\/([0-9a-f]{12})$/, async ({ req, res, m }) => {
    await ready;
    const it = get(m[1]);
    if (!it) return json(res, 404, { error: 'secret inconnu' });
    const b = await readBody(req) || {};
    if (typeof b.name === 'string' && cleanName(b.name)) it.name = cleanName(b.name);
    if (b.targets && typeof b.targets === 'object') it.targets = cleanTargets(b.targets);
    if (b.value !== undefined) {
      if (!validValue(b.value)) return json(res, 400, { error: 'valeur invalide (4 à 4096 caractères, une seule ligne)' });
      try { await setValue(it, b.value.trim()); } catch (e) { return json(res, 500, { error: 'enregistrement impossible : ' + e.message }); }
      it.orgs = {}; // nouvelle valeur : à revérifier
    } else if (b.targets && values.has(it.id)) { try { await backend.writeTarget(it.targets, values.get(it.id)); } catch (e) { return json(res, 400, { error: e.message }); } }
    if (b.isDefault === true && it.kind === 'azure-pat') { V.map.def = it.id; V.map.updated = Math.max(Date.now(), V.map.updated + 1); }
    touch(it); save(); ctx.vaultChanged?.();
    json(res, 200, view(it));
  });
  async function remove(id, { propagate = true } = {}) {
    const it = get(id);
    if (!it) return false;
    const v = values.get(id), t = it.targets || {};
    // cible retirée seulement si elle contient encore la valeur du coffre (jamais une valeur posée par quelqu'un d'autre)
    if (v && (t.keychain || t.env)) { try { if (await backend.readTarget(t) === v) await backend.removeTarget(t); } catch { } }
    await backend.drop(id); values.delete(id);
    V.items = V.items.filter(x => x !== it);
    for (const [k, x] of Object.entries(V.map.orgs)) if (x === id) delete V.map.orgs[k];
    for (const [k, x] of Object.entries(V.map.folders)) if (x === id) delete V.map.folders[k];
    if (V.map.def === id) V.map.def = V.items.find(x => x.kind === 'azure-pat')?.id || '';
    V.map.updated = Math.max(Date.now(), V.map.updated + 1);
    if (propagate) V.deleted[id] = Math.max(Date.now(), (it.updated || 0) + 1);
    if (V.conflicts[id]) { await backend.drop(id + '.c'); values.delete(id + '.c'); delete V.conflicts[id]; }
    save();
    return true;
  }
  route('DELETE', /^\/api\/vault\/([0-9a-f]{12})$/, async ({ res, m }) => {
    await ready;
    if (!await remove(m[1])) return json(res, 404, { error: 'secret inconnu' });
    ctx.vaultChanged?.();
    json(res, 200, { ok: true });
  });
  // « Copier » : la seule route qui renvoie une valeur (jeton complet de l'interface seulement, confirmation dans l'interface)
  route('POST', /^\/api\/vault\/([0-9a-f]{12})\/reveal$/, async ({ res, m }) => {
    await ready;
    const it = get(m[1]);
    if (!it || !values.has(it.id)) return json(res, 404, { error: 'secret inconnu' });
    json(res, 200, { value: values.get(it.id) });
  });
  route('POST', /^\/api\/vault\/([0-9a-f]{12})\/check$/, async ({ req, res, m }) => {
    await ready;
    const it = get(m[1]);
    if (!it || it.kind !== 'azure-pat' || !values.has(it.id)) return json(res, 404, { error: 'PAT inconnu' });
    const b = await readBody(req) || {};
    const orgs = [...new Set([...(azure.ORG.test(b.org || '') ? [b.org] : []), ...Object.keys(it.orgs || {}), ...Object.keys(V.map.orgs)])];
    const out = {};
    for (const org of orgs) {
      const r = await azure.verify(org, values.get(it.id));
      out[org] = r;
      if (r !== 'error') it.orgs = { ...(it.orgs || {}), [org]: { ok: r === 'ok', at: Date.now() } };
      if (r === 'ok' && !V.map.orgs[org]) { V.map.orgs[org] = it.id; V.map.updated = Math.max(Date.now(), V.map.updated + 1); warnings.delete(org); }
    }
    save();
    json(res, 200, { results: out, item: view(it) });
  });
  // PAT choisi à la main pour un dossier sans organisation détectable (id vide : retiré)
  route('PUT', /^\/api\/vault\/folder$/, async ({ req, res }) => {
    const b = await readBody(req) || {};
    if (typeof b.cwd !== 'string' || !b.cwd.trim()) return json(res, 400, { error: 'dossier manquant' });
    const key = portable(b.cwd.trim());
    if (b.id) { if (!get(b.id)) return json(res, 404, { error: 'secret inconnu' }); V.map.folders = { ...V.map.folders, [key]: b.id }; } else { const f = { ...V.map.folders }; delete f[key]; V.map.folders = f; }
    V.map.updated = Math.max(Date.now(), V.map.updated + 1);
    save(); ctx.vaultChanged?.();
    json(res, 200, { ok: true, folder: key, org: orgFor(b.cwd.trim()) });
  });
  // conflit : garder la valeur d'ici, ou prendre celle reçue
  route('POST', /^\/api\/vault\/conflict\/([0-9a-f]{12})$/, async ({ req, res, m }) => {
    await ready;
    const c = V.conflicts[m[1]], it = get(m[1]);
    if (!c) return json(res, 404, { error: 'aucun conflit' });
    const b = await readBody(req) || {};
    if (b.keep === 'remote') {
      const rv = values.get(m[1] + '.c');
      const target = it || { id: m[1], orgs: {} };
      Object.assign(target, { name: c.name, kind: c.kind, targets: c.targets });
      if (rv) await setValue(target, rv);
      if (!it) V.items.push(target);
      touch(target); target.base = target.hash;
    } else if (it) { touch(it); it.base = c.hash; } // la nôtre repart, plus récente que la version reçue
    await backend.drop(m[1] + '.c'); values.delete(m[1] + '.c'); delete V.conflicts[m[1]];
    save(); ctx.vaultChanged?.();
    json(res, 200, { ok: true });
  });

  // ---------------------------------------------------------------- import des PAT déjà présents (une fois, avec accord)
  async function importCandidates() {
    const out = [];
    const envNames = new Set(Object.keys(process.env).filter(k => /^AZURE_DEVOPS_(EXT_)?PAT\w*$/i.test(k)));
    for (const x of declared()) if (x.targets.env) envNames.add(x.targets.env);
    const known = new Set(V.items.flatMap(x => [x.targets?.env, x.targets?.keychain]).filter(Boolean));
    for (const env of envNames) {
      if (known.has(env)) continue;
      let v = null; try { v = await backend.readTarget({ env }); } catch { }
      if (!v && process.env[env]) v = process.env[env];
      if (v) out.push({ key: 'env:' + env, name: env, kind: /AZURE_DEVOPS/i.test(env) ? 'azure-pat' : 'secret', targets: { env } });
    }
    if (IS_MAC) for (const x of declared()) {
      if (!x.targets.keychain || known.has(x.targets.keychain)) continue;
      let v = null; try { v = await backend.readTarget({ keychain: x.targets.keychain }); } catch { }
      if (v) out.push({ key: 'kc:' + x.targets.keychain, name: x.name || x.targets.keychain, kind: 'secret', targets: x.targets });
    }
    return out;
  }
  route('GET', /^\/api\/vault\/import$/, async ({ res }) => { await ready; json(res, 200, { offered: V.importOffered, candidates: await importCandidates() }); });
  route('POST', /^\/api\/vault\/import$/, async ({ req, res }) => {
    await ready;
    const b = await readBody(req) || {};
    const want = new Set(Array.isArray(b.keys) ? b.keys : []);
    let n = 0;
    for (const c of await importCandidates()) {
      if (!want.has(c.key)) continue;
      let v = null; try { v = await backend.readTarget(c.targets); } catch { }
      if (!v && c.targets.env) v = process.env[c.targets.env] || null;
      if (!v || !validValue(v)) continue;
      const it = { id: crypto.randomBytes(6).toString('hex'), name: c.name, kind: c.kind, targets: c.targets, orgs: {} };
      touch(it); await setValue(it, v.trim(), { writeTargets: false });
      V.items.push(it); n++;
      if (it.kind === 'azure-pat' && !get(V.map.def)) { V.map.def = it.id; V.map.updated = Math.max(Date.now(), V.map.updated + 1); }
    }
    V.importOffered = true; save();
    if (n) ctx.vaultChanged?.();
    json(res, 200, { imported: n });
  });

  // ---------------------------------------------------------------- synchro (lib/sync.js)
  // Valeur changée hors de l'app (cible relue à chaque synchro) : devient la nouvelle valeur à diffuser.
  async function refreshFromTargets() {
    await ready;
    let changed = false;
    for (const it of V.items) {
      const t = it.targets || {};
      if (!(t.keychain || t.env) || V.conflicts[it.id]) continue;
      let v = null; try { v = await backend.readTarget(t); } catch { }
      if (v && validValue(v) && hashOf(v.trim()) !== it.hash) { await setValue(it, v.trim(), { writeTargets: false }); it.orgs = {}; touch(it); changed = true; }
    }
    if (changed) save();
  }
  ctx.vault = {
    on: () => settings().syncSecrets !== false,
    ready, refreshFromTargets,
    // documents à envoyer : secrets (avec leur valeur, chiffrés par la synchro), suppressions, associations
    docs() {
      const out = new Map();
      for (const it of V.items) {
        if (V.conflicts[it.id] || !values.has(it.id)) continue;
        out.set('sec-' + it.id, { v: 1, id: it.id, name: it.name, kind: it.kind, targets: it.targets || {}, value: values.get(it.id), updated: it.updated, origin: it.origin || machine() });
      }
      for (const [id, updated] of Object.entries(V.deleted)) if (!get(id)) out.set('sec-' + id, { v: 1, id, deleted: true, updated });
      out.set('sec-map', { v: 1, id: 'map', map: { orgs: V.map.orgs, folders: V.map.folders, def: V.map.def }, updated: V.map.updated || 1 });
      return out;
    },
    // envoyé : la valeur envoyée devient la base commune (conflits)
    sent(uid) { const it = get(uid.slice(4)); if (it) { it.base = it.hash; save(); } },
    // reçu : true si quelque chose a changé ici. Règles : rien n'écrase une valeur modifiée ici depuis la dernière
    // synchro ; deux valeurs différentes modifiées des deux côtés (ou première rencontre) → conflit à trancher.
    async receive(uid, d) {
      await ready;
      if (!d || d.v !== 1) return false;
      if (uid === 'sec-map') {
        if (!d.map || !(Number(d.updated) > (V.map.updated || 0))) return false;
        const ok = id => typeof id === 'string' && ID.test(id);
        V.map = { orgs: Object.fromEntries(Object.entries(d.map.orgs || {}).filter(([o, id]) => azure.ORG.test(o) && ok(id))),
          folders: Object.fromEntries(Object.entries(d.map.folders || {}).filter(([f, id]) => typeof f === 'string' && f.length < 1000 && ok(id))),
          def: ok(d.map.def) ? d.map.def : '', updated: Number(d.updated) };
        save(); return true;
      }
      const id = uid.slice(4);
      if (!ID.test(id) || d.id !== id) return false;
      const it = get(id), updated = Number(d.updated) || 0;
      if (d.deleted) {
        if (!it || (it.updated || 0) >= updated) return false;
        if (it.hash && it.base && it.hash !== it.base) return false; // modifié ici depuis : gardé, il repartira
        await remove(id, { propagate: false });
        return true;
      }
      if (V.deleted[id] && V.deleted[id] >= updated) return false; // supprimé ici après cette version
      if (!validValue(d.value)) return false;
      const rh = hashOf(d.value), meta = { name: cleanName(d.name) || 'secret', kind: KINDS.includes(d.kind) ? d.kind : 'secret', targets: cleanTargets(d.targets) };
      if (!it) {
        const n = { id, ...meta, orgs: {}, updated, origin: String(d.origin || '').slice(0, 80) };
        await setValue(n, d.value); n.base = rh; V.items.push(n); delete V.deleted[id]; save(); return true;
      }
      if (rh === it.hash) { // même valeur : seules les métadonnées plus récentes sont prises
        it.base = rh;
        if (updated > (it.updated || 0)) { Object.assign(it, meta, { updated, origin: String(d.origin || '').slice(0, 80) }); }
        save(); return true;
      }
      if (updated <= (it.updated || 0) && it.hash !== it.base) return false; // version plus ancienne, la nôtre repartira
      const localChanged = !it.base || it.hash !== it.base;
      if (!localChanged) { Object.assign(it, meta, { updated, origin: String(d.origin || '').slice(0, 80), orgs: {} }); await setValue(it, d.value); it.base = rh; save(); return true; }
      if (rh === it.base) return false; // seule la nôtre a changé : elle repartira
      // modifiée des deux côtés (ou première rencontre de deux valeurs différentes) : rien n'est écrasé
      await backend.put(id + '.c', d.value); values.set(id + '.c', d.value);
      V.conflicts[id] = { ...meta, hash: rh, updated, origin: String(d.origin || '').slice(0, 80) };
      save(); return true;
    },
  };
};

module.exports.hashOf = hashOf;
