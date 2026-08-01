// WHICH ALPHABET IS THIS? — the ears' honesty check, and the model's leash.
//
// THE CALL THAT PRODUCED THIS FILE (2026-08-01, 101 s, the founder's first live
// cascade call). The transcriber hallucinated: the caller spoke Tunisian derja
// into a noisy line and the finals came back as Mongolian Cyrillic
// («ийм шийд хэд за это»). Those finals were handed to the LLM as if they were
// speech, the LLM obligingly answered IN MONGOLIAN («Мэнд байна…»), and a
// Tunisian patient heard a stranger's language from their clinic's phone line.
//
// Prompting cannot fix this, and it is important to be precise about why:
//   • the EARS were wrong, not the brain — no instruction to a text model can
//     repair a transcript that never contained the caller's words;
//   • and a model told "always answer in Arabic" still follows the transcript
//     it is shown, because a transcript looks exactly like evidence.
// So the fix is a predicate, in code, on both sides of the model: garbage in is
// refused before it becomes a turn, and garbage out is discarded before it
// reaches a mouth. The prompt (see ./prompt.js, LANGUAGE LOCK) is a cost and
// courtesy optimization on top of that, never the control.
//
// WHAT COUNTS AS WHAT. Three buckets, and the third is the only one that ever
// triggers anything:
//   • ARABIC — the Arabic script, including its diacritics and its presentation
//     forms. Derja is written in it, and so is MSA.
//   • LATIN — French, English, and arabizi (Arabic typed in Latin letters,
//     which the emergency detector already understands).
//   • OTHER — every other writing system on earth: Cyrillic, Han, Kana, Hangul,
//     Devanagari, Hebrew, Greek, Thai… On this product's phone line, in this
//     corridor, a majority-OTHER string is not a caller: it is a machine that
//     guessed.
// Digits, punctuation, symbols, emoji, whitespace and combining marks are
// NEUTRAL — they belong to whatever surrounds them and must never cast a vote.
// (A combining mark is deliberately neutral rather than "other": Latin
// diacritics decompose to Script=Inherited, and counting those as a foreign
// alphabet would make "café" look Mongolian.)
//
// Nothing here throws, allocates per character, or reaches outside its argument.

/** Combining marks belong to their base character, not to a script of their own. */
const MARK_RE = /\p{M}/u;
/** Everything that is not a letter: digits, punctuation, symbols, spaces, controls. */
const NEUTRAL_RE = /[\p{N}\p{P}\p{S}\p{Z}\p{C}]/u;
const ARABIC_RE = /\p{Script=Arabic}/u;
const LATIN_RE = /\p{Script=Latin}/u;
const LETTER_RE = /\p{L}/u;

/**
 * How many characters of each bucket a string carries.
 * @param {string} text
 * @returns {{arabic:number, latin:number, other:number, neutral:number, letters:number}}
 */
export function scriptProfile(text) {
  const out = { arabic: 0, latin: 0, other: 0, neutral: 0, letters: 0 };
  const s = String(text ?? '');
  for (const ch of s) {
    if (MARK_RE.test(ch) || NEUTRAL_RE.test(ch)) {
      out.neutral += 1;
      continue;
    }
    if (ARABIC_RE.test(ch)) out.arabic += 1;
    else if (LATIN_RE.test(ch)) out.latin += 1;
    else if (LETTER_RE.test(ch)) out.other += 1;
    else out.neutral += 1;
  }
  out.letters = out.arabic + out.latin + out.other;
  return out;
}

/**
 * The bucket that owns this string.
 * @returns {'arabic'|'latin'|'other'|'none'} 'none' ⇒ no letters at all
 *   (digits, punctuation, silence) — a caller who said nothing sayable.
 */
export function majorityScript(text) {
  const p = scriptProfile(text);
  if (!p.letters) return 'none';
  if (p.other > p.arabic && p.other > p.latin) return 'other';
  return p.arabic >= p.latin ? 'arabic' : 'latin';
}

/**
 * IS THIS A TRANSCRIPTION HALLUCINATION (or a model that wandered off)?
 *
 * True when the string is MAJORITY a writing system this product does not
 * speak. The floor exists so one stray character cannot condemn a sentence: a
 * derja final containing a single Cyrillic glyph is a noisy final, not a
 * hallucinated one, and treating it as one would make the agent apologize to a
 * caller who was perfectly audible.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.minOther] characters of a foreign script required
 *   before this can fire at all. Default 2.
 * @returns {boolean}
 */
export function isAlienScript(text, { minOther = 2 } = {}) {
  const p = scriptProfile(text);
  if (p.other < minOther) return false;
  return p.other > p.arabic + p.latin;
}

/** Human-readable, for one log line per rejection. */
export function describeScript(text) {
  const p = scriptProfile(text);
  return `arabic=${p.arabic} latin=${p.latin} other=${p.other}`;
}

export default isAlienScript;
