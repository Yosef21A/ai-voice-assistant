// Deterministic post-filter over LLM reply text (P2-HUMANIZE §1 executor
// guardrails). The system prompt already forbids diagnosis / invented prices /
// outcome promises, but prompts are advisory — this filter is the enforcement.
// Sentence-level: violating sentences are dropped; a fully-dropped reply is
// replaced with a safe localized line so the bot never goes silent.
//
// Two passes, because the two failure modes are different:
//   1. PER-SENTENCE — decides WHICH sentence to blame and drop, keeping the
//      rest of a mostly-good reply (a price table loses the invented row, not
//      the clinic's real "from" figure).
//   2. ASSEMBLED — the kept sentences are DELIVERED joined by a space, so a
//      pattern whose halves sat on different lines ("Vous avez :\n- un cancer",
//      the shape Gemini emits for bullet lists) is invisible to pass 1 yet
//      fully present in what we send. Pass 2 re-scans the assembled reply; a
//      hit there means it is unsafe as assembled with no single sentence to
//      blame, so it degrades to the safe line.
//      Pass 2 only glues two fragments together when the line break was
//      FORMATTING inside one clause (the first ends on a dangling connector,
//      or the second opens with a bullet). Two independent lines are probed
//      with a sentence terminator between them, because "Vous avez rendez-vous
//      mardi" + "Signalez toute infection" is two innocent sentences, not a
//      diagnosis.
//
// Both passes scan a NORMALIZED probe, never the delivered text, so the reply
// stays in the patient's own script.
import { normalizeDigits } from '../text.js';

// ── scan probe ───────────────────────────────────────────────────────────────
// Fold everything that changes how a pattern LOOKS but not what it MEANS:
//   · Arabic-Indic digits and ٪ → ASCII, so "١٠٠٪" and "٩٩٩٩ دينار" can't slip;
//   · bidi / zero-width marks removed — an RLM between "3000" and "€" is
//     invisible to the patient but breaks a naive `NUM\s*CUR` match;
//   · markdown emphasis, table pipes and brackets → spaces, so "**12000**
//     euros" and "| Chirurgie | 12000 | EUR |" scan like plain prose;
//   · whitespace collapsed.
// Dashes are deliberately NOT folded: "900-3500 €" is how the clinic writes a
// price RANGE, and turning the dash into a space lets NUM swallow both bounds
// as one bogus 9003500 and censor the tenant's own published figures.
// \p{Cf} = Unicode "format" category: zero-width spaces/joiners, the bidi
// overrides and marks (RLM/LRM/RLE…), word joiner, BOM. Matching the category
// keeps this source ASCII-safe — a literal invisible character in a regex is
// unreviewable, and this is a safety filter.
const INVISIBLE_RE = /\p{Cf}/gu;
const NOISE_RE = /[*_~`|()[\]{}<>«»"“”]+/g;

function scanProbe(s) {
  return normalizeDigits(String(s ?? ''))
    .replace(/٪/g, '%')
    .replace(INVISIBLE_RE, '')
    .replace(NOISE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Arabic has no \b, and a bare root matches inside unrelated words (مية is a
// substring of أهمية). Wrap Arabic alternations in an Arabic-letter boundary.
const AR_LETTER = '\\u0621-\\u064A\\u0671-\\u06D3';
const arWord = (alts) => `(?<![${AR_LETTER}])(?:${alts})(?![${AR_LETTER}])`;

// `[^.!?؟]*` — unbounded WITHIN a clause but unable to cross a sentence
// terminator. A character bound here would be a silent hole: ordinary French
// clinical hedging ("Vous avez, d'après les photos que vous nous avez
// envoyées, une infection") easily runs 50+ characters between the subject and
// the disease word, and capping the gap let exactly that phrasing through.
// Cross-sentence stitching is prevented by the negated class, not by a count.
const DIAGNOSIS_RES = [
  // "you have <disease>", assertions of diagnosis
  /\byou (probably |likely |definitely )?(have|suffer from|are suffering from)\b/i,
  /\bdiagnos(is|ed|e)\b/i,
  /\bvous (avez|souffrez d)\b[^.!?؟]*\b(cancer|tumeur|maladie|infection|fracture)\b/i,
  /\bc'est (sûrement|probablement) (un|une)\b/i,
  // The disease list is boundary-guarded (optional fused ال allowed): مرض is a
  // substring of الممرضة / الممرض ("the nurse"), and "you have an appointment
  // with the nurse" is the most ordinary sentence a booking bot can send.
  new RegExp(`(عندك|تعاني من|مصاب ب)[^.!?؟]{0,12}${arWord('(?:ال)?(?:مرض|سرطان|ورم|التهاب|كسر)')}`),
  /التشخيص (هو|متاعك)/,
  // Arabizi/Derja "you have <disease>" — corridor patients get mirrored Latin
  // replies, so the same assertion arrives in Latin script.
  /\b(3andek|3andk|3andik|candek|3ndek)\b[\w\s]{0,14}\b(cancer|saratan|sartan|waram|marad|mard|iltihab|kasr|jalta|jaltha)\b/i,
  /\bt3ani\w*\b[\w\s]{0,14}\b(cancer|saratan|waram|marad|mard)\b/i,
];

// "Guaranteed" is only a PROMISE when it qualifies an OUTCOME. Bare مضمون /
// madmoun overwhelmingly means "secured / confirmed" in Derja — "موعدك مضمون"
// is "your appointment is confirmed", ordinary booking language the bot must
// stay able to say. So the adjective needs an outcome noun beside it, the same
// co-occurrence discipline the emergency detector applies to ambiguous roots.
// (No leading \b on the Arabizi nouns: the article fuses onto the word —
// "Ennajah", "El natija".)
const AR_OUTCOME = 'نجاح|نتيج\\S*|النتايج|شفاء|علاج|عملي\\S*|جراح\\S*';
const AZ_OUTCOME = 'naja7|najah|nejah|chfa|shfa|natija|nataij|3amaliya|3melia';
const AR_HUNDRED = 'مية|ميه|مئة|مائة';

const PROMISE_RES = [
  /100\s*%/, // trailing \b never matched "100%" before a space/end — dropped it
  /\b100\s*(pour\s*cent|percent)\b/i,
  /\b(one\s+)?hundred\s+percent\b/i,
  /\bcent\s+pour\s+cent\b/i,
  // Arabic 100% is written digit-or-word on EITHER side — "مية بالمية", "مئة في
  // المئة", and (most common of all) the hybrid "100 بالمئة". Boundary-guarded
  // on the OUTER edges only: the article fuses onto the second word ("بالمية"),
  // so a leading guard there would never match.
  new RegExp(
    `(?<![${AR_LETTER}0-9])(?:100|${AR_HUNDRED})\\s*(ب|في)\\s*(ال)?(?:100|${AR_HUNDRED})(?![${AR_LETTER}0-9])`
  ),
  /\b(100|mia|mya|miya)\s*(b?el\s*)?m(i|y)a\w*\b/i, // Arabizi "100 bel miya"
  /\bguarante+(d|s|ing)?\b/i,
  /\bgarant(i|ie|is|ies|it|issent|issons)\b/i,
  /\bsuccess rates?\b/i,
  /\btaux de r[eé]ussite\b/i,
  /نسبة\s*(ال)?نجاح/, // definite AND indefinite ("نسبة نجاح عالية")
  /\b(zero|no)\s+risks?\b/i,
  /\bsans (aucun )?risques?\b/i,
  /\bbla\s+(ma\s?)?khat(a|e)?r\b/i, // Arabizi بلا مخاطر
  /(نضمنو?لك|نضمن لك|بلا مخاطر|نجاح مؤكد)/,
  // "guaranteed 100" needs no outcome noun — the figure IS the promise. This is
  // complementary to the outcome-noun rule below, not an alternative to it.
  new RegExp(`مضمون[ةه]?\\s*(?:100|${AR_HUNDRED})`),
  // outcome + "guaranteed", either order, Arabic script and Arabizi
  new RegExp(`(${AR_OUTCOME})[^.!?؟]{0,12}مضمون[ةه]?|مضمون[ةه]?[^.!?؟]{0,12}(${AR_OUTCOME})`),
  new RegExp(`(${AZ_OUTCOME})\\w*[\\w\\s]{0,14}madmoun\\w*|madmoun\\w*[\\w\\s]{0,14}(${AZ_OUTCOME})`, 'i'),
];

// Currency tokens (Latin ones word-bounded so 'dt'/'dl' don't match inside
// words); matched either before OR after the number so "$3000", "3000€" and
// "3000 dinars" are all caught. Arabic plurals are separate alternatives —
// دينار is NOT a substring of دنانير.
const CUR =
  '(?:€|\\beuros?\\b|\\beur\\b|أورو|اورو|يورو|\\bdinars?\\b|\\bdinari\\b|\\blyd\\b|' +
  'دنانير|دينارا|دينار|د\\.?\\s?ت|\\btnd\\b|\\bdt\\b|\\$|\\bdollars?\\b|دولار|\\busd\\b)';
const NUM = '(\\d[\\d\\s.,]{0,10}\\d|\\d)';
const MONEY_RE = new RegExp(`(?:${CUR}\\s*${NUM})|(?:${NUM}\\s*${CUR})`, 'gi');

// Spelled-out prices bypass MONEY_RE (which needs a digit). A number-WORD next
// to a currency token ("three thousand euros", "ألف دينار", "alf dinar") is an
// invented price just the same. There is no numeric value to check against the
// tenant's figures, so the allow-list here is textual: a spelled amount that
// appears verbatim in the clinic record (a KB answer saying "à partir de trois
// cents euros") is the clinic's own price and passes; anything else is a
// violation.
const NUMWORD =
  '(?:\\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|thousand|million)\\b' +
  '|\\b(?:deux|trois|quatre|cinq|sept|huit|neuf|dix|vingt|trente|quarante|cinquante|cent|cents|mille|millions?)\\b' +
  `|${arWord('ألف|آلاف|الاف|مئة|مائة|مية|ميه|ميتين|ألفين|الفين|مليون')}` +
  '|\\b(?:alf|alef|aalaf|mya|mia|miten|alfin|melyoun)\\b)';
const SPELLED_GAP = `[\\w\\s${AR_LETTER}]{0,20}`;
const SPELLED_MONEY_RE = new RegExp(
  `(?:${NUMWORD}${SPELLED_GAP}${CUR})|(?:${CUR}${SPELLED_GAP}${NUMWORD})`,
  'gi'
);

const SAFE_LINE = {
  ar: 'بالنسبة للتفاصيل الطبية والأسعار الدقيقة، الفريق الطبي هو اللي يأكدهملك بعد الفحص 🙏 تحب نطلبلك واحد من الفريق يتواصل معاك هنا؟',
  fr: "Pour les détails médicaux et les montants exacts, c'est l'équipe médicale qui confirme après examen 🙏 Voulez-vous qu'un membre de l'équipe vous réponde ici ?",
  en: 'For medical specifics and exact amounts, our medical team confirms after an assessment 🙏 Want me to have a team member reply to you here?',
};

const parseNum = (raw) =>
  Number(
    String(raw)
      .replace(/[\s,]/g, '')
      .replace(/\.(?=\d{3}\b)/g, '') // European thousands separator
  );

/** Walk every string/number leaf of the tenant record exactly once. */
function walkClinic(clinic, onNumber, onString) {
  const seen = new WeakSet();
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'number') {
      if (Number.isFinite(v)) onNumber(v);
      return;
    }
    if (typeof v === 'string') {
      onString(v);
      return;
    }
    if (typeof v !== 'object') return;
    if (seen.has(v)) return; // kbLive merge can share references — guard cycles
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    for (const k of Object.keys(v)) {
      if (k === '_baseFaq') continue; // snapshot duplicate of faq
      walk(v[k]);
    }
  };
  try {
    walk(clinic);
  } catch {
    /* best-effort — a partial allow-list still filters invented figures */
  }
}

/**
 * Every number that legitimately exists in the tenant record (prices, hours,
 * phones, KB answers) — the allow-list for money figures in a reply. Collects
 * numeric leaves and digit runs inside strings INDIVIDUALLY, so an array like
 * estimate_eur:[900,3500] contributes 900 AND 3500 (a naive JSON.stringify scan
 * concatenated them across the comma and censored the clinic's own "from 900€").
 */
export function allowedNumbers(clinic) {
  const found = new Set();
  walkClinic(
    clinic,
    (n) => found.add(n),
    (s) => {
      for (const m of s.matchAll(/\d[\d.,\s]*\d|\d/g)) {
        const n = parseNum(m[0]);
        if (Number.isFinite(n)) found.add(n);
      }
    }
  );
  return found;
}

const normSpelled = (s) =>
  normalizeDigits(String(s)).toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Spelled-out money phrases the tenant itself publishes ("à partir de trois
 * cents euros" in a KB answer). Textual twin of allowedNumbers.
 */
export function allowedSpelledMoney(clinic) {
  const found = new Set();
  walkClinic(
    clinic,
    () => {},
    (s) => {
      for (const m of scanProbe(s).matchAll(SPELLED_MONEY_RE)) found.add(normSpelled(m[0]));
    }
  );
  return found;
}

function moneyViolations(probe, allowed, allowedSpelled) {
  for (const m of probe.matchAll(MONEY_RE)) {
    const raw = m[1] ?? m[2];
    if (raw == null) continue;
    const n = parseNum(raw);
    if (Number.isFinite(n) && !allowed.has(n)) return true;
  }
  for (const m of probe.matchAll(SPELLED_MONEY_RE)) {
    if (!allowedSpelled.has(normSpelled(m[0]))) return true;
  }
  return false;
}

/** @returns {'diagnosis'|'promise'|'price'|null} */
function violationKind(probe, allowed, allowedSpelled) {
  if (DIAGNOSIS_RES.some((re) => re.test(probe))) return 'diagnosis';
  if (PROMISE_RES.some((re) => re.test(probe))) return 'promise';
  if (moneyViolations(probe, allowed, allowedSpelled)) return 'price';
  return null;
}

const splitSentences = (text) =>
  String(text)
    .split(/(?<=[.!?؟…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

// A fragment that opens with a bullet/number marker or any non-letter/-digit
// (a stray "%", "€", "-"), or one that follows a dangling connector, is a
// FORMATTING continuation of the previous clause rather than a new sentence.
const OPENS_AS_ITEM = /^(?:\d+[.)]|[^\p{L}\p{N}])/u;
const DANGLING_END = /[:;,،؛]$/;

/**
 * Probe text for the assembled pass. Fragments that belong to ONE clause are
 * glued with a space (so "Vous avez :" + "- un cancer" reads as the single
 * assertion it is); independent fragments get a sentence terminator between
 * them, so the `[^.!?؟]*` gaps cannot stitch two innocent lines into a
 * diagnosis. The DELIVERED text is always a plain space join — this shape is a
 * scanning artefact only.
 */
function assembledProbeSource(fragments) {
  return fragments.reduce((acc, frag, i) => {
    if (i === 0) return frag;
    const sameClause = DANGLING_END.test(fragments[i - 1]) || OPENS_AS_ITEM.test(frag);
    return `${acc}${sameClause ? ' ' : ' . '}${frag}`;
  }, '');
}

/**
 * @returns {{ text: string, violations: string[] }} filtered reply — never empty.
 */
export function filterReply(text, { clinic, lang = 'fr' } = {}) {
  const violations = [];
  const allowed = allowedNumbers(clinic || {});
  const allowedSpelled = allowedSpelledMoney(clinic || {});
  const original = splitSentences(text);
  const kept = [];

  // Pass 1 — per sentence, so only the offending sentence is dropped.
  for (const sentence of original) {
    const kind = violationKind(scanProbe(sentence), allowed, allowedSpelled);
    if (kind) violations.push(`${kind}: ${sentence.slice(0, 80)}`);
    else kept.push(sentence);
  }

  let out = kept.join(' ').trim();

  // Pass 2 — the assembled reply, clause-aware (see assembledProbeSource).
  if (out) {
    const kind = violationKind(
      scanProbe(assembledProbeSource(kept)),
      allowed,
      allowedSpelled
    );
    if (kind) {
      violations.push(`${kind}: (assembled) ${out.slice(0, 80)}`);
      out = '';
    }
  }

  if (!out) out = SAFE_LINE[lang] || SAFE_LINE.fr;
  else if (violations.length) out = `${out} ${SAFE_LINE[lang] || SAFE_LINE.fr}`;
  return { text: out, violations };
}
