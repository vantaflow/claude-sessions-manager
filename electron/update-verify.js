'use strict';
// Authenticité des mises à jour : latest*.yml (empreintes des installeurs) doit porter une signature ed25519 faite
// par la clé du projet (scripts/sign-update.js, clé publique dans update-key.js). Sans elle, l'empreinte du même
// fichier ne prouve que l'intégrité du téléchargement, pas son origine (release publiée avec un compte compromis).
const crypto = require('crypto');
const PUB = require('./update-key');

const publicKey = crypto.createPublicKey({ key: Buffer.from(PUB, 'base64'), format: 'der', type: 'spki' });

// texte de latest*.yml + contenu de latest*.yml.sig (base64) → vrai si signé par la clé du projet
function signedByProject(text, sigB64) {
  try {
    const sig = Buffer.from(String(sigB64 || '').trim(), 'base64');
    return sig.length === 64 && crypto.verify(null, Buffer.from(text), publicKey, sig);
  } catch { return false; }
}
// empreinte sha512 (base64) d'un fichier listé dans latest*.yml (« url: <nom> » puis « sha512: … »)
function sha512Of(yml, name) {
  const i = yml.indexOf(`url: ${name}`);
  const m = i >= 0 && /sha512:\s*(\S+)/.exec(yml.slice(i));
  return m ? m[1] : null;
}
module.exports = { signedByProject, sha512Of };
