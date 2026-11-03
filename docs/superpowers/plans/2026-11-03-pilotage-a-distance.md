# Pilotage à distance — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** depuis CSM sur une autre machine de l'espace (ou un navigateur avec mot de passe), afficher et piloter tout le CSM d'une machine qui l'autorise, en direct, chiffré de bout en bout par le relais du Worker.

**Architecture :** un **tunnel** chiffré (trames HTTP et WebSocket) passe par le Durable Object `Hub` de l'espace. Sur la machine pilotée, l'**hôte** rejoue chaque requête sur son propre serveur local (127.0.0.1, son jeton) : toutes les routes et tous les contrôles existants s'appliquent tels quels. Sur la machine qui pilote, un **mandataire** local (port 127.0.0.1 aléatoire, protégé par un ticket) présente le CSM distant comme un site local : la fenêtre y navigue et l'interface de la machine pilotée tourne sans modification. Dans un navigateur sans CSM, une page du Worker ouvre le tunnel elle-même (service worker + remplacement de `WebSocket`).

**Tech Stack :** Node.js (CommonJS, `ws`), Electron, WebCrypto (`crypto.subtle`, même code navigateur et Node), Cloudflare Worker + Durable Object + D1.

**Spec :** `docs/superpowers/specs/2026-11-03-pilotage-a-distance-design.md`

## Global Constraints

- Interrupteur `remoteControl` (faux par défaut), modifiable seulement en local ; jamais par la synchro.
- Clé de pilotage CSM = `derive(clé de synchro, 'csm-remote', <dev de l'hôte>)` ; clé web = 32 octets aléatoires, gardée par le coffre local (backend de `lib/vault`) ; aucune des deux ne donne accès aux données synchronisées.
- Trames : AES-256-GCM, IV aléatoire de 12 octets, AAD = `<connexion>|<sens>|<numéro>` ; clés de connexion = HKDF(clé, nonce du pilote ‖ nonce de l'hôte) ; numéros strictement croissants par sens (rejeu refusé).
- Web : PBKDF2-SHA256, 600 000 tours, sel aléatoire 16 octets, 64 octets dérivés = 32 de chiffrement de l'enveloppe + 32 de preuve ; le relais garde SHA-256(preuve) ; 10 essais par heure et par lien ; mot de passe ≥ 12 caractères.
- Interdit à distance (403) : `PUT /api/settings` touchant `remoteControl`, `syncCode`, `syncServer` ; routes du code de synchro, retrait de machine, mot de passe web, arrêt / redémarrage du serveur ; `/api/pick-folder` répond « choix impossible à distance ».
- Sortie de terminal regroupée par paquets de 50 ms côté hôte ; morceaux de 256 Ko au plus par trame.
- Interface affichée à distance = fichiers `public/` de la machine pilotée.
- Version 3.64.0 ; README, site, CHANGELOG, guide ; `npm test` et tests du Worker verts.

## Review Focus

- Coupure réseau d'un côté (Wi-Fi, mise en veille) → reconnexion seule, état complet renvoyé (liste + replay), aucune frappe en double → Task 4 test `pilote : reconnexion`.
- Trame rejouée, modifiée ou d'une autre connexion → rejetée sans casser la connexion → Task 1 test `trames : rejeu et altération`.
- Route interdite passée par le tunnel (y compris par une casse ou un encodage différent du chemin) → 403 → Task 3 test `hôte : routes interdites`.
- Processus local quelconque sur la machine qui pilote qui vise le port du mandataire sans ticket → refusé → Task 4 test `mandataire : ticket exigé`.
- Mot de passe web essayé en boucle → bloqué après 10 essais dans l'heure, même avec le bon ensuite → Task 2 test `web : limite d'essais`.

---

### Task 1 : chiffrement du tunnel — `public/remote-crypto.js`
**Files :** Create `public/remote-crypto.js` (utilisable par `<script>` et par `require` : attache `window.csmRemoteCrypto` ou `module.exports`), Test `test/remote.test.js`.
**Produces :**
- `pilotKey(syncKeyBytes: Uint8Array, hostDev: string) -> Promise<Uint8Array>` (même résultat que `derive` de lib/sync.js : le vérifier dans le test)
- `openConnection(baseKey, nonceP, nonceH, role: 'pilot'|'host') -> Promise<{ seal(obj) -> Promise<string>, open(str) -> Promise<obj|null> }>` (null = trame refusée)
- `webEnvelope(password, webKey) -> Promise<{ salt, iter, verifier, envelope }>` et `webUnlock(password, { salt, iter }) -> Promise<{ proof, open(envelope) -> Promise<Uint8Array|null> }>`
**Tests :** `trames : aller-retour`, `trames : rejeu et altération` (même trame deux fois → null ; un octet changé → null ; trame d'une autre connexion → null), `web : enveloppe` (bon mot de passe → même clé ; mauvais → null ; `iter === 600000`).

### Task 2 : relais et accès web — `sync-worker/`
**Files :** Modify `sync-worker/src/index.js` (classe `Hub`, routes), Create `sync-worker/migrations/0003_web.sql` (table `csm_web(w TEXT PRIMARY KEY, space TEXT, dev TEXT, salt TEXT, iter INTEGER, verifier TEXT, envelope TEXT, fails INTEGER, failAt INTEGER, gen INTEGER, updatedAt INTEGER)`), Test `sync-worker/test/worker.test.js`.
**Routes :**
- `GET /relay?role=host&dev=<dev>` (authentifiée comme les autres : `spaceOf`) ; `GET /relay?role=pilot&to=<dev>&c=<id>` ; trames texte `{ c, d }` transmises sans lecture ; hôte absent → fermeture 4404 ; au plus 4 pilotes par hôte.
- `PUT /web-access` `{ w, dev, salt, iter, verifier, envelope }` et `DELETE /web-access/<w>` (authentifiées) ; `gen` incrémenté à chaque PUT (déconnecte les pilotes web de la génération précédente).
- `POST /web/unlock` `{ w, proof }` (public) : SHA-256(proof) comparé en temps constant ; 10 échecs par heure → 429 même avec la bonne preuve ; succès → `{ envelope, ticket }` (ticket signé, 2 min, usage unique pour ouvrir `/web/relay`).
- `GET /web/relay?ticket=` (WebSocket, pilote web) ; `GET /web` et `GET /web/sw.js` (chargeur, Task 6).
**Tests :** `relais : trames entre pilote et hôte`, `relais : hôte absent`, `web : limite d'essais`, `web : nouveau mot de passe déconnecte`.

### Task 3 : hôte — `lib/remote/host.js`, `server.js`
**Files :** Create `lib/remote/host.js` ; Modify `server.js` (module dans la liste ; `X-CSM-Remote` : routes interdites ; WebSocket local accepté avec `remote=<nom>` pour marquer la source des frappes ; `publicView` : `typedBy`), `lib/settings.js` (`remoteControl: false`, interne pour la synchro et pour les requêtes marquées distantes), `lib/sync.js` (fiche machine : `remote: true` quand pilotable).
**Interfaces :** `ctx.remote = { hostStatus() -> { on, connected, pilots: [{ c, name, since }] }, cut() }` ; routes `GET /api/remote/status`, `POST /api/remote/cut`.
**Comportement :** connexion hôte au relais (reconnexion avec délai croissant) ; poignée de main (nonces, Task 1) ; trame `http` → `http.request` sur 127.0.0.1:PORT avec le jeton local, `X-CSM-Remote: <nom du pilote>` et l'en-tête Host attendu ; trame `ws-open` → client `ws` local `/ws?token=…&remote=<nom>` relayé, sorties regroupées par 50 ms ; `index.html` renvoyé avec le jeton remplacé par `remote` (le mandataire le remet, Task 4) ; diffusion locale `{ t: 'remote', pilots }` à chaque changement.
**Tests (relais factice en Node dans le test, même protocole que le Hub) :** `hôte : requête rejouée localement`, `hôte : routes interdites` (dont `/API/Settings` et `%2Fapi`), `hôte : couper ferme les pilotes`, `hôte : désactivé par défaut et pas par la synchro`.

### Task 4 : pilote dans CSM — `lib/remote/pilot.js`
**Files :** Create `lib/remote/pilot.js`, `public/pilot-bar.js` (injecté par le mandataire : bandeau « Vous pilotez <machine> · Revenir sur cette machine », `window.csmRemote = true`, retrait de `csmNative.pickFolder`/`pickSave`) ; Modify `server.js` (module).
**Interfaces :** `POST /api/remote/open { dev } -> { url }` (ouvre le tunnel, démarre le mandataire sur 127.0.0.1:0, URL avec ticket à usage unique qui pose un cookie `HttpOnly; SameSite=Strict`) ; `POST /api/remote/close { dev }` ; `GET /api/remote/machines -> [{ dev, name, platform, online }]`.
**Mandataire :** HTTP → trame `http` (corps découpé en morceaux de 256 Ko), réponse en flux ; upgrade `/ws` → trames `ws` ; `index.html` : jeton remis, `<script src="/__pilot-bar.js">` ajouté ; toute requête sans cookie valide → 403.
**Tests (deux serveurs de test, relais factice) :** `pilote : sessions de l'autre machine`, `pilote : frappe et sortie en direct`, `pilote : reconnexion`, `mandataire : ticket exigé`, `pilote : machine non pilotable refusée`.

### Task 5 : interface
**Files :** Modify `public/index.html`, `public/app.js` (sélecteur de machine en tête de la barre latérale, visible si au moins une machine est pilotable ; `location.href = url`), `public/settings.js` (Réglages › Synchronisation › *Pilotage à distance* : case, mot de passe web, lien à copier, pilotes connectés), `public/pilot-host.js` (bandeau « Pilotée à distance depuis … · Couper » sur la machine pilotée), `public/style.css`, `public/i18n.js`, palette (« Piloter <machine> »).
**Tests :** `test/app.test.js` : sélecteur absent sans machine pilotable ; bandeau affiché à `{ t: 'remote', pilots: [...] }`.

### Task 6 : accès depuis un navigateur sans CSM
**Files :** Modify `sync-worker/src/index.js` (sert `web/loader.html`, `web/sw.js`, `remote-crypto.js` intégrés au Worker) ; Create `sync-worker/web/loader.html`, `sync-worker/web/sw.js` ; Modify `lib/remote/host.js` (mot de passe → `webEnvelope`, `PUT /web-access`, clé web dans le coffre local, pilotes web acceptés avec la clé web).
**Comportement :** la page demande le mot de passe → `/web/unlock` → clé web → tunnel vers l'hôte ; l'interface de l'hôte est chargée dans un cadre servi par le service worker, qui fait passer chaque requête par le tunnel de la page ; `WebSocket` remplacé dans le cadre avant les scripts de l'app ; bouton « Se déconnecter et oublier ».
**Tests :** Worker : chargeur servi, en-têtes CSP ; essai de bout en bout avec Playwright (`test/web-e2e.js`, hors `npm test`) : Worker local (`wrangler dev`) + serveur de test hôte → la liste des sessions s'affiche, une frappe arrive.

### Task 7 : livraison
Version 3.64.0, CHANGELOG, README (§ pilotage à distance), site, guide, captures, revue indépendante de la branche, `npm test`, tests du Worker, tag.
