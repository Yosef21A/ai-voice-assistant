// Appointment reminders — the no-show killer (V2 / P2-E).
//
// A deterministic scheduler: every tick derives what is DUE from the
// appointments store (no pre-created jobs to drift out of sync), sends the
// reminder as interactive confirm/cancel/reschedule buttons, and records ONE
// row per (appointment, kind) as the dedupe contract. Patient replies are
// resolved by the ingest pipeline via `parseReminderAction` + `applyReminderReply`
// below — deterministically, before the engine ever sees the turn.
//
// Meta rules honored (CLAUDE.md non-negotiable):
//   - Free-form messages (and interactive buttons) are allowed ONLY inside the
//     24h service window. Outside it we record `skipped_window` + an audit
//     event — never a silent drop, never a policy-violating send. The template
//     path (pre-approved templates work outside the window) activates when
//     `config.waProductionTemplates` is on — the test number has no custom
//     templates, so the flag stays off until production (RUNBOOK §E).
//   - Quiet hours delay a reminder (no row recorded → retried next tick) while
//     its send window is still open.
//
// Timezone: due-ness is absolute UTC math on the appointment ISO; only quiet
// hours are wall-clock (Africa/Tunis via the shared minutesInTz helpers).
import { t } from '../engine/responses.js';
import { formatWhen } from '../engine/datetime.js';
import { inQuietHours } from '../notifications/service.js';
import { isSandboxWaId } from '../stats/index.js';
import { hasDoctorPersona, doctorName, isFacilitator } from '../engine/tenantProfile.js';

const HOUR = 3600 * 1000;

// Send window per kind: [appt - offset, appt - notAfter). A T-48 reminder for
// an appointment booked 20h ahead would be noise — the T-3 covers it.
export const REMINDER_KINDS = {
  t48: { offsetMs: 48 * HOUR, notAfterMs: 24 * HOUR, template: 'reminder48' },
  t3: { offsetMs: 3 * HOUR, notAfterMs: 0.5 * HOUR, template: 'reminder3' },
};

const reminderCfg = (clinic) => {
  const c = clinic?.reminders && typeof clinic.reminders === 'object' ? clinic.reminders : {};
  return {
    enabled: c.enabled !== false,
    t48: c.t48 !== false,
    t3: c.t3 !== false,
  };
};

const langOf = (appt, clinic) =>
  ['ar', 'fr', 'en'].includes(appt?.lang) ? appt.lang : clinic?.languages?.[0] || 'ar';

/** rem:c:<apptId> | rem:x:<apptId> | rem:r:<apptId> → {action, apptId} | null */
export function parseReminderAction(interactiveId) {
  const m = /^rem:(c|x|r):(.+)$/.exec(String(interactiveId || ''));
  if (!m) return null;
  return { action: { c: 'confirm', x: 'cancel', r: 'reschedule' }[m[1]], apptId: m[2] };
}

export function buildReminderBody(clinic, appt, kind, lang) {
  return t(lang, REMINDER_KINDS[kind].template, {
    clinic: clinic.name,
    ref: appt.ref,
    when: formatWhen(new Date(appt.datetimeISO ?? appt.datetimeIso), lang),
    doctor: hasDoctorPersona(clinic) ? doctorName(clinic, lang) : null,
  });
}

export function reminderButtons(appt, lang) {
  return [
    { id: `rem:c:${appt.id}`, title: t(lang, 'btnReminderConfirm') },
    { id: `rem:x:${appt.id}`, title: t(lang, 'btnReminderCancel') },
    { id: `rem:r:${appt.id}`, title: t(lang, 'btnReminderResched') },
  ];
}

/**
 * Resolve a patient's reminder reply. Pure store/bus effects — the caller
 * (ingest) sends `replyText` itself so outbound attribution stays in one place.
 * @returns {Promise<{handled:boolean, replyText?:string, outcome?:string}>}
 */
export async function applyReminderReply(
  { store, bus, clinic, convo, patientWaId, now = new Date() },
  { action, apptId }
) {
  const tenantId = clinic.id;
  // A facilitator has no calendar (D2): legacy appointment buttons are inert —
  // the team handles any pre-conversion appointments by hand, and a reschedule
  // must never seed a booking flow the facilitator router can't run.
  if (isFacilitator(clinic)) return { handled: false };
  const appt = await store.appointments.get(tenantId, apptId);
  // Gone or already terminal → let the engine handle the turn conversationally.
  if (!appt || !['pending', 'confirmed'].includes(appt.status)) return { handled: false };
  // AUTHORIZATION: the button id names an appointment, but only ITS OWN patient
  // may act on it. Tenant scoping alone is not enough — a crafted payload id
  // must never cancel another patient's slot.
  if (patientWaId && appt.patientWaId && String(appt.patientWaId) !== String(patientWaId)) {
    return { handled: false };
  }
  // A PAST appointment's buttons are inert: months later a stray tap must not
  // "free a slot" that already happened (and page the owner about it).
  const apptTime = new Date(appt.datetimeISO ?? appt.datetimeIso ?? NaN).getTime();
  if (!Number.isFinite(apptTime) || apptTime <= now.getTime()) return { handled: false };

  const lang = langOf(appt, clinic);
  const rows = (await store.reminders?.list?.(tenantId, { apptId })) || [];
  const sentRow = rows
    .filter((r) => r.status === 'sent')
    .sort((a, b) => String(b.sentAt || '').localeCompare(String(a.sentAt || '')))[0];
  const markRow = (status) =>
    sentRow && store.reminders?.update
      ? store.reminders.update(tenantId, sentRow.id, { status, respondedAt: now.toISOString() })
      : Promise.resolve(null);
  const audit = (payload) =>
    store.events
      .append(tenantId, { type: 'reminder.replied', actor: 'patient', conversationId: convo.id, payload })
      .catch(() => {});
  const clearPending = () =>
    store.conversations.update(tenantId, convo.id, { lastReminder: null }).catch(() => {});

  if (action === 'confirm') {
    if (appt.status === 'pending') {
      const updated = await store.appointments.updateStatus(tenantId, apptId, 'confirmed');
      bus.publish('appointment.updated', {
        tenantId,
        conversationId: convo.id,
        appointment: updated || { ...appt, status: 'confirmed' },
        patch: { status: 'confirmed' },
      });
    }
    await markRow('confirmed');
    await audit({ action: 'confirm', apptId, ref: appt.ref });
    await clearPending();
    bus.publish('reminder.replied', { tenantId, conversationId: convo.id, apptId, ref: appt.ref, action: 'confirm' });
    return {
      handled: true,
      outcome: 'confirmed',
      replyText: t(lang, 'reminderConfirmedAck', {
        when: formatWhen(new Date(appt.datetimeISO ?? appt.datetimeIso), lang),
      }),
    };
  }

  if (action === 'cancel') {
    const updated = await store.appointments.updateStatus(tenantId, apptId, 'cancelled');
    await markRow('cancelled');
    await audit({ action: 'cancel', apptId, ref: appt.ref });
    await clearPending();
    bus.publish('appointment.updated', {
      tenantId,
      conversationId: convo.id,
      appointment: updated || { ...appt, status: 'cancelled' },
      patch: { status: 'cancelled' },
    });
    // Owner alert: a freed slot is actionable NOW (call the waitlist).
    bus.publish('appointment.cancelled', {
      tenantId,
      conversationId: convo.id,
      appointment: updated || { ...appt, status: 'cancelled' },
      patientWaId: appt.patientWaId,
    });
    return { handled: true, outcome: 'cancelled', replyText: t(lang, 'reminderCancelledAck') };
  }

  if (action === 'reschedule') {
    const updated = await store.appointments.updateStatus(tenantId, apptId, 'cancelled');
    await markRow('reschedule');
    await audit({ action: 'reschedule', apptId, ref: appt.ref });
    await clearPending();
    bus.publish('appointment.updated', {
      tenantId,
      conversationId: convo.id,
      appointment: updated || { ...appt, status: 'cancelled' },
      patch: { status: 'cancelled' },
    });
    // Seed the CLASSIC booking flow with everything we already know, missing
    // only the datetime — the patient's next message is parsed as the new slot
    // and the normal availability-checked flow re-books (recap + consent
    // included, so the humility guardrails stay intact).
    await store.conversations.update(tenantId, convo.id, {
      state: {
        flow: 'booking',
        step: 'datetime',
        data: {
          specialty: appt.specialty || null,
          name: appt.patientName || null,
          originCity: appt.originCity || null,
          originCountry: appt.originCountry || null,
          originRaw: appt.originRaw || null,
          contact: appt.contact || null,
        },
      },
    });
    return { handled: true, outcome: 'reschedule', replyText: t(lang, 'reminderReschedAsk') };
  }

  return { handled: false };
}

/**
 * @param {object} deps
 * @param {object} deps.store    storage adapter (needs .reminders — JSON store has it)
 * @param {object} deps.sender   WhatsApp sender (sendButtons/sendText)
 * @param {object} deps.bus      shared event bus
 * @param {object} [deps.config] app config (waProductionTemplates, voice of flags)
 * @param {Function} [deps.now]  injectable clock
 * @param {Function} [deps.logger]
 */
export function createReminderService({ store, sender, bus, config = {}, now, logger } = {}) {
  if (!store) throw new Error('createReminderService: store is required');
  if (!sender) throw new Error('createReminderService: sender is required');
  const clock = typeof now === 'function' ? now : () => new Date();
  const log = typeof logger === 'function' ? logger : () => {};
  let timer = null;

  const audit = (tenantId, type, payload) =>
    store.events?.append?.(tenantId, { type, actor: 'reminder', payload })?.catch?.(() => {});

  // 24h service window: the last PATIENT message must be younger than 24h.
  async function serviceWindowOpen(tenantId, waId, nowMs) {
    try {
      const convo = await store.conversations.get(tenantId, waId);
      if (!convo) return { open: false, convo: null };
      const msgs = await store.conversations.listMessages(tenantId, convo.id, {});
      let lastIn = null;
      for (const m of msgs) {
        if (m.direction === 'inbound') lastIn = m.ts;
      }
      const open = !!lastIn && nowMs - new Date(lastIn).getTime() < 24 * HOUR;
      return { open, convo };
    } catch {
      return { open: false, convo: null };
    }
  }

  const MAX_SEND_ATTEMPTS = 5;

  async function remindOne(clinic, appt, kind, nowDate, priorFailedRow) {
    const tenantId = clinic.id;
    const nowMs = nowDate.getTime();
    const lang = langOf(appt, clinic);

    const { open, convo } = await serviceWindowOpen(tenantId, appt.patientWaId, nowMs);

    // A paused conversation belongs to a human — emergency ("the bot steps
    // back", CLAUDE.md) or staff takeover. Delay like quiet hours: no row, so
    // it sends if staff un-pauses while the window is still open.
    if (convo && (convo.aiPaused || convo.status === 'needs_human')) return 'paused';

    if (!open) {
      // Meta's 24h rule — free-form (incl. interactive) is forbidden outside
      // the window, so we log honestly instead of sending. The compliant
      // out-of-window path is PRE-APPROVED TEMPLATES, which arrive with the
      // production number (P2-H / RUNBOOK §E) — no flag can unlock it earlier.
      await store.reminders.record(tenantId, {
        apptId: appt.id,
        ref: appt.ref,
        kind,
        status: 'skipped_window',
        apptIso: appt.datetimeISO ?? appt.datetimeIso,
        to: appt.patientWaId,
        lang,
      });
      await audit(tenantId, 'reminder.skipped', { apptId: appt.id, ref: appt.ref, kind, reason: 'service_window_closed' });
      log('reminder skipped (24h window closed)', clinic.id, appt.ref, kind);
      return 'skipped_window';
    }

    const body = buildReminderBody(clinic, appt, kind, lang);
    const res = await sender.sendButtons(clinic, appt.patientWaId, body, reminderButtons(appt, lang));
    const status = res?.ok ? 'sent' : 'failed';
    const attempts = (priorFailedRow?.attempts || 0) + 1;
    const rowData = {
      status,
      attempts,
      sentAt: res?.ok ? nowDate.toISOString() : null,
      error: res?.ok ? null : res?.error?.message || 'send failed',
    };
    if (priorFailedRow) {
      // Transient-failure retry: update the SAME row (bounded by attempts), so
      // one Graph hiccup doesn't silently forfeit a patient's reminder.
      await store.reminders.update(tenantId, priorFailedRow.id, rowData);
    } else {
      await store.reminders.record(tenantId, {
        apptId: appt.id,
        ref: appt.ref,
        kind,
        apptIso: appt.datetimeISO ?? appt.datetimeIso,
        to: appt.patientWaId,
        lang,
        ...rowData,
      });
    }
    if (res?.ok && convo) {
      // Remember the pending question (incl. its KIND — a typed "no" to the
      // T-3 "on your way?" must not cancel) so a TYPED reply resolves too.
      await store.conversations
        .update(tenantId, convo.id, {
          lastReminder: { apptId: appt.id, ref: appt.ref, kind, at: nowDate.toISOString() },
        })
        .catch(() => {});
    }
    await audit(tenantId, res?.ok ? 'reminder.sent' : 'reminder.failed', {
      apptId: appt.id, ref: appt.ref, kind, to: appt.patientWaId, attempts,
    });
    if (res?.ok) {
      bus?.publish?.('reminder.sent', { tenantId, apptId: appt.id, ref: appt.ref, kind });
    }
    return status;
  }

  // Re-entrancy guard: a tick doing real Graph sends can outlive the interval;
  // an overlapping pass would race the dedupe read and double-send.
  let ticking = false;

  /** One scheduler pass. Fully deterministic given (store, now). */
  async function tick(nowArg) {
    if (ticking) return { sent: 0, skipped: 'reentrant' };
    ticking = true;
    try {
      return await tickOnce(nowArg);
    } finally {
      ticking = false;
    }
  }

  async function tickOnce(nowArg) {
    if (!store.reminders || typeof store.listClinics !== 'function') return { sent: 0 };
    const nowDate = nowArg ? new Date(nowArg) : clock();
    const nowMs = nowDate.getTime();
    const counts = { sent: 0, skipped_window: 0, failed: 0, no_answer: 0 };

    for (const clinic of store.listClinics()) {
      // Facilitator tenants have no calendar — nothing to remind (D2). Any
      // legacy confirmed appointments from before a type switch are staff's.
      if (isFacilitator(clinic)) continue;
      const cfg = reminderCfg(clinic);
      if (!cfg.enabled) continue;
      const quiet = clinic.notifications?.quietHours?.enabled ? clinic.notifications.quietHours : null;
      const tz = clinic.timezone || 'Africa/Tunis';

      let appts = [];
      try {
        appts = await store.appointments.list(clinic.id, { status: 'confirmed' });
      } catch {
        continue;
      }
      for (const appt of appts) {
        if (!appt.patientWaId || isSandboxWaId(appt.patientWaId) || appt.channel === 'sandbox') continue;
        const iso = appt.datetimeISO ?? appt.datetimeIso;
        const apptMs = iso ? new Date(iso).getTime() : NaN;
        if (Number.isNaN(apptMs) || apptMs <= nowMs) continue;

        for (const kind of Object.keys(REMINDER_KINDS)) {
          if (!cfg[kind]) continue;
          const { offsetMs, notAfterMs } = REMINDER_KINDS[kind];
          if (!(nowMs >= apptMs - offsetMs && nowMs < apptMs - notAfterMs)) continue;
          // Dedupe: any prior row settles the matter — EXCEPT a transient
          // 'failed' row, which may retry until the attempt cap.
          const prior = await store.reminders.find(clinic.id, appt.id, kind);
          if (prior && (prior.status !== 'failed' || (prior.attempts || 1) >= MAX_SEND_ATTEMPTS)) continue;
          // Quiet hours DELAY (no row): retried next tick until the window closes.
          if (quiet && inQuietHours(nowDate, { start: quiet.from, end: quiet.to }, tz)) continue;
          try {
            const outcome = await remindOne(clinic, appt, kind, nowDate, prior);
            counts[outcome] = (counts[outcome] || 0) + 1;
          } catch (e) {
            log('reminder dispatch failed', clinic.id, appt.ref, kind, e?.message);
          }
        }
      }

      // Outcome resolution once the appointment time passes: silence becomes
      // `no_answer` — but ONLY for appointments that still stood. A slot staff
      // cancelled (or marked done early) closes its reminder row instead, so
      // the owner's no-answer stat never counts patients who had no question
      // left to answer.
      try {
        const sentRows = await store.reminders.list(clinic.id, { status: 'sent' });
        for (const row of sentRows) {
          const apptMs = row.apptIso ? new Date(row.apptIso).getTime() : NaN;
          if (Number.isNaN(apptMs) || apptMs > nowMs) continue;
          const appt = await store.appointments.get(clinic.id, row.apptId);
          const stillStood = appt && ['pending', 'confirmed'].includes(appt.status);
          await store.reminders.update(clinic.id, row.id, {
            status: stillStood ? 'no_answer' : 'closed',
          });
          if (stillStood) counts.no_answer += 1;
        }
      } catch {
        /* best-effort */
      }
    }
    return counts;
  }

  return {
    tick,
    start() {
      const interval = Number(config.remindersIntervalMs) || 0;
      if (interval <= 0 || timer) return;
      timer = setInterval(() => {
        tick().catch((e) => log('reminder tick failed', e?.message));
      }, interval);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export default createReminderService;
