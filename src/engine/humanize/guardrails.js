// Deterministic post-filter over LLM reply text (P2-HUMANIZE §1 executor
// guardrails). The system prompt already forbids diagnosis / invented prices /
// outcome promises, but prompts are advisory — this filter is the enforcement.
// Sentence-level: violating sentences are dropped; a fully-dropped reply is
// replaced with a safe localized line so the bot never goes silent.

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
  /\b100\s*%\b/,
  /\bguarante+[ds]?\b/i,
  /\bgaranti[es]?\b/i,
  /\bsuccess rate\b/i,
  /\bzero risk\b/i,
  /\bsans (aucun )?risque\b/i,
  /(نضمنو?لك|نضمن لك|مضمون[ةه]?\s*100|بلا مخاطر|نجاح مؤكد)/,
];

const MONEY_RE = /(\d[\d\s.,]{0,10}\d|\d)\s*(?:€|eur(?:os?)?\b|دينار|د\.ت|tnd\b|dt\b|\$|dollars?\b|دولار)/gi;

const SAFE_LINE = {
  ar: 'بالنسبة للتفاصيل الطبية والأسعار الدقيقة، الفريق الطبي هو اللي يأكدهملك بعد الفحص 🙏 تحب نطلبلك واحد من الفريق يتواصل معاك هنا؟',
  fr: "Pour les détails médicaux et les montants exacts, c'est l'équipe médicale qui confirme après examen 🙏 Voulez-vous qu'un membre de l'équipe vous réponde ici ?",
  en: 'For medical specifics and exact amounts, our medical team confirms after an assessment 🙏 Want me to have a team member reply to you here?',
};

/** Every number that legitimately exists in the tenant record (prices, hours,
 *  phones, KB answers) — the allow-list for money figures in a reply. */
export function allowedNumbers(clinic) {
  const found = new Set();
  const scan = (s) => {
    for (const m of String(s).matchAll(/\d[\d\s.,]{0,10}\d|\d/g)) {
      const n = Number(m[0].replace(/[\s,]/g, '').replace(/\.(?=\d{3}\b)/g, ''));
      if (Number.isFinite(n)) found.add(n);
    }
  };
  try {
    scan(JSON.stringify(clinic));
  } catch {
    /* clinic may carry cycles via kbLive merge — scan the safe subsets */
    scan(JSON.stringify(clinic?.pricing || {}));
    scan(JSON.stringify(clinic?.faq || []));
    scan(JSON.stringify(clinic?.workingHours || {}));
    scan(JSON.stringify(clinic?.handoff || {}));
  }
  return found;
}

function moneyViolations(sentence, allowed) {
  for (const m of sentence.matchAll(MONEY_RE)) {
    const n = Number(m[1].replace(/[\s,]/g, '').replace(/\.(?=\d{3}\b)/g, ''));
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
  const kept = [];
  for (const sentence of splitSentences(text)) {
    if (DIAGNOSIS_RES.some((re) => re.test(sentence))) {
      violations.push(`diagnosis: ${sentence.slice(0, 80)}`);
      continue;
    }
    if (PROMISE_RES.some((re) => re.test(sentence))) {
      violations.push(`promise: ${sentence.slice(0, 80)}`);
      continue;
    }
    if (moneyViolations(sentence, allowed)) {
      violations.push(`price: ${sentence.slice(0, 80)}`);
      continue;
    }
    kept.push(sentence);
  }
  let out = kept.join(' ').trim();
  if (!out) out = SAFE_LINE[lang] || SAFE_LINE.fr;
  else if (violations.length) out = `${out} ${SAFE_LINE[lang] || SAFE_LINE.fr}`;
  return { text: out, violations };
}
