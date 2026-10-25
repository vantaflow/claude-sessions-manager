# Claude Sessions

Une seule fenêtre pour piloter plusieurs sessions [Claude Code](https://docs.claude.com/claude-code) au lieu d'une pile d'onglets de terminal. **Windows et macOS · libre (MIT).**

**Site et guide : https://vantaflow.github.io/claude-sessions-manager/** · [Guide détaillé en ligne](https://vantaflow.github.io/claude-sessions-manager/guide.html) · [Journal des versions](CHANGELOG.md)

![Claude Sessions : sessions par groupe avec leur état, terminal de la session active, quotas en bas de la barre latérale](docs/img/app-dark.png)

## Sommaire

1. [Installation](#1-installation)
2. [Premiers pas](#2-premiers-pas)
3. [L'écran principal](#3-lécran-principal)
4. [Les sessions](#4-les-sessions) — et [le menu ⋯ d'une session](#4-bis-le-menu--dune-session)
5. [Ranger : groupes, épinglage, couleurs](#5-ranger--groupes-épinglage-couleurs)
6. [Vue partagée](#6-vue-partagée)
7. [Worktrees git : plusieurs Claude sur le même dépôt](#7-worktrees-git--plusieurs-claude-sur-le-même-dépôt)
8. [Panneau Modifications, Chronologie, Consommation](#8-panneau-modifications-chronologie-consommation)
9. [Historique et sessions ouvertes dans un terminal](#9-historique-et-sessions-ouvertes-dans-un-terminal)
10. [Images et fichiers](#10-images-et-fichiers)
11. [Palette, recherche, prompts, file d'attente, envoi groupé](#11-palette-recherche-prompts-file-dattente-envoi-groupé) — et [demandes programmées](#11-bis-demandes-programmées)
12. [Modèles de session](#12-modèles-de-session) — et [extensions](#12-bis-extensions)
13. [Verrouiller une session par mot de passe](#13-verrouiller-une-session-par-mot-de-passe)
14. [Notifications, zone de notification, arrière-plan](#14-notifications-zone-de-notification-arrière-plan) — et [accès depuis l'app Claude (téléphone)](#14-bis-accès-depuis-lapp-claude-téléphone) — et [connexion à Claude qui expire](#14-ter-connexion-à-claude-qui-expire--your-login-expires-in-3-days-)
15. [Thème clair / sombre, langue](#15-thème-clair--sombre-langue)
16. [Réglages](#16-réglages) — [mémoire des sessions](#16-ter-mémoire-des-sessions) et [synchroniser les sessions entre machines](#16-bis-synchroniser-les-sessions-entre-machines) — et [changer d'ordinateur (export / import)](#16-quater-changer-dordinateur--export--import)
17. [Mises à jour](#17-mises-à-jour)
18. [Raccourcis clavier](#18-raccourcis-clavier)
19. [Données, sécurité, confidentialité](#19-données-sécurité-confidentialité)
20. [Dépannage](#20-dépannage)
21. [Ligne de commande `csm` (sans l'application)](#21-ligne-de-commande-csm-sans-lapplication)
22. [Développement](#22-développement)

---

<a id="installation"></a><a id="application-recommandé"></a>
## 1. Installation

Seul prérequis : **Claude Code** installé (la commande `claude` fonctionne dans un terminal). Node.js n'est pas nécessaire.

| Système | Fichier ([dernière version](https://github.com/vantaflow/claude-sessions-manager/releases/latest)) | Installation |
|---|---|---|
| Windows 10 / 11 | `Claude-Sessions-Setup-x.y.z.exe` | double-clic ; installation en un clic, sans droits administrateur |
| Mac Apple Silicon (M1…M4) | `Claude-Sessions-x.y.z-arm64.dmg` | ouvrir, glisser **Claude Sessions** dans Applications |
| Mac Intel | `Claude-Sessions-x.y.z-x64.dmg` | idem |

L'application n'est pas encore signée par un certificat éditeur, donc chaque système prévient au premier lancement :
- **Windows** : « Windows a protégé votre ordinateur » → *Informations complémentaires* → *Exécuter quand même*.
- **macOS** : au premier lancement, macOS bloque l'app (« impossible de vérifier le développeur »). Ouvre **Réglages Système › Confidentialité et sécurité**, descends jusqu'au message sur Claude Sessions et clique **Ouvrir quand même** (puis confirme). Sur les macOS récents, « clic droit › Ouvrir » ne suffit plus. Autre possibilité, dans le Terminal : `xattr -cr "/Applications/Claude Sessions.app"`.

Ensuite, les nouvelles versions s'installent toutes seules sous Windows (§ 17).

## 2. Premiers pas

1. Lance **Claude Sessions**. Au premier lancement, un assistant vérifie que Claude Code est **installé** et **connecté à ton compte**, et que `git` est là. Claude Code absent : il donne la commande d'installation à copier, puis **Vérifier de nouveau** le trouve sans redémarrer l'app. Pas connecté : **Se connecter à Claude** ouvre la connexion depuis l'app. Il propose ensuite de créer ta première session.
2. **+ Nouvelle** (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>N</kbd>) : choisis un **dossier de travail** (*Parcourir…*), éventuellement un nom et un groupe, le modèle (opus par défaut), puis **Lancer**.
3. La session démarre : c'est un vrai Claude Code, avec tes réglages, tes hooks, tes serveurs MCP et tes commandes `/…`. Tu tapes comme dans un terminal.
4. Crée d'autres sessions de la même façon : elles apparaissent dans la barre latérale et tournent **toutes en même temps**.

Tu peux fermer la fenêtre à tout moment : les sessions continuent en arrière-plan et reviennent même après un redémarrage de l'ordinateur.

## 3. L'écran principal

```
┌─ barre latérale ──────┬─ barre de la session active ────────────────────────────────────────┐
│ + Nouvelle            │ ● nom ✎  ⎇ branche  dossier  état   ▢◫⊟⊞  ± Modifications  ↗ Ouvrir │
│ Rechercher…   Ctrl+K  │                                    Joindre  Relancer  ⋯  Fermer     │
│ ─ ÉPINGLÉES ─     1   ├──────────────────────────────────────────────────┬──────────────────┤
│ ● session A           │                                                  │ panneau latéral  │
│ ─ PROJET X ─      2   │   terminal de la session (ou 2 / 4 panneaux)     │  Modifications   │
│ ● session B           │                                                  │  Chronologie     │
│ ● session C           │                                                  │  Consommation    │
│ ─ SANS GROUPE ─   1   │                                                  │                  │
│ ● session D (verrou)  │                                                  │                  │
│ Dans un terminal (2)  │                                                  │                  │
│ Historique   ⚙   ⇤    │                                                  │                  │
└───────────────────────┴──────────────────────────────────────────────────┴──────────────────┘
```

- **Barre latérale** : tes sessions, rangées par groupe, avec leur état en direct. En bas : l'historique des conversations, les réglages (⚙) et le mode compact (⇤).
- **Barre de la session active** : nom (✎ renommer), branche si c'est un worktree, dossier, état ; à droite la disposition (1, 2 ou 4 panneaux), le panneau Modifications, « Ouvrir dans… », joindre un fichier (📎), relancer, le menu **⋯** (toutes les actions de la session) et Fermer.
- **Clic droit** partout : menu adapté (session, terminal, champ de saisie, historique, icône de la zone de notification).

### États d'une session

| Pastille | État | Signification |
|---|---|---|
| 🟠 orange (clignote) | travaille | Claude répond ou utilise un outil |
| 🔴 rouge (pulse) | attend une réponse | Claude a besoin de toi (question, permission) : notification et son |
| 🟢 vert | prêt | Claude a fini (« terminé » tant que tu n'as pas regardé la session) |
| ⚪ cercle | arrêtée | le processus est arrêté ; « Reprendre » relance la conversation |

Après <kbd>Ctrl</kbd>+<kbd>C</kbd> ou <kbd>Échap</kbd> pendant une réponse, la session repasse à « prêt (interrompu) ». Une session **rouge** le reste tant que Claude attend vraiment (permission, question) : l'afficher ne suffit pas, il faut lui répondre.

L'état vient directement de Claude Code (des hooks sont ajoutés à chaque session) : il est exact même fenêtre fermée.

<a id="fonctionnement"></a><a id="persistance"></a>
## 4. Les sessions

| Action | Où | Effet |
|---|---|---|
| **Nouvelle** | + Nouvelle, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>N</kbd>, palette | dossier, nom, groupe, modèle, mode, worktree, premier prompt, arguments |
| **Renommer** | ✎, double-clic sur le nom, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd> | le nom est aussi écrit dans la conversation Claude (historique, `claude --resume`) et c'est **le nom de la session pour Claude Code** (`/rename`) : celui que voient les autres sessions quand elles se parlent (« Message from @… », liste des sessions). Donné au lancement, appliqué aussitôt à une session ouverte ; un `/rename` tapé dans la session renomme aussi la session dans l'app, et le nom suit sur les autres machines (synchro). |
| **Relancer / Reprendre** | bouton ou ⋯ | relance Claude dans la **même conversation** (`--resume`) |
| **Pause** | ⏸ Pause (barre du haut), ⋯ › Mettre en pause | arrête la session **en gardant tout** : elle reste dans la liste, ici et sur tes autres machines (« en pause »). Avant de rendre la main, sa **mémoire** est enregistrée et **tout est synchronisé** (conversation comprise) : « Reprendre », ici ou sur une autre machine, continue la conversation |
| **Arrêter** | ⋯ › Arrêter | arrête le processus ; la session reste dans la liste |
| **Fermer** | Fermer, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>W</kbd> | arrête et **retire la session de la liste** de cette machine ; la conversation reste dans l'Historique. Synchronisée, elle est d'abord **mise en pause, sa mémoire enregistrée et tout synchronisé**, puis **gardée « en pause » sur tes autres machines** (reprenable là-bas) ; elle ne revient pas ici |
| **Supprimer** | ⋯ ou clic droit › Supprimer…, palette | la retire de la liste (sur **toutes tes machines** si elle est synchronisée), après confirmation ; la conversation reste dans l'Historique. Session dans un worktree : garder, fusionner ou supprimer le worktree |
| **Changer de session** | clic, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>1</kbd>…<kbd>9</kbd>, <kbd>↑</kbd>/<kbd>↓</kbd> | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>A</kbd> : prochaine session qui t'attend |
| **Réordonner** | glisser-déposer dans la liste | ordre mémorisé |
| **Ouvrir dans…** | ↗ Ouvrir, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>E</kbd> | le dossier dans ton éditeur (VS Code, Cursor, Windsurf, Zed, IntelliJ, Sublime ou commande personnalisée), l'Explorateur / le Finder, un terminal |

**Persistance** : chaque session ouverte (dossier, nom, modèle, groupe, ordre, conversation) est mémorisée. Après un redémarrage de l'ordinateur ou de l'app, toutes celles qui tournaient sont relancées dans leur conversation. Seules celles que tu as arrêtées ou fermées restent arrêtées.

### 4 bis. Le menu ⋯ d'une session

Le bouton **⋯** en haut à droite de la session ouverte (ou clic droit sur une session de la liste) regroupe les actions sur cette session. Sur Mac, <kbd>Ctrl</kbd> devient <kbd>⌘</kbd>.

| Entrée | Raccourci | Ce que ça fait | Détails |
|---|---|---|---|
| **File d'attente…** | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Q</kbd> | Des prompts envoyés **un par un, automatiquement**, chaque fois que Claude a fini le précédent. Badge ⏳ = nombre en attente. Pause automatique près de la limite des 5 h (badge ⏸), reprise à la réinitialisation. | [§ 11](#11-palette-recherche-prompts-file-dattente-envoi-groupé) |
| **Insérer un prompt…** |  | Ouvre ta **bibliothèque de prompts** : *Insérer* place le texte dans la saisie (tu relis, puis Entrée), *Envoyer* le soumet. Variables `{dossier}`, `{branche}`, `{nom}`, `{selection}`. | [§ 11](#11-palette-recherche-prompts-file-dattente-envoi-groupé) |
| **Envoyer à plusieurs sessions…** | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>B</kbd> | Le **même prompt à plusieurs sessions** cochées : tout de suite si elles sont prêtes, sinon dans leur file d'attente. | [§ 11](#11-palette-recherche-prompts-file-dattente-envoi-groupé) |
| **Modifications** | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd> | Panneau des **fichiers modifiés** dans le dossier (git) : diff coloré, annuler un fichier, commit avec message proposé, fusion d'un worktree. | [§ 8](#8-panneau-modifications-chronologie-consommation) |
| **Chronologie** |  | Ce que Claude a fait, dans l'ordre : **fichiers lus et modifiés**, commandes lancées, outils appelés. | [§ 8](#8-panneau-modifications-chronologie-consommation) |
| **Consommation** |  | **Tokens et coût estimé** de la session, puis de toutes les sessions sur 5 h, aujourd'hui et 7 jours, avec un graphique par jour. | [§ 8](#8-panneau-modifications-chronologie-consommation) |
| **📱 Accès depuis l'app Claude (téléphone)** |  | Rend la session **pilotable depuis l'app Claude et claude.ai/code** (Remote Control de Claude Code), sans port ouvert. Même entrée pour désactiver. | [§ 14 bis](#14-bis-accès-depuis-lapp-claude-téléphone) |
| **Exporter la conversation…** |  | La conversation en **Markdown** (fichier ou presse-papiers) ou en **PDF** (impression). Grisé tant que la session n'a pas de conversation. | [§ 8](#8-panneau-modifications-chronologie-consommation) |
| **Enregistrer comme modèle…** |  | Mémorise **dossier, nom, modèle, mode, worktree, groupe et premier prompt** pour relancer une session identique en un clic (Nouvelle session, palette, demandes programmées). | [§ 12](#12-modèles-de-session) |
| **Déplacer vers le groupe…** |  | Range la session dans un **groupe** existant ou nouveau (aussi par glisser-déposer dans la liste). | [§ 5](#5-ranger--groupes-épinglage-couleurs) |
| **Épingler en haut** |  | Garde la session **en tête de la liste**, quel que soit l'ordre. Même entrée pour désépingler. | [§ 5](#5-ranger--groupes-épinglage-couleurs) |
| **Verrouiller par mot de passe…** |  | **Masque** le contenu et bloque la saisie jusqu'au mot de passe ; la session continue de tourner. Reverrouillage automatique réglable. | [§ 13](#13-verrouiller-une-session-par-mot-de-passe) |
| **Couper les alertes de cette session** |  | Plus de **notification ni de son** pour cette session (les autres continuent). Même entrée pour les réactiver. | [§ 14](#14-notifications-zone-de-notification-arrière-plan) |
| **Mettre en pause** |  | Arrête la session en la gardant dans la liste, ici et sur tes autres machines ; mémoire enregistrée et synchro faite avant de rendre la main. *Reprendre* continue la conversation, sur n'importe quelle machine. | [§ 4](#4-les-sessions) |
| **Plafond de quota…** |  | Seuil sur le quota **5 h** et/ou **7 jours** (50 à 99 %) pour cette session. Atteint, Claude reçoit aussitôt la demande d'enregistrer où il en est (notes de reprise, commit du travail en cours, sans pousser), même en plein travail : il la traite après son étape en cours ; à la fin de sa réponse la session se met **en pause** (mémoire et synchro comme *Mettre en pause*), avec une notification. Option : **reprise automatique** à la réinitialisation du quota, avec un message pour continuer. Message envoyé modifiable (`{quota}`, `{pct}`). Aussi dans la palette, et dès la création : **Nouvelle session › Plafond de quota** (5 h, 7 jours, reprise automatique), repris par les modèles. | [§ 11](#11-palette-recherche-prompts-file-dattente-envoi-groupé) |
| **Arrêter** |  | Arrête le processus Claude ; la session **reste dans la liste**, reprenable d'un clic dans la même conversation. *Supprimer…* la retire de la liste (partout si elle est synchronisée). | [§ 4](#4-les-sessions) |

## 5. Ranger : groupes, épinglage, couleurs

Un **groupe** est une étiquette libre qui sert à **ranger tes sessions par projet dans la barre latérale** — par exemple « Travail », « Perso », « Client X ». Il n'a aucun effet sur le fonctionnement des sessions : c'est de l'organisation visuelle.

- **Créer un groupe** : bouton **🗂** en bas de la barre latérale (ou palette › Nouveau groupe). Un groupe créé ainsi reste affiché **même vide**, avec une zone « Glisse une session ici ».
- **Déplacer une session** : **glisse-la sur le titre d'un groupe** (ou sur une session de ce groupe), ou clic droit / ⋯ › **Déplacer vers le groupe…** (liste des groupes, *Nouveau groupe…*, *Sans groupe*). À la création : liste *Groupe* dans « Nouvelle session » (tous les groupes, même vides ; *(aucun)* par défaut = « Sans groupe » ; *Nouveau groupe…*).
- **Sous-groupes** : un groupe peut en contenir d'autres, sur plusieurs niveaux (« Clients › Acme »). Au survol du titre d'un groupe, **+** crée un sous-groupe (aussi : clic droit › *Nouveau sous-groupe…*, palette, ou « Parent/Enfant » tapé comme nom). Pour ranger un groupe existant dans un autre : **glisse son titre sur celui du groupe parent** (sur « Sans groupe » = premier niveau), ou clic droit › *Déplacer le groupe vers…*. Le sous-groupe s'affiche en retrait sous son parent ; le parent compte aussi les sessions de ses sous-groupes, et **le replier masque tous ses sous-groupes**. Renommer ou déplacer un groupe emmène ses sous-groupes et leurs sessions ; supprimer un groupe supprime ses sous-groupes, et leurs sessions **remontent dans le groupe parent** (ou « Sans groupe »). Synchronisés comme les groupes.
- **Gérer un groupe** : au survol de son titre, **✎ renommer** (ou double-clic sur le nom ; ses sessions suivent) et **✕ supprimer** (ses sessions passent dans « Sans groupe », rien n'est fermé). Aussi par clic droit sur le titre (*Nouvelle session dans ce groupe*, *Nouveau sous-groupe…*, *Renommer le groupe…*, *Déplacer le groupe vers…*, *Supprimer le groupe*) et par la palette (*Renommer le groupe « … »*, *Supprimer le groupe « … »*). Renommer vers un groupe existant fusionne les deux.
- **Affichage** : chaque groupe a un en-tête (nom + nombre de sessions) ; **clic sur l'en-tête = replier / déplier**. Les sessions sans groupe sont sous « Sans groupe ».
- **Épingler** (⋯ › Épingler en haut) : la session passe dans « Épinglées », tout en haut, quel que soit son groupe.
- **Couleur** : liseré à gauche de la session pour la repérer d'un coup d'œil.
- Un **modèle de session** peut fixer le groupe (§ 12).

## 6. Vue partagée

La **barre du haut** ne coupe jamais un bouton : quand la place manque (fenêtre étroite, type de session, vue partagée), les libellés laissent place aux icônes (survol = nom du bouton), puis le message d'état se masque, et en dernier recours les boutons passent sur une seconde ligne.

Pour **suivre plusieurs sessions en même temps** : boutons de disposition dans la barre (▢ une, ◫ deux colonnes, ⊟ deux lignes, ⊞ grille 2×2) ou palette.

- **Placer une session** : glisse-la depuis la barre latérale sur un panneau, ou clique-la (elle va dans le panneau actif, surligné en orange).
- **Changer de panneau** : clic dans le panneau ou <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>←</kbd>/<kbd>→</kbd> ; ✕ en haut d'un panneau le vide.
- Chaque terminal garde sa propre taille ; la disposition est mémorisée. L'en-tête d'un panneau montre le numéro de la session ; quand elle demande une autorisation, **Oui / Toujours / Non** y répondent sans quitter la grille.
- **Envoyer à tous les panneaux** : la barre sous la grille envoie un même message à toutes les sessions affichées (« Envoyer à N panneaux ») ; une session qui travaille le reçoit en file d'attente (case *en file si occupée*).
- **Mode focus** (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd>) : masque la barre latérale.

## 7. Worktrees git : plusieurs Claude sur le même dépôt

Deux sessions qui modifient le même dépôt au même moment se marchent dessus. Un **worktree git** donne à une session **son propre dossier et sa propre branche**, à côté du dépôt principal, sans y toucher.

1. « Nouvelle session » dans un dépôt git → cocher **Travailler dans un worktree git dédié**. Une branche est proposée (`csm/<nom>`), modifiable.
2. La session travaille dans `<dépôt>.worktrees/<branche>` ; son badge **⎇ branche** apparaît dans la liste et la barre.
3. Travail prêt : panneau **Modifications** → commit, puis **Fusionner dans `<branche de base>`**.
4. En fermant la session : **garder** le worktree (y revenir plus tard), **fusionner puis supprimer**, ou **supprimer** (abandonner la branche).

La fusion est refusée s'il reste des modifications non commitées, si le dépôt principal n'est pas sur la branche de base, ou en cas de conflit (la fusion est alors annulée proprement).

## 8. Panneau Modifications, Chronologie, Consommation

**Usage de Claude** (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>U</kbd>, palette, ou clic sur les quotas en bas de la barre latérale) : sessions actives, demandes à traiter, **temps de travail de Claude** aujourd'hui (dont le temps « sans toi », pendant que la file d'attente envoyait les demandes), coût estimé du jour et des 7 jours ; **quota 5 h** avec son historique et une **prévision** (« au rythme actuel, limite atteinte vers 15:40 ») ; prochaines **tâches planifiées** (avec la session ou le modèle visé ; *Ajouter*, *Gérer*) ; détail **par session**. **Période** au choix : jour, 7 jours ou 30 jours. Graphique du quota 5 h avec les heures, la prévision en hachuré jusqu'à la réinitialisation et le seuil de pause de la file ; **quota 7 jours** avec sa propre prévision (rythme des dernières 24 h). Avec la synchro, **Cette machine / Toutes les machines** additionne l'usage de tes machines (colonne Machine) : chaque machine ne partage que des totaux chiffrés par jour et par session, jamais de conversation (option *Usage de Claude* de la synchro).

Bouton **± Modifications** (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd>) ou ⋯ : panneau latéral à trois onglets pour la session active.

- **Modifications** : fichiers modifiés dans le dossier de la session (git) avec leur état (M modifié, N nouveau, S supprimé). Clic = **diff coloré** ; ↺ = annuler un fichier ; **commit** avec « Proposer un message » et « Committer tout ». Rafraîchi quand Claude a fini un tour.
- **Prompts** (<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Alt</kbd>+<kbd>P</kbd>, ⋯ › Mes prompts) : **toutes tes demandes** dans cette session, de la plus récente à la plus ancienne, numérotées et datées, pour te rappeler de quoi elle parle. Recherche, clic pour déplier un long prompt, **Copier**, **Réutiliser** (le colle dans ta saisie). Relues dans la conversation (sans messages système, sorties de commandes ni interruptions).
- **Chronologie** : les actions de Claude (📖 lus, ✏️ modifiés, ▶ commandes, 🔎 recherches…) avec l'heure.
- **Consommation** : tokens d'entrée / sortie et **coût estimé** de la session, puis de toutes les sessions sur 5 h, aujourd'hui et 7 jours ; graphique par jour ; sessions les plus coûteuses. Estimation aux tarifs API publics, indicative (inclus dans un abonnement Claude).
- **Barre d'état des quotas** : sous l'invite de chaque session, CSM affiche tes quotas d'abonnement et l'heure de leur réinitialisation, le contexte utilisé et le modèle : `5h 20% ↻ 13:21 (2h09) · 7j 90% ↻ jeu 18:44 (2j7h) · ctx 42% · Opus 5.5`. Seulement si tu n'as pas déjà ta propre barre d'état Claude Code (`statusLine` dans `~/.claude/settings.json`) ; désactivable dans Réglages › Général.

**Exporter une conversation** : ⋯ › Exporter → Markdown (fichier ou presse-papiers) ou impression / PDF.

## 9. Historique et sessions ouvertes dans un terminal

- **Historique** (🕘, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>H</kbd>) : toutes tes conversations Claude Code de cet ordinateur (titre, dossier, branche, dernier message), filtrables. Clic = reprendre la conversation dans une nouvelle session, dans son dossier. Clic droit : renommer, copier le chemin ou l'identifiant.
- **Dans un terminal** (bas de la barre latérale) : les sessions Claude lancées dans des terminaux apparaissent toutes seules. Clic → **Déplacer** (la session s'arrête dans le terminal et reprend ici, même conversation, dans le dossier où elle travaillait ; si Claude était en plein travail, la tâche repart d'elle-même avec « continue ») ou **Copier** (le terminal continue, une copie s'ouvre ici). **Tout ramener** les déplace toutes.

## 10. Images et fichiers

Comme dans un terminal, Claude reçoit images et fichiers :
- **glisser-déposer** un fichier sur le terminal ;
- **coller** une capture d'écran (<kbd>Ctrl</kbd>+<kbd>V</kbd> / <kbd>⌘</kbd>+<kbd>V</kbd>) ;
- bouton **📎**, ou clic droit › Joindre un fichier… / Coller.

Le fichier est copié dans un dossier temporaire et son chemin collé dans ta ligne de saisie : Claude affiche `[Image #1]` et l'envoie avec ton message. Les copies sont effacées après 7 jours.

**Aperçu** : chaque image jointe apparaît en **miniature en haut à droite du terminal** (images du message en cours, propres à chaque session : seules celles de la session active sont affichées ; elles disparaissent dès que le message est envoyé). **Clic** = l'image en grand avec son nom (<kbd>Échap</kbd> pour fermer) ; **✕** masque les miniatures jusqu'à la prochaine pièce jointe. Les autres fichiers apparaissent en 📄.

## 11. Palette, recherche, prompts, file d'attente, envoi groupé

- **Palette de commandes** (<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd>) : quelques lettres pour aller à une session, reprendre une conversation, lancer un modèle, insérer un prompt ou exécuter une action (disposition, thème, réglages, diagnostic, verrouillage…). Les actions récentes remontent en tête. Résultats rangés par **sections** (Sessions, Actions, Prompts, Modèles, Conversations), terme surligné ; `>` ne montre que les commandes, `/` que les prompts ; <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Entrée</kbd> ouvre la session choisie dans un panneau de la vue partagée.
- **Rechercher dans les sessions** (<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Maj</kbd>+<kbd>F</kbd>) : un texte dans le contenu de tous les terminaux ouverts ; clic = y aller.
- **Bibliothèque de prompts** (⋯ › Insérer un prompt…, palette, Réglages › Prompts) : tes demandes réutilisables. Elle démarre avec 8 prompts prêts à l'emploi (relire les modifications, écrire les tests, expliquer du code, préparer un commit, corriger un bug, proposer un plan, documenter, résumer), modifiables et supprimables ; **+ Nouveau** pour ajouter les tiens. **Insérer** les place dans la ligne de saisie (tu relis, puis Entrée) ; **Envoyer** les soumet. Variables : `{dossier}`, `{branche}`, `{nom}`, `{selection}` (texte sélectionné dans le terminal).
- **File d'attente** (⋯ › File d'attente…, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Q</kbd>) : des prompts envoyés **un par un, automatiquement, chaque fois que Claude a fini** le précédent — « implémente », puis « ajoute les tests », puis « relis ». Le badge ⏳ indique le nombre en attente.
  - **Quota** (Réglages › Général, activé par défaut) : près de la limite des 5 heures (seuil réglable, 95 % par défaut, lu dans la barre d'état de l'app) ou quand Claude Code affiche « 5-hour limit reached ∙ resets 3pm », la file **se met en pause** (badge **⏸ quota 15:00**) et **repart seule à la réinitialisation**, une minute après. Les sessions coupées en plein travail par la limite reçoivent alors « continue » (option *Relancer les sessions coupées par la limite*). Rien n'est envoyé pour rien pendant la nuit.
- **Envoi groupé** (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>B</kbd>) : le même prompt à plusieurs sessions cochées, tout de suite ou en file d'attente si elles travaillent.

### 11 bis. Demandes programmées

Réglages › **Programmées** : envoyer un prompt à une session, ou lancer un modèle de session (avec son premier prompt, plus celui de la demande), **à une heure donnée** : une seule fois (date) ou certains jours de la semaine (par exemple « relis les modifications d'hier » chaque matin à 9 h). Chaque ligne indique la prochaine échéance et le résultat de la dernière ; une case la met en pause, **Lancer** l'exécute tout de suite.

- Session occupée, arrêtée ou en pause de quota : le prompt est mis dans **sa file d'attente** et part dès que possible.
- L'app doit être ouverte (même réduite). Une échéance manquée il y a moins de 2 heures (ordinateur en veille, app fermée) est rattrapée au démarrage ; plus ancienne, elle est sautée.
- Les demandes restent sur cette machine (`schedules.json` dans les données de l'app), elles ne sont pas synchronisées.

## 12. Modèles de session

Un **modèle** mémorise une session type : dossier, nom, groupe, modèle Claude, mode, worktree, arguments et **premier prompt** (envoyé dès que la session est prête).

- **Créer** : sur une session existante, ⋯ ou clic droit › **Enregistrer comme modèle…** (reprend son dossier, son groupe, son modèle et son mode) ; ou remplis « Nouvelle session » puis **Enregistrer comme modèle**. La liste est vide tant que tu n'en as pas créé.
- **Utiliser** : liste *Modèle de session* en haut de « Nouvelle session », ou palette › « Lancer le modèle : … ».
- **Utiliser** : en haut de « Nouvelle session », section *Partir d'un modèle* : un clic sur une carte remplit le formulaire (les modèles des extensions portent le nom de leur extension). Le modèle Claude se choisit en un clic (Opus, Sonnet, Haiku, Défaut).
- **Gérer** : Réglages › Modèles de session (lancer, renommer, supprimer).

### 12 bis. Extensions

Une **extension** est un seul fichier `.csm.json` qui ajoute des **modèles de session**, des **prompts** et des **types de session** : un affichage dédié, rempli par Claude (résumé, tableaux, chronologie, liste d'actions, brouillon à relire…), et des boutons qui envoient une demande à la session. Après une action qui change l'état (publication, réassignation…), Claude réécrit l'affichage ; s'il finit son tour sans l'avoir fait, l'app le lui demande une fois. Elle n'exécute aucun code dans l'app : elle se partage donc en privé sans risque, et une nouvelle fonctionnalité métier devient une nouvelle extension, sans modifier l'application.

- **Installer** : Réglages › **Extensions** › *Importer un fichier…* (ou glisser le fichier sur la page), ou **coller un lien** puis *Importer le lien* : fichier GitHub (`…/blob/main/x.csm.json`), dossier, dépôt entier (ses `.csm.json` à la racine, dans `csm/` ou `extensions/`), gist ou toute adresse https. Dépôt privé : la CLI GitHub connectée (`gh auth login`) suffit, son jeton n'est envoyé qu'à l'API GitHub. Une extension importée par lien garde son lien : **Mettre à jour** la récupère à nouveau. Un plugin Claude Code peut aussi en fournir (dossier `csm/` du plugin) : elles suivent ses mises à jour.
- **Utiliser** : les modèles apparaissent dans « Nouvelle session » (groupés par extension), les prompts dans la palette. Une session d'un type affiche son **badge** en haut et un bouton pour passer de l'**Affichage** au **Terminal**.
- **Champ à remplir** : un modèle peut demander une valeur (ex. *Numéros des tickets*), affichée en haut de Nouvelle session et reprise dans le premier message ; un type de session peut avoir un champ dans son affichage, avec son bouton (ex. *Analyser*), pour envoyer d'autres valeurs à la session.
- **Gérer** : activer, désactiver ou supprimer chaque extension dans Réglages › Extensions.
- **Synchro** : une extension importée sur une machine est installée sur toutes les machines de l'espace de synchro (chiffrée, comme les modèles) ; sa désactivation et sa suppression suivent. Elle y apparaît « reçue de *machine* ». Les extensions **fournies par un plugin** ne voyagent qu'**avec leur plugin** (elles utilisent ses skills et agents) : la synchro des plugins propose de l'installer sur les autres machines, et l'extension arrive avec lui ; jamais de copie seule. Option *Extensions importées* dans Réglages › Synchronisation.
- Le **type** d'une session (son affichage dédié) suit aussi la session d'une machine à l'autre ; sans l'extension sur l'autre machine, la session y reste une session ordinaire.
- **Jetons d'accès** : une extension dont les outils ont besoin d'un jeton (API, dépôt privé…) le déclare (`secrets`). Au démarrage, s'il manque, l'app ouvre une fenêtre **Accès à configurer** avec le lien **Obtenir le jeton** ; collé, il est rangé là où ces outils le lisent (trousseau macOS, variable de ton compte sous Windows), jamais gardé ni réaffiché par l'app. *Plus tard* ou *Ne plus demander*.
- **Créer** : format complet dans [docs/extensions.md](docs/extensions.md), exemple prêt à importer : [extensions/revue-de-code.csm.json](extensions/revue-de-code.csm.json).

## 13. Verrouiller une session par mot de passe

Pour masquer une session sensible (écran partagé, poste laissé ouvert) : ⋯ ou clic droit › **Verrouiller par mot de passe…** (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>L</kbd>), avec un indice facultatif. *(Depuis la version 3.2.)*

- La session **continue de tourner**, mais son contenu est masqué et la saisie bloquée : un écran 🔒 demande le mot de passe. Dans la liste, 🔒 = verrouillée, 🔓 = déverrouillée dans cette fenêtre.
- Le verrou est **appliqué par le serveur** : une fenêtre non déverrouillée ne reçoit ni l'affichage de la session ni son historique d'affichage, et les actions sensibles (modifications, export, chronologie, consommation, file d'attente, fermeture) sont refusées ; son titre est masqué dans l'Historique.
- Déverrouiller ne vaut que pour **la fenêtre** où tu as tapé le mot de passe. Le verrou revient quand la fenêtre est réduite ou masquée, après une inactivité (Réglages › Sécurité), au redémarrage de l'app, ou tout de suite avec ⋯ › **Verrouiller maintenant**.
- ⋯ › **Changer le mot de passe…** / **Retirer le mot de passe…**
- Mot de passe haché (scrypt), essais limités. **Il ne peut pas être récupéré** : si tu l'oublies, ferme la session (la conversation reste dans les fichiers de Claude Code).
- Limite : le verrou protège ce qu'affiche l'application ; les conversations enregistrées par Claude Code (`~/.claude/projects`) restent des fichiers non chiffrés sur ton disque.

## 14. Notifications, zone de notification, arrière-plan

**Centre d'attention** : le bouton **À traiter N** (barre du haut), <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>I</kbd> ou la palette ouvre la liste des demandes de **toutes** tes sessions :
- **autorisations** (avec les dernières lignes du terminal pour voir la commande) : **Autoriser**, **Toujours pour ce projet**, **Refuser** — envoyés comme au clavier (1, 2, Échap). Les commandes risquées (push, suppression, déploiement…) sont signalées et listées en premier ; **Autoriser les lectures seules** accepte d'un coup les simples lectures de fichiers ;
- **questions** de Claude : réponse directe dans la carte ;
- **tâches terminées** pas encore regardées : à relire, ou *Marquer comme vu*.
Les sessions verrouillées n'y apparaissent pas.

- **Notifications système** quand une session attend ta réponse ou a fini (seulement si tu ne la regardes pas), avec un **son** au choix. **Ne pas déranger** coupe tout ; ⋯ › Couper les alertes le fait pour une seule session.
- **Rappels** si une session attend depuis X minutes ou travaille depuis plus de Y minutes (Réglages › Notifications).
- **Pastille** sur l'icône de l'app (Dock / barre des tâches) avec le **nombre** de sessions en attente (9+ au-delà). Sur Mac, l'app n'étant pas signée par Apple, macOS masque la pastille native : le nombre est alors dessiné sur l'icône du Dock.
- Les notifications passent par l'app sur Windows comme sur Mac : un **clic** ramène la fenêtre sur la session concernée. Sur Mac (app non signée), macOS refuse les notifications propres à l'app : elles passent par celles du système (via « Éditeur de script », à autoriser dans Réglages Système › Notifications), sans ouverture au clic.
- **Tester la notification** (Réglages › Notifications) en montre une et dit par quel moyen elle passe, et quoi régler si rien ne s'affiche.
- **Zone de notification** (Windows, près de l'horloge) / **barre de menus** (macOS)  : **fermer la fenêtre l'y envoie** (réglable), les sessions continuent. **Réduire** laisse l'app dans la barre des tâches / le Dock ; pour la ranger près de l'horloge sans la fermer : **⋯ › Réduire dans la zone de notification** (aussi dans la palette, le clic droit sur l'icône et, sur Mac, le menu Fenêtre). Clic sur l'icône = afficher / masquer ; **clic droit** = la **liste des sessions et leur état** (🟠 travaille, 🔴 attend, 🟢 prête ; clic pour y aller), nouvelle session, historique, réglages, lancer au démarrage, redémarrer le serveur, quitter. Un **point rouge** sur l'icône signale une session qui t'attend. Windows 11 : si l'icône est cachée, elle est sous la flèche **^** (glisse-la dans la zone visible).
- **Quitter** : « Quitter (les sessions continuent) » ferme l'app ; « Quitter et arrêter toutes les sessions » arrête aussi le serveur (elles reviendront au prochain lancement).
- **Lancement au démarrage** de l'ordinateur : activé au premier lancement, réglable dans le menu de l'icône.
- **Fenêtre noire ou vide** (affichage ou GPU planté, page dont le script n'a pas démarré après 25 s, fenêtre figée plus de 20 s ; une page qui attend simplement le serveur, au démarrage de l'ordinateur, n'est recréée qu'au bout de 3 min) : la fenêtre se **recrée seule**, sans toucher au serveur ni aux sessions. <kbd>F5</kbd> (Windows) / <kbd>Cmd</kbd>+<kbd>R</kbd> (macOS) ou « Recharger la fenêtre » dans le menu de l'icône la recréent aussi à la main.

### 14 ter. Connexion à Claude qui expire (« Your login expires in 3 days »)

La connexion de Claude Code à ton compte claude.ai a une durée limitée (en Team / Enterprise, l'organisation peut imposer de la renouveler régulièrement). L'app s'en occupe :

- **Bandeau 🔑** en haut de l'écran quelques jours avant l'expiration (5 par défaut, Réglages › Général), et une **notification** par jour ; rouge si elle a expiré. *Plus tard* le masque 24 h.
- **Renouveler** (ou palette › *Renouveler la connexion à Claude*) : l'app lance `claude auth login` en arrière-plan, le **navigateur s'ouvre** sur la page de connexion de Claude ; tu te connectes et autorises. Si la page affiche un code, colle-le dans la fenêtre de l'app. Le bandeau disparaît dès que la connexion est renouvelée.
- C'est la même connexion que `/login` : l'app ne lit et ne garde que sa **date d'expiration**, jamais les jetons. Sur macOS (connexion rangée dans le trousseau, que l'app ne lit pas), l'expiration est déduite des avertissements que Claude affiche dans les sessions.
- Les sessions ouvertes utilisent la nouvelle connexion dès leur prochain échange ; si l'une affiche encore une erreur de connexion, **Relancer**.

### 14 bis. Accès depuis l'app Claude (téléphone)

Claude Code sait rendre une session locale pilotable depuis l'**app Claude** (iOS / Android, onglet **Code**) et depuis **claude.ai/code** : c'est la fonction **Remote Control** de Claude Code, que Claude Sessions active pour toi.

- **Pour une nouvelle session** : coche **📱 Accessible depuis l'app Claude** dans « Nouvelle session ».
- **Pour une session ouverte** : ⋯ › **📱 Accès depuis l'app Claude** (ou palette). La conversation continue, sans relancer ; même menu pour désactiver.
- **Pour toutes les nouvelles sessions** : Réglages › Général › *Rendre les nouvelles sessions accessibles depuis l'app Claude*.
- La session apparaît dans l'app Claude sous le **nom qu'elle a dans Claude Sessions** (pastille verte quand elle est en ligne) ; le badge **📱** la repère dans la liste. Après un redémarrage, elle se reconnecte toute seule.
- **Prérequis** : abonnement Claude **Pro, Max, Team ou Enterprise**, connecté dans Claude Code avec `/login` (une clé API ne suffit pas). En Team / Enterprise, l'administrateur doit autoriser Remote Control.
- **Sécurité** : connexion sortante chiffrée via Anthropic, **aucun port ouvert** sur ton PC ; le code et les fichiers restent chez toi. Le transcript de la session est stocké par Anthropic pour la synchronisation ([détails](https://code.claude.com/docs/en/remote-control)).

## 15. Thème clair / sombre, langue

- **Style « Atelier »** (3.30) : graphite et argile en sombre, ivoire en clair ; textes en IBM Plex Sans, terminal en JetBrains Mono (polices intégrées à l'app, aucune connexion). Les états se distinguent aussi par leur clarté : ambre = travaille, corail = attend ta réponse, vert d'eau = prêt, gris = arrêtée.
- **Bas de la barre latérale** : quotas **5 h** et **7 jours** de ton abonnement (barres, pourcentage et heure de réinitialisation, transmis par la barre d'état de Claude Code) et état de la synchro.
- **Thème** : **Système** (par défaut) suit automatiquement le mode clair ou sombre de Windows / macOS, y compris quand il change en cours de journée ; ou forcer **Clair** / **Sombre** (Réglages › Général, ou palette › « Thème »). Le terminal suit le thème. Claude Code a ses propres couleurs (sombres par défaut) : en thème clair, le terminal de l'app **fonce automatiquement tout texte trop clair** (code, diffs, couleurs RVB), pour qu'il reste lisible (contraste minimal 4,5:1). Pour des couleurs pensées pour un fond clair, tape aussi `/theme` dans une session et choisis un thème clair de Claude Code (ce réglage vaut aussi pour le terminal du système).
- **Langue** : français ou anglais, automatiquement selon la langue du système, ou forcée dans Réglages › Général.
- **Langue des réponses de Claude** : les sessions lancées par l'app répondent dans la langue de l'interface (en français si l'app est en français ; en « Automatique », celle du système, lue dans ses langues préférées), quelle que soit la langue de tes messages ou du code. Réglages › Général › *Langue des réponses de Claude* : une autre langue, ou *Réglage de Claude Code* pour garder le tien (`language` dans `~/.claude/settings.json`). Claude Code ne lit ce réglage qu'au démarrage : après un changement, l'app **propose de relancer les sessions ouvertes** (la conversation reprend là où elle en était ; une session en plein travail est relancée dès qu'elle a fini son tour). Même chose pour la mémoire, le compactage et la barre d'état. Le `claude` du terminal n'est pas concerné.

## 16. Réglages

⚙ en bas de la barre latérale, ou <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>,</kbd>.

| Onglet | Contenu |
|---|---|
| **Général** | thème (système, clair, sombre), langue, modèle et mode par défaut, worktree proposé par défaut, éditeur pour « Ouvrir dans », barre d'état des quotas, mémoire des sessions (§ 16 ter), pause de la file d'attente sur quota, compactage automatique, Remote Control par défaut, mises à jour automatiques, barre latérale compacte, réduire / fermer dans la zone de notification |
| **Terminal** | taille et police du texte, historique gardé à la compaction |
| **Notifications** | notifications système, son (coupé par défaut, avec test), ne pas déranger, rappels d'attente et de longue exécution |
| **Sécurité** | reverrouiller quand la fenêtre est masquée, après une inactivité |
| **Modèles de session** | lancer, renommer, supprimer |
| **Prompts** | ouvrir la bibliothèque de prompts |
| **Programmées** | demandes programmées (§ 11 bis) |
| **Mémoire** | voir, chercher et corriger la mémoire (§ 16 ter) |
| **Synchronisation** | créer ou saisir un code de synchro, le copier, fréquence (5, 10, 30 ou 60 min), état, machines et place occupée, changer de code ; Avancé : nom de machine, correspondance des dossiers, serveur (§ 16 bis) |
| **Diagnostic** | versions, `claude` et `git` trouvés ou non, hooks, dossiers, dernières lignes du journal ; **Copier le rapport** pour une issue |
| **Journaux** | le journal du serveur, filtrable |
| **À propos** | version, rechercher des mises à jour, auteur |

#### Chaque réglage, onglet par onglet

**Général**

- **Thème** : Système (suit Windows / macOS en direct), clair ou sombre.
- **Langue** : Automatique (celle du système), français ou anglais. L'interface se recharge.
- **Modèle par défaut** : Modèle proposé dans « Nouvelle session » : opus, sonnet, haiku, ou celui de Claude Code.
- **Mode par défaut** : Mode d'autorisation proposé : par défaut, acceptEdits (modifie sans demander), plan (propose avant d'agir) ou bypassPermissions (aucune confirmation, à réserver aux dossiers sans risque).
- **Proposer un worktree git par défaut** : Dans un dépôt git, la case « worktree dédié » est cochée d'office : chaque nouvelle session travaille sur sa propre branche (§ 7).
- **Éditeur pour « Ouvrir dans »** : Automatique (le premier trouvé), VS Code, Cursor, Windsurf, Zed, IntelliJ, Sublime, ou une commande personnalisée avec `{path}`.
- **Signer les commits et les PR faits par Claude** : décoché par défaut, Claude n'ajoute **aucune signature** (ni `Co-Authored-By: Claude…`, ni « Generated with Claude Code », ni lien de session) à ses commits et pull requests (réglage `attribution` de Claude Code, posé pour chaque session lancée par l'app). Coché : le comportement normal de Claude Code. Les sessions ouvertes le prennent en compte à leur relance (l'app la propose).
- **Afficher les quotas sous chaque session** : Barre d'état de l'app sous l'invite de Claude : quotas 5 h et 7 jours, heure de réinitialisation, contexte utilisé, modèle. Si tu as ta propre barre d'état, c'est elle qui s'affiche, inchangée : l'app y relève seulement les quotas (barre latérale, file d'attente) ; elle sert aussi à la pause de la file d'attente.
- **Mémoire des sessions** : **Mémoire intégrée** (recommandé, rien à installer) ou **claude-mem** (installé automatiquement). Une seule à la fois, pour les sessions de l'app ; avec la synchro, le même choix sur toutes les machines (§ 16 ter).
- **Pause de la file d'attente près de la limite des 5 h** : La file d'attente n'envoie plus rien au-delà du **seuil** (80, 90, 95 ou 99 %) ou quand la limite est atteinte, et repart à la réinitialisation (§ 11).
- **Relancer les sessions coupées par la limite** : À la réinitialisation, envoie « continue » aux sessions interrompues en plein travail par la limite.
- **Compactage automatique** : Moment où Claude Code résume la conversation : **fenêtre complète du modèle** (recommandé, évite les compactages en boucle), vers 400 000 ou 200 000 tokens, ou réglage de Claude Code (§ 16 ter).
- **Rendre les nouvelles sessions accessibles depuis l'app Claude** : Active d'office le Remote Control pour chaque nouvelle session (pilotage depuis le téléphone et claude.ai/code, § 14 bis).
- **Mises à jour automatiques** : Recherche et télécharge les nouvelles versions ; une version prête s'installe en quittant l'app ou à son lancement. **Installer et redémarrer tout seul** : seulement fenêtre réduite, en arrière-plan ou après 5 min d'inactivité, jamais pendant qu'une session travaille ; les sessions reviennent (§ 17).
- **Barre latérale compacte** : Liste des sessions réduite aux pastilles d'état (aussi le bouton ⇤).
- **Fermer dans la zone de notification** : fermer la fenêtre range l'app près de l'horloge (sinon elle se ferme ; les sessions continuent dans tous les cas). Réduire, lui, reste dans la barre des tâches ; la zone de notification se choisit depuis un menu (⋯ › Réduire dans la zone de notification).

**Terminal**

- **Taille du texte, police** : Taille et police des terminaux ; <kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>−</kbd> / <kbd>0</kbd> pour zoomer.
- **Garder l'historique affiché** (activé par défaut) : à la compaction (« Conversation compacted ») et à `/clear`, Claude Code efface l'écran **et** l'historique de défilement. Claude Sessions garde ce qui était affiché : il reste au-dessus, en remontant dans le terminal (10 000 lignes). Décoché : comportement d'origine, tout est effacé.
- **Après un redémarrage de l'app** (mise à jour, reboot) : le contenu du terminal de chaque session est gardé sur le disque (son dernier Mo ; rien pour une session verrouillée) et réaffiché au-dessus de la conversation reprise. Quand il n'y en a pas (première reprise, session venue d'une autre machine, *Relancer*) et que la conversation a été compactée, l'app affiche la **discussion d'avant la compaction**, lue dans la conversation (synchronisée entre tes machines) : Claude Code n'en montre plus que la suite.

**Notifications**

- **Notifications système** : Une notification quand une session t'attend ou a fini.
- **Son** : Aucun (par défaut), discret ou clochette, avec un bouton pour tester.
- **Ne pas déranger** : Ni notification ni son, pour toutes les sessions (une seule session : ⋯ › Couper les alertes).
- **Rappel si une session attend depuis…** : Nouvelle alerte si une session attend ta réponse depuis N minutes (0 = jamais).
- **Alerte si une session travaille depuis plus de…** : Prévient d'un tour anormalement long (0 = jamais).

**Sécurité**

- **Reverrouiller quand la fenêtre est masquée** : Les sessions verrouillées par mot de passe se reverrouillent dès que la fenêtre est réduite ou cachée.
- **Reverrouiller après une inactivité de…** : Et après N minutes sans action (0 = jamais) (§ 13).

**Modèles de session**

- **Liste des modèles** : Lancer, renommer ou supprimer les modèles créés avec « Enregistrer comme modèle » (§ 12).

**Prompts**

- **Bibliothèque de prompts** : Créer, modifier, supprimer tes prompts réutilisables (§ 11).

**Programmées**

- **Demandes programmées** : Un prompt dans une session, ou un modèle de session lancé, à une heure donnée : une fois ou certains jours. Case pour mettre en pause, **Lancer** pour exécuter tout de suite (§ 11 bis).

**Mémoire**

- **Recherche et sources** : mémoire intégrée (fiches), notes de Claude Code, claude-mem ; filtres par dossier et par machine.
- **Corriger une fiche** : renommer, note **« À retenir »** donnée en premier à Claude, retirer une demande ou une réponse, **Oublier** la fiche ; suit la synchro.
- **Notes de Claude Code** : modifier ou supprimer (copie gardée 30 jours).

**Synchronisation**

- **Créer un code / J'ai déjà un code** : Active la synchro entre tes machines ; le code s'affiche pour le saisir sur les autres. Garde-le secret : qui l'a voit tes sessions (§ 16 bis).
- **À synchroniser** : Les sessions (toujours), et au choix : leurs **conversations**, la **liste des groupes**, les **modèles de session**, la **mémoire des sessions** (et le choix de la mémoire).
- **Configuration de Claude** : Règles (`CLAUDE.md`, `~/.claude/rules`), skills, agents et commandes, notes de Claude Code : les mêmes sur toutes les machines, la plus récente gagne.
- **Me demander avant d'appliquer…** : décochée par défaut, tout s'applique seul. Cochée, les règles, skills, agents, commandes et plugins reçus attendent ton accord dans **Fichiers reçus** (Appliquer, Refuser). Dans les deux cas : journal des changements et **Restaurer**.
- **Synchroniser automatiquement** : Toutes les 5, 10, 30 ou 60 minutes ; tes modifications partent tout de suite, l'intervalle règle la récupération de celles des autres machines.
- **Machines** : la liste des machines de l'espace et la place occupée sur le serveur de synchro (1 Go, détail par catégorie) ; **Retirer** une machine de la liste ; **Changer de code (couper l'accès d'une machine)…** pour couper l'accès d'une machine (l'ancien espace est effacé du serveur).
- **Avancé** : Nom de la machine, **racines de dossiers** (alias=chemin, pour retrouver un projet rangé à un autre endroit sur l'autre machine), serveur de synchro (vide = celui du projet).

**Diagnostic**

- **Diagnostic** : Versions, `claude` et `git` trouvés ou non, hooks, dossiers, fin du journal ; **Copier le rapport** pour signaler un problème.

**Journaux**

- **Journaux** : Le journal du serveur, filtrable.

**À propos**

- **À propos** : Version, **Rechercher des mises à jour**, **Redémarrer pour mettre à jour** quand une version est prête, auteur.

### 16 ter. Mémoire des sessions

Claude repart de zéro à chaque session. **La mémoire des sessions** lui rappelle ce qui a déjà été fait. Dans Réglages › Général › *Mémoire des sessions : laquelle utiliser ?*, on choisit **une seule** des deux :

- **Mémoire intégrée** (par défaut, recommandé) : rien à installer, décrite ci-dessous. claude-mem est alors désactivé pour les sessions de l'app.
- **claude-mem** : le plugin [claude-mem](https://github.com/thedotmack/claude-mem), plus complet (observations détaillées, recherche dans les souvenirs), est **installé automatiquement** s'il manque (`claude plugin marketplace add thedotmack/claude-mem`, puis `claude plugin install claude-mem@thedotmack`). L'état de l'installation s'affiche sous le choix. La mémoire intégrée est alors arrêtée.

Le choix ne concerne que les sessions lancées par l'app : il passe par `enabledPlugins` dans leur fichier `--settings`. Un `claude` lancé dans un terminal garde les réglages de `~/.claude/settings.json`.

- **Ce qui est retenu** : pour chaque session lancée par l'app, une fiche avec son titre, ses demandes, la fin de chaque réponse de Claude (« où on en est »), les fichiers modifiés, la branche git et la machine. La fiche est mise à jour à la fin de chaque tour : seule la suite du transcript est lue. Les sorties d'outils, les sous-agents et les messages système sont ignorés.
- **Ce que Claude reçoit au démarrage** : un résumé des 6 sessions les plus récentes **du même dossier**, toutes machines confondues (première demande, dernières demandes, où on en est, fichiers modifiés), puis la liste des autres dossiers récents. C'est environ 9 000 caractères au plus. La session en cours n'est jamais incluse. Claude est invité à vérifier dans le code avant de s'y fier.
- **Mémoire complète, lisible et cherchable** : `memory/projects/<dossier>.md` dans les données de l'app contient un fichier Markdown par dossier, avec toutes les demandes et réponses de chaque session. Le chemin est donné à Claude, qui peut le lire ou y chercher (`grep`) s'il a besoin de plus de détails. Les fiches brutes sont dans `memory/sessions/<id>.json`.
- **Partagée entre les machines** : si la synchronisation est active (§ 16 bis), option *Mémoire des sessions*, cochée par défaut. Les fiches partent chiffrées de bout en bout, et celles des autres machines sont ajoutées ici. Une session du Mac donne donc son contexte à la session suivante du PC dans le même projet, puisque les dossiers sont traduits comme pour les sessions. Si une fiche a changé des deux côtés, la plus récente gagne.
- **Sessions concernées** : celles lancées par Claude Sessions. Au premier lancement, les sessions de l'app existantes sont rattrapées. Un `claude` lancé dans un terminal n'est ni lu ni modifié. Choisir claude-mem arrête la capture et l'injection ; les fiches déjà écrites restent sur le disque, et on peut supprimer le dossier `memory` pour les effacer.
- **API locale** : `GET /api/memory` liste les fiches.
- **Après un compactage**, le contexte n'est pas redonné : le résumé du compactage le contient déjà.

#### Écran Mémoire (Réglages › Mémoire)

Voir, chercher et corriger ce que Claude retient. Une recherche plein texte et des filtres (dossier, machine), et trois sources :

- **Mémoire intégrée** : une fiche par session. Clic = détail : **renommer**, ajouter une note **« À retenir »** (une consigne ou un fait durable, donné à Claude **en premier** au démarrage de chaque session de ce dossier, avant le résumé des sessions), **retirer** une demande ou une réponse fausse (✕, elle ne revient pas à la relecture du transcript), **Oublier cette fiche** (plus jamais donnée à Claude ni recréée). Les corrections suivent la synchro : elles s'appliquent aussi sur tes autres machines.
- **Notes de Claude Code** : les fichiers `memory/*.md` que Claude Code écrit lui-même dans `~/.claude/projects` ; les modifier ou les supprimer (une copie de la version actuelle est gardée 30 jours) ; ils suivent la synchro de `~/.claude`.
- **claude-mem** (si c'est la mémoire choisie) : recherche dans ses observations, en lecture seule (sa synchro ne fait qu'ajouter : une correction ne passerait pas aux autres machines).

#### Compactage automatique

Réglages › Général › *Compactage automatique* fixe la fenêtre à partir de laquelle Claude Code compacte la conversation des sessions de l'app. Par défaut, c'est **la fenêtre complète du modèle**, par exemple 1 million de tokens avec Opus 1M. Les autres choix sont vers 400 000 tokens, vers 200 000 tokens, ou *Réglage de Claude Code* (rien n'est imposé).

Si une session compacte toutes les quelques minutes, la cause est souvent `CLAUDE_CODE_AUTO_COMPACT_WINDOW` réglé trop bas, par exemple 128000 dans `env` de `~/.claude/settings.json`. Claude compacte alors vers 95 000 tokens, même sur un modèle 1M. Le choix par défaut remplace cette valeur pour les sessions de l'app. Pour le terminal, retirer la ligne de `~/.claude/settings.json`.

<a id="16-bis-synchroniser-la-liste-entre-machines"></a>

### 16 bis. Synchroniser les sessions entre machines

Retrouver sur le PC les sessions créées sur le Mac, et inversement : **nom, dossier, modèle et options, groupe, épinglage, couleur, accès téléphone**, et **leur conversation** (historique et contexte), pour continuer sur une machine ce qui a été commencé sur l'autre.

Le **modèle** suivi est celui que la conversation utilise vraiment : changé en cours de session (`/model` dans Claude Code), il remplace celui choisi à la création, pour la relance, la reprise et les autres machines.

- **Quoi synchroniser** (Réglages › Synchronisation › *À synchroniser*) : la liste des sessions (toujours), et au choix **les conversations**, **la liste des groupes** (groupes vides compris, dans l'ordre ; déplacer une session d'un groupe à l'autre sur une machine la déplace aussi sur les autres) et **les modèles de session** (chiffrés, dossier traduit comme pour les sessions). À la première synchro, les groupes des deux machines sont réunis. Une option décochée n'envoie ni n'applique rien ; recochée, tout ce qui a changé entre-temps est rattrapé. Pendant que Claude travaille, une conversation part au plus toutes les 2 minutes (10 minutes au-delà de 20 Mo), compressée en arrière-plan sans ralentir les terminaux.
- **Plugins Claude Code** : les machines d'un même espace ont les **mêmes plugins**. Chacune publie ceux qu'elle a installés depuis un marketplace GitHub ; les autres les installent (`claude plugin marketplace add` puis `claude plugin install`). Comme un plugin peut faire exécuter du code, un plugin reçu attend ta validation (*Plugins à valider*, dans Réglages › Synchronisation) si « Me demander avant d'appliquer… » est coché ; décoché (par défaut), il s'installe seul. Une machine qui n'a pas un plugin ne le fait **jamais** retirer ailleurs : seule une vraie désinstallation, sur une machine qui l'avait, est propagée — appliquée seule, ou proposée si la validation est cochée. Les marketplaces locaux (un dossier d'une machine) ne sont pas partagés.
- **Machine non synchronisée** : sans code de synchro, rien n'est partagé, elle garde ses plugins et ses sessions. Pour garder l'historique d'une machine seule (sauvegarde chiffrée de ses sessions, conversations, modèles…), crée-lui son propre code sans le saisir ailleurs : c'est un espace à elle.
- **Mémoire des sessions** (une seule case, cochée par défaut) : la mémoire choisie dans Réglages › Général est partagée, chiffrée, **ainsi que ce choix lui-même** : passer de la mémoire intégrée à claude-mem sur une machine fait passer toutes les autres (claude-mem s'y installe au besoin). Une machine qui rejoint l'espace prend le choix déjà partagé.
  - *Mémoire intégrée* : les résumés de chaque session (§ 16 ter) partent chiffrés, et ceux des autres machines sont donnés à Claude au démarrage des sessions du même dossier.
  - *claude-mem* : les sessions lancées par Claude Sessions ont **leur propre mémoire claude-mem** (dossier `claude-mem` des données de l'app, worker sur son propre port). Ses observations, résumés et prompts partent chiffrés dans l'espace de synchro, et ceux des autres machines sont chargés ici : une machine qui saisit le code **récupère toute la mémoire à sa première synchro**, avant même sa première session. **Le terminal du système est séparé** : `claude` lancé dans Terminal, iTerm ou PowerShell garde sa mémoire locale (`~/.claude-mem`), jamais lue, envoyée ni modifiée. Limites : ajout seulement (un souvenir effacé sur une machine ne l'est pas ailleurs) ; la recherche sémantique (Chroma) ne voit les souvenirs reçus qu'après sa réindexation, la recherche plein texte tout de suite.
- **Configuration de Claude** (cadre *Configuration de Claude*, quatre cases cochées par défaut) : chaque machine synchronisée a les mêmes **règles**, **skills**, **agents** et les mêmes **notes de Claude Code** :
  - *Règles* : `~/.claude/CLAUDE.md`, les fichiers `.md` posés à côté (ceux qu'il importe avec `@`, par exemple `RTK.md`) et `~/.claude/rules`.
  - *Skills* : `~/.claude/skills`. Un lien vers un dossier est suivi. Les skills des plugins ne sont pas concernées, ni `skills/synced/` (les skills de ton compte claude.ai, que Claude Code télécharge lui-même sur chaque machine).
  - *Agents et commandes* : `~/.claude/agents` et `~/.claude/commands`.
  - *Notes de Claude Code* : les dossiers `memory/` de `~/.claude/projects`, que Claude Code écrit lui-même (rien à voir avec la mémoire des sessions ci-dessus), pour les projets placés au même endroit sous le dossier personnel (`~/Projects/x` sur Mac correspond à `C:\Users\…\Projects\x` sous Windows).

  Chaque fichier part chiffré, avec son chemin. Les créations, modifications et **suppressions** suivent, et **la version la plus récente gagne**. Exception : l'index des notes (`memory/MEMORY.md`) est **fusionné** ligne à ligne — les notes ajoutées sur chaque machine restent listées, une note supprimée ne revient pas.

  - **Validation** (case *Me demander avant d'appliquer…*, décochée par défaut : tout s'applique seul) : cochée, les règles, skills, agents, commandes et plugins reçus **ne sont écrits qu'après ton accord** (Réglages › Synchronisation › *Fichiers reçus* : Appliquer, Refuser, Tout appliquer) ; décochée, ce qui attendait encore s'applique à la synchro suivante. Les notes de Claude Code s'appliquent toujours seules. Pourquoi : ces fichiers guident Claude et peuvent lui faire exécuter des commandes ; **quiconque a ton code de synchro pourrait en envoyer**. Garde le code secret comme un mot de passe.
  - **Journal et restauration** : chaque fichier reçu (créé, remplacé, supprimé, refusé) est noté avec la machine d'origine ; **Restaurer** remet la version d'avant (la version actuelle est copiée d'abord), qui repart vers les autres machines. Les copies sont dans `claude-sync-backup/<date>/` du dossier de données de l'app, gardées 30 jours ; rien n'est remplacé si la copie échoue.
  - **Garde-fous** : jamais d'écriture à travers un lien symbolique (skill relié à un dépôt), ni hors de `~/.claude`, ni dans un dossier caché ; le bit exécutable n'est pas synchronisé ; une suppression n'est envoyée que si le fichier n'existe vraiment plus (un fichier devenu trop gros ou illisible n'est pas pris pour supprimé), et si plus de 20 % des fichiers disparaissent d'un coup, rien n'est supprimé ailleurs (avertissement dans Réglages). Ne sont pas envoyés : les fichiers de plus de 2 Mo, les dossiers cachés, `node_modules` et `__pycache__`. Les conversations et les réglages (`settings.json`) restent locaux.
- **Tout est chiffré de bout en bout** : sessions, groupes, modèles et conversations sont chiffrés sur ta machine (AES-256-GCM, clé dérivée de ton code) avant l'envoi. Le code ne quitte jamais tes machines : le serveur ne reçoit qu'une clé d'accès dérivée (il n'en garde que l'empreinte) et ne peut ni lire ni modifier ce qu'il stocke. Seuls le modèle, le mode (hors bypassPermissions) et l'effort d'une session passent d'une machine à l'autre : aucun autre argument de `claude` n'est repris.

- **Désactivée par défaut.** Rien n'est synchronisé tant qu'aucun **code de synchro** n'est actif. Chaque code est un espace isolé : sans ton code, personne ne voit tes sessions, et tu ne vois pas les leurs.
- **Première machine** : Réglages › Synchronisation › **Créer un code**. L'app tire un code (`XXXX-XXXX-XXXX-XXXX-XXXX`), enregistre sur le serveur l'empreinte de la clé d'accès qui en dérive, et l'affiche en clair avec un bouton **Copier**. La synchro démarre tout de suite.
- **Autres machines** : Réglages › Synchronisation › **J'ai déjà un code**, colle le code puis **Activer** (majuscules, espaces et tirets indifférents). Donne un **nom de machine** parlant (« PC bureau », « Mac ») dans **Avancé**.
- Une session venue d'une autre machine apparaît **arrêtée**, avec un badge **⇄ machine**. **Reprendre** continue sa conversation dans le dossier correspondant de cette machine (la dernière version est récupérée juste avant). Une conversation est envoyée dès qu'elle change (au plus toutes les 2 minutes pendant que Claude travaille) ; si elle a été modifiée des deux côtés, la plus récente gagne, et la version remplacée est d'abord copiée dans `transcript-backup/<date>/` du dossier de données (30 jours). Une session ouverte ici n'est jamais écrasée. Limite : 40 Mo par conversation (compressée).
- **Dossiers** : le dossier personnel est traduit tout seul (`/Users/moi/Projets/app` ↔ `C:\Users\moi\Projets\app`). Pour d'autres emplacements, déclare des alias identiques sur chaque machine (Avancé), une ligne par alias : `code=D:\dev` sur le PC, `code=~/dev` sur le Mac. Si le dossier n'existe pas ici, la session s'ouvre dans le dossier personnel (une note l'indique).
- **Fréquence** (Réglages › Synchronisation › *Synchroniser automatiquement*) : **toutes les 5, 10 ou 30 minutes ou toutes les heures** (5 min par défaut). Ce que tu changes sur une machine part **tout de suite** ; l'intervalle règle quand les autres machines vont le chercher. **Synchroniser maintenant** force une synchro immédiate.
- **Temps réel** : dès qu'une machine envoie un changement (session renommée, regroupée, supprimée, conversation, mémoire, règles, skills…), le serveur prévient les autres, qui se synchronisent **en quelques secondes**, sans attendre la fréquence choisie. Serveur injoignable : relevé de la liste toutes les 30 s et synchro complète à la fréquence choisie, comme avant ; en cas de modifications simultanées, la plus récente gagne. Une session supprimée ailleurs mais **en cours ici** n'est pas arrêtée.
- **Fermeture, veille, extinction** : à l'arrêt du serveur (mise à jour, *Quitter et arrêter*, *Redémarrer le serveur*), une dernière synchro part avant la sortie (au plus 12 s) ; la mise en veille, l'extinction et le verrouillage de l'écran lancent aussi une synchro. Les derniers renommages, mises en pause et conversations ne restent plus bloqués sur la machine qu'on éteint.
- **Ne partage ton code qu'avec tes propres machines** : il donne accès à tes sessions et à leurs conversations. **Désactiver** l'efface de cette machine.

**Machines** (Réglages › Synchronisation › *Machines*) : chaque machine de l'espace (nom, système, version de l'app, mémoire choisie, dernière synchro), « cette machine » en tête, et la **place occupée sur le serveur de synchro** (par exemple « 94 Mo sur 1 Go », avec le détail : conversations, configuration de Claude, claude-mem, mémoire intégrée). Ce n'est pas le disque de ta machine : c'est l'espace chiffré partagé par tes machines, limité à 1 Go ; plein, le serveur refuse les nouvelles conversations (le reste continue).

- **Retirer** enlève une machine de la liste ; elle y revient si elle se synchronise encore, puisqu'elle a toujours le code.
- **Changer de code (couper l'accès d'une machine)…** coupe vraiment l'accès : un nouveau code est créé, tout ce que cette machine a (sessions, conversations, mémoire, configuration) part dans le nouvel espace, puis **l'ancien espace est effacé du serveur**. Les machines restées sur l'ancien code reçoivent « code refusé » ; saisis le nouveau code sur celles que tu gardes (Réglages › Synchronisation › J'ai déjà un code), elles y renvoient alors ce qu'elles ont.

**Serveur de synchro** : par défaut, l'app utilise le serveur public du projet (Worker Cloudflare : métadonnées dans une base D1, conversations chiffrées dans R2, jusqu'à 1 Go par espace). Il ne voit jamais le code ni le contenu en clair, et limite la création d'espaces et la place occupée. **Code créé avant la 3.8** : il avait été tiré par le serveur ; il continue de fonctionner (rattaché automatiquement à la nouvelle clé d'accès), mais pour un chiffrement de bout en bout strict, crée un nouveau code (Désactiver, puis Créer un code) et saisis-le sur tes autres machines. Tu peux héberger le tien (gratuit) avec [`sync-worker/`](sync-worker), puis mettre son adresse dans Réglages › Synchronisation › Avancé › **Serveur** :

```bash
cd sync-worker
npx wrangler d1 create csm-sync          # puis mets son database_id dans wrangler.toml
npx wrangler d1 execute csm-sync --remote --file schema.sql
npx wrangler r2 bucket create csm-sync-chunks   # morceaux chiffrés des conversations (R2 gratuit : 10 Go)
npx wrangler deploy                       # affiche l'adresse https://csm-sync.<toi>.workers.dev
```

Mise à jour d'un serveur existant : `npx wrangler d1 execute csm-sync --remote --file migrations/2026-10-02-parts-ok.sql` une fois, puis `npx wrangler deploy`. Les tests du Worker : `cd sync-worker && npm install && npm test` (serveur local, D1 et R2 locaux) ; GitHub Actions les lance à chaque modification et déploie au tag si le secret `CLOUDFLARE_API_TOKEN` est configuré.

Chaque code a son propre espace. Le serveur refuse tout code qu'il n'a pas créé et ne stocke que les champs listés plus haut.

### 16 quater. Changer d'ordinateur : export / import

Sans synchronisation, un **fichier** suffit pour retrouver toutes tes sessions sur un nouvel ordinateur (Mac ou Windows, dans un sens ou dans l'autre).

1. **Sur l'ancien** : Réglages › **Export / import** › *Exporter les sessions…*. Le fichier `.csmx` contient toutes les sessions de la liste (noms, dossiers, groupes, couleurs, options, pause), **leurs conversations** (case à décocher pour un fichier léger), les groupes, les modèles, les extensions importées et la mémoire des sessions. Un **mot de passe** (conseillé) chiffre le fichier (AES-256-GCM, clé dérivée par scrypt) ; il sera demandé à l'import.
2. Copie le fichier sur le nouvel ordinateur (clé USB, cloud, e-mail…). Rien ne passe par internet de la part de l'app.
3. **Sur le nouveau** : Réglages › **Export / import** › *Choisir un fichier .csmx…* : l'aperçu liste les sessions (déjà présentes, dossier introuvable ici, sans conversation), puis *Importer*. **Reprendre** continue chaque conversation.

- Les dossiers sous ton dossier personnel sont retrouvés d'un système à l'autre (`/Users/toi/Projets/app` ↔ `C:\Users\toi\Projets\app`, et les racines de Réglages › Synchronisation) ; un dossier absent ouvre la session dans le dossier personnel.
- Rien en double : une session déjà présente (même conversation) est ignorée, une conversation déjà présente n'est jamais remplacée, une mémoire déjà présente est gardée. Importer deux fois le même fichier ne change rien.
- Non exportés : les réglages de la machine, le code de synchro, les jetons d'accès. Une session **verrouillée** est exportée sans sa conversation (à déverrouiller avant).
- Les plugins et la configuration de Claude Code (`~/.claude`) ne sont pas dans le fichier : réinstalle-les, ou utilise la synchro (§ 16 bis) qui les propose.

## 17. Mises à jour

- **Windows** : l'app vérifie les nouvelles versions (au lancement puis toutes les 30 minutes, même fenêtre cachée), les télécharge en arrière-plan et affiche un bandeau **Redémarrer pour mettre à jour** (aussi dans le menu de l'icône). Le serveur est relancé avec le nouveau code et **tes sessions reviennent toutes seules**.
- **macOS** : même principe. L'app télécharge le `.dmg` de ton processeur (Apple Silicon ou Intel), vérifie son empreinte (sha512 de `latest-mac.yml`), prépare la nouvelle version puis affiche **Redémarrer pour mettre à jour** : l'app se ferme, est remplacée dans son dossier (sans mot de passe ; si l'app a été installée par un autre compte, le mot de passe administrateur est demandé **une seule fois** et l'app t'est ensuite attribuée, les mises à jour suivantes passent sans) et se relance avec tes sessions. En cas d'échec, elle revient au lien vers la page de téléchargement.
- **Installation et redémarrage automatiques** (Windows et macOS, activés par défaut) : une fois la version prête, l'app l'installe et redémarre **toute seule** dès que la fenêtre est réduite ou cachée en arrière-plan (elle revient alors cachée, sans te déranger) ou que l'ordinateur est inactif depuis 5 minutes, et jamais pendant qu'une session travaille ; les sessions reviennent. Tu peux aussi cliquer **Redémarrer pour mettre à jour** sans attendre, ou **Plus tard** pour fermer le bandeau : cette version ne s'installe alors plus seule jusqu'au prochain lancement de l'app, et tu l'appliques quand tu veux (Réglages › À propos ou menu de l'icône) ; une version plus récente est reproposée.
- **En quittant ou en relançant l'app** : quitter l'app avec une version prête l'installe au passage, sans rien demander (menu de l'icône : *Quitter et installer la version…* ; aussi <kbd>⌘</kbd>+<kbd>Q</kbd> et la fermeture de la fenêtre quand elle quitte l'app). Les sessions reprennent au prochain lancement, sur la nouvelle version. Et une version déjà téléchargée trouvée au lancement de l'app s'installe tout de suite (l'app redémarre une fois, quelques secondes), même après *Plus tard*.
- Réglages › Général › décocher **Installer la mise à jour et redémarrer tout seul** pour garder la main (installation en arrière-plan) ; décocher **Mises à jour automatiques** pour ne rien installer du tout. Sur macOS, si le dossier de l'app demande un mot de passe administrateur, l'installation reste manuelle. Le journal `update.log` (dossier de données de l'app) indique chaque étape et pourquoi une installation attend (fenêtre au premier plan, session au travail…).
- Réglages › À propos › **Rechercher des mises à jour** pour vérifier tout de suite. Quand une version est prête, le bouton **Redémarrer pour mettre à jour** y apparaît aussi.
- Bandeau jaune **« le serveur tourne une ancienne version »** : clique **Redémarrer le serveur** ; les fonctions récentes (dépôt d'images, verrouillage…) en dépendent.

<a id="raccourcis"></a><a id="raccourcis-ctrlalt"></a><a id="raccourcis-ctrlalt--sur-mac--ctrloption"></a>
## 18. Raccourcis clavier

| Raccourci | Action |
|---|---|
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> | palette de commandes |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>,</kbd> | réglages |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Maj</kbd>+<kbd>F</kbd> | rechercher dans toutes les sessions |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>N</kbd> | nouvelle session |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>H</kbd> | historique |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>1</kbd>…<kbd>9</kbd> / <kbd>↑</kbd> <kbd>↓</kbd> | changer de session (touche physique : marche en AZERTY) |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>←</kbd> <kbd>→</kbd> | changer de panneau (vue partagée) |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>A</kbd> | prochaine session qui attend une réponse |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd> | panneau Modifications |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>E</kbd> | ouvrir le dossier dans l'éditeur |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Q</kbd> | file d'attente de la session |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>B</kbd> | envoyer à plusieurs sessions |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>L</kbd> | verrouiller la session |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd> | mode focus |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd> / <kbd>W</kbd> | renommer / fermer la session |

Sur Mac, <kbd>Ctrl</kbd>+<kbd>Alt</kbd> = <kbd>Ctrl</kbd>+<kbd>Option</kbd>. Dans le terminal — Windows : <kbd>Ctrl</kbd>+<kbd>C</kbd> avec sélection copie, <kbd>Ctrl</kbd>+<kbd>V</kbd> colle, <kbd>Ctrl</kbd>+<kbd>+</kbd>/<kbd>−</kbd>/<kbd>0</kbd> zoome. macOS : <kbd>⌘</kbd>+<kbd>C</kbd>/<kbd>V</kbd>/<kbd>+</kbd>/<kbd>−</kbd>/<kbd>0</kbd> ; <kbd>Ctrl</kbd>+<kbd>C</kbd> et <kbd>Ctrl</kbd>+<kbd>V</kbd> restent à Claude.

## 19. Données, sécurité, confidentialité

- **Tout reste sur ta machine.** Le serveur de l'app écoute uniquement sur `127.0.0.1` (inaccessible depuis le réseau), exige un jeton aléatoire et vérifie l'en-tête Host. Aucune télémétrie : seules tes sessions Claude Code parlent à l'API d'Anthropic, comme d'habitude. Seule exception, si tu l'actives : la synchronisation (§ 16 bis) envoie la liste des sessions (noms, dossiers, groupes, options) et, sauf si tu le désactives, leurs conversations chiffrées de bout en bout, au serveur de synchro (celui du projet ou le tien). [Politique de confidentialité](https://vantaflow.github.io/claude-sessions-manager/privacy.html).
- **Fenêtre isolée** : pas d'accès système depuis la page, navigation limitée au serveur local, liens externes ouverts dans ton navigateur, permissions limitées aux notifications et au presse-papiers, aucun script extérieur (CSP).
- **Données de l'app** : `%APPDATA%\claude-sessions` (Windows), `~/Library/Application Support/claude-sessions` (macOS) — sessions, réglages, modèles, prompts, demandes programmées, jeton, journal, copies et journal de la synchro de `~/.claude`. Désinstaller l'app ne les supprime pas.
- **Mémoire des sessions** : `memory/` dans les données de l'app (§ 16 ter). Elle reste locale, sauf si la synchro et son option *Mémoire des sessions* sont actives ; elle est alors envoyée chiffrée.
- **Conversations** : ce sont celles de Claude Code, dans `~/.claude/projects` ; l'app les lit (historique, consommation, export) et n'y écrit que le nom d'une session renommée, ou la conversation reçue d'une autre machine quand la synchro est active (envoyée chiffrée, voir § 16 bis).

## 20. Dépannage

| Problème | Solution |
|---|---|
| Glisser une image affiche « Échec : route », ou une fonction récente n'apparaît pas | le serveur tourne un ancien code : bandeau jaune **Redémarrer le serveur** (ou menu de l'icône › Redémarrer le serveur). Les sessions reviennent. |
| Terminaux qui se figent par moments | chaque blocage de plus d'une seconde est noté dans `server.log` (dossier des données de l'app, ligne « lenteur », avec la mémoire utilisée). Une conversation très longue (plusieurs dizaines de Mo) alourdit sa session : `/compact` ou une nouvelle session. |
| « Claude Code introuvable » / la session s'arrête aussitôt | vérifier `claude --version` dans un terminal ; Réglages › Diagnostic indique le chemin utilisé. Sur Mac : lancer une fois `open -a "Claude Sessions"` depuis le Terminal. |
| Worktrees / Modifications indisponibles | `git` n'est pas installé (Diagnostic l'indique). |
| L'icône n'apparaît pas près de l'horloge (Windows 11) | elle est sous la flèche **^** ; glisse-la dans la zone visible. |
| macOS : l'app ne s'ouvre pas (« développeur non vérifié », « endommagée ») | Réglages Système › Confidentialité et sécurité › **Ouvrir quand même** ; ou `xattr -cr "/Applications/Claude Sessions.app"` puis relancer. |
| « Your login expires in N days » / « Please run /login » | bandeau 🔑 **Renouveler** (§ 14 ter) : le navigateur s'ouvre sur la page de connexion de Claude. |
| Mot de passe de verrouillage oublié | non récupérable : fermer la session ; la conversation reste dans les fichiers de Claude Code. |
| Autre souci | Réglages › Diagnostic › **Copier le rapport**, puis [ouvrir une issue](https://github.com/vantaflow/claude-sessions-manager/issues). |

<a id="installation-en-ligne-de-commande-sans-application"></a><a id="commandes"></a><a id="options"></a>
## 21. Ligne de commande `csm` (sans l'application)

Pour utiliser Claude Sessions dans un navigateur, sans l'application de bureau (prérequis : [Node.js](https://nodejs.org) 18+) :

```sh
git clone https://github.com/vantaflow/claude-sessions-manager.git ~/claude-sessions-manager
cd ~/claude-sessions-manager
npm ci && npm install -g .   # commande « csm »
csm install                  # démarrage automatique + raccourci (tâche planifiée / LaunchAgent)
csm                          # ouvre la fenêtre
```

Autres commandes : `csm stop` (les sessions reviendront au prochain démarrage), `csm restart`, `csm status`, `csm log`, `csm where`, `csm uninstall`. Mise à jour : `git pull && npm ci && csm restart`. Variables : `CSM_PORT` (défaut 7890 ; un autre port = instance séparée avec ses propres données), `CSM_DATA`, `CSM_CLAUDE`.

> `npm install -g github:…` n'est pas fiable sous Windows (bug npm avec node-pty) : passer par le clone.

<a id="développement"></a>
## 22. Développement

```sh
npm ci
npm test            # serveur de bout en bout (faux claude, profil temporaire, aucun appel API)
npm run test:app    # application Electron (Playwright, fenêtre invisible)
npm run app         # lancer l'app en développement (CSM_PORT=7891 pour une instance séparée)
npm run dist:win    # installeur Windows → dist/   (npm run dist:mac sur un Mac)
cd sync-worker && npm install && npm test   # Worker de synchro (wrangler dev local)
```

Architecture : `server.js` (serveur local, un pseudo-terminal node-pty par session, hooks Claude Code pour l'état) + modules `lib/` (git, verrouillage, réglages, consommation, outils, file d'attente et quota, demandes programmées, mémoire, synchro) ; interface `public/` (xterm.js) ; application `electron/`. Un tag `v*` lance les tests puis construit et publie les installeurs Windows et macOS (`.github/workflows/release.yml`) ; le Worker est testé à chaque modification et déployé au tag (`.github/workflows/worker.yml`).

## Licence

[MIT](LICENSE) — logiciel libre. Projet indépendant, non affilié à Anthropic ; « Claude » et « Claude Code » sont des marques d'Anthropic.

## Code signing policy

Windows builds are intended to be signed through the [SignPath Foundation](https://signpath.org) free code signing program for open-source projects (application pending).

- Builds are produced only by the public GitHub Actions workflow [`.github/workflows/release.yml`](.github/workflows/release.yml) from tagged commits of this repository; no locally built binary is ever signed.
- Committers and reviewers: [@vantaflow](https://github.com/vantaflow)
- Approvers (release signing): [@vantaflow](https://github.com/vantaflow)

## Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. Full policy: https://vantaflow.github.io/claude-sessions-manager/privacy.html

Claude Sessions runs a server bound to `127.0.0.1` only (not reachable from the network) and stores its data locally (`%APPDATA%\claude-sessions`, `~/Library/Application Support/claude-sessions`). It collects no telemetry. Network traffic comes only from the Claude Code sessions the user starts, which talk to Anthropic's API as Claude Code normally does.
