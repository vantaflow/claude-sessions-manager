# Mémoire IA partagée et coffre de secrets — conception

Date : 2026-11-03 · Dépôt : `vantaflow/claude-sessions-manager` (Claude Sessions) · Branche : `feat/memoire-ia`

## Intention

L'utilisateur veut l'équivalent de [claude-mem](https://github.com/thedotmack/claude-mem), mais « en ligne » :
une mémoire qui **comprend** ses sessions Claude Code et la partage entre toutes ses machines (Mac
`MacBook-Air-de-Khalil.local`, PC Windows `KHALIL`). Il constate que la mémoire partagée actuelle « n'est pas au
point », et ce **tous les jours**.

Constats faits sur la mémoire native actuelle (`lib/memory.js`, `memoryEngine = native`) :

- elle ne résume pas, elle **recopie** : 40 dernières demandes, 12 dernières réponses, coupées à longueur fixe
  (`PROMPT_LEN`, `ANSWER_LEN`, `clip`) ; d'où des phrases tronquées (« Le lect… ») ;
- « Où on en est » = la dernière réponse brute, qui peut être un **message d'erreur d'API** ;
- titres = début de la première demande (« S10+ », « STORAGE ») ; aucune décision ni raison retenue ;
- l'injection au démarrage pousse des fiches récentes du dossier sans tri par pertinence.
- claude-mem est installé (`claude-mem@thedotmack` activé, `memsync.js` existe) mais son worker (port 37790) ne
  tourne pas : il ne rend aucun service aujourd'hui.

Le transport chiffré existe déjà et marche : `csm-sync` (Cloudflare Worker + D1 + R2), blobs compressés gzip
puis chiffrés AES-256-GCM sur la machine avec la clé du code de synchro, le serveur ne voit que des octets
opaques. **Ce qui manque, c'est l'intelligence**, et le partage des secrets (PAT Azure DevOps).

## Décisions de l'utilisateur

1. **Intégré à Claude Sessions** (pas un plugin séparé). Remplace la mémoire native comme moteur par défaut.
2. **Mode « le serveur ne voit rien »** : toute l'analyse IA et la recherche se font sur les machines ; le
   serveur reste un coffre synchronisé chiffré (on réutilise `csm-sync`, chiffrer + compresser d'un côté,
   déchiffrer + décompresser de l'autre).
3. **Pas de masquage des secrets** : le contenu est conservé tel quel, protégé seulement par le chiffrement.
4. **Haiku**, analyse légère **une fois par session** (quota partagé avec le travail : sobriété).
5. **Partager les PAT Azure DevOps** (et secrets du même genre) entre les machines.

## Objectifs

- O1. Après chaque session, des **observations** courtes, typées et fidèles, plus un **résumé de session**
  (titre clair, demande, état réel, prochaine étape), écrits par Haiku en français.
- O2. Ces données sont **partagées chiffrées** entre machines via `csm-sync`.
- O3. Au démarrage d'une session, Claude reçoit un **contexte court et pertinent** pour le dossier en cours.
- O4. Claude peut **chercher** dans toute la mémoire (toutes machines, tous dossiers) à la demande, via un outil.
- O5. **Coffre de secrets synchronisé** : un PAT saisi ou remplacé sur une machine arrive automatiquement sur les
  autres, rangé là où les outils le lisent (trousseau macOS / variable d'environnement Windows).
- O6. claude-mem devient inutile et est désactivé.

## Non-objectifs

- Pas d'IA ni de recherche côté serveur ; pas d'accès depuis claude.ai web.
- Pas d'analyse après chaque action de Claude (contrairement à claude-mem).
- Pas de plugin installable par des tiers.
- Pas de masquage/caviardage automatique.

## Anti-objectifs (échec même si « ça marche »)

- Le serveur ou Cloudflare peut lire une observation, un résumé ou un secret.
- La mémoire consomme une part visible du quota (analyses en boucle, re-analyses inutiles, Opus/Sonnet).
- Un message d'erreur, un texte tronqué ou un titre vide est présenté comme « état » d'une session.
- Une analyse de mémoire déclenche elle-même une session mémorisée (boucle) ou apparaît dans la liste des
  sessions de l'utilisateur.
- Un secret écrase silencieusement une valeur locale plus récente, ou une suppression ne se propage pas.
- Le démarrage d'une session est ralenti (le hook `SessionStart` doit rester rapide, timeout 15 s).

## Contraintes

- Node.js / Electron existants, Mac (arm64, x64) et Windows ; aucune dépendance Python (Chroma exclu).
- Code, commentaires et interface en **français**, dans le style du dépôt ; tests `node --test` (`npm test`),
  `fake-claude.js` pour simuler Claude ; lint ESLint.
- Chiffrement : réutiliser les primitives de `lib/sync.js` (`seal`, clé dérivée du code, AAD liant uid/version).
- Le hook ne fonctionne que pour les sessions lancées par l'app (`CSM_ID`) : inchangé.
- Respecter le plafond de quota (`lib/quotastop.js`) : pas d'analyse quand un plafond est atteint.
- Conventions du dépôt pour la livraison : numéro de version, `CHANGELOG.md`, `README.md`, guide.

## Conception

### 1. Analyse par Haiku (sur la machine)

- **Quand** : une fois par session « terminée » : hook `SessionEnd`, ou session restée inactive (après `Stop`)
  pendant un délai (choix du bâtisseur, ordre de 20–30 min) car les sessions Claude Sessions sont persistantes et
  peuvent ne jamais se fermer. Si la session reprend ensuite, une analyse suivante ne traite **que la partie
  nouvelle** du transcript (repère d'avancement par session, comme `readFrom` aujourd'hui) et met à jour le
  résumé. *(Appel de Claude : le principe « une fois par session » adapté aux sessions persistantes.)*
- **Comment** : `claude -p --model haiku` (abonnement de l'utilisateur, pas de clé API), sortie JSON validée par
  un schéma ; une seule analyse à la fois ; sessions triviales (moins de 2 échanges utiles) ignorées.
  Le processus d'analyse est lancé **sans** `CSM_ID` et sans hooks/plugins (pas de boucle, pas de claude-mem).
- **Entrée** : le transcript (`~/.claude/projects/…/<id>.jsonl`) réduit à l'utile : demandes de l'utilisateur,
  réponses de Claude, noms d'outils et fichiers modifiés, erreurs ; sorties volumineuses d'outils écourtées. Un
  plafond de taille par analyse (choix du bâtisseur) ; au-delà, découpage en morceaux analysés à la suite.
- **Sortie** :
  - *Résumé de session* : `title` (nom clair du sujet), `request` (ce qui était demandé), `state` (où on en est
    réellement — jamais un message d'erreur d'API brut ; si la session a fini sur une erreur, le dire en clair),
    `next` (prochaine étape ou « rien »), `project` (forme portable `{home}/…`), `machine`, `branch`, dates.
  - *Observations* (0–15 par analyse) : `type` ∈ `decision | fix | discovery | change | todo | preference`,
    `title` (≤ 80 car.), `body` (2–5 phrases, le pourquoi compris), `files`, `keywords` (fr + en, pour la
    recherche), `sessionId`, `project`, `createdAt`.
- Prompt d'analyse versionné dans le dépôt ; une erreur d'analyse ne casse rien (réessai plus tard, plafonné).

### 2. Stockage local et recherche

- Base locale par machine dans `DATA/memory/` contenant résumés + observations reçus de toutes les machines.
- **Recherche plein texte** (mots-clés, accents ignorés) obligatoire.
- **Recherche par le sens** : locale, hors ligne, multilingue fr/en, sans Python (ex. petit modèle d'embeddings
  ONNX via transformers.js). Si le coût (taille de l'app, temps CPU) est déraisonnable, le bâtisseur le signale :
  la recherche plein texte + mots-clés fr/en écrits par Haiku doit déjà donner de bons résultats seule.
- Les fiches de la mémoire native existantes restent consultables (lecture seule) ; pas de ré-analyse en masse
  de l'historique (coût de quota). *(Appel de Claude.)*

### 3. Synchronisation chiffrée

- Via `csm-sync`, sur le modèle des fiches `nm-` de `lib/sync.js` : un blob chiffré par session (résumé +
  observations), uid à préfixe dédié (ex. `ob-<id de conversation>`), la version la plus récente (`updated`)
  gagne, AAD liant uid/version/date. Le serveur n'apprend que des tailles et des dates.
- « Oublier » une session/observation se propage (marque de suppression synchronisée, comme `forgotten`).
- Le Worker ne devrait pas avoir besoin de changer ; si c'est le cas, schéma D1 rétrocompatible.

### 4. Contexte au démarrage (hook `SessionStart`)

- Budget court (de l'ordre de 3 000–4 000 caractères), construit à partir de la base locale, sans appel IA :
  1. notes « À retenir » de l'utilisateur pour ce dossier (existant) ;
  2. résumés des 3–5 sessions les plus récentes du dossier (titre, état, prochaine étape) ;
  3. les observations les plus utiles du dossier (récentes, types `decision`/`todo`/`preference` en priorité) ;
  4. une ligne expliquant à Claude qu'il peut chercher dans la mémoire avec l'outil ci-dessous.
- Doit répondre en quelques centaines de ms.

### 5. Outil de recherche pour Claude

- Un serveur MCP fourni par l'app (script stdio qui interroge le serveur local de l'app, jeton existant), branché
  automatiquement dans les sessions lancées par l'app. Outils : `chercher` (texte libre, filtres dossier/type/
  période → liste courte : id, titre, date, machine), `details` (observations/résumé complets par id),
  `chronologie` (ce qui s'est passé autour d'une observation). Réponses compactes (économie de contexte).

### 6. Coffre de secrets synchronisé

- Étend `lib/secrets.js`. Un secret = `name`, valeur, cibles par système (`keychain` : service macOS, ex.
  `azure-pat`, `azure-pat-ro` lus par le plugin b3g-wafacash ; `env` : variable Windows, ex. `AZURE_DEVOPS_PAT`,
  `AZURE_DEVOPS_PAT_RO`), `updatedAt`, `deleted`.
- Synchronisé chiffré via `csm-sync` (préfixe dédié, ex. `sec-<name>`), même clé ; la plus récente gagne ;
  application automatique à la réception (écriture trousseau / `setx` + environnement des sessions suivantes),
  suppression propagée.
- Interface (Réglages) : liste des noms et dates uniquement — jamais la valeur affichée en clair après saisie ;
  ajouter, remplacer, supprimer. Les secrets déjà déclarés par les extensions (champ `secrets` des `*.csm.json`)
  sont partagés de la même façon.

### 7. Réglages, migration, claude-mem

- Nouveau moteur `memoryEngine = ia` (par défaut) ; `native` reste disponible en secours, et sert de repli
  automatique si `claude` / Haiku est indisponible.
- Réglages › Mémoire : chercher, lire, renommer, oublier une session/observation ; état des analyses (en attente,
  faites, échouées) ; bouton « analyser maintenant » pour une session.
- claude-mem : moteur `claude-mem` et `memsync.js` retirés ou désactivés ; l'app propose de désactiver le plugin
  `claude-mem@thedotmack` dans `~/.claude/settings.json` (avec confirmation) et ne lance plus son worker.

## Précisions après relecture (appels de Claude, à vérifier par l'utilisateur)

- **Canal de synchro des observations** : le même que les fiches `nm-`, c'est-à-dire le canal des conversations
  (`remoteTranscripts`, morceaux chiffrés dans R2), **pas** les lignes `csm_sessions` (plafonnées à 20 000
  caractères et 5 000 lignes par le Worker). Un blob par session, découpé en morceaux comme aujourd'hui. Le
  Worker ne change pas.
- **Réglages de synchro** : les observations suivent le réglage existant `syncSessionMemory`. Nouveau réglage
  `syncSecrets` (activé par défaut), désactivable par machine.
- **Moteur** : le passage à `ia` est fait d'office sur toutes les machines à la mise à jour (le choix du moteur
  reste synchronisé comme aujourd'hui via `MEM_UID`) ; `native` reste choisissable à la main.
- **Repli** : `claude` introuvable ou 3 échecs d'analyse d'affilée → analyses suspendues, avec un avertissement
  dans Réglages › Mémoire ; plafond de quota atteint → analyse simplement reportée. Le contexte de démarrage
  continue toujours avec ce qui existe (résumés IA, et fiches natives pour les sessions pas encore analysées).
- **Outil de recherche (MCP)** : passé à chaque lancement de session par l'app (`--mcp-config`, y compris en
  reprise `--resume`) ; aucun fichier de réglages de l'utilisateur n'est modifié pour ça.
- **Secrets — import** : au premier lancement, l'app propose (une fois, avec confirmation) d'importer les secrets
  connus déjà présents localement : `azure-pat`, `azure-pat-ro` (trousseau macOS) /
  `AZURE_DEVOPS_PAT`, `AZURE_DEVOPS_PAT_RO` (Windows), et ceux déclarés par les extensions. Le coffre libre
  s'ajoute aux secrets d'extensions, il ne les remplace pas.
- **Secrets — conflits** : l'app garde l'empreinte (HMAC) de la dernière valeur synchronisée pour chaque secret,
  et relit la valeur locale à chaque synchro pour détecter un changement fait hors de l'app (qui devient alors la
  nouvelle valeur à diffuser). Si deux machines ont des valeurs différentes sans historique commun (première
  synchro) ou modifiées toutes les deux depuis la dernière synchro, **rien n'est écrasé** : l'interface montre le
  conflit (machines, dates) et l'utilisateur choisit.
- **Secrets — validation** : noms de variables reçus validés par `safeEnvName`, noms de service trousseau par un
  motif strict ; jamais de variable système (`PATH`, etc.).

## Laissé au bâtisseur

Format de la base locale, modèle d'embeddings (ou son absence motivée), délai d'inactivité exact, plafonds de
taille, texte du prompt Haiku, découpage en modules, nommage des préfixes de synchro, détail de l'interface
Réglages dans le style existant.
