# Pilotage à distance d'une machine — conception

Date : 2026-11-03 · Dépôt : `vantaflow/claude-sessions-manager` (Claude Sessions, « CSM ») · Branche : `feat/pilotage`

## Intention

L'utilisateur a deux machines dans son espace de synchro : un Mac portable et un PC fixe à la maison (Windows).
**Quand il part en laissant le PC allumé, il veut reprendre la main sur tout le CSM du PC depuis le Mac**, comme
s'il était devant : voir ses sessions et leurs terminaux en direct, écrire, valider, interrompre, lancer, relancer,
et le reste de l'app. Claude continue de tourner sur le PC, avec ses fichiers, son VPN et ses outils. Il le veut
« depuis le début de CSM ».

Il veut aussi, « si c'est faisable », le faire **depuis le navigateur d'un ordinateur sans CSM**, protégé par un
**mot de passe**. Le téléphone n'est pas concerné : Remote Control (app Claude) le couvre déjà.

## Décisions de l'utilisateur

1. **Tout CSM** de la machine à distance, pas seulement les sessions déjà ouvertes.
2. **Verrou** : un simple interrupteur suffit pour lui (« personne ne l'aura, c'est mon PC chez moi »).
3. **Depuis un navigateur sans CSM** : oui, avec un mot de passe.
4. **Affichage** : « la plus performante option ». *(Appel de Claude : la fenêtre bascule entièrement sur la
   machine choisie — sélecteur « Ce Mac / PC KHALIL » — plutôt que de mêler les sessions des deux machines : un seul
   flux à la fois, et l'interface existante est réutilisée telle quelle.)*
5. Pas de solution payante : le serveur de synchro existant (Cloudflare Worker `csm-sync`, Durable Object `Hub`,
   offre gratuite) sert de relais.

## Objectifs

- O1. Dans CSM, une machine de l'espace qui l'autorise apparaît « pilotable » ; la choisir fait afficher toute
  l'interface de CSM de cette machine (sessions, terminaux, réglages, coffre, mémoire, usage…), en direct.
- O2. Frappes, Entrée, Ctrl+C, collage, images jointes, création / relance / arrêt de sessions marchent comme en local.
- O3. Les deux fenêtres (devant le PC et à distance) restent synchronisées ; on continue depuis l'une ou l'autre.
- O4. Chiffré de bout en bout : le relais ne voit que des octets illisibles ; aucun port ouvert sur la machine
  pilotée (connexion sortante vers le Worker, comme la synchro).
- O5. Accès depuis un navigateur sans CSM : page servie par le Worker, lien personnel, mot de passe.
- O6. Pour les autres utilisateurs de CSM : disponible dès qu'il y a un code de synchro, **désactivé par défaut**,
  sans autre configuration qu'une case à cocher sur la machine à piloter.

## Non-objectifs

- Pas de téléphone (Remote Control le fait).
- Pas de contrôle du bureau Windows / macOS (écran, souris) : seulement CSM.
- Pas de pilotage d'une machine qui n'a pas CSM ouvert (elle doit tourner, avec l'interrupteur coché).
- Pas de partage avec une autre personne.

## Anti-objectifs (échec même si « ça marche »)

- Le relais (Cloudflare) peut lire un écran de terminal, une frappe, un mot de passe ou une valeur du coffre.
- Une machine devient pilotable sans que son utilisateur l'ait autorisé **sur cette machine**.
- La machine pilotée ne montre pas qu'elle est pilotée (pas de bandeau, pas de moyen de couper).
- Le mot de passe web peut être deviné à force d'essais (pas de limite), ou le lien seul suffit.
- L'usage dépasse l'offre gratuite de Cloudflare au quotidien (requêtes du Durable Object, messages WebSocket).
- La frappe à distance a un retard gênant (objectif : écho perçu comme immédiat, de l'ordre de 100–300 ms).
- Une ancienne version de CSM sur une autre machine de l'espace casse ou affiche des choses fausses.

## Contraintes

- Node.js / Electron existants, Mac et Windows ; tests `node --test` (`npm test`), Worker testé dans `sync-worker/test`.
- Chiffrement : clé dérivée de la clé de synchro (comme `lib/sync.js`, `derive`), AES-256-GCM, compteur ou nonce
  unique par message, données authentifiées liant l'expéditeur, le destinataire et le sens.
- Interface : même code (`public/`) en local, à distance depuis CSM, et dans le navigateur.
- Le jeton local (`x-csm-token`) de la machine pilotée ne quitte jamais cette machine.
- Code, commentaires et interface en français, style du dépôt ; README, site, CHANGELOG, guide à jour.

## Conception

### 1. Relais (Worker)
- Le `Hub` (Durable Object par espace, déjà utilisé pour `/live`) gagne un canal de relais : une machine pilotable
  s'y connecte en WebSocket comme **hôte** (son identifiant de machine), un client comme **pilote**. Le Hub ne fait
  que transmettre des trames opaques entre un pilote et l'hôte demandé ; il ne déchiffre rien.
- Hibernation des WebSockets (déjà utilisée) ; trames groupées côté hôte (sortie de terminal par paquets de ~50 ms)
  pour rester dans l'offre gratuite. Plafond de pilotes par hôte.

### 2. Machine pilotée (hôte)
- Réglage **« Autoriser le contrôle à distance de cette machine »** (Réglages › Synchronisation), désactivé par défaut,
  modifiable seulement sur la machine elle-même (jamais par la synchro ni à distance).
- Cochée : le serveur CSM ouvre la connexion hôte au relais. Les requêtes reçues d'un pilote sont exécutées par le
  même code que les requêtes de l'interface locale (mêmes routes, même contrôle), et le flux WebSocket local
  (`/ws` : liste des sessions, sorties de terminal, replay…) est relayé.
- **Bandeau** dans la fenêtre de la machine pilotée : « Pilotée à distance depuis <machine> » + « Couper ».
- Les fonctions natives de la machine pilotée (sélecteur de dossier, notifications système, fenêtre) ne sont pas
  déclenchées à distance ; à distance, un dossier se choisit par un chemin saisi ou une liste de dossiers servie par
  l'hôte.

### 3. Pilote dans CSM
- Sélecteur de machine (machines de l'espace, avec « pilotable » / « hors ligne »). Choisir une autre machine :
  toute la fenêtre bascule ; `api()` et le WebSocket de l'interface passent par le tunnel chiffré au lieu du serveur
  local. Revenir sur « Ce Mac » rétablit l'affichage local.
- Indicateur permanent « Vous pilotez <machine> » tant que le pilotage dure.

### 4. Navigateur sans CSM
- Le Worker sert la page de CSM (fichiers de `public/`) à une adresse personnelle donnée par la machine pilotée
  (`…/web#<identifiant>`). La page demande le **mot de passe** choisi sur la machine pilotée.
- La machine pilotée publie sur le relais la clé d'accès **chiffrée par ce mot de passe** (dérivation lente du mot de
  passe) ; le navigateur la déchiffre lui-même. Le mot de passe et la clé ne sont jamais envoyés en clair.
- Le relais limite les essais (par exemple 10 par heure et par lien) ; changer le mot de passe invalide les accès.
- Bouton « Se déconnecter et oublier » dans la page.

### 5. Compatibilité
- Les machines en version antérieure ignorent le relais : elles ne sont ni pilotables, ni pilotes.

## Précisions après relecture (appels de Claude, à vérifier par l'utilisateur)

- **Clés séparées.** Le pilotage n'utilise jamais la clé de synchro elle-même :
  - entre machines CSM, une clé de pilotage est dérivée de la clé de synchro pour chaque machine pilotée ;
  - l'accès web a sa propre clé, tirée au hasard par la machine pilotée. Elle ne sert **qu'au pilotage** et ne permet ni de lire ni d'écrire les données synchronisées (coffre, mémoire, conversations).
- **Accès web et mot de passe.**
  - Le lien `…/web#<identifiant>` désigne un accès web, pas l'espace.
  - Le relais ne garde qu'une enveloppe : la clé web chiffrée par le mot de passe, avec une dérivation lente (PBKDF2-SHA256, 600 000 tours, sel aléatoire).
  - L'enveloppe n'est remise qu'en échange d'une preuve tirée du mot de passe, avec au plus 10 essais par heure et par lien. Le lien seul ne donne donc rien.
  - Le mot de passe fait 12 caractères au moins. Comme le relais lui-même pourrait tenter de le casser à partir de ce qu'il garde, c'est la longueur du mot de passe et le coût de la dérivation qui protègent.
  - Changer le mot de passe tire une nouvelle clé web, ce qui déconnecte les navigateurs ouverts.
- **Couper.** « Couper », sur la machine pilotée, ferme tous les pilotages en cours. Décocher l'interrupteur ferme aussi la connexion au relais. Les sessions continuent de tourner sur la machine. Un pilote qui perd la connexion se reconnecte seul et reçoit de nouveau l'état complet, comme une fenêtre locale qui se reconnecte.
- **Ce qui reste local.** Ces réglages ne se changent pas à distance :
  - l'interrupteur de pilotage ;
  - le mot de passe web ;
  - le code de synchro (le changer, le quitter, retirer une machine) ;
  - l'arrêt ou le redémarrage de l'app.

  Tout le reste se fait à distance, y compris le coffre et le déverrouillage d'une session verrouillée : le mot de passe passe alors dans le tunnel chiffré.
- **Version.** L'interface affichée à distance est toujours **celle de la machine pilotée** : ses fichiers `public/` passent par le tunnel, pour CSM comme pour le navigateur. Pilote et machine pilotée n'ont donc jamais de versions qui ne s'accordent pas. La page servie par le Worker se limite à un petit chargeur : mot de passe, tunnel, puis l'interface de la machine.
- **Budget gratuit.** L'usage de référence est d'environ 4 heures de pilotage par jour, avec un ou deux terminaux affichés. La sortie des terminaux est regroupée (paquets d'environ 50 ms) pour que cet usage tienne dans l'offre gratuite des Durable Objects.
- **Deux fenêtres à la fois.** Les frappes s'entrelacent, comme dans un terminal partagé. Chaque fenêtre affiche qui a tapé en dernier dans la session (« ici » ou « <machine> »).

## Laissé au bâtisseur

Format exact des trames, protocole de poignée de main et de reprise après coupure, dérivation des clés, taille des
paquets et rythme d'envoi, plafonds de connexions, gestion des envois de fichiers (images jointes) par le tunnel,
détails de la page web (hébergement des fichiers par le Worker ou par Pages), textes de l'interface.
