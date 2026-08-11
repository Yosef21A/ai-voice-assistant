// Emergency + hot-lead DETECTORS — pure functions, ZERO I/O.
//
// These are the safety-critical and revenue-critical classifiers behind the
// owner-notification service (P1-E). They take plain values in and return plain
// verdicts out, so they are trivially unit-testable and can be reused anywhere
// (webhook path, simulator, sandbox, future per-tenant tuning). Nothing here
// reads a file, a clock, a DB, or the network.
//
// ── Design notes ─────────────────────────────────────────────────────────────
// • Multilingual by construction: separate AR / FR / EN / ARABIZI keyword
//   tables, incl. Libyan/Tunisian colloquial forms (وجع / يوجعني / طاح / ما
//   يفيقش …). "Arabizi" is Arabic written in Latin letters with digits for the
//   sounds Latin lacks (3=ع, 7=ح, 9=ق, 5=خ) — how most corridor patients type.
//   It is matched against the Latin-folded text, like fr/en.
// • Conservative matching (guardrail: false NEGATIVES on emergencies are worse
//   than false positives, but we must not scream on every cardiology or
//   cosmetic-surgery inquiry):
//     - Latin (fr/en/arabizi): whole-token / whole-phrase matching after accent
//       + case + apostrophe folding, so "pas de douleur" never trips a
//       chest-pain rule (there is no bare "douleur" keyword).
//     - Arabic: root-aware substring matching after diacritic + alef/ya/
//       ta-marbuta normalization, so prefixes (و/ب/ال/ف) and suffixes (ي/ك/نا)
//       still match.
//     - Ambiguous roots (صدر "chest" also in "مصدر"/breast cosmetics, قلب,
//       حساسية) require CO-OCCURRENCE with an acute marker, as { all: [...] }.
//     - Ambiguous LATIN roots additionally require PROXIMITY, as
//       { groups: [[...], [...]], within }. Co-occurrence alone is not enough
//       once the tokens are everyday words: 'dam' is the ordinary word for a
//       blood TEST, 'di9' for a shortage ("di9 el wa9t" = short of time),
//       'sadr' for the breast in cosmetic-surgery traffic. Without a distance
//       bound, a long booking message containing both tokens in unrelated
//       clauses would fire the ambulance override. `not:` suppresses a rule
//       outright on a known-benign collocation.
//     - Function words are never tokens. 'ma' negates practically every
//       Tunisian sentence (and is French "my"); 'mesh' is also the English
//       hernia-mesh term. Negated verbs are spelled out as whole phrases
//       instead ('ma yfi9ch'), which is both safer and more readable.
// • Easy to extend per tenant later: the tables are exported; a tenant override
//   can be merged before matching without touching this file's logic.
import { extractSpecialty, extractOrigin } from '../engine/slots.js';

// ── text normalizers ─────────────────────────────────────────────────────────
// Regex character-classes use \u escapes (ASCII-safe source) so they can never
// accidentally span into the Arabic-Indic digit block (U+0660–U+0669).

/** Fold Latin text: lowercase, strip accents + apostrophes, collapse to single
 *  spaces, and PAD with spaces so `includes(' phrase ')` is a word-boundary test. */
export function normalizeLatin(s = '') {
  return (
    ' ' +
    String(s)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // combining accents
      .replace(/[’'`´]/g, '') // can't -> cant, j'ai -> jai
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() +
    ' '
  );
}

/** Fold Arabic text: strip tashkeel/tatweel, unify alef/ya/ta-marbuta/hamza,
 *  collapse spaces. Returned WITHOUT boundary padding — Arabic matching is
 *  root/substring based because the language glues particles onto words. */
export function normalizeArabic(s = '') {
  return String(s)
    .replace(/[ً-ٰٕـ]/g, '') // harakat, hamza/madda marks, superscript alef, tatweel
    .replace(/[آأإ]/g, 'ا') // آ أ إ -> ا
    .replace(/ى/g, 'ي') // ى -> ي
    .replace(/ؤ/g, 'و') // ؤ -> و
    .replace(/ئ/g, 'ي') // ئ -> ي
    .replace(/ة/g, 'ه') // ة -> ه
    .replace(/ء/g, '') // bare hamza ء -> drop
    .replace(/[^؀-ۿ0-9\s]/g, ' ') // keep Arabic block + digits + spaces
    .replace(/\s+/g, ' ')
    .trim();
}

function matchLatin(normText, kw) {
  return normText.includes(normalizeLatin(kw));
}
function matchArabic(normText, kw) {
  const k = normalizeArabic(kw);
  return k.length > 0 && normText.includes(k);
}

/** Every [start,end) of `kw` in the padded Latin text (token span, no padding). */
function latinPositions(normText, kw) {
  const k = normalizeLatin(kw); // ' kw '
  const out = [];
  if (k.length <= 2) return out; // empty keyword folds to '  '
  for (let i = normText.indexOf(k); i !== -1; i = normText.indexOf(k, i + 1)) {
    out.push([i + 1, i + k.length - 1]);
  }
  return out;
}

/** Every [start,end) of `kw` in the normalized Arabic text. */
function arabicPositions(normText, kw) {
  const k = normalizeArabic(kw);
  const out = [];
  if (!k) return out;
  for (let i = normText.indexOf(k); i !== -1; i = normText.indexOf(k, i + 1)) {
    out.push([i, i + k.length]);
  }
  return out;
}

// Distance bound for a { groups } rule, measured as the GAP — the characters
// sitting BETWEEN the matched tokens, i.e. total span minus the tokens' own
// lengths. Measuring the raw span instead would punish long keywords: with a
// span bound, 'ma najjamtsh ntnaffes' (21 chars of keyword, 1 of gap) looks
// "further apart" than a genuinely loose pair of short words. ~18 chars of gap
// is about three intervening words — "wja3 kbir barcha fi sadri" — which is
// how people actually write, while still refusing to bridge separate clauses.
const DEFAULT_GAP = 18;

/**
 * True when at least one token from EACH group is present AND some choice of
 * one occurrence per group leaves at most `maxGap` characters between them.
 */
function groupsMatch(groups, positionsOf, maxGap) {
  const lists = groups.map((g) => g.flatMap((kw) => positionsOf(kw)));
  if (lists.some((l) => l.length === 0)) return false;
  let best = Infinity;
  const walk = (idx, lo, hi, tokenChars) => {
    if (best <= maxGap) return; // already satisfied
    if (idx === lists.length) {
      best = Math.min(best, Math.max(0, hi - lo - tokenChars));
      return;
    }
    for (const [s, e] of lists[idx]) {
      walk(idx + 1, Math.min(lo, s), Math.max(hi, e), tokenChars + (e - s));
    }
  };
  walk(0, Infinity, -Infinity, 0);
  return best <= maxGap;
}

// ── emergency keyword tables ─────────────────────────────────────────────────
// A matcher is one of:
//   'phrase'                                   — whole phrase / token
//   { all: [roots], label }                    — co-occurrence anywhere (Arabic)
//   { groups: [[...],[...]], gap, not, label }   — co-occurrence + proximity
// Categories map to the guardrail list in PRODUCT-SPEC §5 / CLAUDE.md.
export const EMERGENCY_KEYWORDS = {
  bleeding: {
    ar: ['نزيف', 'نزف', 'ينزف', 'الدم يسيل', 'يسيل الدم', 'الدم ما يوقفش', 'الدم ما يسكرش'],
    fr: [
      'hemorragie',
      'saigne abondamment',
      'saignement important',
      'perte de sang importante',
      'je perds beaucoup de sang',
      'il perd beaucoup de sang',
      'ne s arrete pas de saigner',
      'sang qui coule',
    ],
    en: [
      'bleeding',
      'bleed',
      'hemorrhage',
      'haemorrhage',
      'losing a lot of blood',
      'lots of blood',
      'wont stop bleeding',
      'cant stop the bleeding',
    ],
    arabizi: [
      'nazif',
      'nzif',
      'nazeef',
      {
        groups: [
          ['dam', 'damm', 'demm', 'eddem'],
          ['yseel', 'ysil', 'ysayel', 'sayel', 'yfour', 'ywa9ef', 'ywa9efch', 'yew9efch', 'yow9efch'],
        ],
        // 'dam' is the everyday word for a blood TEST and 'sayel' just means
        // liquid — this pair only reads as haemorrhage in a tight collocation,
        // and never when the message is about lab work.
        not: ['ta7lil', 'tahlil', 'tahalil', 'analyse', 'analyses', 'bilan', 'prise de sang'],
        gap: 14,
        label: 'dam (blood) + flow',
      },
    ],
  },
  chest_pain: {
    ar: [
      { all: ['وجع', 'صدر'], label: 'وجع في الصدر' },
      { all: ['الم', 'صدر'], label: 'ألم في الصدر' },
      { all: ['يوجعني', 'صدر'], label: 'يوجعني صدري' },
      { all: ['ضغط', 'صدر'], label: 'ضغط على الصدر' },
      'نوبه قلبيه',
      'ذبحه صدريه',
      'جلطه قلبيه',
    ],
    fr: [
      'douleur thoracique',
      'douleur a la poitrine',
      'mal a la poitrine',
      'serrement a la poitrine',
      'oppression thoracique',
      'point au coeur',
      'crise cardiaque',
      'infarctus',
    ],
    en: [
      'chest pain',
      'chest pains',
      'pain in my chest',
      'pain in the chest',
      'tightness in my chest',
      'chest tightness',
      'pressure in my chest',
      'heart attack',
    ],
    arabizi: [
      'nawba 9albiya',
      'jalta 9albiya',
      'zab7a sadriya',
      {
        groups: [
          ['wja3', 'wje3', 'uja3', 'waja3', 'yewja3ni', 'yuja3ni', 'youja3ni', 'mwaja3', 'weja3'],
          ['sadr', 'sadri', 'sder', 'sedri', 'sadrou'],
        ],
        gap: 18,
        label: 'wja3 sadr (chest pain)',
      },
      {
        groups: [
          ['di9', 'dhi9', 'daghet', 'dhaghet'],
          ['sadr', 'sadri', 'sder', 'sedri', 'sadrou'],
        ],
        // Standing alone 'di9' (ضيق) is the ordinary word for scarcity.
        not: ['di9 el wa9t', 'di9 fel wa9t', 'di9 lwa9t', 'di9 el 7al', 'di9 fel budget', 'di9 fel flous'],
        gap: 16,
        label: 'chest tightness',
      },
    ],
  },
  breathing: {
    ar: [
      'صعوبه في التنفس',
      'ضيق تنفس',
      'ضيق في التنفس',
      'ما يتنفسش',
      'مايتنفسش',
      'ما ينجمش يتنفس',
      'انقطع نفسه',
      'نختنق',
      'يختنق',
      'خنقه',
    ],
    fr: [
      'du mal a respirer',
      'peine a respirer',
      'pas a respirer',
      'ne peux pas respirer',
      'difficile de respirer',
      'je suffoque',
      'il suffoque',
      'detresse respiratoire',
      'essoufflement severe',
    ],
    en: [
      'cant breathe',
      'cannot breathe',
      'difficulty breathing',
      'trouble breathing',
      'hard to breathe',
      'struggling to breathe',
      'short of breath',
      'shortness of breath',
      'choking',
    ],
    arabizi: [
      '5na9',
      'khna9',
      'nakhtne9',
      'nekhtne9',
      'nkhna9',
      'ykhne9',
      'yekhne9',
      'ma yetnaffesch',
      'ma yitnaffesch',
      'ma ytnaffesch',
      'mayetnaffesch',
      {
        groups: [
          ['di9', 'dhi9', 'dae9', 'daye9', 'sae9', 'saye9'],
          ['nefs', 'nefes', 'nafas', 'tnaffes', 'tanaffos'],
        ],
        not: ['di9 el wa9t', 'di9 fel wa9t', 'di9 lwa9t'],
        gap: 16,
        label: 'di9 nefes (breathing distress)',
      },
      {
        // Negated VERB forms only — bare 'ma' is a function word.
        groups: [
          [
            'manajjamtsh',
            'najjamtsh',
            'najamtsh',
            'najamtish',
            'najjamtish',
            'nnajjamch',
            'manajjamch',
            'ma3adch',
            'sa3ib',
            's3ib',
          ],
          ['ntnaffes', 'netnaffes', 'natnaffes', 'ntanaffas', 'yetnaffes', 'ntnafes'],
        ],
        gap: 20,
        label: "can't breathe",
      },
    ],
  },
  unconscious: {
    ar: [
      'غيبوبه',
      'اغماء',
      'اغمي عليه',
      'مغمي عليه',
      'مغمى عليه',
      'فاقد الوعي',
      'غاب عن الوعي',
      'ما يفيق',
      'مايفيقش',
      'ما يفيقش',
      'طاح ع الارض',
    ],
    fr: [
      'inconscient',
      'evanoui',
      'evanouissement',
      'perte de connaissance',
      'perte de conscience',
      'ne se reveille pas',
      'ne repond plus',
      'tombe dans les pommes',
    ],
    en: [
      'unconscious',
      'passed out',
      'pass out',
      'fainted',
      'fainting',
      'collapsed',
      'wont wake up',
      'not waking up',
      'unresponsive',
      'loss of consciousness',
    ],
    arabizi: [
      'ghmaya',
      'ghaybouba',
      'ghaïbouba',
      'maghmi',
      'mghmi',
      // Spelled out instead of a {ma, mesh, mish} × {yfi9} group: those group-1
      // tokens are function words, and 'yfi9' on its own is just "wakes up".
      'ma yfi9',
      'ma yfi9ch',
      'mayfi9ch',
      'ma yfou9ch',
      'mayfou9ch',
      'ma yfik',
      'ma yfikch',
      'mayfikch',
      'mesh yfi9',
      'mish yfi9',
      'ma3adch yfi9',
      {
        groups: [
          ['tah', 'ta7', 'taht', 'ta7et'],
          ['ard', 'lard', 'larth'],
        ],
        gap: 12,
        label: 'collapsed',
      },
    ],
  },
  stroke: {
    ar: ['جلطه دماغيه', 'سكته دماغيه', 'سكته', 'فمه معوج', 'وجهه معوج', 'نصو مشلول', 'شلل مفاجئ', 'لسانه متلغبط'],
    fr: [
      'avc',
      'accident vasculaire',
      'attaque cerebrale',
      'bouche qui tombe',
      'visage paralyse',
      'moitie du corps',
      'ne sent plus son bras',
      'paralysie soudaine',
    ],
    en: [
      'stroke',
      'face drooping',
      'slurred speech',
      'cant move my arm',
      'cant move his arm',
      'numbness on one side',
      'one side of the body',
      'sudden paralysis',
    ],
    arabizi: [
      'sakta',
      'sakta dimaghiya',
      'jalta dimaghiya',
      'jalta dimghiya',
      'jalta fel mokh',
      {
        groups: [
          ['fom', 'fomm', 'wejh', 'wjeh', 'wejhou'],
          ['m3awej', 'm3awaj', 'ma3wej', 'm3awja'],
        ],
        gap: 16,
        label: 'facial droop',
      },
    ],
  },
  allergic: {
    ar: [
      { all: ['حساسيه', 'شديد'], label: 'حساسية شديدة' },
      { all: ['حساسيه', 'خطير'], label: 'حساسية خطيرة' },
      { all: ['حساسيه', 'مفرط'], label: 'حساسية مفرطة' },
      'صدمه تحسسيه',
      'انتفخ وجهه',
      'انتفاخ في الحلق',
      'حلقه متسكر',
    ],
    fr: [
      'choc anaphylactique',
      'anaphylaxie',
      'reaction allergique severe',
      'reaction allergique grave',
      'allergie severe',
      'gorge qui gonfle',
      'visage qui gonfle',
      'langue qui gonfle',
    ],
    en: [
      'anaphylaxis',
      'anaphylactic',
      'severe allergic reaction',
      'severe allergy',
      'throat closing',
      'throat swelling',
      'face swelling up',
      'tongue swelling',
    ],
    arabizi: [
      'sadma tahassousiya',
      'sadma ta7assousiya',
      {
        groups: [
          ['hasasiya', '7asasiya', '7assasiya', 'hsesiya'],
          ['chdida', 'shdida', 'khtira', '5tira', 'mfarta', 'gadda'],
        ],
        // Tight: the intensifier sits next to the noun in a real report
        // ("hasasiya chdida"). Loosen it and an allergy INQUIRY that happens to
        // say "ma3andich chdida" further along starts paging the owner.
        gap: 14,
        label: 'severe allergy',
      },
      {
        groups: [
          ['ntfa5', 'ntafa5', 'entafa5', 'ntfakh', 'ntafakh'],
          ['wejh', 'wjeh', 'wejhou', 'wjehou', '7al9', 'hal9', '7al9i', 'lsen', 'lseni', 'lsanou'],
        ],
        gap: 16,
        label: 'swelling (face/throat/tongue)',
      },
    ],
  },
  self_harm: {
    ar: [
      'انتحار',
      'ننتحر',
      'نقتل روحي',
      'نقتل نفسي',
      'اقتل نفسي',
      'نأذي روحي',
      'اذي روحي',
      'ايذاء النفس',
      'ما عادش نحب نعيش',
      'نحب نموت',
      'ننهي حياتي',
      'باش ننهي حياتي',
    ],
    fr: [
      'suicide',
      'me suicider',
      'suicider',
      'envie de mourir',
      'je veux mourir',
      'me faire du mal',
      'en finir avec la vie',
      'plus envie de vivre',
    ],
    en: [
      'suicide',
      'kill myself',
      'killing myself',
      'want to die',
      'end my life',
      'hurt myself',
      'harm myself',
      'self harm',
      'dont want to live',
      'no reason to live',
    ],
    arabizi: [
      'ntihar',
      'nntihar',
      {
        groups: [
          ['n9tel', 'nn9tel', 'na9tel', 'ne9tel', 'nqtel', 'na9tal'],
          ['rou7i', 'rouhi', 'nefsi', 'ro7i', 'rohi'],
        ],
        gap: 12,
        label: 'kill myself',
      },
      {
        groups: [
          ['nheb', 'n7eb', 'nhab', 'nhib'],
          ['nmout', 'nmoot', 'namout', 'nmut'],
        ],
        // 'nheb' ("I want") opens most booking messages — keep this one tight.
        gap: 8,
        label: 'want to die',
      },
      {
        groups: [
          ['ma3adch', 'ma3adech', 'ma3adnich', 'manajjamch'],
          ['n3ich', 'na3ich', 'ne3ich'],
        ],
        gap: 12,
        label: "don't want to live",
      },
    ],
  },
};

// Priority is not behaviourally important (any hit steps the bot back) but keeps
// the returned category deterministic when a message trips more than one rule.
const EMERGENCY_ORDER = [
  'bleeding',
  'chest_pain',
  'breathing',
  'unconscious',
  'stroke',
  'allergic',
  'self_harm',
];

/**
 * Detect an emergency in free text. Scans AR/FR/EN/ARABIZI tables regardless of
 * `lang` (a fr-tagged conversation can still send Arabic), Arabic first since
 * script is self-identifying. `lang` only nudges which table is tried first.
 * @param {string} text
 * @param {'ar'|'fr'|'en'} [lang]
 * @returns {{hit:boolean, keyword?:string, category?:string, lang?:string}}
 */
export function detectEmergency(text = '', lang) {
  if (!text) return { hit: false };
  const latin = normalizeLatin(text);
  const arabic = normalizeArabic(text);
  const langs = orderLangs(lang);

  for (const category of EMERGENCY_ORDER) {
    const table = EMERGENCY_KEYWORDS[category];
    for (const L of langs) {
      const list = table[L];
      if (!list) continue;
      // Arabizi (Arabic in Latin letters) is matched like fr/en against the
      // space-padded Latin text, so short roots ('dam','di9') stay whole-word.
      const isAr = L === 'ar';
      const has = isAr ? (k) => matchArabic(arabic, k) : (k) => matchLatin(latin, k);
      const positionsOf = isAr
        ? (k) => arabicPositions(arabic, k)
        : (k) => latinPositions(latin, k);
      for (const m of list) {
        if (typeof m === 'string') {
          if (has(m)) return { hit: true, keyword: m, category, lang: L };
        } else if (m && Array.isArray(m.all)) {
          if (m.all.every(has)) return { hit: true, keyword: m.label || m.all.join(' + '), category, lang: L };
        } else if (m && Array.isArray(m.groups)) {
          if (m.not && m.not.some(has)) continue; // known-benign collocation
          if (groupsMatch(m.groups, positionsOf, m.gap ?? DEFAULT_GAP)) {
            return {
              hit: true,
              keyword: m.label || m.groups.map((g) => g[0]).join(' + '),
              category,
              lang: L,
            };
          }
        }
      }
    }
  }
  return { hit: false };
}

function orderLangs(lang) {
  // 'arabizi' is always scanned (Latin-script Arabic is common in the corridor
  // and script-ambiguous, so lang tagging can't be trusted to include it).
  const all = ['ar', 'fr', 'en', 'arabizi'];
  if (lang && all.includes(lang)) return [lang, ...all.filter((x) => x !== lang)];
  return all;
}

// ── hot-lead detection ───────────────────────────────────────────────────────

/** Specialties worth a same-day owner ping when a price/quote is requested. */
export const DEFAULT_HIGH_VALUE_SPECIALTIES = Object.freeze([
  'cosmetic_surgery',
  'fertility',
  'cardiology',
  'orthopedics',
]);

// Home-country dial codes — a number NOT starting with the tenant's home code is
// treated as an inbound medical-tourism prospect.
const HOME_DIAL_CODES = { Tunisia: '216', Libya: '218', Algeria: '213', Morocco: '212', Egypt: '20' };
const FOREIGN_CODES = [
  { code: '218', country: 'Libya' },
  { code: '213', country: 'Algeria' },
  { code: '212', country: 'Morocco' },
  { code: '20', country: 'Egypt' },
  { code: '966', country: 'Saudi Arabia' },
  { code: '971', country: 'UAE' },
];

/** Classify a WhatsApp id (E.164 digits, no +) as foreign to the tenant. */
export function classifyOrigin(waId, tenantConfig = {}) {
  const raw = String(waId ?? '').replace(/[^\d]/g, '');
  if (!raw || raw.length < 8) return { foreign: false };
  const n = raw.startsWith('00') ? raw.slice(2) : raw;
  const homeCode =
    tenantConfig?.notifications?.homeDialCode || HOME_DIAL_CODES[tenantConfig?.country] || '216';
  if (n.startsWith(homeCode)) return { foreign: false, country: tenantConfig?.country || null };
  for (const f of FOREIGN_CODES) {
    if (n.startsWith(f.code) && f.code !== homeCode) return { foreign: true, country: f.country };
  }
  // A full-length international number that is not the home country → foreign.
  if (n.length >= 10) return { foreign: true, country: null };
  return { foreign: false };
}

function highValueSet(tenantConfig) {
  const list =
    tenantConfig?.notifications?.highValueSpecialties ||
    tenantConfig?.highValueSpecialties ||
    DEFAULT_HIGH_VALUE_SPECIALTIES;
  return new Set(list);
}

/**
 * Decide whether an inbound turn is a high-value ("hot") lead worth an instant
 * owner alert. Triggers (PRODUCT-SPEC §3.6 / §4):
 *   1. a pricing/quote intent about a high-value specialty;
 *   2. travel / medical-tourism intake from a FOREIGN number (+218 …);
 *   3. an explicit "coming from Libya / abroad" statement.
 * A completed booking turn (engineResult.appointment set) is NOT a lead — the
 * appointment.created alert already covers it.
 *
 * @param {object} engineResult  the engine's handleMessage() result
 * @param {object} tenantConfig  the clinic/tenant config object
 * @param {string} inboundText   the raw patient message
 * @param {object} [opts]        { waId } — additive; enables the +218 trigger
 * @returns {{hot:boolean, reason?:string, procedure?:string, country?:string}}
 */
export function isHotLead(engineResult = {}, tenantConfig = {}, inboundText = '', opts = {}) {
  // A confirmed appointment is handled by the booking alert, never a "lead".
  if (engineResult && engineResult.appointment) return { hot: false };

  const intent = engineResult?.intent;
  const waId = opts.waId;
  const text = String(inboundText || '');

  // 1) Pricing/quote on a high-value specialty.
  if (intent === 'pricing_quote') {
    const sp = safeSpecialty(text, tenantConfig);
    if (sp && highValueSet(tenantConfig).has(sp.id)) {
      return { hot: true, reason: 'pricing_high_value', procedure: sp.id };
    }
  }

  // 2) Travel / booking intake originating from a foreign number.
  if (intent === 'travel_help' || intent === 'book_appointment') {
    const origin = classifyOrigin(waId, tenantConfig);
    if (origin.foreign) {
      const sp = safeSpecialty(text, tenantConfig);
      return {
        hot: true,
        reason: 'foreign_travel_intake',
        country: origin.country || undefined,
        ...(sp ? { procedure: sp.id } : {}),
      };
    }
  }

  // 3) Explicit foreign-origin statement anywhere in the message.
  const stated = safeOrigin(text);
  if (stated && stated.country && stated.country !== (tenantConfig?.country || 'Tunisia')) {
    const sp = safeSpecialty(text, tenantConfig);
    return {
      hot: true,
      reason: 'stated_foreign_origin',
      country: stated.country,
      ...(sp ? { procedure: sp.id } : {}),
    };
  }

  return { hot: false };
}

// Pure engine helpers can throw on malformed config; never let a classifier
// break a turn.
function safeSpecialty(text, tenantConfig) {
  try {
    return extractSpecialty(text, tenantConfig) || null;
  } catch {
    return null;
  }
}
function safeOrigin(text) {
  try {
    return extractOrigin(text) || null;
  } catch {
    return null;
  }
}
