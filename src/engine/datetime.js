// Lightweight, dependency-free natural-language date/time parsing for AR/FR/EN,
// plus slot resolution against a clinic's working hours. Deliberately pragmatic:
// it understands the common ways patients phrase a time, and ALWAYS falls back
// to the next open slot so the booking flow can never dead-end.
import { WD_KEYS, SLOT_MIN, toMins } from '../store/availability.js';
import { normalizeDigits as normDigits } from './text.js';

const WEEKDAY_WORDS = {
  0: ['sunday', 'dimanche', 'الاحد', 'الأحد', 'احد'],
  1: ['monday', 'lundi', 'الاثنين', 'الإثنين', 'الاتنين', 'اثنين'],
  2: ['tuesday', 'mardi', 'الثلاثاء', 'الثلاثا', 'ثلاثاء'],
  3: ['wednesday', 'mercredi', 'الاربعاء', 'الأربعاء', 'اربعاء'],
  4: ['thursday', 'jeudi', 'الخميس', 'خميس'],
  5: ['friday', 'vendredi', 'الجمعة', 'الجمعه', 'جمعة'],
  6: ['saturday', 'samedi', 'السبت', 'سبت'],
};

const WEEKDAY_NAMES = {
  ar: ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'],
  fr: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};

function offsetDate(now, days) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate() };
}

function nextWeekday(now, target) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const add = (target - d.getDay() + 7) % 7; // 0 == today
  d.setDate(d.getDate() + add);
  return { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate() };
}

/**
 * Parse a free-text time expression into { date, hour, minute } (any may be null).
 * @param {string} text
 * @param {Date} now
 */
export function parseDateTimeRequest(text, now) {
  const t = normDigits(text).toLowerCase();
  let hour = null;
  let minute = null;
  let date = null;
  let bareHour = false;

  // ── time: explicit separator forms ──
  let m = t.match(/(\d{1,2})\s*[:h]\s*(\d{2})?/); // 10:30 / 10h / 10h30
  if (m) {
    hour = +m[1];
    minute = m[2] != null ? +m[2] : 0;
  }

  // ── date: explicit ISO ── (parsed before the lone-number rule so the date's
  // own digits can never be mistaken for an hour)
  let rest = t;
  m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    date = { y: +m[1], mo: +m[2] - 1, d: +m[3] };
    rest = rest.replace(m[0], ' ');
  }

  // ── date: relative words ──
  if (!date) {
    if (/(بعد غد|بعد غدا|apres-demain|après-demain|day after tomorrow)/.test(t)) date = offsetDate(now, 2);
    else if (/(غدا|غدًا|غداً|بكرة|demain|tomorrow)/.test(t)) date = offsetDate(now, 1);
    else if (/(اليوم|aujourd'?hui|today)/.test(t)) date = offsetDate(now, 0);
  }

  // ── date: weekday name ──
  if (!date) {
    for (const [wd, words] of Object.entries(WEEKDAY_WORDS)) {
      if (words.some((w) => t.includes(w))) {
        date = nextWeekday(now, +wd);
        break;
      }
    }
  }

  // ── time: lone number ── Trusted when a time-context word OR a date is
  // present: "اثنين ١٠" means Monday at 10 — dropping the 10 silently booked
  // the wrong slot (live failure F4).
  if (hour == null) {
    const hasTimeWord = /(ساعة|صباح|مساء|عشية|matin|soir|midi|heure|apres-?midi|après-?midi|morning|afternoon|evening|\bam\b|\bpm\b|\bat\b|على\s|à)/.test(t);
    m = rest.match(/\b(\d{1,2})\b/);
    if (m && +m[1] <= 23 && (hasTimeWord || date)) {
      hour = +m[1];
      minute = 0;
      bareHour = true;
    }
  }

  if (hour != null) {
    // Word-bounded am/pm: bare "am" is a substring of "samedi" (French
    // Saturday), which silently made the afternoon inference below fire only on
    // some weekdays. Boundaries keep the meridiem tied to a real am/pm token.
    const pm = /(مساء|عشية|soir|apres-?midi|après-?midi|afternoon|evening|\bpm\b)/.test(t);
    const am = /(صباح|matin|morning|\bam\b)/.test(t);
    if (pm && hour < 12) hour += 12;
    if (am && hour === 12) hour = 0;
    // A bare 1-7 with no am/pm marker means the afternoon in clinic context
    // ("الخميس 3" = Thursday 15:00, nobody books a 3 AM consultation).
    if (bareHour && !pm && !am && hour >= 1 && hour <= 7) hour += 12;
  }

  return { date, hour, minute, raw: text };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Local "YYYY-MM-DDTHH:MM" (no timezone math — kept human-readable). */
export function toLocalISO(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Human-friendly localized date, e.g. "lundi 03/08/2026 10:00". */
export function formatWhen(date, lang) {
  const names = WEEKDAY_NAMES[lang] || WEEKDAY_NAMES.fr;
  return (
    `${names[date.getDay()]} ${pad(date.getDate())}/${pad(date.getMonth() + 1)}/` +
    `${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * Resolve a concrete, bookable slot from a (possibly partial) request.
 * Guarantees a slot inside working hours and at least LEAD_MS in the future,
 * scanning up to 21 days ahead. Returns null only if the clinic has no hours.
 *
 * @returns {{iso:string, date:Date, adjusted:boolean, dayKey:string}|null}
 */
export function resolveSlot(clinic, req, now) {
  const LEAD_MS = 60 * 60 * 1000; // 1h minimum lead time
  const earliest = new Date(now.getTime() + LEAD_MS);
  const base = req.date
    ? new Date(req.date.y, req.date.mo, req.date.d)
    : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const wantHour = req.hour;
  const wantMin = req.minute != null ? req.minute : 0;

  for (let i = 0; i < 21; i++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    const hours = clinic.workingHours?.[WD_KEYS[day.getDay()]];
    if (!hours) continue;
    const open = toMins(hours[0]);
    const close = toMins(hours[1]);
    const lastSlot = close - SLOT_MIN;
    if (lastSlot < open) continue; // window too small for a slot

    // Desired start, CLAMPED into the bookable window. A too-late request snaps
    // to the last slot of the day rather than skipping the day entirely.
    let want = wantHour != null ? wantHour * 60 + wantMin : open;
    if (want < open) want = open;
    if (want > lastSlot) want = lastSlot;

    let cand = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(want / 60), want % 60);

    if (cand.getTime() < earliest.getTime()) {
      const sameDayAsEarliest =
        earliest.getFullYear() === day.getFullYear() &&
        earliest.getMonth() === day.getMonth() &&
        earliest.getDate() === day.getDate();
      if (!sameDayAsEarliest) continue; // this whole day is before "now"
      const em = earliest.getHours() * 60 + earliest.getMinutes();
      let bumped = Math.ceil(Math.max(want, em) / SLOT_MIN) * SLOT_MIN;
      if (bumped < open) bumped = open;
      if (bumped > lastSlot) continue; // no room left today
      cand = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(bumped / 60), bumped % 60);
      if (cand.getTime() < earliest.getTime()) continue;
    }

    const adjusted =
      (wantHour != null && (cand.getHours() !== wantHour || cand.getMinutes() !== wantMin)) ||
      (!!req.date &&
        (cand.getFullYear() !== base.getFullYear() ||
          cand.getMonth() !== base.getMonth() ||
          cand.getDate() !== base.getDate()));

    return { iso: toLocalISO(cand), date: cand, adjusted, dayKey: WD_KEYS[day.getDay()] };
  }
  return null;
}
