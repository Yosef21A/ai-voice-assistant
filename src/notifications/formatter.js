// Owner-facing alert + digest formatting — pure functions, ZERO I/O.
//
// This is the *presentation* layer of the owner-notification service (P1-E):
// it turns a domain event (booking / hot lead / handoff / emergency) or a
// digest-stats object into a concise, WhatsApp-native message written in the
// OWNER's language. Nothing here reads a store, a clock, or the network — the
// service layer resolves the tenant, the recipient and the language, then hands
// plain values in and gets a string out. That keeps every string trivially
// unit-testable and keeps ALL owner-facing copy in one file.
//
// ── Design notes ─────────────────────────────────────────────────────────────
// • Owner language defaults to FR (the founder's + most clinic owners' working
//   language). The service passes the resolved language in; `resolveOwnerLang`
//   is exported for callers that only hold a tenant record.
// • Every formatter is defensive: a missing field renders as an em-dash, never a
//   crash or a literal `undefined`, because an alert must survive a partial
//   payload from any emitter (server webhook, simulator, sandbox).
// • Datetime is rendered with Intl in the tenant timezone; if the runtime lacks
//   the tz data the raw ISO is shown rather than throwing.

const DASH = '—';

// ── language / locale helpers ────────────────────────────────────────────────

/** Owner alert language: explicit pref → tenant notifications config → FR. */
export function resolveOwnerLang(tenant, pref) {
  const cfg = tenantConfig(tenant);
  const lang =
    pref?.lang ||
    cfg?.notifications?.lang ||
    cfg?.ownerLang ||
    cfg?.owner?.lang ||
    'fr';
  return ['ar', 'fr', 'en'].includes(lang) ? lang : 'fr';
}

/** Unwrap a tenant *record* ({config}) or accept a bare clinic object. */
function tenantConfig(tenant) {
  if (!tenant || typeof tenant !== 'object') return {};
  if (tenant.config && typeof tenant.config === 'object') return tenant.config;
  return tenant;
}

function tenantName(tenant) {
  const cfg = tenantConfig(tenant);
  return tenant?.name || cfg?.name || null;
}

function tenantTimezone(tenant) {
  const cfg = tenantConfig(tenant);
  return tenant?.timezone || cfg?.timezone || 'Africa/Tunis';
}

function tenantCurrency(tenant) {
  const cfg = tenantConfig(tenant);
  return tenant?.currency || cfg?.currency || null;
}

const LOCALES = { ar: 'ar', fr: 'fr-FR', en: 'en-GB' };

function pick(lang, table) {
  return table[lang] || table.fr || table.en;
}

function val(x) {
  const s = x == null ? '' : String(x).trim();
  return s === '' ? DASH : s;
}

/** Human-readable datetime in the tenant tz; falls back to the raw value. */
export function formatDateTime(iso, { tz = 'Africa/Tunis', lang = 'fr' } = {}) {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  try {
    return new Intl.DateTimeFormat(LOCALES[lang] || 'fr-FR', {
      timeZone: tz,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(d);
  } catch {
    return String(iso);
  }
}

/** Group thousands with a thin space: 8400 → "8 400". Deterministic, no locale. */
export function groupThousands(n) {
  const num = Math.round(Number(n) || 0);
  return String(num).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Turn a specialty id into a readable label ("cosmetic_surgery" → "cosmetic surgery"). */
function prettyProcedure(lead, lang) {
  const p = lead?.procedureLabel || lead?.procedure;
  if (!p) return null;
  return String(p).replace(/_/g, ' ');
}

// ── instant alerts ───────────────────────────────────────────────────────────

const BOOKING = {
  ar: (v) =>
    `✅ حجز جديد\n👤 ${v.patient}\n🩺 ${v.specialty}\n📅 ${v.when}\n🔖 ${v.ref}`,
  fr: (v) =>
    `✅ Nouvelle réservation\n👤 ${v.patient}\n🩺 ${v.specialty}\n📅 ${v.when}\n🔖 ${v.ref}`,
  en: (v) =>
    `✅ New booking\n👤 ${v.patient}\n🩺 ${v.specialty}\n📅 ${v.when}\n🔖 ${v.ref}`,
};

/** New-booking alert (patient, specialty, datetime, ref). */
export function formatBooking({ tenant, appointment = {}, lang } = {}) {
  const L = lang || resolveOwnerLang(tenant);
  const iso =
    appointment.datetimeISO ||
    appointment.datetimeIso ||
    appointment.datetime ||
    appointment.slotIso;
  const body = pick(L, BOOKING)({
    patient: val(appointment.patientName || appointment.name || appointment.patient),
    specialty: val(appointment.specialtyLabel || appointment.specialty),
    when: appointment.whenText
      ? val(appointment.whenText)
      : formatDateTime(iso, { tz: tenantTimezone(tenant), lang: L }),
    ref: val(appointment.ref || appointment.id),
  });
  return withClinicTag(body, tenant);
}

const LEAD_WHY = {
  pricing_high_value: {
    ar: (v) => `طلب سعر لإجراء عالي القيمة${v.proc ? ` (${v.proc})` : ''}`,
    fr: (v) => `Demande de devis, procédure à forte valeur${v.proc ? ` (${v.proc})` : ''}`,
    en: (v) => `Price request on a high-value procedure${v.proc ? ` (${v.proc})` : ''}`,
  },
  foreign_travel_intake: {
    ar: (v) => `مريض دولي${v.country ? ` من ${v.country}` : ''} يسأل على العلاج والسفر`,
    fr: (v) => `Patient international${v.country ? ` (${v.country})` : ''} — voyage médical`,
    en: (v) => `International patient${v.country ? ` (${v.country})` : ''} — medical travel`,
  },
  stated_foreign_origin: {
    ar: (v) => `مريض جاي${v.country ? ` من ${v.country}` : ' من الخارج'}`,
    fr: (v) => `Patient venant${v.country ? ` de ${v.country}` : " de l'étranger"}`,
    en: (v) => `Patient coming${v.country ? ` from ${v.country}` : ' from abroad'}`,
  },
};

const LEAD = {
  ar: (v) =>
    `🔥 عميل مهم (Lead)\n👤 ${v.who}\n🩺 ${v.what}\nℹ️ ${v.why}\n⏱️ رد بسرعة — السرعة = حجز.`,
  fr: (v) =>
    `🔥 Lead à forte valeur\n👤 ${v.who}\n🩺 ${v.what}\nℹ️ ${v.why}\n⏱️ Répondez vite — la vitesse = la réservation.`,
  en: (v) =>
    `🔥 Hot lead\n👤 ${v.who}\n🩺 ${v.what}\nℹ️ ${v.why}\n⏱️ Reply fast — speed wins the booking.`,
};

const WHAT_FALLBACK = { ar: 'استفسار عالي القيمة', fr: 'Demande à forte valeur', en: 'High-value inquiry' };

/** Hot-lead alert (who / what / why + reply-fast nudge). */
export function formatHotLead({ tenant, lead = {}, patientWaId, lang } = {}) {
  const L = lang || resolveOwnerLang(tenant);
  const proc = prettyProcedure(lead, L);
  const whyTable = LEAD_WHY[lead.reason];
  const why = whyTable
    ? pick(L, whyTable)({ proc, country: lead.country })
    : pick(L, LEAD_WHY.pricing_high_value)({ proc, country: lead.country });
  const body = pick(L, LEAD)({
    who: val(lead.patientName || patientWaId || lead.patientWaId),
    what: proc ? val(proc) : WHAT_FALLBACK[L] || WHAT_FALLBACK.fr,
    why,
  });
  return withClinicTag(body, tenant);
}

const HANDOFF = {
  ar: (v) =>
    `🙋 طلب موظف بشري\n👤 ${v.who}\n💬 "${v.msg}"\nالبوت توقف وترك المحادثة للفريق.`,
  fr: (v) =>
    `🙋 Demande de conseiller humain\n👤 ${v.who}\n💬 "${v.msg}"\nLe bot s'est mis en retrait.`,
  en: (v) =>
    `🙋 Human handoff requested\n👤 ${v.who}\n💬 "${v.msg}"\nThe bot has stepped back.`,
};

/** Human-handoff alert (who + last patient message). */
export function formatHandoff({ tenant, handoff = {}, patientWaId, lastMessage, lang } = {}) {
  const L = lang || resolveOwnerLang(tenant);
  const body = pick(L, HANDOFF)({
    who: val(handoff.patientName || patientWaId || handoff.patientWaId),
    msg: val(lastMessage || handoff.lastMessage),
  });
  return withClinicTag(body, tenant);
}

const EMERGENCY = {
  ar: (v) =>
    `🚨 حالة طوارئ\n👤 ${v.who}\n⚠️ كلمة: "${v.keyword}"\nتم إرسال رقم الطوارئ للمريض والبوت توقف. تدخّل حالاً.`,
  fr: (v) =>
    `🚨 URGENCE détectée\n👤 ${v.who}\n⚠️ Mot-clé : "${v.keyword}"\nNuméro d'urgence envoyé au patient, le bot s'est retiré. Intervenez immédiatement.`,
  en: (v) =>
    `🚨 EMERGENCY detected\n👤 ${v.who}\n⚠️ Keyword: "${v.keyword}"\nEmergency number sent to the patient, the bot stepped back. Step in now.`,
};

/** Emergency alert (who, keyword, "emergency number sent, bot stepped back"). */
export function formatEmergency({ tenant, keyword, patientWaId, lang } = {}) {
  const L = lang || resolveOwnerLang(tenant);
  const body = pick(L, EMERGENCY)({
    who: val(patientWaId),
    keyword: val(keyword),
  });
  return withClinicTag(body, tenant);
}

const MEDIA_KIND_LABEL = {
  image: { ar: 'صورة / أشعة', fr: 'Photo / radio', en: 'Photo / X-ray' },
  document: { ar: 'ملف', fr: 'Document', en: 'Document' },
  audio: { ar: 'رسالة صوتية', fr: 'Note vocale', en: 'Voice note' },
};

const MEDIA = {
  ar: (v) => `📎 وصل ${v.kind}\n👤 ${v.who}${v.caption ? `\n💬 "${v.caption}"` : ''}\nتلقّى المريض تأكيد الاستلام؛ الملف في لوحة التحكم.`,
  fr: (v) => `📎 ${v.kind} reçu(e)\n👤 ${v.who}${v.caption ? `\n💬 "${v.caption}"` : ''}\nLe patient a reçu un accusé ; le fichier est dans le tableau de bord.`,
  en: (v) => `📎 ${v.kind} received\n👤 ${v.who}${v.caption ? `\n💬 "${v.caption}"` : ''}\nThe patient got a receipt; the file is in the dashboard.`,
};

/** Media-received alert (kind + who + optional caption). */
export function formatMedia({ tenant, media = {}, patientWaId, lang } = {}) {
  const L = lang || resolveOwnerLang(tenant);
  const kindTable = MEDIA_KIND_LABEL[media.kind] || MEDIA_KIND_LABEL.document;
  const body = pick(L, MEDIA)({
    kind: kindTable[L] || kindTable.fr,
    who: val(patientWaId),
    caption: media.caption ? String(media.caption).slice(0, 120) : '',
  });
  return withClinicTag(body, tenant);
}

function withClinicTag(body, tenant) {
  const name = tenantName(tenant);
  return name ? `${body}\n🏥 ${name}` : body;
}

/**
 * Single dispatch entry used by the service: map a bus event type + a plain
 * data bag to the right formatter. Keeps the service free of copy decisions.
 * @param {string} type  bus event type
 * @param {object} data  { tenant, lang, appointment?, lead?, handoff?, keyword?,
 *                         patientWaId?, lastMessage? }
 */
export function formatAlert(type, data = {}) {
  switch (type) {
    case 'appointment.created':
      return formatBooking(data);
    case 'lead.hot':
      return formatHotLead(data);
    case 'handoff.requested':
      return formatHandoff(data);
    case 'emergency.detected':
      return formatEmergency(data);
    case 'media.received':
      return formatMedia(data);
    default:
      return '';
  }
}

// ── digests ──────────────────────────────────────────────────────────────────

const DIGEST_TITLE = {
  daily: { ar: 'ملخص اليوم', fr: 'Résumé quotidien', en: 'Daily summary' },
  weekly: { ar: 'التقرير الأسبوعي', fr: 'Rapport hebdomadaire', en: 'Weekly report' },
};
const DIGEST_LABELS = {
  ar: { convos: '💬 محادثات', bookings: '📅 حجوزات', leads: '🔥 عملاء محتملون', after: '🌙 خارج الدوام', money: '💶 القيمة المقدّرة المحصّلة' },
  fr: { convos: '💬 Conversations', bookings: '📅 Réservations', leads: '🔥 Leads', after: '🌙 Hors horaires', money: '💶 Valeur estimée captée' },
  en: { convos: '💬 Conversations', bookings: '📅 Bookings', leads: '🔥 Leads', after: '🌙 After-hours', money: '💶 Estimated captured value' },
};

function formatDigest(kind, stats = {}, { tenant, lang } = {}) {
  const L = lang || resolveOwnerLang(tenant);
  const name = tenantName(tenant) || val(stats.clinicName);
  const lbl = DIGEST_LABELS[L] || DIGEST_LABELS.fr;
  const title = pick(L, DIGEST_TITLE[kind] || DIGEST_TITLE.daily);

  const pct =
    stats.afterHoursPct != null
      ? Math.round(stats.afterHoursPct)
      : Math.round((Number(stats.afterHoursShare) || 0) * 100);

  const lines = [
    `📊 ${title}${name ? ` — ${name}` : ''}`,
    `${lbl.convos} : ${Number(stats.conversations) || 0}`,
    `${lbl.bookings} : ${Number(stats.bookings) || 0}`,
    `${lbl.leads} : ${Number(stats.leads) || 0}`,
    `${lbl.after} : ${pct}%`,
  ];

  // Money line only when an average procedure value is configured (guardrail:
  // never invent a captured-value number the owner didn't set up).
  const money = Number(stats.money);
  if (Number.isFinite(money) && money > 0) {
    const cur = tenantCurrency(tenant) || stats.currency || '';
    lines.push(`${lbl.money} : ≈ ${groupThousands(money)}${cur ? ` ${cur}` : ''}`);
  }
  return lines.join('\n');
}

/** Morning digest (yesterday's numbers + money line). */
export function formatDailyDigest(stats, opts = {}) {
  return formatDigest('daily', stats, opts);
}

/** Weekly report (7-day numbers + money line). */
export function formatWeeklyDigest(stats, opts = {}) {
  return formatDigest('weekly', stats, opts);
}

export default {
  resolveOwnerLang,
  formatDateTime,
  groupThousands,
  formatBooking,
  formatHotLead,
  formatHandoff,
  formatEmergency,
  formatAlert,
  formatDailyDigest,
  formatWeeklyDigest,
};
