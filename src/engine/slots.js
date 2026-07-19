// Slot extractors for the booking flow: specialty, patient name, origin
// (city/country) and contact number. Plus a yes/no detector for confirmation.
const AR_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };

/** Lowercase + strip Latin diacritics (Arabic left intact). */
export function normalize(s = '') {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

function normDigits(s) {
  return String(s).replace(/[٠-٩]/g, (d) => AR_DIGITS[d]);
}

/**
 * Match a clinic specialty by id, localized label, or synonym.
 * @returns the specialty object or null
 */
export function extractSpecialty(text, clinic) {
  const t = normalize(text);
  if (!t) return null;
  for (const sp of clinic.specialties || []) {
    const candidates = [
      sp.id.replace(/_/g, ' '),
      sp.labels?.ar,
      sp.labels?.fr,
      sp.labels?.en,
      ...(sp.synonyms || []),
    ].filter(Boolean);
    for (const c of candidates) {
      if (t.includes(normalize(c))) return sp;
    }
  }
  return null;
}

const NAME_PREFIXES = [
  /^اسمي( هو)?\s+/,
  /^انا\s+/,
  /^أنا\s+/,
  /^اسمي\s+/,
  /^je m'appelle\s+/i,
  /^je suis\s+/i,
  /^moi c'est\s+/i,
  /^mon nom est\s+/i,
  /^my name is\s+/i,
  /^i am\s+/i,
  /^i'm\s+/i,
  /^this is\s+/i,
  /^name\s*:?\s*/i,
];

/** Strip a leading "my name is / je m'appelle / اسمي" and return the name. */
export function extractName(text, _lang) {
  let s = String(text || '').trim();
  for (const re of NAME_PREFIXES) {
    if (re.test(s)) {
      s = s.replace(re, '').trim();
      break;
    }
  }
  s = s.replace(/[.,،!؟?]+$/g, '').trim();
  return s || null;
}

// Canonical Libyan cities and their AR/FR/EN variants.
const LIBYAN_CITIES = [
  { city: 'Tripoli', variants: ['tripoli', 'طرابلس'] },
  { city: 'Benghazi', variants: ['benghazi', 'bengasi', 'بنغازي'] },
  { city: 'Misrata', variants: ['misrata', 'misurata', 'مصراتة', 'مصراته'] },
  { city: 'Zawiya', variants: ['zawiya', 'zawiyah', 'الزاوية'] },
  { city: 'Sabha', variants: ['sabha', 'sebha', 'سبها'] },
  { city: 'Sirte', variants: ['sirte', 'surt', 'سرت'] },
  { city: 'Tobruk', variants: ['tobruk', 'tobruq', 'طبرق'] },
  { city: 'Derna', variants: ['derna', 'درنة'] },
  { city: 'Zliten', variants: ['zliten', 'زليتن'] },
  { city: 'Khoms', variants: ['khoms', 'alkhums', 'الخمس'] },
  { city: 'Ajdabiya', variants: ['ajdabiya', 'اجدابيا', 'أجدابيا'] },
  { city: 'Sabratha', variants: ['sabratha', 'صبراتة'] },
];

const COUNTRY_HINTS = [
  { country: 'Libya', variants: ['libya', 'libye', 'ليبيا'] },
  { country: 'Tunisia', variants: ['tunisia', 'tunisie', 'تونس'] },
  { country: 'Algeria', variants: ['algeria', 'algerie', 'الجزائر'] },
];

/**
 * Extract origin city + country. Because this is a Libya-focused product, a
 * recognised Libyan city implies Libya when no country is stated.
 * @returns {{city:string|null, country:string|null, raw:string}}
 */
export function extractOrigin(text) {
  const raw = String(text || '').trim();
  const t = normalize(raw);
  let city = null;
  let country = null;

  for (const c of LIBYAN_CITIES) {
    if (c.variants.some((v) => t.includes(normalize(v)))) {
      city = c.city;
      break;
    }
  }
  for (const c of COUNTRY_HINTS) {
    if (c.variants.some((v) => t.includes(normalize(v)))) {
      country = c.country;
      break;
    }
  }
  if (!country && city) country = 'Libya';

  if (!city) {
    // Fall back to "from X" / "de X" / "من X" capture.
    const m = raw.match(/(?:from|de|من|d')\s+([A-Za-z؀-ۿ][\w؀-ۿ\s-]{1,40})/i);
    if (m) city = m[1].trim().replace(/[،,.].*$/, '').trim();
  }

  return { city: city || null, country: country || null, raw };
}

/** Extract the first plausible phone number. Returns a cleaned string or null. */
export function extractContact(text) {
  const t = normDigits(text || '');
  const m = t.match(/(\+?\d[\d\s().-]{6,}\d)/);
  if (!m) return null;
  const cleaned = m[1].replace(/[\s().-]/g, '');
  return cleaned.length >= 7 ? cleaned : null;
}

const YES = {
  ar: ['نعم', 'ايه', 'أيه', 'اي', 'أكد', 'اكد', 'موافق', 'تمام', 'اوكي', 'أوكي', 'صحيح', 'باهي', 'ايوه'],
  fr: ['oui', 'confirme', 'confirmer', 'confirmé', "d'accord", 'daccord', 'ok', 'okay', 'parfait', 'exact', 'correct', 'ouais'],
  en: ['yes', 'yeah', 'yep', 'confirm', 'confirmed', 'ok', 'okay', 'sure', 'correct', 'right', 'good'],
};
const NO = {
  ar: ['لا', 'الغاء', 'إلغاء', 'بطل', 'ما نحبش', 'موش', 'مش'],
  fr: ['non', 'annuler', 'annule', 'pas', 'faux'],
  en: ['no', 'nope', 'cancel', 'wrong', 'incorrect'],
};

/** @returns {'yes'|'no'|null} */
export function detectYesNo(text) {
  const t = normalize(text);
  const toks = new Set(t.split(/[\s.,،!؟?()]+/).filter(Boolean));
  // Single words must match a whole token (so Arabic "لا" won't match inside
  // another word); multi-word phrases fall back to a substring test.
  const has = (list) =>
    list.some((w) => {
      const n = normalize(w);
      return n.includes(' ') ? t.includes(n) : toks.has(n);
    });
  const yes = has(YES.ar) || has(YES.fr) || has(YES.en);
  const no = has(NO.ar) || has(NO.fr) || has(NO.en);
  if (yes) return 'yes'; // confirmation intent wins ties
  if (no) return 'no';
  return null;
}
