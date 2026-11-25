# Parité des interfaces natives avec l'app Electron

À mettre à jour dans le même commit que tout changement de `public/` (voir `README.md`).
✅ fait · 🟡 partiel · ⬜ à faire · 🌐 reste web exprès

| Fonction (interface web) | Fichier web | Windows | macOS |
|---|---|---|---|
| Connexion au serveur (lancé ou à lancer), jeton, WebSocket | app.js | ✅ | ⬜ |
| Liste des sessions, état en direct (point de couleur, message) | app.js | ✅ | ⬜ |
| Groupes et sous-groupes, épinglées | app.js | ✅ | ⬜ |
| Recherche dans la liste (Ctrl+K) | app.js | ✅ | ⬜ |
| Terminal d'une session (sortie, saisie, redimensionnement, contenu d'avant) | app.js | ✅ | ⬜ |
| Session affichée signalée (`shown` : veille, réveil) | app.js | ✅ | ⬜ |
| Nouvelle session (dossier, nom, groupe, modèle, mode, premier prompt) | newsession | ✅ | ⬜ |
| Nouvelle session : worktree, modèle de session, arguments | newsession | ⬜ | ⬜ |
| Relancer / Reprendre, Pause, Arrêter, Fermer (partout) | app.js | ✅ | ⬜ |
| Renommer | app.js | ✅ | ⬜ |
| Menu clic droit (veille, ne jamais mettre en veille, épingler, groupe, Remote Control, couper les alertes) | app.js | ✅ | ⬜ |
| Fermer une session de worktree (garder, fusionner, supprimer) | app.js | ⬜ | ⬜ |
| Notifications système (attend ta réponse, terminé) | attention.js | ✅ | ⬜ |
| Icône de la zone de notification, réduire, quitter | electron/main.js | 🟡 | ⬜ |
| Barre d'état des quotas (5 h, 7 jours) | sidestatus.js | ✅ | ⬜ |
| Dispositions 2 et 4 panneaux | app.js | ⬜ | ⬜ |
| Palette de commandes (Ctrl+K) | palette.js | ⬜ | ⬜ |
| Envoi groupé à plusieurs panneaux | app.js | ⬜ | ⬜ |
| File d'attente, plafond de quota | app.js, quotastop.js | ⬜ | ⬜ |
| Historique des conversations (reprendre, renommer, exporter) | app.js, panel.js | ⬜ | ⬜ |
| Mes prompts, bibliothèque, modèles de session | app.js, settings.js | ⬜ | ⬜ |
| Panneau Modifications (git : diff, commit, fusion) | panel.js | ⬜ | ⬜ |
| Joindre un fichier, image collée | app.js | ⬜ | ⬜ |
| Coffre | vault.js | ⬜ | ⬜ |
| Mémoire (recherche, fiches, mémoire IA) | settings.js | ⬜ | ⬜ |
| Réglages (14 onglets) | settings.js | ⬜ | ⬜ |
| Synchronisation (code, machines, ce qui est partagé) | settings.js | ⬜ | ⬜ |
| Verrou par mot de passe | lock.js | ⬜ | ⬜ |
| Skills et plugins | skills.js | ⬜ | ⬜ |
| Tableau d'usage | dashboard.js | ⬜ | ⬜ |
| Transfert de fichiers entre machines | transfer.js | ⬜ | ⬜ |
| Connexion Claude (/login) | auth.js | ⬜ | ⬜ |
| Mises à jour de l'app | electron | ⬜ | ⬜ |
| Pilotage à distance d'une autre machine | remote.js, pilot-bar.js | 🌐 | 🌐 |
| Vues HTML des extensions | extensions.js | 🌐 | 🌐 |
| Version téléphone | mobile.js | 🌐 | 🌐 |
