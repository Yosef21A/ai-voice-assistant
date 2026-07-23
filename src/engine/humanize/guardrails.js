// Deterministic post-filter over LLM reply text (P2-HUMANIZE §1 executor
// guardrails). The system prompt already forbids diagnosis / invented prices /
// outcome promises, but prompts are advisory — this filter is the enforcement.
// Sentence-level: violating sentences are dropped; a fully-dropped reply is
// replaced with a safe localized line so the bot never goes silent.
//
// The scan runs on a digit-normalized copy (Arabic-Indic ٠-٩ and the Arabic
// percent ٪ folded to ASCII) so an LLM reply that quotes a price or "١٠٠٪" in
// Arabic numerals can't slip past the regexes; the KEPT text is the original,
// so the reply stays in the patient's native script.
import { normalizeDigits } from '../text.js';

const DIAGNOSIS_RES = [
  // "you have <disease>", assertions of diagnosis
  /\byou (probably |likely |definitely )?(have|suffer from|are suffering from)\b/i,
  /\bdiagnos(is|ed|e)\b/i,
  /\bvous (avez|souffrez d)\b.*\b(cancer|tumeur|maladie|infection|fracture)\b/i,
  /\bc'est (sûrement|probablement) (un|une)\b/i,
  /(عندك|تعاني من|مصاب ب)\s*(مرض|سرطان|ورم|التهاب|كسر)/,
  /التشخيص (هو|متاعك)/,
];

const PROMISE_RES = [
  /100\s*%/, // trailing \b never matched "100%" before a space/end — dropped it
  /\bguarante+[ds]?\b/i,
  /\bgaranti[es]?\b/i,
  /\bsuccess rate\b/i,
  /\bzero risk\b/i,
  /\bsans (aucun )?risque\b/i,
  /(نضمنو?لك|نضمن لك|مضمون[ةه]?\s*100|بلا مخاطر|نجاح مؤكد)/,
];

// Currency tokens (Latin ones word-bounded so 'dt'/'dl' don't match inside
// words); matched either before OR after the number so "$3000", "3000€" and
// "3000 dinars" are all caught.
const CUR =
  '(?:€|\\beuros?\\b|\\beur\\b|\\bdinars?\\b|\\bdinari\\b|\\blyd\\b|دينار|د\\.?\\s?ت|\\btnd\\b|\\bdt\\b|\\$|\\bdollars?\\b|دولار|\\busd\\b)';
const NUM = '(\\d[\\d\\s.,]{0,10}\\d|\\d)';
const MONEY_RE = new RegExp(`(?:${CUR}\\s*${NUM})|(?:${NUM}\\s*${CUR})`, 'gi');

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

/**
 * Every number that legitimately exists in the tenant record (prices, hours,
 * phones, KB answers) — the allow-list for money figures in a reply. Walks the
 * object collecting numeric leaves and digit runs inside strings INDIVIDUALLY,
 * so an array like estimate_eur:[900,3500] contributes 900 AND 3500 (a naive
 * JSON.stringify scan concatenated them across the comma and censored the
 * clinic's own "from 900€").
 */
export function allowedNumbers(clinic) {
  const found = new Set();
  const seen = new WeakSet();
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'number') {
      if (Number.isFinite(v)) found.add(v);
      return;
    }
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\d[\d.,\s]*\d|\d/g)) {
        const n = parseNum(m[0]);
        if (Number.isFinite(n)) found.add(n);
      }
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
  return found;
}

function moneyViolations(sentence, allowed) {
  for (const m of sentence.matchAll(MONEY_RE)) {
    const raw = m[1] ?? m[2];
    if (raw == null) continue;
    const n = parseNum(raw);
    if (Number.isFinite(n) && !allowed.has(n)) return true;
  }
  return false;
}

const splitSentences = (text) =>
  String(text)
    .split(/(?<=[.!?؟…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * @returns {{ text: string, violations: string[] }} filtered reply — never empty.
 */
export function filterReply(text, { clinic, lang = 'fr' } = {}) {
  const violations = [];
  const allowed = allowedNumbers(clinic || {});
  const original = splitSentences(text);
  // Scan a normalized copy (digits + ٪) but keep the ORIGINAL sentence so the
  // reply stays in the patient's script.
  const scan = original.map((s) => normalizeDigits(s).replace(/٪/g, '%'));
  const kept = [];
  original.forEach((sentence, i) => {
    const probe = scan[i];
    if (DIAGNOSIS_RES.some((re) => re.test(probe))) {
      violations.push(`diagnosis: ${sentence.slice(0, 80)}`);
      return;
    }
    if (PROMISE_RES.some((re) => re.test(probe))) {
      violations.push(`promise: ${sentence.slice(0, 80)}`);
      return;
    }
    if (moneyViolations(probe, allowed)) {
      violations.push(`price: ${sentence.slice(0, 80)}`);
      return;
    }
    kept.push(sentence);
  });
  let out = kept.join(' ').trim();
  if (!out) out = SAFE_LINE[lang] || SAFE_LINE.fr;
  else if (violations.length) out = `${out} ${SAFE_LINE[lang] || SAFE_LINE.fr}`;
  return { text: out, violations };
}
