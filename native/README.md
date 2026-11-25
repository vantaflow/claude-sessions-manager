# CSM natif (Windows, puis macOS)

Interfaces natives de Claude Sessions Manager, sans page web, **à côté** de l'app Electron qui reste la version de
référence.

## Principe : un seul serveur, plusieurs interfaces

```
              ┌──────────────── serveur CSM (server.js + lib/, Node) ────────────────┐
              │ sessions et terminaux (node-pty), synchro, mémoire, coffre, veille,  │
              │ file d'attente, quotas, pilotage, extensions…                        │
              └──────────────▲────────────────────▲────────────────────▲──────────┘
                    HTTP /api + WebSocket /ws (jeton DATA/token, Host 127.0.0.1:PORT)
              ┌──────────────┴───┐      ┌─────────┴────────┐      ┌────────┴─────────┐
              │ app Electron     │      │ CSM natif Windows │      │ CSM natif macOS  │
              │ (public/, web)   │      │ WPF + Windows     │      │ SwiftUI +        │
              │                  │      │ Terminal (.NET)   │      │ SwiftTerm        │
              └──────────────────┘      └──────────────────┘      └──────────────────┘
```

- **Tout le fonctionnement reste dans le serveur.** Une app native n'est qu'un affichage : elle ne garde aucune
  donnée et ne réimplémente aucune règle (veille, synchro, Fermer partout…). Elle lit et écrit par la même API que
  l'interface web. Résultat : une session, un réglage ou un secret change de la même façon quelle que soit
  l'interface, et la synchro entre machines reste exactement celle d'aujourd'hui.
- **Même dépôt, même version.** Les apps natives sont construites depuis ce dépôt et publiées avec le même tag
  `v*` que l'app Electron, avec le serveur de cette version. Une version native ne parle jamais à un serveur d'une
  autre version (vérifié au démarrage par `GET /api/version`, à brancher).
- **Les deux interfaces peuvent tourner ensemble** sur la même machine : elles se branchent sur le même serveur
  (port 7890 par défaut) et voient les mêmes sessions en direct.

## Rester synchronisé avec la version Electron

1. Toute fonction nouvelle ou modifiée **côté serveur** profite aux deux sans rien faire.
2. Toute fonction nouvelle ou modifiée **dans l'interface web** (`public/`) est inscrite dans
   [`PARITY.md`](PARITY.md) dans le même commit : ✅ fait en natif, 🟡 partiel, ⬜ à faire, 🌐 reste web exprès.
3. Une version qui touche l'interface web liste dans son CHANGELOG ce qui reste à porter en natif.
4. Les textes viennent des mêmes sources : français dans le code, anglais par `public/i18n.js` (à partager avec
   les apps natives, phase 2).

## Windows (`native/windows`)

- WPF sur .NET 10, terminal = moteur de Windows Terminal (`CI.Microsoft.Terminal.Wpf`, paquet Microsoft), branché
  sur le WebSocket du serveur par `SessionConnection` (interface `ITerminalConnection`).
- Serveur : celui déjà lancé (app Electron, tâche planifiée, autre fenêtre), sinon le **serveur embarqué** dans l'exécutable : `native/windows/pack-server.ps1` met dans `out/server.zip` node.exe, le code du serveur de la même version et ses modules de production (node-pty est en N-API : son binaire marche avec ce Node). L'app l'extrait une fois dans `%LOCALAPPDATA%\claude-sessions-native\server\<version>` et le lance sans fenêtre (`CsmServer.StartServer`). L'app Electron n'est donc pas nécessaire ; si elle est installée, les deux se branchent sur le même serveur. Même moteur, même Worker Cloudflare pour la synchro : rien n'est réécrit.
- Compiler : `dotnet build native/windows/CsmNative -c Release -p:Platform=x64` (NuGet : `native/windows/nuget.config`,
  nuget.org seulement).

- Mises à jour : la release publie `latest-native-windows.json` (version, fichier, SHA-256) signé en ed25519 avec la clé des mises à jour de CSM (`electron/update-key.js`). L'app native n'installe qu'un exécutable dont l'empreinte correspond à un manifeste correctement signé (`Updater.cs`, vérifiable avec `CSM.exe --verify <fichier> <fichier.sig>`).
- Vérifications : `CSM.exe --selftest` (dialogue avec un serveur de test) et `CSM.exe --snapshot <dossier>` (captures des écrans, hors de l'écran).

## macOS (`native/macos`, phase suivante)

SwiftUI + SwiftTerm (`TerminalView`, alimenté par le même WebSocket), compilé sur GitHub Actions (runner macOS).
