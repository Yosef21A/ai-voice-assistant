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

// ── Arabizi (Arabic in Latin letters, F2) ────────────────────────────────────
// Two signals: a lexicon of common Tunisian/Libyan chat words, and the
// letters-as-digits convention (3=ع, 7=ح, 9=ق, 5=خ, 2=ء) INSIDE a word.
const ARABIZI_WORDS = new Set([
  'aslema', 'aslama', '3aslema', 'salam', 'salem', 'slm', 'mar7ba', 'mar7aba', 'marahba',
  'sba7', 'sbah', 'labes', 'lebes', 'chneya', 'chnowa', 'chnia', 'chkoun', 'kifach', 'kifech',
  '9adech', '9addech', 'kadesh', 'chhal', 'ch7al', 'na7eb', 'n7eb', 'nheb', 'nhebb',
  'na7jez', 'n7jez', 'nahjez', '7ajz', 'hjez', 'maw3ed', 'maw3ad', 'mawid', 'mou3id',
  'tbib', 'doktor', 'doctour', '3iyada', 'behi', 'bahi', 'barcha', 'barsha', 'yezzi',
  'sa7a', 'sahha', 'ya3tik', 'wa9tach', 'waktach', 'win', 'wen', 'famma', 'fama',
  'mawjoud', 'njem', 'najem', 'momken', 'mumken', '3andi', '3andek', '3andkom',
  'bech', 'besh', 'inchallah', 'nchalla', '3la', 'mte3', 'mta3',
]);
const ARABIZI_TOKEN_RE = /[a-z][23579][a-z]|^[23579][a-z]{3,}$/;

/** True when the text reads as Arabic written in Latin letters. */
export function isArabizi(text = '') {
  if (ARABIC_RE.test(text)) return false; // real Arabic script wins
  const toks = String(text)
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter(Boolean);
  let hits = 0;
  for (const w of toks) {
    if (ARABIZI_WORDS.has(w)) hits += 2;
    else if (/[a-z]/.test(w) && ARABIZI_TOKEN_RE.test(w)) hits += 1;
  }
  return hits >= 2;
}

/**
 * @param {string} text
 * @returns {'ar'|'fr'|'en'|null}
 */
export function detectLanguage(text = '') {
  if (ARABIC_RE.test(text)) return 'ar';
  // Arabizi replies in Arabic script (P2-HUMANIZE §2.1): route to 'ar'.
  if (isArabizi(text)) return 'ar';

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
