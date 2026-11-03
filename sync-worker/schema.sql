-- Une ligne par session synchronisée. Les conversations (csm_transcripts, morceaux dans R2) arrivent
-- chiffrées par l'app : le serveur ne peut pas les lire.
-- space = empreinte SHA-256 du code de synchro : chaque code est un espace isolé.
CREATE TABLE IF NOT EXISTS csm_sessions (
  space     TEXT NOT NULL,
  uid       TEXT NOT NULL,      -- syncId, identique sur toutes les machines
  data      TEXT NOT NULL,      -- JSON : nom, dossier portable, modèle, groupe, couleur…
  updatedAt INTEGER NOT NULL,   -- horloge de la machine qui a modifié (last-write-wins)
  deleted   INTEGER NOT NULL DEFAULT 0,
  origin    TEXT NOT NULL DEFAULT '',
  rev       INTEGER NOT NULL,   -- compteur du serveur : curseur de pull indépendant des horloges
  PRIMARY KEY (space, uid)
);
CREATE INDEX IF NOT EXISTS csm_sessions_rev ON csm_sessions(space, rev);

-- Espaces créés par POST /spaces : empreinte de la clé d'accès (ou du code, avant la 3.8) ; ipHash limite les créations.
CREATE TABLE IF NOT EXISTS csm_spaces (
  space     TEXT PRIMARY KEY,
  createdAt INTEGER NOT NULL,
  ipHash    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS csm_spaces_created ON csm_spaces(createdAt);

-- Conversation en vigueur de chaque session : version (HMAC du contenu, calculé par l'app) et nombre de morceaux.
CREATE TABLE IF NOT EXISTS csm_transcripts (
  space     TEXT NOT NULL,
  uid       TEXT NOT NULL,      -- syncId de la session
  cid       TEXT NOT NULL,      -- identifiant de la conversation Claude Code
  ver       TEXT NOT NULL,
  chunks    INTEGER NOT NULL,
  size      INTEGER NOT NULL,   -- octets chiffrés
  updatedAt INTEGER NOT NULL,   -- date de modification du transcript sur la machine qui l'a envoyé
  origin    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (space, uid)
);

-- Morceaux chiffrés (1 Mo au plus) : le contenu est dans R2 (clé <space>/<uid>/<ver>/<n>) ; ici, seulement
-- leur liste (pour vérifier qu'une version est complète et effacer les anciennes) et leur taille.
CREATE TABLE IF NOT EXISTS csm_parts (
  space TEXT NOT NULL,
  uid   TEXT NOT NULL,
  ver   TEXT NOT NULL,
  n     INTEGER NOT NULL,
  size  INTEGER NOT NULL,
  at    INTEGER NOT NULL,       -- date d'envoi : les morceaux jamais validés sont effacés après une heure
  ok    INTEGER NOT NULL DEFAULT 0, -- 1 = version validée (PUT /transcripts/<uid>), 0 = en attente
  PRIMARY KEY (space, uid, ver, n)
);
CREATE INDEX IF NOT EXISTS csm_parts_at ON csm_parts(at);
CREATE INDEX IF NOT EXISTS csm_parts_pending ON csm_parts(space, ok);

-- Place occupée par espace (octets de tous les morceaux présents), tenue à jour à chaque morceau reçu :
-- évite de relire toutes les lignes pour vérifier les limites.
CREATE TABLE IF NOT EXISTS csm_usage (
  space TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL DEFAULT 0
);

-- Clés d'accès rattachées à un espace créé avant la 3.8 (POST /spaces/link) : empreinte -> espace.
CREATE TABLE IF NOT EXISTS csm_auth (
  auth  TEXT PRIMARY KEY,
  space TEXT NOT NULL
);

-- 3.64 : accès web au pilotage à distance (lien personnel + mot de passe). Le serveur ne garde que l'empreinte de
-- la preuve tirée du mot de passe et l'enveloppe chiffrée de la clé web (illisible sans le mot de passe).
CREATE TABLE IF NOT EXISTS csm_web (
  w         TEXT PRIMARY KEY,   -- identifiant du lien (aléatoire, pas l'espace)
  space     TEXT NOT NULL,
  dev       TEXT NOT NULL,      -- machine pilotée
  salt      TEXT NOT NULL,
  iter      INTEGER NOT NULL,
  verifier  TEXT NOT NULL,      -- SHA-256 de la preuve
  envelope  TEXT NOT NULL,
  fails     INTEGER NOT NULL DEFAULT 0,
  failAt    INTEGER NOT NULL DEFAULT 0,
  gen       INTEGER NOT NULL DEFAULT 1,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS csm_web_space ON csm_web(space);
