'use strict';
// Clé publique (ed25519, SPKI DER en base64) qui vérifie les mises à jour : la compilation signe latest*.yml (qui
// contient l'empreinte de chaque installeur) avec la clé privée correspondante (secret UPDATE_SIGNING_KEY du dépôt,
// copie dans le trousseau du Mac : service « csm-update-signing-key »). Une version publiée sans cette signature,
// ou avec une autre clé, n'est jamais installée.
module.exports = 'MCowBQYDK2VwAyEA1viF4qWpXWVcM0gRvQE213W8RqOwGW6+n8TOEChYi0c=';
