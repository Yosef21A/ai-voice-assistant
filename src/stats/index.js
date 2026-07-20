// Shared analytics module (P2-A) — ONE aggregation source of truth so the
// dashboard "Statistiques" screen and the daily/weekly WhatsApp digests can
// never disagree on a number.
//
// Layout:
//   • pure time helpers (parseHM / minutesInTz / weekdayInTz / isAfterHours)
//     — moved here from src/notifications/service.js, which now re-exports
//     them for back-compat;
//   • computeDigestStats(storeData, range)  — the digest aggregate (pure);
//   • computeAnalytics(storeData, range)    — superset for the dashboard (pure);
//   • collectDigestStats / collectAnalytics — the I/O step (fetch via the store
//     interface, then call the pure function), shared by the digest runner and
//     GET /api/stats.
//
// Conventions decided here (and now applied to BOTH digest and dashboard):
//   • sandbox traffic (waId `sandbox:<uid>` / channel 'sandbox') is excluded —
//     the appointments API already excluded it; digests previously did not;
//   • window is inclusive-from / EXCLUSIVE-to;
//   • conversation activity ts = lastMessageAt || updatedAt || createdAt;
//   • money line: avgValue resolution order range.avgValue →
//     cfg.notifications.avgProcedureValue → cfg.avgProcedureValue →
//     cfg.avgBookingValue → null (null ⇒ the UI hides the money line);
//   • "bookings" (digest) === funnel.bookingConfirmed (dashboard): appointments
//     CREATED in-window with status !== 'cancelled'.

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const QUESTION_INTENTS = new Set(['faq', 'unknown', 'pricing_quote', 'travel_help']);

export const isSandboxWaId = (waId) => String(waId || '').startsWith('sandbox:');

function cfgOf(tenant) {
  if (!tenant || typeof tenant !== 'object') return {};
  return tenant.config && typeof tenant.config === 'object' ? tenant.config : tenant;
}

// ── time helpers (tz-aware, Intl-based) ───────────────────────────────────────

/** 'HH:MM' (or fractional hours number) → minutes since midnight, else null. */
export function parseHM(hm) {
  if (hm == null) return null;
  if (typeof hm === 'number') return Math.max(0, Math.min(1439, Math.round(hm * 60)));
  const m = String(hm).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minutes-since-midnight of `date` in `tz` (Intl-based; falls back to local). */
export function minutesInTz(date, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    const mi = Number(parts.find((p) => p.type === 'minute')?.value);
    if (Number.isFinite(h) && Number.isFinite(mi)) return (h % 24) * 60 + mi;
  } catch {
    /* fall through */
  }
  return date.getHours() * 60 + date.getMinutes();
}

/** Weekday key ('mon'…'sun') of `date` in `tz`. */
export function weekdayInTz(date, tz) {
  try {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date);
    return wd.toLowerCase().slice(0, 3);
  } catch {
    return DAY_KEYS[date.getDay()];
  }
}

/**
 * Whether a timestamp is outside the clinic's working hours (closed day ⇒ true).
 * Handles overnight windows (e.g. ['20:00','02:00']) the same way quiet hours
 * do: the window wraps past midnight.
 */
export function isAfterHours(ts, workingHours, tz) {
  if (!workingHours) return false; // unknown schedule ⇒ don't overstate
  const day = weekdayInTz(new Date(ts), tz);
  const wh = workingHours[day];
  if (!Array.isArray(wh) || wh.length < 2) return true; // null / closed day
  const open = parseHM(wh[0]);
  const close = parseHM(wh[1]);
  if (open == null || close == null) return true;
  const mins = minutesInTz(new Date(ts), tz);
  const within = open <= close ? mins >= open && mins < close : mins >= open || mins < close;
  return !within;
}

// ── shared row predicates ─────────────────────────────────────────────────────

const convoWaId = (c) => c.patientWaId ?? c.waId;
const realConvo = (c) => !isSandboxWaId(convoWaId(c));
const realAppt = (a) => !isSandboxWaId(a.patientWaId) && a.channel !== 'sandbox';
const activityTs = (c) => c.lastMessageAt || c.updatedAt || c.createdAt;

function rangePredicate(range) {
  const from = new Date(range.from).getTime();
  const to = new Date(range.to).getTime();
  return (ts) => {
    if (!ts) return false;
    const t = new Date(ts).getTime();
    return Number.isFinite(t) && t >= from && t < to;
  };
}

function resolveAvgValue(cfg, range) {
  if (range.avgValue != null) return Number(range.avgValue);
  if (cfg?.notifications?.avgProcedureValue != null) return Number(cfg.notifications.avgProcedureValue);
  if (cfg?.avgProcedureValue != null) return Number(cfg.avgProcedureValue);
  if (cfg?.avgBookingValue != null) return Number(cfg.avgBookingValue);
  return null;
}

// ── digest aggregate (PURE — the reference numbers) ───────────────────────────
/**
 * Aggregate a tenant's raw collections into digest numbers. No I/O, no clock.
 * @param {object} storeData { tenant, conversations[], appointments[], leads[] }
 * @param {object} range     { from, to, tz?, avgValue? }
 */
export function computeDigestStats(storeData = {}, range = {}) {
  const tenant = storeData.tenant || {};
  const cfg = cfgOf(tenant);
  const tz = range.tz || tenant.timezone || cfg.timezone || 'Africa/Tunis';
  const inRange = rangePredicate(range);
  const workingHours = cfg.workingHours || null;

  let convoCount = 0;
  let afterHours = 0;
  for (const c of storeData.conversations || []) {
    if (!realConvo(c)) continue;
    const ts = activityTs(c);
    if (!inRange(ts)) continue;
    convoCount += 1;
    if (isAfterHours(ts, workingHours, tz)) afterHours += 1;
  }

  const bookings = (storeData.appointments || []).filter(
    (a) => realAppt(a) && inRange(a.createdAt) && a.status !== 'cancelled'
  ).length;

  const leads = (storeData.leads || []).filter(
    (l) => !isSandboxWaId(l.patientWaId) && inRange(l.createdAt)
  ).length;

  const avgValue = resolveAvgValue(cfg, range);
  const money = avgValue != null && Number.isFinite(avgValue) ? bookings * avgValue : null;
  const afterHoursShare = convoCount > 0 ? afterHours / convoCount : 0;

  return {
    conversations: convoCount,
    bookings,
    leads,
    afterHours,
    afterHoursShare,
    afterHoursPct: Math.round(afterHoursShare * 100),
    money,
    avgValue,
    currency: tenant.currency || cfg.currency || null,
    clinicName: tenant.name || cfg.name || null,
    from: new Date(range.from).toISOString(),
    to: new Date(range.to).toISOString(),
  };
}

// ── dashboard aggregate (PURE superset) ───────────────────────────────────────
/**
 * Everything the "Statistiques" screen needs. Extends computeDigestStats with
 * hour buckets, response time, language split, intents/questions and the
 * booking funnel. Intent/question data comes from persisted `message.analyzed`
 * events (written by ingest since P2-A) and therefore only covers traffic from
 * deployment forward — counts are 0 on older data, never wrong.
 *
 * @param {object} storeData { tenant, conversations[], appointments[], leads[],
 *                             events[], messagesByConvo: Map<convoId, message[]> }
 * @param {object} range     { from, to, tz?, avgValue? }
 */
export function computeAnalytics(storeData = {}, range = {}) {
  const digest = computeDigestStats(storeData, range);
  const tenant = storeData.tenant || {};
  const cfg = cfgOf(tenant);
  const tz = range.tz || tenant.timezone || cfg.timezone || 'Africa/Tunis';
  const inRange = rangePredicate(range);

  const conversations = (storeData.conversations || []).filter(realConvo);
  const inRangeConvos = conversations.filter((c) => inRange(activityTs(c)));

  // 24h heatmap — one bucket per in-window conversation, tz-local hour.
  const conversationsByHour = Array.from({ length: 24 }, () => 0);
  for (const c of inRangeConvos) {
    const hour = Math.floor(minutesInTz(new Date(activityTs(c)), tz) / 60) % 24;
    conversationsByHour[hour] += 1;
  }

  // Language split — conversation-level lang covers all history (the engine
  // persists convo.lang), unlike per-message events which start at P2-A.
  const languageSplit = { ar: 0, fr: 0, en: 0, other: 0 };
  for (const c of inRangeConvos) {
    const l = c.lang;
    if (l === 'ar' || l === 'fr' || l === 'en') languageSplit[l] += 1;
    else languageSplit.other += 1;
  }

  // Message volume + response time (median inbound → first outbound, seconds).
  let messageCount = 0;
  const deltas = [];
  const byConvo = storeData.messagesByConvo || new Map();
  const listsOf = typeof byConvo.values === 'function' ? [...byConvo.values()] : Object.values(byConvo);
  for (const msgs of listsOf) {
    let pendingInboundMs = null;
    for (const m of msgs || []) {
      if (inRange(m.ts)) messageCount += 1;
      const t = new Date(m.ts).getTime();
      if (!Number.isFinite(t)) continue;
      if (m.direction === 'inbound') {
        // First inbound of a patient burst starts the clock (in-window only).
        if (pendingInboundMs == null && inRange(m.ts)) pendingInboundMs = t;
      } else if (m.direction === 'outbound' && pendingInboundMs != null && t >= pendingInboundMs) {
        deltas.push((t - pendingInboundMs) / 1000);
        pendingInboundMs = null;
      }
    }
  }
  deltas.sort((a, b) => a - b);
  const responseTimeMedianSec = deltas.length
    ? deltas.length % 2
      ? deltas[(deltas.length - 1) / 2]
      : (deltas[deltas.length / 2 - 1] + deltas[deltas.length / 2]) / 2
    : null;

  // Intents + top questions from persisted message.analyzed events.
  const analyzed = (storeData.events || []).filter(
    (e) => e.type === 'message.analyzed' && inRange(e.createdAt)
  );
  const intentCounts = new Map();
  const questionGroups = new Map(); // normalized → {text, lang, count}
  const bookingStartedConvos = new Set();
  for (const e of analyzed) {
    const intent = e.payload?.intent || 'unknown';
    intentCounts.set(intent, (intentCounts.get(intent) || 0) + 1);
    if (intent === 'book_appointment' && e.conversationId) bookingStartedConvos.add(e.conversationId);
    if (QUESTION_INTENTS.has(intent) && e.payload?.snippet) {
      const norm = normalizeQuestion(e.payload.snippet);
      if (!norm) continue;
      const g = questionGroups.get(norm) || { text: e.payload.snippet, lang: e.payload.lang || null, count: 0 };
      g.count += 1;
      questionGroups.set(norm, g);
    }
  }
  const topIntents = [...intentCounts.entries()]
    .map(([intent, count]) => ({ intent, count }))
    .sort((a, b) => b.count - a.count || a.intent.localeCompare(b.intent))
    .slice(0, 8);
  const topQuestions = [...questionGroups.values()]
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, 8);
  const unknownCount = intentCounts.get('unknown') || 0;
  const unknownRate = analyzed.length > 0 ? unknownCount / analyzed.length : null;

  // Funnel + appointment status breakdown (in-window created, sandbox excluded).
  const inRangeAppts = (storeData.appointments || []).filter((a) => realAppt(a) && inRange(a.createdAt));
  const apptStatuses = { pending: 0, confirmed: 0, done: 0, no_show: 0, cancelled: 0 };
  for (const a of inRangeAppts) {
    if (a.status in apptStatuses) apptStatuses[a.status] += 1;
  }
  const funnel = {
    conversations: digest.conversations,
    bookingStarted: bookingStartedConvos.size,
    bookingConfirmed: digest.bookings, // same definition as the digest money base
  };

  return {
    ...digest,
    tz,
    conversationsByHour,
    languageSplit,
    messageCount,
    responseTimeMedianSec,
    topIntents,
    topQuestions,
    unknownCount,
    unknownRate,
    funnel,
    apptStatuses,
    workingHours: cfg.workingHours || null, // lets the UI draw the after-hours band
  };
}

/**
 * Dedupe key for questions: lowercase, strip diacritics (French accents and
 * Arabic tashkeel are combining marks), strip punctuation, collapse whitespace —
 * so "Combien coûte un implant ?" groups with "combien coute un implant".
 */
export function normalizeQuestion(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── collect steps (the ONLY I/O in this module) ───────────────────────────────

async function safeList(fn) {
  try {
    const rows = await fn();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/** Fetch + aggregate the digest numbers. `tenant` is the already-loaded record. */
export async function collectDigestStats(store, tenant, range = {}) {
  const tenantId = tenant.id;
  const [conversations, appointments, leads] = await Promise.all([
    safeList(() => store.conversations.list(tenantId)),
    safeList(() => store.appointments.list(tenantId)),
    safeList(() => store.leads.list(tenantId)),
  ]);
  return computeDigestStats({ tenant, conversations, appointments, leads }, range);
}

/** Fetch + aggregate the full dashboard analytics. */
export async function collectAnalytics(store, tenant, range = {}) {
  const tenantId = tenant.id;
  const [conversations, appointments, leads, events] = await Promise.all([
    safeList(() => store.conversations.list(tenantId)),
    safeList(() => store.appointments.list(tenantId)),
    safeList(() => store.leads.list(tenantId)),
    safeList(() => store.events.list(tenantId, { type: 'message.analyzed' })),
  ]);

  // Transcripts only for conversations active in the window (bounded work).
  const inRange = rangePredicate(range);
  const active = conversations.filter((c) => realConvo(c) && inRange(activityTs(c)));
  const messagesByConvo = new Map();
  await Promise.all(
    active.map(async (c) => {
      messagesByConvo.set(c.id, await safeList(() => store.conversations.listMessages(tenantId, c.id, {})));
    })
  );

  return computeAnalytics(
    { tenant, conversations, appointments, leads, events, messagesByConvo },
    range
  );
}
