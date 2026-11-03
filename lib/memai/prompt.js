'use strict';
// Mémoire IA : consigne donnée à Haiku, schéma de sa réponse (--json-schema) et validation de ce qu'il renvoie.
// Une sortie douteuse (état qui est un message d'erreur, titre vide, hors schéma) est refusée : rien n'est écrit,
// l'analyse compte comme un échec et sera refaite.
const PROMPT_VERSION = 1;
const TYPES = ['decision', 'fix', 'discovery', 'change', 'todo', 'preference'];
const MAX_OBS = 15;

const str = (d, max) => ({ type: 'string', description: d, maxLength: max });
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'observations'],
  properties: {
    summary: {
      type: 'object', additionalProperties: false, required: ['title', 'request', 'state', 'next'],
      properties: {
        title: str('Nom clair du sujet de la session (pas le début de la demande)', 120),
        request: str('Ce que l’utilisateur demandait, en une à trois phrases', 600),
        state: str('Où on en est réellement à la fin (fait, en cours, bloqué et pourquoi)', 800),
        next: str('Prochaine étape concrète, ou « rien »', 400),
      },
    },
    observations: {
      type: 'array', maxItems: MAX_OBS,
      items: {
        type: 'object', additionalProperties: false, required: ['type', 'title', 'body', 'keywords'],
        properties: {
          type: { type: 'string', enum: TYPES },
          title: str('Titre court', 80),
          body: str('Deux à cinq phrases : ce qui a été compris, et pourquoi', 800),
          files: { type: 'array', items: { type: 'string' }, maxItems: 20 },
          keywords: { type: 'array', items: { type: 'string' }, maxItems: 12, description: 'Mots-clés en français et en anglais' },
        },
      },
    },
  },
};

function buildPrompt({ text, previous, project, part = 1, parts = 1 }) {
  return [
    'Tu tiens la mémoire de travail d’un développeur qui utilise Claude Code. Voici le déroulé d’une de ses sessions'
      + (project ? ` (dossier ${project})` : '') + (parts > 1 ? `, morceau ${part} sur ${parts}` : '') + '.',
    'Écris en français un résumé fidèle de la session et des observations utiles pour les sessions suivantes.',
    '',
    'Consignes :',
    '- title : le sujet de la session en quelques mots clairs, jamais le simple début de la première demande.',
    '- state : où on en est réellement à la fin. Si la session s’est arrêtée sur une erreur, dis-le en clair '
      + '(« arrêtée sur une erreur de l’API pendant… »), sans recopier le message d’erreur.',
    '- next : la prochaine étape concrète, ou « rien » si le travail est fini.',
    '- observations (0 à 15) : décisions et leur raison, corrections et leur cause, découvertes sur le code ou '
      + 'l’environnement, changements faits, choses à faire, préférences de l’utilisateur. Le pourquoi compris, '
      + 'pas la recopie des messages. Mots-clés en français et en anglais pour la recherche.',
    '- N’invente rien : ce qui n’est pas dans le déroulé n’existe pas. Une session sans contenu utile donne 0 observation.',
    ...(previous ? ['', 'Résumé déjà écrit pour le début de cette session : mets-le à jour avec la suite ci-dessous '
      + '(garde ce qui reste vrai, remplace ce qui a changé) :', JSON.stringify(previous)] : []),
    '', '--- Déroulé ---', text,
  ].join('\n');
}

const one = (s, n) => { s = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''; return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const BAD_STATE = /^(API Error|Error:|\[?Request interrupted|\{|\[)/i;

function clean(out) {
  const s = out && typeof out === 'object' && out.summary;
  if (!s || typeof s !== 'object') return null;
  const summary = { title: one(s.title, 120), request: one(s.request, 600), state: one(s.state, 800), next: one(s.next, 400) || 'rien' };
  if (summary.title.length < 3 || summary.state.length < 3 || BAD_STATE.test(summary.state) || BAD_STATE.test(summary.title)) return null;
  const observations = (Array.isArray(out.observations) ? out.observations : [])
    .filter(o => o && TYPES.includes(o.type) && one(o.title, 80))
    .slice(0, MAX_OBS)
    .map(o => ({
      type: o.type, title: one(o.title, 80), body: one(o.body, 800),
      files: (Array.isArray(o.files) ? o.files : []).filter(f => typeof f === 'string' && f).slice(0, 20).map(f => f.slice(0, 300)),
      keywords: [...new Set((Array.isArray(o.keywords) ? o.keywords : []).filter(k => typeof k === 'string').map(k => one(k, 40).toLowerCase()).filter(Boolean))].slice(0, 12),
    }));
  return { summary, observations };
}

module.exports = { SCHEMA, PROMPT_VERSION, TYPES, buildPrompt, clean };
