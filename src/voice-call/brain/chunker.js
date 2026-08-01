// THE SENTENCE CHUNKER — where a stream of model text becomes things worth
// saying out loud. Extracted from brain/loop.js at V7-P1 so the incumbent Live
// loop and the new cascade orchestrator cut speech IDENTICALLY. Two
// implementations of this rule would drift, and the drift is audible: it is a
// wrong price read to a patient over the phone.
//
// It lives under brain/ rather than under brain-cascade/ on purpose — the
// dependency arrow in this tier points cascade → brain (the cascade already
// imports codec.js, tools.js, prompts.js and tts/ from here), and inverting it
// for one pure function would make the incumbent depend on the experiment.
//
// SENTENCE SPLITTING IS A MEDICAL-SAFETY SURFACE, NOT A FORMATTING DETAIL.
// A naive split on `.` turned "الفحص يبدا من 1.500 دينار للكشف." into two
// utterances — the caller heard a WRONG PRICE, in two pieces, from a medical
// clinic. Every rule below was paid for by a real broken utterance.
//
// Everything here is a PURE function over strings: no clock, no I/O, no state.

/**
 * What ends a spoken sentence. `؟` is the Arabic question mark and `।` the
 * danda — models reach for both when writing Arabic, and neither is in the
 * Latin set. A newline counts: models use them as hard breaks.
 */
export const SENTENCE_END = new Set(['.', '!', '?', '؟', '।', '…', '\n']);
/**
 * Below this, a "sentence" is an abbreviation or an initial, not a clause.
 * Synthesizing "د." on its own would cost a whole HTTP round trip to say
 * nothing, and would chop the sentence it belongs to in half.
 */
export const MIN_SENTENCE_CHARS = 12;
/**
 * A run-on with no terminator in sight gets spoken anyway at this length. A
 * model that forgets its punctuation must not translate into dead air.
 */
export const MAX_SENTENCE_CHARS = 240;
/**
 * Something has to be SAID for an utterance to be worth an HTTP request. A
 * piece of pure punctuation is not: it costs a round trip to say nothing, and —
 * proven in review — a provider error on that nothing would end the call.
 */
export const SPEAKABLE_RE = /[\p{L}\p{N}]/u;
export const LETTER_RE = /\p{L}/u;
/**
 * Words whose full stop does not end a sentence. Single LETTERS are handled
 * separately (any initial: "M.", "د.", the two dots of "a.m."), so this list is
 * only for the multi-letter ones.
 */
export const ABBREVIATIONS = new Set([
  'dr',
  'mr',
  'mrs',
  'ms',
  'mme',
  'mlle',
  'prof',
  'st',
  'ste',
  'no',
  'vs',
  'etc',
]);

/**
 * A '.' between two digits is a DECIMAL, not a full stop. Proven in review:
 * "الفحص يبدا من 1.500 دينار للكشف." was split into "…من 1." and "500 دينار
 * للكشف." — the caller heard a WRONG PRICE, in two pieces, from a medical
 * clinic. Same shape for "14.30" and "9.30".
 */
export function isDecimalDot(buf, i) {
  if (buf[i] !== '.') return false;
  return /\d/.test(buf[i - 1] || '') && /\d/.test(buf[i + 1] || '');
}

/**
 * "Dr. Amine" and "a.m." are one utterance, not two. Walk back over the
 * letters immediately before the dot: a SINGLE letter is an initial (M., د.,
 * and both dots of a.m.), and a known abbreviation is not a sentence end.
 */
export function isAbbreviationDot(buf, i) {
  if (buf[i] !== '.') return false;
  let k = i - 1;
  let word = '';
  while (k >= 0 && LETTER_RE.test(buf[k])) {
    word = buf[k] + word;
    k -= 1;
  }
  if (!word) return false;
  if (word.length === 1) return true;
  return ABBREVIATIONS.has(word.toLowerCase());
}

/** Runs of terminators ("...", "?!") are ONE terminator; returns its last index. */
export function terminatorRunEnd(buf, i) {
  let j = i;
  while (j + 1 < buf.length && SENTENCE_END.has(buf[j + 1])) j += 1;
  return j;
}

/**
 * Cut a growing model-text buffer into things worth saying.
 *
 * Speech has to start on the first CLAUSE, not at the end of the reply: a
 * provider round trip is ~200-600 ms and waiting for the whole paragraph stacks
 * that on top of the model's own generation time.
 *
 * FOUR RULES, every one of them paid for by a real broken utterance:
 *   1. A terminator only counts when WHITESPACE follows it (or the terminator
 *      itself is a newline). "1.500" and "www.x" are not two sentences.
 *   2. A terminator at the very END of the buffer WAITS. Mid-stream we cannot
 *      yet tell "1." from "1.500", or "Dr." from "Dr. Amine" — the next
 *      fragment decides, and the end-of-turn flush is the backstop. The cost
 *      is one text fragment of latency; the alternative is a wrong price.
 *   3. Decimals and abbreviations are never terminators (above).
 *   4. A piece with no letter or digit in it is never an utterance: it is
 *      glued onto whatever follows instead of becoming an HTTP request.
 * Plus the originals: shorter than MIN_SENTENCE_CHARS glues forward, and a
 * run-on past MAX_SENTENCE_CHARS is spoken anyway rather than held.
 *
 * @param {string} buffer  everything the model has written and we have not said
 * @returns {{pieces: string[], rest: string}} complete utterances, in order,
 *   plus whatever is left in the buffer (never null)
 */
export function takeSentences(buffer) {
  let sentenceBuf = String(buffer ?? '');
  const out = [];
  for (;;) {
    let cut = -1;
    for (let i = 0; i < sentenceBuf.length; i += 1) {
      if (!SENTENCE_END.has(sentenceBuf[i])) continue;
      if (isDecimalDot(sentenceBuf, i)) continue;
      if (isAbbreviationDot(sentenceBuf, i)) continue;
      const end = terminatorRunEnd(sentenceBuf, i);
      const after = sentenceBuf[end + 1];
      // Rule 2: nothing after it yet ⇒ we cannot know. Wait.
      if (after === undefined) break;
      // Rule 1: a newline IS the break; anything else needs whitespace after.
      const hardBreak = /\s/.test(sentenceBuf.slice(i, end + 1));
      if (!hardBreak && !/\s/.test(after)) {
        i = end; // skip the whole run, not just its first char
        continue;
      }
      const piece = sentenceBuf.slice(0, end + 1);
      if (piece.trim().length < MIN_SENTENCE_CHARS) {
        i = end;
        continue;
      }
      // Rule 4: nothing to say ⇒ glue it forward.
      if (!SPEAKABLE_RE.test(piece)) {
        i = end;
        continue;
      }
      cut = end + 1;
      break;
    }
    if (cut < 0) {
      if (sentenceBuf.length < MAX_SENTENCE_CHARS) break;
      // No terminator and too long to keep waiting: break at the last space
      // so we do not cut a word in half, and take the lot if there is none.
      const space = sentenceBuf.lastIndexOf(' ', MAX_SENTENCE_CHARS);
      cut = space > MIN_SENTENCE_CHARS ? space + 1 : MAX_SENTENCE_CHARS;
    }
    const piece = sentenceBuf.slice(0, cut);
    sentenceBuf = sentenceBuf.slice(cut);
    // The scan above already guarantees a speakable piece. The forced
    // MAX_SENTENCE_CHARS cut does not, and re-buffering it there would spin
    // forever — 240 characters of pure punctuation is a broken model, not an
    // utterance, so it is dropped.
    if (SPEAKABLE_RE.test(piece)) out.push(piece);
  }
  return { pieces: out, rest: sentenceBuf };
}

export default takeSentences;
