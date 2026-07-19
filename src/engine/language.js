// Language detection via script + keyword heuristics. Returns 'ar' | 'fr' | 'en'
// or null when the text is too ambiguous to decide (e.g. a bare name or phone
// number) — in that case the engine keeps the conversation's previous language.
const ARABIC_RE = /[؀-ۿ]/;
const FR_CHARS_RE = /[àâäéèêëîïôöùûüÿçœ]/i;

const FR_HINTS = new Set([
  'bonjour', 'salut', 'bonsoir', 'coucou', 'merci', 'oui', 'non', 'je', 'jai',
  'voudrais', 'veux', 'rendez', 'vous', 'prix', 'tarif', 'combien', 'cout',
  'vol', 'hotel', 'hôtel', 'medecin', 'docteur', 'chirurgie', 'esthetique',
  'svp', 'sil', 'plait', 'pouvez', 'quand', 'ou', 'comment', 'numero', 'viens',
  'appelle', 'reserver', 'consultation', 'sante', 'clinique', 'demain',
]);
const EN_HINTS = new Set([
  'hello', 'hi', 'hey', 'please', 'appointment', 'book', 'booking', 'price',
  'cost', 'how', 'much', 'thanks', 'thank', 'yes', 'no', 'doctor', 'surgery',
  'flight', 'hotel', 'when', 'where', 'name', 'from', 'want', 'would', 'like',
  'the', 'clinic', 'tomorrow', 'my',
]);

function tokens(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-zàâäéèêëîïôöùûüÿçœ']+/i)
    .filter(Boolean);
}

/**
 * @param {string} text
 * @returns {'ar'|'fr'|'en'|null}
 */
export function detectLanguage(text = '') {
  if (ARABIC_RE.test(text)) return 'ar';

  const t = String(text).toLowerCase();
  let fr = 0;
  let en = 0;
  if (FR_CHARS_RE.test(t)) fr += 2; // accented chars are a strong French signal

  const toks = tokens(text);
  for (const w of toks) {
    if (FR_HINTS.has(w)) fr += 1;
    if (EN_HINTS.has(w)) en += 1;
  }

  if (fr === 0 && en === 0) return null; // ambiguous
  return fr >= en ? 'fr' : 'en';
}

/**
 * Resolve the working language for a turn: fresh detection wins, else the
 * conversation's remembered language, else the clinic's primary language.
 */
export function resolveLanguage(detected, previous, clinic) {
  if (detected) return detected;
  if (previous) return previous;
  return clinic?.languages?.[0] || 'fr';
}
