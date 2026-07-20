// Owner-notification service (P1-E) — the bus consumer that turns domain events
// into WhatsApp messages on the owner's / reception's phone (PRODUCT-SPEC §3.6).
//
// "Meet them where they live": the admin alert channel IS WhatsApp. This service
// subscribes to the four instant events, resolves per-tenant recipients + prefs,
// respects quiet hours (never for emergencies) and a dedupe window, then sends
// via the P1-B sender. It is defensive by construction: a formatting, store or
// send failure is caught and recorded to the events audit log — it must NEVER
// throw back into a bus handler and break the turn that triggered it.
//
// It also computes the digests (§3.4 money line) via a PURE `computeDigestStats`
// helper so the aggregation is unit-testable without a live store, and thin
// `runDailyDigest` / `runWeeklyDigest` methods a cron can call (see README.md).
import { formatAlert, formatDailyDigest, formatWeeklyDigest, resolveOwnerLang } from './formatter.js';
import {
  computeDigestStats,
  collectDigestStats,
  isAfterHours,
  minutesInTz,
  weekdayInTz,
  parseHM,
} from '../stats/index.js';

// The aggregation moved to src/stats (P2-A) so the dashboard /api/stats and the
// digests share ONE source of numbers. Re-exported here for back-compat.
export { computeDigestStats, isAfterHours, minutesInTz, weekdayInTz };

const DEFAULT_DEDUPE_MS = 10 * 60 * 1000; // 10 minutes, same conversation + type

// Map each bus event → its pref toggle key (with aliases for forgiving config),
// the emergency bypass flag, and how to derive the dedupe subject when there is
// no conversationId on the envelope.
const EVENT_META = {
  'appointment.created': {
    key: 'booking',
    aliases: ['booking', 'appointment', 'bookings'],
    emergency: false,
    subject: (e) => e.conversationId || refOf(e.appointment) || 'booking',
  },
  'lead.hot': {
    key: 'hotLead',
    aliases: ['hotLead', 'hot_lead', 'lead', 'leads'],
    emergency: false,
    subject: (e) => e.conversationId || e.lead?.patientWaId || 'lead',
  },
  'handoff.requested': {
    key: 'handoff',
    aliases: ['handoff', 'handoffs'],
    emergency: false,
    subject: (e) => e.conversationId || e.handoff?.patientWaId || 'handoff',
  },
  'emergency.detected': {
    key: 'emergency',
    aliases: ['emergency', 'emergencies'],
    emergency: true,
    subject: (e) => e.conversationId || e.waId || e.patientWaId || 'emergency',
  },
};

function refOf(appt) {
  return appt ? appt.ref || appt.id : null;
}

/**
 * @param {object}   deps
 * @param {object}   deps.bus      ClinicEventBus (from src/events/bus.js)
 * @param {object}   deps.sender   WhatsApp sender (from src/whatsapp) — sendText(tenant, to, text)
 * @param {object}   deps.store    storage adapter (from src/store) — tenants/notificationPrefs/events/…
 * @param {Function} [deps.now]    injectable clock () => Date (quiet-hours + dedupe)
 * @param {number}   [deps.dedupeWindowMs] default 10 min
 * @param {object}   [deps.quietHours]     service-wide default {start:'HH:MM', end:'HH:MM'}
 * @param {Function} [deps.logger] (msg, ...args) => void
 * @returns {{stop:Function, settled:Function, runDailyDigest:Function, runWeeklyDigest:Function, computeDigestStats:Function}}
 */
export function createNotificationService({
  bus,
  sender,
  store,
  now,
  dedupeWindowMs = DEFAULT_DEDUPE_MS,
  quietHours,
  logger,
} = {}) {
  if (!bus) throw new Error('createNotificationService: bus is required');
  if (!sender) throw new Error('createNotificationService: sender is required');
  if (!store) throw new Error('createNotificationService: store is required');

  const clock = typeof now === 'function' ? now : () => new Date();
  const log = typeof logger === 'function' ? logger : () => {};
  const dedupe = new Map(); // key -> last-sent ms
  const inflight = new Set(); // pending dispatch promises (for settled())
  const subscriptions = [];

  // ── subscribe ────────────────────────────────────────────────────────────
  for (const type of Object.keys(EVENT_META)) {
    const handler = (envelope) => {
      const p = dispatch(type, envelope || {})
        .catch((e) => log('notification dispatch failed', type, e?.message))
        .finally(() => inflight.delete(p));
      inflight.add(p);
    };
    bus.on(type, handler);
    subscriptions.push([type, handler]);
  }

  // ── per-event dispatch (never throws) ──────────────────────────────────────
  async function dispatch(type, envelope) {
    const meta = EVENT_META[type];
    if (!meta) return;
    const tenantId = envelope.tenantId;
    if (!tenantId) return;

    let tenant = null;
    try {
      tenant = await store.tenants.getById(tenantId);
    } catch (e) {
      log('tenant lookup failed', tenantId, e?.message);
    }
    if (!tenant) return;

    // Dedupe: same conversation + type inside the window is dropped entirely.
    const subject = safe(() => meta.subject(envelope)) || 'unknown';
    const dedupeKey = `${tenantId}|${type}|${subject}`;
    const nowMs = clock().getTime();
    pruneDedupe(nowMs);
    const last = dedupe.get(dedupeKey);
    if (last != null && nowMs - last < dedupeWindowMs) return;

    const prefs = await listPrefs(tenantId);
    const recipients = resolveRecipients(tenant, prefs, meta);
    if (recipients.length === 0) return;

    let sentAny = false;
    for (const rcpt of recipients) {
      // Toggle: an explicit `false` disables; default is on.
      if (!isEventEnabled(rcpt.events, meta.aliases)) continue;
      // Quiet hours suppress everything EXCEPT emergencies.
      if (!meta.emergency && inQuietHours(clock(), rcpt.quietHours, rcpt.tz)) continue;

      const text = safe(() =>
        formatAlert(type, {
          tenant,
          lang: rcpt.lang,
          appointment: envelope.appointment,
          lead: envelope.lead,
          handoff: envelope.handoff,
          keyword: envelope.keyword,
          patientWaId: patientOf(type, envelope),
          lastMessage: lastMessageOf(envelope),
        })
      );
      if (!text) continue;

      await sendTo(tenant, rcpt.recipient, text, type);
      sentAny = true;
    }

    if (sentAny) dedupe.set(dedupeKey, nowMs);
  }

  // ── send + audit (both success and failure recorded, never throws) ─────────
  async function sendTo(tenant, recipient, text, type) {
    try {
      const res = await sender.sendText(tenant, recipient, text);
      await recordEvent(tenant.id, {
        type: res && res.ok ? 'notification.sent' : 'notification.error',
        payload: {
          event: type,
          recipient,
          ok: !!(res && res.ok),
          waMessageId: (res && res.waMessageId) || null,
          error: res && res.error ? res.error : null,
        },
      });
    } catch (e) {
      // sender is contractually non-throwing, but be paranoid — an exception here
      // must not escape into the bus handler.
      log('sender.sendText threw', type, e?.message);
      await recordEvent(tenant.id, {
        type: 'notification.error',
        payload: { event: type, recipient, ok: false, error: String(e?.message || e) },
      });
    }
  }

  async function recordEvent(tenantId, evt) {
    try {
      await store.events.append(tenantId, { actor: 'notifier', ...evt });
    } catch (e) {
      log('events.append failed', e?.message);
    }
  }

  async function listPrefs(tenantId) {
    try {
      const rows = await store.notificationPrefs.list(tenantId);
      return Array.isArray(rows) ? rows : [];
    } catch (e) {
      log('notificationPrefs.list failed', tenantId, e?.message);
      return [];
    }
  }

  // ── digests ────────────────────────────────────────────────────────────────
  // Digests are cron-triggered at a chosen hour, so they ignore quiet hours and
  // dedupe. Recipients still honor their per-event digest toggle (default on).
  async function runDigest(kind, tenantId, opts = {}) {
    let tenant = null;
    try {
      tenant = await store.tenants.getById(tenantId);
    } catch (e) {
      log('tenant lookup failed (digest)', tenantId, e?.message);
    }
    if (!tenant) return { ok: false, reason: 'tenant_not_found' };

    const to = opts.now ? new Date(opts.now) : clock();
    const spanMs = kind === 'weekly' ? 7 * 24 * 3600 * 1000 : 24 * 3600 * 1000;
    const from = opts.from ? new Date(opts.from) : new Date(to.getTime() - spanMs);
    const tz = opts.tz || tenant.timezone || cfgOf(tenant).timezone || 'Africa/Tunis';

    // Shared fetch+aggregate (src/stats) — the same numbers /api/stats serves.
    const stats = await collectDigestStats(store, tenant, { from, to, tz, avgValue: opts.avgValue });

    const meta =
      kind === 'weekly'
        ? { key: 'weeklyDigest', aliases: ['weeklyDigest', 'weekly', 'digest'] }
        : { key: 'dailyDigest', aliases: ['dailyDigest', 'daily', 'digest'] };
    const prefs = await listPrefs(tenantId);
    const recipients = resolveRecipients(tenant, prefs, meta);

    const format = kind === 'weekly' ? formatWeeklyDigest : formatDailyDigest;
    const sent = [];
    for (const rcpt of recipients) {
      if (!isEventEnabled(rcpt.events, meta.aliases)) continue;
      const text = safe(() => format(stats, { tenant, lang: rcpt.lang }));
      if (!text) continue;
      await sendTo(tenant, rcpt.recipient, text, `${kind}.digest`);
      sent.push(rcpt.recipient);
    }
    return { ok: true, stats, sent };
  }

  return {
    /** Unsubscribe from the bus. Idempotent. */
    stop() {
      for (const [type, handler] of subscriptions.splice(0)) bus.off(type, handler);
      dedupe.clear();
    },
    /** Await all in-flight event dispatches (test hook / graceful shutdown). */
    async settled() {
      await Promise.allSettled([...inflight]);
    },
    runDailyDigest: (tenantId, opts) => runDigest('daily', tenantId, opts),
    runWeeklyDigest: (tenantId, opts) => runDigest('weekly', tenantId, opts),
    computeDigestStats,
  };

  // ── helpers (closure-local) ────────────────────────────────────────────────
  function pruneDedupe(nowMs) {
    for (const [k, ts] of dedupe) if (nowMs - ts >= dedupeWindowMs) dedupe.delete(k);
  }
}

// ═══ pure helpers (exported for tests / reuse) ═══════════════════════════════

function cfgOf(tenant) {
  if (!tenant || typeof tenant !== 'object') return {};
  return tenant.config && typeof tenant.config === 'object' ? tenant.config : tenant;
}

/** Normalize a phone string to WhatsApp-friendly digits (drop +, spaces, punctuation). */
export function normalizeMsisdn(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const digits = s.replace(/[^\d]/g, '');
  return digits.length >= 6 ? digits : null;
}

/**
 * Resolve who gets alerted for an event, with SAFE DEFAULTS: when a tenant has
 * no notification_prefs rows, the escalation/owner number becomes the sole
 * recipient with all instant events ON (PRODUCT-SPEC §3.6).
 */
export function resolveRecipients(tenant, prefs, meta) {
  const cfg = cfgOf(tenant);
  const tz = tenant?.timezone || cfg?.timezone || 'Africa/Tunis';
  const defaultQuiet = cfg?.notifications?.quietHours || null;

  const active = (Array.isArray(prefs) ? prefs : []).filter((p) => p && p.active !== false && p.recipient);
  if (active.length > 0) {
    return active.map((p) => ({
      recipient: normalizeMsisdn(p.recipient) || String(p.recipient),
      channel: p.channel || 'whatsapp',
      lang: resolveOwnerLang(tenant, p),
      quietHours: p.quietHours || defaultQuiet,
      tz: p.tz || tz,
      events: p.events || {},
    }));
  }

  // No prefs configured → default to the clinic's escalation / owner number.
  const fallbacks = [
    ...(Array.isArray(cfg?.notifications?.recipients) ? cfg.notifications.recipients : []),
    cfg?.notifications?.ownerPhone,
    cfg?.owner?.phone,
    cfg?.ownerPhone,
    cfg?.handoff?.phone,
  ]
    .map(normalizeMsisdn)
    .filter(Boolean);

  const unique = [...new Set(fallbacks)];
  return unique.map((recipient) => ({
    recipient,
    channel: 'whatsapp',
    lang: resolveOwnerLang(tenant),
    quietHours: defaultQuiet,
    tz,
    events: {}, // empty ⇒ all events default ON
  }));
}

/** A pref's event map disables an event only with an explicit `false`. */
export function isEventEnabled(events, aliases) {
  if (!events || typeof events !== 'object') return true;
  let decided = true;
  let seen = false;
  for (const a of aliases) {
    if (a in events) {
      seen = true;
      decided = events[a] !== false;
    }
  }
  return seen ? decided : true;
}

// ── quiet hours (parseHM/minutesInTz shared via src/stats) ────────────────────
/** True when `date` falls inside the recipient's quiet-hours window. */
export function inQuietHours(date, quietHours, tz) {
  if (!quietHours) return false;
  const s = parseHM(quietHours.start);
  const e = parseHM(quietHours.end);
  if (s == null || e == null || s === e) return false;
  const mins = minutesInTz(date, quietHours.tz || tz);
  return s < e ? mins >= s && mins < e : mins >= s || mins < e;
}

// ── tiny internals ─────────────────────────────────────────────────────────────
function patientOf(type, e) {
  if (type === 'emergency.detected') return e.patientWaId || e.waId || subjectWaId(e.conversationId);
  if (type === 'lead.hot') return e.lead?.patientWaId || subjectWaId(e.conversationId);
  if (type === 'handoff.requested') return e.handoff?.patientWaId || e.patientWaId || subjectWaId(e.conversationId);
  return e.patientWaId || null;
}

// conversationId is `${tenantId}:${waId}` in the JSON adapter — recover the waId.
function subjectWaId(conversationId) {
  if (!conversationId || typeof conversationId !== 'string') return null;
  const i = conversationId.lastIndexOf(':');
  return i >= 0 ? conversationId.slice(i + 1) : null;
}

function lastMessageOf(e) {
  return (
    e.lastMessage ||
    (e.message && (e.message.text || (e.message.body && e.message.body.text))) ||
    e.handoff?.lastMessage ||
    null
  );
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

export default createNotificationService;
