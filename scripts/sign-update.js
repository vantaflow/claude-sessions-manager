'use strict';
// Signe les fichiers de mise à jour (latest*.yml) : écrit <fichier>.sig (signature ed25519 en base64) à côté de
// chacun. Clé privée PEM dans UPDATE_SIGNING_KEY ; chaque signature est revérifiée avec la clé publique de l'app.
// Sans clé, échec : une release non signée ne serait jamais installée par les apps déjà à jour.
const fs = require('fs');
const crypto = require('crypto');
const PUB = require('../electron/update-key');

const pem = process.env.UPDATE_SIGNING_KEY;
if (!pem) { console.error('UPDATE_SIGNING_KEY absent : impossible de signer la mise à jour'); process.exit(1); }
const priv = crypto.createPrivateKey(pem);
const pub = crypto.createPublicKey({ key: Buffer.from(PUB, 'base64'), format: 'der', type: 'spki' });
const files = process.argv.slice(2);
if (!files.length) { console.error('aucun fichier à signer'); process.exit(1); }
for (const f of files) {
  const data = fs.readFileSync(f), sig = crypto.sign(null, data, priv);
  if (!crypto.verify(null, data, pub, sig)) { console.error(`${f} : la clé privée ne correspond pas à la clé publique de l'app`); process.exit(1); }
  fs.writeFileSync(`${f}.sig`, sig.toString('base64'));
  console.log(`signé : ${f}`);
}
