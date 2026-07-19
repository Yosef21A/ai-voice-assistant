// Emergency + hot-lead DETECTORS — pure functions, ZERO I/O.
//
// These are the safety-critical and revenue-critical classifiers behind the
// owner-notification service (P1-E). They take plain values in and return plain
// verdicts out, so they are trivially unit-testable and can be reused anywhere
// (webhook path, simulator, sandbox, future per-tenant tuning). Nothing here
// reads a file, a clock, a DB, or the network.
//
// ── Design notes ─────────────────────────────────────────────────────────────
// • Multilingual by construction: separate AR / FR / EN keyword tables, incl.
//   Libyan/Tunisian colloquial Arabic forms (وجع / يوجعني / طاح / ما يفيقش …).
// • Conservative matching (guardrail: false NEGATIVES on emergencies are worse
//   than false positives, but we must not scream on every cardiology or
//   cosmetic-surgery inquiry):
//     - Latin (fr/en): whole-token / whole-phrase matching after accent + case
//       + apostrophe folding, so "pas de douleur" never trips a chest-pain rule
//       (there is no bare "douleur" keyword).
//     - Arabic: root-aware substring matching after diacritic + alef/ya/
//       ta-marbuta normalization, so prefixes (و/ب/ال/ف) and suffixes (ي/ك/نا)
//       still match.
//     - Ambiguous roots (صدر "chest" also in "مصدر"/breast cosmetics, قلب,
//       حساسية) require CO-OCCURRENCE with an acute marker, as { all: [...] }.
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
    .replace(/[\u064B-\u0655\u0670\u0640]/g, '') // harakat, hamza/madda marks, superscript alef, tatweel
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

// ── emergency keyword tables ─────────────────────────────────────────────────
// A matcher is either a string (phrase) or { all:[roots], label } (co-occurrence).
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
 * Detect an emergency in free text. Scans AR/FR/EN tables regardless of `lang`
 * (a fr-tagged conversation can still send Arabic), Arabic first since script is
 * self-identifying. `lang` only nudges which table is tried first.
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
      const has = L === 'ar' ? (k) => matchArabic(arabic, k) : (k) => matchLatin(latin, k);
      for (const m of list) {
        if (typeof m === 'string') {
          if (has(m)) return { hit: true, keyword: m, category, lang: L };
        } else if (m && Array.isArray(m.all)) {
          if (m.all.every(has)) return { hit: true, keyword: m.label || m.all.join(' + '), category, lang: L };
        }
      }
    }
  }
  return { hit: false };
}

function orderLangs(lang) {
  const all = ['ar', 'fr', 'en'];
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
