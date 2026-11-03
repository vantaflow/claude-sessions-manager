# Mémoire IA (Haiku) — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** après chaque session lancée par l'app, Haiku écrit un résumé fiable et des observations typées, partagés chiffrés entre machines, donnés en contexte court au démarrage et cherchables par Claude via un MCP.

**Architecture :** nouveau dossier `lib/memai/` (fonctions pures + module ctx), branché sur les événements `idle`/`end`/`exit` déjà émis par `server.js`. La mémoire native (`lib/memory.js`) reste la base (capture, offsets, repli) ; `buildContext` préfère le résumé IA quand il existe. Synchro par le canal des conversations (R2), comme les fiches `nm-`, préfixe `ob-`.

**Tech Stack :** Node.js (CommonJS), Electron, `node --test`, `claude -p` (Claude Code ≥ 2.1, `--json-schema`, champ `structured_output`).

**Spec :** `docs/superpowers/specs/2026-11-03-memoire-ia-design.md` (lire en entier).

## Global Constraints

- Code, commentaires, interface et prompt en **français**, style du dépôt (commentaires d'intention en tête de module).
- Aucune dépendance nouvelle (pas de SDK MCP, pas d'embeddings : voir « Écarts » ci-dessous).
- Appel IA : `claude -p --model haiku --output-format json --json-schema <schéma> --no-session-persistence --tools "" --strict-mcp-config --settings '{"disableAllHooks":true,"enabledPlugins":{"claude-mem@thedotmack":false}}'`, entrée sur stdin, cwd `DATA/memory/ai-run/`, environnement **sans** `CSM_ID`/`CSM_PORT`/`CSM_TOKEN` ni `CLAUDE_CODE_*`. Lu : `JSON.parse(stdout).structured_output`, `is_error` doit être faux.
- Une seule analyse à la fois ; une fois par session terminée (SessionEnd/exit : 5 s ; inactive après Stop : `CSM_MEMAI_IDLE` ms, défaut **25 min**) ; seulement la partie nouvelle du transcript.
- Sessions triviales (moins de **2** échanges utiles demande→réponse dans la partie nouvelle et l'ancienne réunies) : pas d'analyse.
- Entrée réduite plafonnée à **60 000** caractères par appel (`CSM_MEMAI_MAX_INPUT`) ; au-delà, morceaux analysés à la suite, chacun recevant le résumé précédent.
- Quota : pas d'analyse si `ctx.quota.blockedUntil > now` ou `ctx.quota.pct >= 90` : reportée de 15 min.
- Repli : `claude` introuvable ou **3** échecs d'affilée → analyses suspendues (état visible), reprises au redémarrage de l'app ou par « Analyser maintenant ».
- Contexte de démarrage : ≤ **4 000** caractères quand au moins un résumé IA existe pour le dossier ; réponse en quelques centaines de ms, sans appel IA.
- Observations : 0–15 par analyse, `type ∈ decision|fix|discovery|change|todo|preference`, `title` ≤ 80, `body` 2–5 phrases (≤ 800 car.), `files` ≤ 20, `keywords` ≤ 12 (fr + en).
- Pas de masquage des secrets ; protégés seulement par le chiffrement de la synchro.
- Mise à jour simple : rien à faire pour l'utilisateur, marche sans code de synchro, un seul message d'accueil avec bouton « Couper », rien de propre à B3G codé en dur.
- Livraison : version **3.62.0**, `CHANGELOG.md`, `README.md`, `docs/index.html`, `npm run guide`, `npm test` vert.

## Écarts assumés avec la spec (à signaler à l'utilisateur)

1. **`memoryEngine` reste `native`** et un réglage booléen `memoryAI` (vrai par défaut) active l'IA. Une valeur `ia` casserait les anciennes versions (enum `lib/settings.js:76`, `MEM_UID` de `lib/sync.js:396/460` qui ne connaît que native/claude-mem).
2. **Pas de recherche par le sens** : transformers.js + un modèle multilingue ajoutent ~100 Mo à l'app et du CPU ; la recherche plein texte (accents ignorés) sur titres, corps et mots-clés fr/en écrits par Haiku suffit.

## Review Focus

- Transcript énorme (100 Mo+) ou analyse de la première fois sur une vieille session : jamais tout envoyé, morceaux plafonnés, au plus **3** morceaux par analyse (le reste à l'analyse suivante) → Task 2, test `réduction : plafond et morceaux`.
- Haiku renvoie un `state` qui est un message d'erreur d'API, un JSON hors schéma ou vide → refusé, compté comme échec, rien d'écrit → Task 3, test `validation : erreur d'API refusée`.
- Session reprise après analyse : seule la suite est envoyée et le résumé est **mis à jour** (pas remplacé par un résumé de la seule suite) → Task 4, test `analyse incrémentale`.
- Le processus d'analyse ne doit jamais apparaître comme session ni déclencher le hook (boucle) → Task 4, test `analyse : environnement sans CSM_ID`.
- Une ancienne version (3.61) synchronisée avec `memoryEngine: claude-mem` ne doit pas rebasculer cette machine sur claude-mem → Task 7, test `claude-mem reçu ignoré`.

---

### Task 1 : faux claude en mode `-p`

**Files :** Modify `test/fake-claude.js` (avant la lecture de `--settings`, ~l.55).

**Interfaces :** Produces : comportement de test réutilisé par les Tasks 4, 6, 7.

- [ ] **Step 1 :** si `argv.includes('-p')` : lire stdin en entier ; ajouter une ligne `{ args, env: { CSM_ID, CSM_PORT }, input }` à `~/.fake-ai-calls.jsonl` ; si `FAKE_AI_FAIL=1` : `{ is_error: true, result: 'API Error: 529 overloaded' }` ; si `FAKE_AI_OUT` (chemin) : `structured_output` = contenu de ce fichier ; sinon `structured_output` = `{ summary: { title: 'Sujet : ' + première ligne de demande, request: '…', state: 'Fait.', next: 'rien' }, observations: [{ type: 'decision', title: 'Choix fait', body: 'Parce que.', files: [], keywords: ['choix', 'choice'] }] }`. Écrire `JSON.stringify({ type: 'result', is_error, result, structured_output })` puis sortir 0.
- [ ] **Step 2 :** `node test/fake-claude.js -p < /dev/null` affiche un JSON avec `structured_output`.
- [ ] **Step 3 :** commit `test : faux claude en mode -p (analyse de la mémoire IA)`.

### Task 2 : réduction du transcript

**Files :** Create `lib/memai/reduce.js` ; Test `test/memai.test.js`.

**Interfaces :** Produces `reduce(lines: object[], { maxInput = 60000, maxChunks = 3 } = {}) -> { chunks: string[], exchanges: number, rest: boolean }` ; `usefulExchanges(lines) -> number`.

- [ ] **Step 1 : tests** (`test/memai.test.js`, réutiliser les fabriques `user`/`said` de `test/memory.test.js`) :
  - `réduction : utile seulement` — demande, réponse texte, `tool_use` Edit sur `/w/app/a.js`, `tool_result` de 5 000 caractères, rappel `<system-reminder>`, sous-agent → le texte contient `Demande : …`, `Claude : …`, `Outil Edit : /w/app/a.js`, ne contient ni `system-reminder` ni le texte du sous-agent ; la sortie d'outil est écourtée à ≤ 300 car. ; `exchanges === 1`.
  - `réduction : erreurs gardées` — un `tool_result` avec `is_error: true` apparaît sous `Erreur : …`.
  - `réduction : plafond et morceaux` — 2 000 échanges de 200 car. avec `maxInput: 50000` → `chunks.length === 3`, chaque morceau ≤ 50 000, `rest === true`.
- [ ] **Step 2 :** `node --test test/memai.test.js` → échec (module absent).
- [ ] **Step 3 :** implémenter ; réutiliser `noise` et `textOf` de `lib/memory.js` (les exporter). Coupure entre deux lignes, jamais au milieu.
- [ ] **Step 4 :** tests verts.
- [ ] **Step 5 :** commit `mémoire IA : réduction du transcript`.

### Task 3 : prompt, schéma et validation

**Files :** Create `lib/memai/prompt.js` ; Test `test/memai.test.js`.

**Interfaces :** Produces `SCHEMA` (objet JSON Schema : `summary{title,request,state,next}` requis, `observations[]`), `PROMPT_VERSION = 1`, `buildPrompt({ text, previous?: summary, project, part, parts }) -> string`, `clean(out) -> { summary, observations } | null`.

- [ ] **Step 1 : tests :**
  - `validation : sortie correcte` — types inconnus retirés, titres coupés à 80, au plus 15 observations, mots-clés en minuscules dédoublonnés.
  - `validation : erreur d'API refusée` — `state` = `API Error: 529 {"type":"error"…}` ou `Request interrupted` ou titre vide → `null`.
  - `prompt : résumé précédent repris` — `buildPrompt({ previous })` contient le résumé précédent et la consigne de le **mettre à jour**.
- [ ] **Step 2 :** échec attendu.
- [ ] **Step 3 :** prompt en français : rôle (« tu tiens la mémoire d'un développeur »), consignes (titre = sujet clair, pas le début de la demande ; `state` = où on en est réellement, une session finie sur une erreur se dit en clair ; `next` ou « rien » ; observations = le pourquoi compris, pas la recopie ; mots-clés fr et en ; ne rien inventer). Détection d'erreur : `/^(API Error|Error:|Request interrupted|\{)/i` ou longueur < 3.
- [ ] **Step 4 :** tests verts. **Step 5 :** commit `mémoire IA : prompt, schéma et validation`.

### Task 4 : stockage, analyse et ordonnancement

**Files :** Create `lib/memai/store.js`, `lib/memai/index.js` ; Modify `server.js` (liste des modules, l.1138 : ajouter `'memai'` après `'memory'`), `lib/settings.js` (réglages) ; Test `test/server.test.js`.

**Interfaces :**
- Consumes : `reduce`, `buildPrompt`, `SCHEMA`, `clean` ; `ctx.on('idle'|'working'|'end'|'exit')`, `ctx.transcriptPath(cid)`, `ctx.CLAUDE`, `ctx.quota`, `ctx.getSettings`.
- Produces : fiche IA `{ v: 1, id, summary, obs: [{ id, type, title, body, files, keywords, createdAt }], project, machine, branch, created, updated, analyzedAt, promptVersion, forgotten? }` dans `DATA/memory/ai/<id>.json` (mode 0600) ; local seulement : `DATA/memory/ai-state.json` `{ off: {cid: octets}, fails, suspended, pending: [cid] }` ; `ctx.memai = { on, list(), get(id), put(entry) -> bool, shared(entry), search(q, { project, type, since, limit }) -> hits, status() }`.
- Réglages (`lib/settings.js`) : `memoryAI: true`, `memoryAIWelcomed: false` (interne), `memoryAIMigrated: false` (interne).

- [ ] **Step 1 : tests** (`test/server.test.js`, `CSM_MEMAI_IDLE=300`, faux claude) :
  - `mémoire IA : résumé après inactivité` — session lancée, 2 échanges, hook Stop ; après 300 ms la fiche `DATA/memory/ai/<cid>.json` existe, `summary.title` commence par `Sujet :`, `~/.fake-ai-calls.jsonl` a 1 appel avec `--model haiku` et `--no-session-persistence`.
  - `analyse : environnement sans CSM_ID` — l'appel enregistré a `env.CSM_ID === undefined` et la liste des sessions ne change pas.
  - `analyse incrémentale` — nouvel échange puis Stop : 2ᵉ appel dont l'entrée ne contient pas les demandes déjà analysées mais contient le titre précédent ; un seul fichier de fiche.
  - `analyse : session triviale ignorée` — 1 échange puis SessionEnd → aucun appel.
  - `analyse : échecs puis suspension` — `FAKE_AI_FAIL=1`, 3 sessions → `GET /api/memory/ai/status` `{ suspended: true }`, pas de 4ᵉ appel.
  - `analyse : quota atteint` — `ctx.quota.pct = 95` simulé via la barre d'état (event `quota`) → pas d'appel, `pending` contient la session.
- [ ] **Step 2 :** échec attendu.
- [ ] **Step 3 :** `store.js` : chargement au démarrage, écriture atomique (`.tmp` + `rename`), recherche : mots normalisés (`NFKD`, sans accents, minuscules), chaque mot doit apparaître dans titre/corps/mots-clés/fichiers/résumé ; score = titre ×3, mots-clés ×2, corps ×1, plus récence ; fiches `forgotten` exclues.
- [ ] **Step 4 :** `index.js` : minuteur par session (annulé par `working`), file FIFO, `execFile(ctx.CLAUDE, args, { input, timeout: 120000, cwd, env })` (via `spawn` + `stdin.end(prompt)`, Windows `windowsHide`) ; avance l'offset seulement après succès ; route `GET /api/memory/ai/status` → `{ enabled, running, pending, fails, suspended, lastError, done }`.
- [ ] **Step 5 :** tests verts. **Step 6 :** commit `mémoire IA : analyse par Haiku une fois par session`.

### Task 5 : contexte de démarrage

**Files :** Modify `lib/memory.js` (`buildContext`, `ctx.memoryContext`) ; Test `test/memory.test.js`.

**Interfaces :** `buildContext(entries, project, { exclude, dir, isWin, ai = [] })` ; `ai` = fiches IA (`ctx.memai.list()`).

- [ ] **Step 1 : tests :**
  - `contexte IA : court et trié` — 6 fiches IA du dossier + 2 fiches natives sans fiche IA → longueur ≤ 4 000 ; notes « À retenir » d'abord ; 5 résumés au plus (titre, état, prochaine étape) ; observations `decision`/`todo`/`preference` avant les autres ; une fiche native sans fiche IA apparaît en forme courte ; dernière ligne mentionne l'outil `chercher` de `csm-memoire`.
  - `contexte : sans fiche IA, inchangé` — `ai: []` → même sortie qu'avant (test existant inchangé).
  - `contexte : ni état d'erreur ni texte tronqué` — fiche native dont `last` est `API Error: …` → la ligne « Où on en est » est omise.
- [ ] **Step 2 :** échec attendu. **Step 3 :** implémenter (budget 4 000 quand `ai` contient au moins une fiche du dossier ; sinon l'ancien chemin). **Step 4 :** verts. **Step 5 :** commit `mémoire IA : contexte court au démarrage`.

### Task 6 : outil de recherche (MCP) pour Claude

**Files :** Create `lib/memai/mcp.js` (script stdio autonome, JSON-RPC 2.0 sur lignes : `initialize`, `tools/list`, `tools/call`, `notifications/initialized`) ; Modify `lib/memai/index.js` (routes), `server.js` (`spawnSession` : `--mcp-config`, contrôle du jeton l.840) ; Test `test/server.test.js`.

**Interfaces :**
- Routes (jeton complet **ou** jeton des hooks) : `GET /api/memory/ai/search?q&project&type&since&limit` → `[{ id, kind: 'resume'|'observation', title, date, machine, project }]` (≤ 10 par défaut) ; `GET /api/memory/ai/item/<id>` (fiche ou observation `<cid>:<n>`) ; `GET /api/memory/ai/timeline/<id>` (observations de la même session et de la session précédente du dossier).
- Outils MCP : `chercher` (q, dossier?, type?, depuis?), `details` (id), `chronologie` (id) ; réponses texte compactes.
- `ctx.mcpArgs(s) -> string[]` : `['--mcp-config', DATA/memory/mcp.json]` si `memoryAI` ; fichier `{ mcpServers: { 'csm-memoire': { command: process.execPath, args: [mcp.js], env: { CSM_PORT, CSM_TOKEN: HOOK_TOKEN, ELECTRON_RUN_AS_NODE: '1' } } } }`, mode 0600, réécrit au démarrage (le jeton change).

- [ ] **Step 1 : tests :**
  - `MCP : lancé avec la session` — le faux claude reçoit `--mcp-config` (lancement et `--resume`) ; le fichier existe en 0600.
  - `MCP : chercher puis détails` — lancer `node lib/memai/mcp.js` avec l'env du fichier, envoyer `initialize`, `tools/list` (3 outils), `tools/call chercher {q:"choix"}` → texte contenant l'id ; `details` → corps de l'observation.
  - `jeton des hooks : seulement la mémoire en lecture` — jeton des hooks sur `GET /api/memory/ai/search` → 200 ; sur `GET /api/sessions` et `PATCH /api/memory/ai/…` → 401.
- [ ] **Step 2 :** échec. **Step 3 :** implémenter. **Step 4 :** verts. **Step 5 :** commit `mémoire IA : outil de recherche pour Claude (MCP)`.

### Task 7 : synchro chiffrée, migration claude-mem

**Files :** Modify `lib/sync.js` (nouvelle fonction `syncAiMemory` sur le modèle de `syncNativeMemory`, l.~975 ; `applyDoc` MEM_UID l.460), `lib/settings.js` (migration), `server.js` (`sessionSettings` : `enabledPlugins` claude-mem faux quand `memoryAI`) ; Test `test/server.test.js`.

**Interfaces :** préfixe `ob-<cid>`, AAD `o|<uid>|<ver>|<updatedAt>`, ≤ 4 morceaux, suit `syncSessionMemory` et `ctx.memai.on()` ; la plus récente (`updated`) gagne ; `forgotten` propagé.

- [ ] **Step 1 : tests :**
  - `synchro : fiches IA partagées chiffrées` — deux serveurs de test sur le même faux serveur de synchro : fiche créée sur A arrive sur B ; le serveur ne contient pas le titre en clair ; oubli sur B → oubliée sur A.
  - `claude-mem reçu ignoré` — document MEM_UID `{ engine: 'claude-mem' }` reçu avec `memoryAI` vrai → `memoryEngine` reste `native`, aucune installation lancée.
  - `migration : claude-mem → native une fois` — réglages `{ memoryEngine: 'claude-mem' }` au démarrage → `native`, `memoryAIMigrated: true` ; remis à `claude-mem` à la main ensuite → gardé.
  - `réglages de session : claude-mem coupé` — `enabledPlugins['claude-mem@thedotmack'] === false` quand `memoryAI`.
- [ ] **Step 2 :** échec. **Step 3 :** implémenter. **Step 4 :** verts. **Step 5 :** commit `mémoire IA : synchro chiffrée, claude-mem désactivé`.

### Task 8 : interface, accueil et livraison

**Files :** Modify `public/index.html` (section `memory` et `memChoice`), `public/settings.js`, `public/i18n.js`, `public/style.css` ; `lib/memai/index.js` (routes `POST /api/memory/ai/analyze/<cid>`, `POST /api/memory/ai/claude-mem-off`) ; `package.json` 3.62.0, `CHANGELOG.md`, `README.md` (§ mémoire), `docs/index.html`, `npm run guide` ; Test `test/app.test.js` ou `test/server.test.js`.

- [ ] **Step 1 : tests :**
  - `accueil : une seule fois` — `GET /api/memory/ai/status` → `welcome: true` tant que `memoryAIWelcomed` est faux ; `PUT /api/settings { memoryAIWelcomed: true }` → `welcome: false`.
  - `claude-mem : désactivation proposée seulement s'il est installé` — `status.claudeMemInstalled` faux sans `~/.claude/plugins/installed_plugins.json` ; avec, `POST …/claude-mem-off` écrit `enabledPlugins['claude-mem@thedotmack'] = false` dans `~/.claude/settings.json` après copie de sauvegarde dans `DATA/claude-sync-backup/`.
  - `analyser maintenant` — `POST /api/memory/ai/analyze/<cid>` lève la suspension et lance l'analyse.
- [ ] **Step 2 :** échec. **Step 3 :** interface : case « Mémoire IA (Haiku) » à la place du choix native/claude-mem (claude-mem n'est plus proposé) ; source « Mémoire IA » par défaut dans la liste (`#memSrc`) : résumés et observations, chercher, oublier, renommer ; ligne d'état (en attente, faites, échouées, suspendue) avec « Analyser maintenant » ; bandeau d'accueil unique (texte : « Nouveau : la mémoire des sessions est écrite par Haiku à la fin de chaque session, pour une petite part de ton quota. ») avec « Compris » et « Couper » ; proposition « Désactiver claude-mem » seulement s'il est installé.
- [ ] **Step 4 :** documentation, version, guide ; `npm test` complet vert.
- [ ] **Step 5 :** commit `v3.62.0 : mémoire IA des sessions (Haiku), partagée chiffrée, cherchable par Claude`.
