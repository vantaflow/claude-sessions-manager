'use strict';
// Texte copié depuis le terminal. Claude Code coupe lui-même ses lignes à la largeur du terminal (vrais retours à la
// ligne, suite décalée de deux espaces) : copié tel quel, un paragraphe arrive haché, indenté, avec des espaces en fin
// de ligne. Ici : espaces de fin retirés, lignes coupées par le retour automatique recollées (la ligne remplit presque
// toute la largeur et le premier mot de la suivante n'y tenait pas), indentation commune retirée.
(function (root) {
  function tidyCopy(text, cols) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[ \t ]+$/, ''));
    if (lines.length < 2) return lines.join('\n');
    // indentation commune des lignes suivantes (la première commence souvent au milieu d'une ligne, sans retrait)
    const ind = l => l.match(/^ */)[0].length;
    const rest = lines.slice(1).filter(l => l.trim());
    const common = rest.length ? Math.min(...rest.map(ind)) : 0;
    const out = [lines[0].slice(Math.min(common, ind(lines[0])))]; // sélection commencée en début de ligne : même retrait
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1], line = lines[i], body = line.trimStart(); // prev : la ligne affichée, avant recollage
      const word = (body.match(/^\S+/) || [''])[0];
      // retour automatique : ligne précédente pleine (à 3 colonnes près) et suite indentée au moins autant que le texte
      const wrapped = cols > 20 && prev.trim() && body && prev.length + 1 + word.length > cols - 3
        && ind(line) >= common && !/^([-*+•●⎿│|]|\d+[.)])\s/.test(body);
      if (wrapped) out[out.length - 1] += ' ' + body;
      else out.push(line.slice(Math.min(common, ind(line))));
    }
    return out.join('\n');
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { tidyCopy };
  else root.tidyCopy = tidyCopy;
})(typeof window !== 'undefined' ? window : globalThis);
