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

import { LEAD_STATUSES, LEAD_WON as LEAD_WON_STATUS } from '../leads/status.js';

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
 * A window belongs to the day it OPENS on; an overnight window (close < open,
 * e.g. fri ['20:00','02:00']) spills its 00:00→close tail into the NEXT
 * calendar day. So Sat 01:00 during a Friday night shift is IN hours, while
 * Fri 01:00 (nothing open since Thursday evening) is after hours.
 */
export function isAfterHours(ts, workingHours, tz) {
  if (!workingHours) return false; // unknown schedule ⇒ don't overstate
  const date = new Date(ts);
  const mins = minutesInTz(date, tz);
  const today = weekdayInTz(date, tz);

  const winOf = (day) => {
    const wh = workingHours[day];
    if (!Array.isArray(wh) || wh.length < 2) return null; // null / closed day
    const open = parseHM(wh[0]);
    const close = parseHM(wh[1]);
    return open == null || close == null ? null : [open, close];
  };

  const t = winOf(today);
  if (t) {
    const [open, close] = t;
    // Overnight window: today covers open→midnight; the rest belongs to tomorrow.
    if (open <= close ? mins >= open && mins < close : mins >= open) return false;
  }
  // Yesterday's overnight tail (its window wrapped past midnight into today).
  const yesterday = DAY_KEYS[(DAY_KEYS.indexOf(today) + 6) % 7];
  const y = winOf(yesterday);
  if (y && y[1] < y[0] && mins < y[1]) return false;
  return true;
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

// ── calls block (V3) ──────────────────────────────────────────────────────────
// Sourced from the audit events the voice-call service appends (src/voice-call/
// index.js): EXACTLY one terminal event per call — 'call.ended' (patient held
// it, outcome 'completed'|'failed') or 'call.missed' (never carried audio:
// closed/no_answer/failed-to-connect). total = ended + missed by construction,
// so it can never double-count or drift from the two halves. avgDurationSec is
// averaged over ANSWERED calls only — a missed call's durationSec is always 0,
// and folding it in would understate real talk time. voiceBookings mirrors the
// digest's own "bookings" convention (sandbox + cancelled excluded) restricted
// to channel:'call'. Every count defaults to 0 — never NaN — when the events
// ring holds no call rows yet (older data, or calls disabled for the tenant).
function computeCallStats(events, appointments, inRange) {
  const ended = (events || []).filter((e) => e.type === 'call.ended' && inRange(e.createdAt));
  const missed = (events || []).filter((e) => e.type === 'call.missed' && inRange(e.createdAt));
  const totalDurationSec = ended.reduce((sum, e) => sum + (Number(e.payload?.durationSec) || 0), 0);
  const voiceBookings = (appointments || []).filter(
    (a) => realAppt(a) && a.channel === 'call' && a.status !== 'cancelled' && inRange(a.createdAt)
  ).length;
  return {
    total: ended.length + missed.length,
    answered: ended.length,
    missed: missed.length,
    avgDurationSec: ended.length > 0 ? Math.round(totalDurationSec / ended.length) : 0,
    voiceBookings,
  };
}

// ── digest aggregate (PURE — the reference numbers) ───────────────────────────
/**
 * Aggregate a tenant's raw collections into digest numbers. No I/O, no clock.
 * @param {object} storeData { tenant, conversations[], appointments[], leads[], events[]? }
 *   events[] (V3, optional) — 'call.ended'/'call.missed' audit rows feed the
 *   calls block; omitted or empty ⇒ calls is all zeros, never NaN.
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

  // Training loop (P2-B): KB entries the owner created from unknown questions
  // in-window — the digest's "le bot a appris N réponses" line.
  const learned = (storeData.kbEntries || []).filter(
    (e) => e.source === 'didnt_know' && e.status === 'active' && inRange(e.updatedAt || e.createdAt)
  ).length;

  const avgValue = resolveAvgValue(cfg, range);
  const money = avgValue != null && Number.isFinite(avgValue) ? bookings * avgValue : null;
  const afterHoursShare = convoCount > 0 ? afterHours / convoCount : 0;

  // V3: voice-call totals. storeData.events carries whatever call.* rows the
  // collector fetched (collectDigestStats/collectAnalytics both merge them in
  // alongside message.analyzed) — computed HERE so /api/stats and the digests
  // read the exact same numbers, per the P2-A "one source" law.
  const calls = computeCallStats(storeData.events, storeData.appointments, inRange);

  return {
    conversations: convoCount,
    bookings,
    leads,
    learned,
    afterHours,
    afterHoursShare,
    afterHoursPct: Math.round(afterHoursShare * 100),
    money,
    avgValue,
    calls,
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

  // Training-queue depth (P2-B): open questions the owner hasn't triaged —
  // a queue size, deliberately NOT range-filtered.
  const unansweredNew = (storeData.unanswered || []).filter((u) => u.status === 'new').length;

  // Leads pipeline (P2-C): current snapshot (NOT range-filtered — a pipeline is
  // a live board), sandbox excluded. pipelineValue sums the staff-entered deal
  // values; conversion = won (booked+arrived) / total.
  const pipelineLeads = (storeData.leads || []).filter((l) => !isSandboxWaId(l.patientWaId));
  const leadsByStatus = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0]));
  let pipelineValue = 0;
  let wonLeads = 0;
  for (const l of pipelineLeads) {
    if (l.status in leadsByStatus) leadsByStatus[l.status] += 1;
    if (LEAD_WON_STATUS.has(l.status)) wonLeads += 1;
    const v = Number(l.value);
    if (Number.isFinite(v)) pipelineValue += v;
  }
  const leadConversion = pipelineLeads.length ? wonLeads / pipelineLeads.length : null;

  // ── reminders & no-shows (V2) ──────────────────────────────────────────────
  // Reminder outcomes (range-filtered on the row's creation) — the renewal
  // pitch in four numbers. `confirmed`/`cancelled`/`reschedule` are patient
  // REPLIES to a reminder; `no_answer` means the appointment time passed in
  // silence; `skipped_window` is a reminder Meta's 24h rule forbade us to send.
  const remRows = (storeData.reminders || []).filter((r) => inRange(r.createdAt));
  const reminderOutcomes = {
    sent: 0, confirmed: 0, cancelled: 0, reschedule: 0,
    no_answer: 0, skipped_window: 0, failed: 0,
  };
  for (const r of remRows) {
    if (r.status !== 'sent' && r.status in reminderOutcomes) reminderOutcomes[r.status] += 1;
    // Every row that reached the patient counts as "sent" regardless of what
    // the patient did next — replies are outcomes ON TOP of a send. 'closed'
    // means the appointment was resolved by staff before the patient answered.
    if (['sent', 'confirmed', 'cancelled', 'reschedule', 'no_answer', 'closed'].includes(r.status)) {
      reminderOutcomes.sent += 1;
    }
  }

  // Weekly no-show trend over PAST appointments in range (by appointment date,
  // Monday-keyed weeks): rate = no_show / (done + no_show) — cancelled slots
  // were refilled or freed, they are not "did not come".
  const weekKey = (d) => {
    const day = new Date(d);
    const dow = (day.getDay() + 6) % 7; // Monday = 0
    day.setDate(day.getDate() - dow);
    day.setHours(0, 0, 0, 0);
    return day.toISOString().slice(0, 10);
  };
  const trendBuckets = new Map();
  const nowMs = Date.now();
  for (const a of (storeData.appointments || []).filter(realAppt)) {
    const iso = a.datetimeISO ?? a.datetimeIso;
    const t = iso ? new Date(iso).getTime() : NaN;
    if (Number.isNaN(t) || t > nowMs || !inRange(iso)) continue;
    if (a.status !== 'done' && a.status !== 'no_show') continue;
    const key = weekKey(iso);
    const b = trendBuckets.get(key) || { week: key, done: 0, noShow: 0 };
    if (a.status === 'done') b.done += 1;
    else b.noShow += 1;
    trendBuckets.set(key, b);
  }
  const noShowTrend = [...trendBuckets.values()]
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((b) => ({ ...b, ratePct: Math.round((b.noShow / (b.done + b.noShow)) * 100) }));

  // Smart follow-ups (V4): nudge funnel — sent → replied → converted (+ opt-outs).
  const nudges = { sent: 0, replied: 0, converted: 0, optOut: 0 };
  for (const c of conversations) {
    if (c.nudge && inRange(c.nudge.at)) {
      nudges.sent += 1;
      if (c.nudge.replied) nudges.replied += 1;
      if (c.nudge.converted) nudges.converted += 1;
      // Opt-outs scoped to the same window as their nudge, so the funnel can
      // never display more opt-outs than sends.
      if (c.nudgeOptOut) nudges.optOut += 1;
    }
  }

  return {
    ...digest,
    tz,
    unansweredNew,
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
    leadsByStatus,
    pipelineValue,
    pipelineOpen: pipelineLeads.length - (leadsByStatus.lost || 0) - wonLeads,
    leadConversion,
    reminderOutcomes,
    noShowTrend,
    nudges,
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

// Fetch bounds: analytics is a dashboard read that must stay cheap no matter
// how big a tenant's history grows (any authenticated user can hit it).
const EVENTS_FETCH_LIMIT = 20000; // last N analyzed events (JSON store also ring-caps)
// V3: the store's events.list() filters by a SINGLE `type` (both adapters —
// no OR support), so the two terminal call types are fetched as separate
// calls and merged, same as message.analyzed. A lower cap than
// EVENTS_FETCH_LIMIT is plenty — a tenant doing 20k calls has bigger problems.
const CALL_EVENTS_FETCH_LIMIT = 5000;
const TRANSCRIPT_CONVOS_MAX = 1000; // messageCount/responseTime sample over the most recent N
const TRANSCRIPT_CHUNK = 20; // listMessages concurrency bound (no unbounded fan-out)

async function fetchCallEvents(store, tenantId) {
  const [ended, missed] = await Promise.all([
    safeList(() => store.events.list(tenantId, { type: 'call.ended', limit: CALL_EVENTS_FETCH_LIMIT })),
    safeList(() => store.events.list(tenantId, { type: 'call.missed', limit: CALL_EVENTS_FETCH_LIMIT })),
  ]);
  return [...ended, ...missed];
}

/** Fetch + aggregate the digest numbers. `tenant` is the already-loaded record. */
export async function collectDigestStats(store, tenant, range = {}) {
  const tenantId = tenant.id;
  const [conversations, appointments, leads, kbEntries, callEvents] = await Promise.all([
    safeList(() => store.conversations.list(tenantId)),
    safeList(() => store.appointments.list(tenantId)),
    safeList(() => store.leads.list(tenantId)),
    safeList(() => store.kbEntries.list(tenantId, { status: 'active' })),
    fetchCallEvents(store, tenantId),
  ]);
  return computeDigestStats({ tenant, conversations, appointments, leads, kbEntries, events: callEvents }, range);
}

/** Fetch + aggregate the full dashboard analytics. */
export async function collectAnalytics(store, tenant, range = {}) {
  const tenantId = tenant.id;
  const [conversations, appointments, leads, analyzedEvents, kbEntries, unanswered, reminders, callEvents] =
    await Promise.all([
      safeList(() => store.conversations.list(tenantId)),
      safeList(() => store.appointments.list(tenantId)),
      safeList(() => store.leads.list(tenantId)),
      safeList(() => store.events.list(tenantId, { type: 'message.analyzed', limit: EVENTS_FETCH_LIMIT })),
      safeList(() => store.kbEntries.list(tenantId, { status: 'active' })),
      safeList(() => store.unanswered.list(tenantId, {})),
      safeList(() => store.reminders.list(tenantId, {})), // absent on PG until P1-G → []
      fetchCallEvents(store, tenantId),
    ]);
  // One merged events[] — computeAnalytics/computeDigestStats each filter it
  // by the type they care about (message.analyzed vs call.ended/call.missed).
  const events = [...analyzedEvents, ...callEvents];

  // Transcripts only for conversations active in the window; most recent first,
  // capped and fetched in bounded chunks. Beyond the cap, messageCount and
  // responseTime become a most-recent-N sample (counts above never bind at
  // pilot scale); conversation/funnel/afterHours numbers don't use transcripts.
  const inRange = rangePredicate(range);
  const active = conversations
    .filter((c) => realConvo(c) && inRange(activityTs(c)))
    .sort((a, b) => String(activityTs(b)).localeCompare(String(activityTs(a))))
    .slice(0, TRANSCRIPT_CONVOS_MAX);
  const messagesByConvo = new Map();
  for (let i = 0; i < active.length; i += TRANSCRIPT_CHUNK) {
    await Promise.all(
      active.slice(i, i + TRANSCRIPT_CHUNK).map(async (c) => {
        messagesByConvo.set(c.id, await safeList(() => store.conversations.listMessages(tenantId, c.id, {})));
      })
    );
  }

  return computeAnalytics(
    { tenant, conversations, appointments, leads, events, kbEntries, unanswered, reminders, messagesByConvo },
    range
  );
}
