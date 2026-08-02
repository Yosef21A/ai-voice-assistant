// TURN-TAKING — the three predicates that decide whether a noise is a TURN.
//
// V8-D3, written after the founder's field calls. The orchestrator used to have
// exactly one rule for "the caller said something": any text at all. That rule
// produced three failures on a real Tunisian line, and each of the predicates
// here is one of them:
//
//  1. THE BACKCHANNEL. Derja conversation is dense with «أيوا», «تمام»,
//     «باهي», «مم» — a listener saying "go on", not a speaker taking the floor.
//     Treated as speech they interrupted the agent mid-sentence, over and over,
//     and every one of them cost a reply the caller had not asked for.
//  2. THE FRAGMENT. A streaming transcriber emits «نحب» or «ال» on its way to a
//     sentence. One word, ended by a pause, is a transcription artefact far
//     more often than it is a question — EXCEPT while the agent is collecting a
//     phone number or a day, where a one-token utterance is exactly the data it
//     asked for.
//  3. THE ASK. The agent knows when it has just asked for a name, a number or a
//     date, and that is when a caller pauses mid-answer. Nobody can read that
//     off the booking gate alone (the model asks conversationally, long before
//     stage_booking is ever called), so it is read off what the agent SAID.
//
// Deliberately dependency-light and deterministic: no model decides any of this
// on a live medical call, and every predicate is exported so the suite can hold
// it still.
import { normalize } from '../../engine/slots.js';

/** Anything that is not a letter or a digit separates two words. */
const TOKEN_SPLIT_RE = /[^\p{L}\p{N}]+/u;
/**
 * …except these, which JOIN one. "mm-hmm", "uh-huh", "d'accord" and
 * "rendez-vous" are each ONE thing said, and splitting them would both
 * miscount the words and turn two ignore-list entries into four tokens that
 * match nothing.
 */
const JOINER_RE = /['’‘`‑-]/g;

/**
 * Compare-only normalization. `normalize()` lowercases and NFD-decomposes;
 * stripping the remaining combining marks folds Arabic hamza/diacritics too, so
 * أيوا and ايوا are one entry rather than two ways to miss.
 */
export function normalizeToken(text) {
  return normalize(String(text || '')).replace(/\p{M}+/gu, '');
}

/** The words of an utterance, normalized. Punctuation and '…' are not words. */
export function words(text) {
  return normalizeToken(text)
    .replace(JOINER_RE, '')
    .split(TOKEN_SPLIT_RE)
    .filter(Boolean);
}

/** How many real words the caller said. Digits count — «9 8 7» is three. */
export function countWords(text) {
  return words(text).length;
}

/**
 * THE IGNORE-LIST (V8-D3 §2). Every one of these is a listener noise, in the
 * three languages this line speaks, plus the spellings a transcriber actually
 * produces for them. They never stop the agent.
 *
 * «نعم» and «صح» are in here and they are ALSO how a caller says yes to a
 * booking recap. That contradiction is resolved by the caller of this function,
 * not by the list: see the staged/data-capture exception in the orchestrator.
 *
 * The list is matched against a TRANSCRIPT, so it carries every spelling a
 * transcriber actually produces for one word — including the Latin ones, which
 * liveEars emits for derja and which used to walk straight past this set.
 */
export const BACKCHANNELS = Object.freeze(
  new Set([
    // ── derja / Arabic ──
    'ايوا',
    'ايوه',
    'ايه',
    'اي',
    'نعم',
    'تمام',
    'باهي',
    // Not in the V8 brief's list, added from the same field calls: after «باهي»
    // this is the commonest thing a Tunisian caller says while listening.
    'طيب',
    'مم',
    'ممم',
    'همم',
    'هاو',
    'صح',
    'اه',
    'اها',
    'اوكي',
    'اوك',
    // ── derja, WRITTEN IN LATIN — and this is not a nicety ──────────────────
    // liveEars (a Gemini Live session used as ears) transcribes derja into
    // whichever script it feels like: on a V8 rehearsal call «باهي» came back as
    // "Bahi", missed the ignore-list entirely, and became a full LLM turn — the
    // exact interruption D3 §2 exists to prevent. The Arabic spellings above
    // were never enough on their own, because the ignore-list is matched against
    // a TRANSCRIPT, not against what the caller's mouth did. These are the Latin
    // forms of entries that are already on this list and nothing else: no new
    // word becomes a backchannel here, only a second spelling of an old one.
    'bahi',
    'behi',
    'baheh',
    'tayeb',
    'taib',
    'tamem',
    'tamam',
    'aywa',
    'ayweh',
    'aywah',
    'naam',
    'nam',
    'sahh',
    'haw',
    // ── French ──
    'oui',
    'ouais',
    'daccord',
    'voila',
    'hum',
    // ── English / universal ──
    'ok',
    'okay',
    'yeah',
    'yep',
    'yes',
    'mmhmm',
    'mhm',
    'uhhuh',
    'hmm',
    'ah',
    'aha',
    'right',
  ])
);

/** Backchannels are short by nature; four tokens is a sentence, not a nod. */
export const MAX_BACKCHANNEL_TOKENS = 3;

/**
 * True when this utterance is NOTHING but listener noise.
 *
 * @param {string} text
 * @param {object} [p]
 * @param {number} [p.maxTokens] default 3
 * @returns {boolean}
 */
export function isBackchannelOnly(text, { maxTokens = MAX_BACKCHANNEL_TOKENS } = {}) {
  const list = words(text);
  if (!list.length || list.length > maxTokens) return false;
  return list.every((w) => BACKCHANNELS.has(w));
}

/**
 * WHAT THE AGENT JUST ASKED FOR. Matched against the sentence the agent SPOKE,
 * because that is the only place the answer exists before the caller gives it:
 * the model collects a name and a number conversationally, and the booking gate
 * (brain/tools.js) only learns about them at stage_booking — one whole turn too
 * late to be patient with the caller who is reading a number off a card.
 *
 * Over-matching is the cheap direction: a false 'date' costs 500 ms of extra
 * patience on one turn, while a miss cuts a caller off mid-digit.
 *
 * @param {string} text  what the agent said
 * @returns {'name'|'phone'|'date'|null}
 */
export function detectCaptureAsk(text) {
  const s = normalizeToken(text);
  if (!s) return null;
  // Phone first: "شنوة رقم التلفون" also contains no name/date words, but a
  // number is the slot a caller is most likely to pause inside.
  if (PHONE_ASK_RE.test(s)) return 'phone';
  if (NAME_ASK_RE.test(s)) return 'name';
  if (DATE_ASK_RE.test(s)) return 'date';
  return null;
}

const PHONE_ASK_RE =
  /(رقم|نمرة|نمره|تلفون|هاتف|جوال|موبايل)|(numero|téléphone|telephone|portable|gsm)|(phone|mobile|number)/;
const NAME_ASK_RE = /(اسمك|اسم|الاسم|سميتك)|(nom|appelez)|(name)/;
const DATE_ASK_RE =
  /(وقتاش|انهار|نهار|يوم|ساعة|ساعه|وقت|موعد|الصباح|العشية|العشيه|غدوة)|(jour|heure|quand|matin|apres ?midi|date|creneau)|(day|time|when|morning|afternoon|slot|date)/;

/**
 * ONE-WORD QUESTIONS ARE REAL TURNS (V8-D3 §3, review minor 7).
 *
 * The fragment rule throws away a one-word non-backchannel final as a
 * transcription artefact. That is right for «نحب» and wrong for «وقتاش؟» — the
 * commonest thing a derja caller says is a single interrogative word, and two
 * of them in a row used to fall through to the WhatsApp degrade with the caller
 * never answered. Two independent tells rescue them:
 *
 *   1. THE VENDOR'S OWN PUNCTUATION. A trailing «؟»/«?» is the transcriber
 *      asserting this was a question — evidence a fragment does not carry.
 *   2. A CLOSED INTERROGATIVE SET. «وقتاش قداش وين شنوة كيفاش علاش» and their
 *      French/English twins are questions whether or not the vendor punctuated
 *      them. The set is closed on purpose: it can only ever let real questions
 *      through, never a random short noise.
 */
export const INTERROGATIVES = Object.freeze(
  new Set([
    // ── derja / Arabic ──
    'وقتاش',
    'قداش',
    'بقداش',
    'قداه',
    'وين',
    'فين',
    'شنوة',
    'شنوا',
    'شنية',
    'اشنوة',
    'شكون',
    'كيفاش',
    'علاش',
    'لواش',
    // ── French ──
    'quand',
    'combien',
    'ou', // où → normalizes to «ou»
    'comment',
    'pourquoi',
    'qui',
    'quoi',
    // ── English ──
    'when',
    'how',
    'much',
    'where',
    'what',
    'why',
    'who',
    'which',
  ])
);

/**
 * True when a short final is really a question and must NOT be refused as a
 * fragment. Trailing «؟»/«?» OR any interrogative token.
 * @param {string} text
 * @returns {boolean}
 */
export function isInterrogativeFragment(text) {
  if (/[؟?]\s*$/.test(String(text || '').trim())) return true;
  return words(text).some((w) => INTERROGATIVES.has(w));
}

/**
 * ONE-WORD GOODBYES ARE REAL TURNS TOO (V8 self-test, 2026-08-02).
 *
 * Found on a scored booking run: the caller said «بسلامة», the ears returned
 * «بسلام», the fragment rule threw it away as an artefact — and the agent
 * answered the last beat of the call with «سامحني، فما حس برشة — تنجم تعاود آخر
 * حاجة؟» and then the two-strike WhatsApp offer. The booking had just been
 * written. The caller was asked to repeat their own goodbye, twice, and the line
 * was never released: `end_call` is the only thing that hangs up, and the model
 * never got the turn in which to call it.
 *
 * A farewell is the one utterance a caller is MOST likely to say in a single
 * word, and it is the one utterance where guessing wrong is free: answering a
 * mis-heard «بسلامة» costs a warm goodbye, while refusing a real one costs the
 * hang-up. So the same closed-set treatment the interrogatives get.
 *
 * The set is closed and it is spellings-of-goodbye ONLY — including the Latin
 * forms liveEars emits for derja, and the truncations a streaming transcriber
 * produces («بسلام» for «بسلامة»), which is precisely what was observed.
 */
export const FAREWELLS = Object.freeze(
  new Set([
    // ── derja / Arabic (and the truncations the ears actually return) ──
    'بسلامة',
    'بسلامه',
    'بسلام',
    'سلامة',
    'سلامه',
    'السلامة',
    'السلامه',
    'بالسلامة',
    'بالسلامه',
    'سلام',
    // ── derja, WRITTEN IN LATIN — same reason as BACKCHANNELS above ──
    'bslama',
    'beslama',
    'besslema',
    'bislama',
    'slama',
    'salam',
    // ── French ──
    'revoir',
    'aurevoir',
    'salut',
    'ciao',
    // ── English ──
    'bye',
    'byebye',
    'goodbye',
  ])
);

/**
 * THE POLITENESS THAT RIDES ALONG WITH A GOODBYE (V8, the hang-up backstop).
 *
 * Nobody says «revoir» — they say «au revoir», «merci, au revoir», «thank you,
 * bye». The two-token all-in-set rule above therefore recognised the ARABIC
 * goodbye and missed both of the other two languages this line speaks, which
 * matters now that a caller farewell arms a deterministic hang-up. These tokens
 * carry no meaning of their own in a closing utterance, so they are stripped
 * before the test — and stripping them can never turn a non-goodbye into one,
 * because at least one true FAREWELL token is still required.
 */
export const FAREWELL_FILLERS = Object.freeze(
  new Set([
    // ── derja / Arabic ──
    'شكرا',
    'يعيشك',
    'برشا',
    'برشة',
    'و',
    'مع',
    'الله',
    // ── French ──
    'au',
    'a',
    'merci',
    'bonne',
    'journee',
    'soiree',
    'bientot',
    // ── English ──
    'thank',
    'thanks',
    'you',
    'ok',
    'okay',
    'so',
    'then',
  ])
);

/**
 * True when a short final is nothing but a farewell. Checked only where the
 * fragment rule would otherwise refuse the turn — and, since V8, where the
 * caller's goodbye arms the hang-up backstop.
 * @param {string} text
 * @returns {boolean}
 */
export function isFarewellFragment(text) {
  const list = words(text);
  if (!list.length || list.length > 4) return false;
  const meaningful = list.filter((w) => !FAREWELL_FILLERS.has(w));
  // All filler and no goodbye is «شكرا» — a thank-you, not the end of the call.
  if (!meaningful.length || meaningful.length > 2) return false;
  return meaningful.every((w) => FAREWELLS.has(w));
}

/**
 * DIGITS ARE DATA, NEVER AN ARTEFACT (V8 self-test, 2026-08-02).
 *
 * The fragment rule's own docstring already names "a group of digits" as
 * something it must not eat — but it only knows that through `dataCapture()`,
 * which is state the agent has to have entered. On a scored booking run it had
 * not: asked for the name, the model answered with a bare disfluency («لحظة
 * وحدة نتثبت…»), no tool ran, no question was asked, so nothing marked the call
 * as collecting a phone number. The caller then read their number off a card,
 * the ears returned it as «21» · «29» · «4 9 6 7», and the first two were
 * refused as fragments — two strikes, the WhatsApp degrade, and a booking that
 * could never land.
 *
 * A streaming transcriber emits half-WORDS on its way to a sentence. It does
 * not emit a spurious number: «21» is a caller reading digits, or an hour, and
 * on a clinic line it is always data the agent asked for. So a final made only
 * of digit runs is a turn regardless of what the capture state believes.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isDigitFragment(text) {
  const list = words(text);
  if (!list.length) return false;
  return list.every((w) => /^\p{N}+$/u.test(w));
}

/**
 * …and what a TOOL just told us the agent is missing. This is the other half of
 * the signal: `stage_booking` refusing for a missing name is proof that the
 * next thing the caller says is a name, whatever phrasing the model chose.
 *
 * @param {string} name    the tool that ran
 * @param {object} result  what the executor returned
 * @returns {'name'|'phone'|'date'|'recap'|null|'clear'}
 */
export function captureFromTool(name, result) {
  const ok = result?.ok === true;
  if (name === 'stage_booking') {
    if (ok) return 'recap'; // the caller is about to answer a read-back
    if (result?.error === 'missing_name') return 'name';
    if (result?.error === 'missing_contact') return 'phone';
    return 'date';
  }
  if (name === 'get_available_slots') return 'date';
  // A written booking, a handoff or a goodbye: nothing is being collected.
  if (name === 'confirm_booking' && ok) return 'clear';
  if (name === 'end_call') return 'clear';
  return null;
}

export default detectCaptureAsk;
