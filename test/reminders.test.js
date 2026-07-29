// V2 — appointment reminders (the no-show killer). The scheduler is
// deterministic: given (store, now) a tick decides what is due, honors the
// dedupe row, quiet hours and Meta's 24h service window, and patient replies
// (buttons or typed yes/no) resolve appointment status deterministically
// before the engine sees the turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../src/config.js';
import { createStore } from '../src/store/index.js';
import {
  createReminderService,
  parseReminderAction,
  REMINDER_KINDS,
} from '../src/reminders/index.js';
import { computeAnalytics } from '../src/stats/index.js';
import { makeTestApp, listen, request, setupOwner } from '../test-helpers/client.js';
import { ingestInbound } from '../src/api/ingest.js';

const HOUR = 3600 * 1000;
const TENANT = 'el-amen-sousse';
const PNID_BY_ID = true; // appointments are seeded directly; no engine needed here

function freshStore() {
  const base = getConfig();
  const runtimeDir = path.join(os.tmpdir(), `omen-rem-${randomUUID()}`);
  return createStore({ clinicsFile: base.clinicsFile, runtimeDir, reset: true });
}

/** Recording sender stub — asserts on exactly what would go to WhatsApp. */
function fakeSender() {
  const calls = [];
  return {
    calls,
    async sendButtons(tenant, to, body, buttons) {
      calls.push({ kind: 'buttons', to, body, buttons });
      return { ok: true, waMessageId: `m${calls.length}` };
    },
    async sendText(tenant, to, text) {
      calls.push({ kind: 'text', to, text });
      return { ok: true, waMessageId: `m${calls.length}` };
    },
  };
}

const fakeBus = () => ({ events: [], publish(type, e) { this.events.push({ type, ...e }); } });

// Appointment on Tuesday 2026-08-04 10:00 local (fixed, matches working hours).
const APPT_ISO = new Date(2026, 7, 4, 10, 0, 0).toISOString();

async function seedAppt(store, over = {}) {
  return store.appointments.create(TENANT, {
    ref: 'EAS-TEST-001',
    patientWaId: '218910000077',
    specialty: 'cardiology',
    specialtyLabel: 'Cardiologie',
    datetimeISO: APPT_ISO,
    patientName: 'Test Patient',
    contact: '+218910000077',
    lang: 'ar',
    status: 'confirmed',
    channel: 'whatsapp',
    ...over,
  });
}

// A recent inbound message opens the 24h service window.
async function openWindow(store, waId, atMs) {
  let convo = await store.conversations.get(TENANT, waId);
  if (!convo) convo = await store.conversations.create(TENANT, { patientWaId: waId });
  await store.conversations.appendMessage(TENANT, convo.id, {
    direction: 'inbound',
    body: { text: 'hello', by: 'patient' },
    ts: new Date(atMs).toISOString(),
  });
  return convo;
}

function svc(store, sender, bus, configOver = {}) {
  return createReminderService({ store, sender, bus, config: { ...configOver } });
}

// ── scheduling math ──────────────────────────────────────────────────────────

test('T-48 fires inside its window, once, with confirm/cancel/reschedule buttons', async () => {
  const store = freshStore();
  const sender = fakeSender();
  const bus = fakeBus();
  const appt = await seedAppt(store);
  const now = new Date(new Date(APPT_ISO).getTime() - 47 * HOUR);
  await openWindow(store, appt.patientWaId, now.getTime() - HOUR);

  const s = svc(store, sender, bus);
  const first = await s.tick(now);
  assert.equal(first.sent, 1);
  assert.equal(sender.calls.length, 1);
  const call = sender.calls[0];
  assert.equal(call.kind, 'buttons');
  assert.ok(call.body.includes('EAS-TEST-001'), 'body carries the ref');
  assert.deepEqual(
    call.buttons.map((b) => b.id),
    [`rem:c:${appt.id}`, `rem:x:${appt.id}`, `rem:r:${appt.id}`]
  );

  // Dedupe: an immediate second tick sends nothing.
  const second = await s.tick(now);
  assert.equal(second.sent, 0);
  assert.equal(sender.calls.length, 1);

  assert.ok(bus.events.some((e) => e.type === 'reminder.sent'));
});

test('T-48 does NOT fire for an appointment booked less than 24h out; T-3 does', async () => {
  const store = freshStore();
  const sender = fakeSender();
  const appt = await seedAppt(store);
  const s = svc(store, sender, fakeBus());

  // 20h before: outside the t48 window [T-48, T-24), inside nothing yet.
  await openWindow(store, appt.patientWaId, new Date(APPT_ISO).getTime() - 21 * HOUR);
  await s.tick(new Date(new Date(APPT_ISO).getTime() - 20 * HOUR));
  assert.equal(sender.calls.length, 0);

  // 2h before: inside the t3 window [T-3, T-30min).
  await s.tick(new Date(new Date(APPT_ISO).getTime() - 2 * HOUR));
  assert.equal(sender.calls.length, 1);
  const rows = await store.reminders.list(TENANT, {});
  assert.deepEqual(rows.map((r) => r.kind), ['t3']);
});

test('a cancelled appointment never gets a reminder', async () => {
  const store = freshStore();
  const sender = fakeSender();
  const appt = await seedAppt(store, { status: 'cancelled' });
  await openWindow(store, appt.patientWaId, new Date(APPT_ISO).getTime() - 48 * HOUR);
  const s = svc(store, sender, fakeBus());
  await s.tick(new Date(new Date(APPT_ISO).getTime() - 40 * HOUR));
  assert.equal(sender.calls.length, 0);
});

test('quiet hours DELAY a reminder: skipped during, sent after, no dedupe row in between', async () => {
  const store = freshStore();
  const sender = fakeSender();
  const appt = await seedAppt(store);
  // Africa/Tunis = UTC+1: quiet 21:00–08:00 local.
  const clinic = store.getClinicById(TENANT);
  clinic.notifications = { ...(clinic.notifications || {}), quietHours: { enabled: true, from: '21:00', to: '08:00' } };

  const apptMs = new Date(APPT_ISO).getTime();
  await openWindow(store, appt.patientWaId, apptMs - 48 * HOUR);
  const s = svc(store, sender, fakeBus());

  // T-36h lands at 22:00 local on Aug 2 → inside quiet hours (delay, no row).
  const during = new Date(2026, 7, 2, 22, 0, 0);
  await s.tick(during);
  assert.equal(sender.calls.length, 0);
  assert.equal((await store.reminders.list(TENANT, {})).length, 0);

  // Next morning 09:00 local (still inside [T-48, T-24)) → sends.
  const after = new Date(2026, 7, 3, 9, 0, 0);
  await s.tick(after);
  assert.equal(sender.calls.length, 1);
});

test('24h window closed → skipped_window row + audit, nothing sent', async () => {
  const store = freshStore();
  const sender = fakeSender();
  const appt = await seedAppt(store);
  const apptMs = new Date(APPT_ISO).getTime();
  // Last patient message 30h ago → window closed.
  await openWindow(store, appt.patientWaId, apptMs - 47 * HOUR - 30 * HOUR);
  const s = svc(store, sender, fakeBus());
  await s.tick(new Date(apptMs - 47 * HOUR));
  assert.equal(sender.calls.length, 0);
  const rows = await store.reminders.list(TENANT, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'skipped_window');
  // Dedupe holds: the same kind never retries.
  await s.tick(new Date(apptMs - 46 * HOUR));
  assert.equal(sender.calls.length, 0);
});

test('a sent reminder with no reply becomes no_answer after the appointment time', async () => {
  const store = freshStore();
  const sender = fakeSender();
  const appt = await seedAppt(store);
  const apptMs = new Date(APPT_ISO).getTime();
  await openWindow(store, appt.patientWaId, apptMs - 3 * HOUR);
  const s = svc(store, sender, fakeBus());
  await s.tick(new Date(apptMs - 2 * HOUR));
  assert.equal(sender.calls.length, 1);
  await s.tick(new Date(apptMs + HOUR));
  const rows = await store.reminders.list(TENANT, {});
  assert.equal(rows[0].status, 'no_answer');
});

test('per-tenant toggles: reminders disabled → nothing fires', async () => {
  const store = freshStore();
  const sender = fakeSender();
  const appt = await seedAppt(store);
  const clinic = store.getClinicById(TENANT);
  clinic.reminders = { enabled: false };
  await openWindow(store, appt.patientWaId, new Date(APPT_ISO).getTime() - 47 * HOUR);
  const s = svc(store, sender, fakeBus());
  await s.tick(new Date(new Date(APPT_ISO).getTime() - 47 * HOUR + 1000));
  assert.equal(sender.calls.length, 0);
});

test('sandbox appointments never get reminders', async () => {
  const store = freshStore();
  const sender = fakeSender();
  await seedAppt(store, { patientWaId: 'sandbox:wizard', channel: 'sandbox' });
  const s = svc(store, sender, fakeBus());
  await s.tick(new Date(new Date(APPT_ISO).getTime() - 47 * HOUR));
  assert.equal(sender.calls.length, 0);
});

// ── reply handling through the REAL ingest pipeline ──────────────────────────

function appDeps(composed) {
  const { store, engine, sender, bus, config } = composed;
  return { store, engine, sender, bus, config };
}

const PNID = () => {
  // derive El Amen's pnid from the seed so re-keying never breaks the suite
  return null;
};

test('button reply rem:x cancels the appointment, acks the patient, alerts the owner', async () => {
  const composed = makeTestApp();
  const { store, bus } = composed;
  const appt = await seedAppt(store);
  const convo = await openWindow(store, appt.patientWaId, Date.now() - HOUR);
  const alerts = [];
  bus.on('appointment.cancelled', (e) => alerts.push(e));

  const clinic = store.getClinicById(TENANT);
  const res = await ingestInbound(appDeps(composed), {
    channel: 'whatsapp',
    from: appt.patientWaId,
    text: 'Annuler ❌',
    interactiveId: `rem:x:${appt.id}`,
    phoneNumberId: clinic.whatsapp.phoneNumberId,
    messageId: 'wamid.test1',
    timestamp: Date.now(),
  });
  assert.equal(res.reminder, 'cancelled');
  const updated = await store.appointments.get(TENANT, appt.id);
  assert.equal(updated.status, 'cancelled');
  assert.equal(alerts.length, 1);
  // Patient got the localized ack (AR appointment).
  const msgs = await store.conversations.listMessages(TENANT, convo.id, {});
  const lastOut = msgs.filter((m) => m.direction === 'outbound').pop();
  assert.ok(lastOut.body.text.includes('تم إلغاء الموعد'));
});

test('typed "نعم" right after a reminder confirms it without waking the engine', async () => {
  const composed = makeTestApp();
  const { store } = composed;
  const appt = await seedAppt(store);
  const convo = await openWindow(store, appt.patientWaId, Date.now() - HOUR);
  await store.conversations.update(TENANT, convo.id, {
    lastReminder: { apptId: appt.id, ref: appt.ref, at: new Date().toISOString() },
  });

  const clinic = store.getClinicById(TENANT);
  const res = await ingestInbound(appDeps(composed), {
    channel: 'whatsapp',
    from: appt.patientWaId,
    text: 'نعم',
    phoneNumberId: clinic.whatsapp.phoneNumberId,
    messageId: 'wamid.test2',
    timestamp: Date.now(),
  });
  assert.equal(res.reminder, 'confirmed');
  const rows = await store.reminders.list(TENANT, { apptId: appt.id });
  assert.equal(rows.length, 0); // no sent row existed; status math is stats-only
  const fresh = await store.conversations.get(TENANT, appt.patientWaId);
  assert.equal(fresh.lastReminder, null, 'pending question cleared');
});

test('reschedule reply cancels the old slot and seeds a datetime-only booking flow', async () => {
  const composed = makeTestApp();
  const { store } = composed;
  const appt = await seedAppt(store);
  await openWindow(store, appt.patientWaId, Date.now() - HOUR);

  const clinic = store.getClinicById(TENANT);
  const res = await ingestInbound(appDeps(composed), {
    channel: 'whatsapp',
    from: appt.patientWaId,
    text: 'Changer 🔄',
    interactiveId: `rem:r:${appt.id}`,
    phoneNumberId: clinic.whatsapp.phoneNumberId,
    messageId: 'wamid.test3',
    timestamp: Date.now(),
  });
  assert.equal(res.reminder, 'reschedule');
  assert.equal((await store.appointments.get(TENANT, appt.id)).status, 'cancelled');
  const convo = await store.conversations.get(TENANT, appt.patientWaId);
  assert.equal(convo.state.flow, 'booking');
  assert.equal(convo.state.step, 'datetime');
  assert.equal(convo.state.data.specialty, 'cardiology');
  assert.equal(convo.state.data.name, 'Test Patient');
  assert.equal(convo.state.data.contact, '+218910000077');
});

test('a patient can never act on ANOTHER patient\'s appointment via a crafted button id', async () => {
  const composed = makeTestApp();
  const { store } = composed;
  const appt = await seedAppt(store); // belongs to 218910000077
  const attacker = '218999999999';
  await openWindow(store, attacker, Date.now() - HOUR);

  const clinic = store.getClinicById(TENANT);
  const res = await ingestInbound(appDeps(composed), {
    channel: 'whatsapp',
    from: attacker,
    text: 'Annuler ❌',
    interactiveId: `rem:x:${appt.id}`, // someone else's appointment
    phoneNumberId: clinic.whatsapp.phoneNumberId,
    messageId: 'wamid.test-atk',
    timestamp: Date.now(),
  });
  assert.equal(res.reminder, undefined, 'not resolved as a reminder reply');
  assert.equal((await store.appointments.get(TENANT, appt.id)).status, 'confirmed', 'victim appointment untouched');
});

test('typed "no" after the T-3 "on your way?" reminder does NOT cancel', async () => {
  const composed = makeTestApp();
  const { store } = composed;
  const appt = await seedAppt(store);
  const convo = await openWindow(store, appt.patientWaId, Date.now() - HOUR);
  await store.conversations.update(TENANT, convo.id, {
    lastReminder: { apptId: appt.id, ref: appt.ref, kind: 't3', at: new Date().toISOString() },
  });
  const clinic = store.getClinicById(TENANT);
  const res = await ingestInbound(appDeps(composed), {
    channel: 'whatsapp',
    from: appt.patientWaId,
    text: 'لا',
    phoneNumberId: clinic.whatsapp.phoneNumberId,
    messageId: 'wamid.t3no',
    timestamp: Date.now(),
  });
  assert.equal(res.reminder, undefined, 'falls through to the engine');
  assert.equal((await store.appointments.get(TENANT, appt.id)).status, 'confirmed');
});

test('a bot message AFTER the reminder supersedes it — typed "نعم" no longer confirms', async () => {
  const composed = makeTestApp();
  const { store } = composed;
  const appt = await seedAppt(store);
  const convo = await openWindow(store, appt.patientWaId, Date.now() - HOUR);
  const remAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  await store.conversations.update(TENANT, convo.id, {
    lastReminder: { apptId: appt.id, ref: appt.ref, kind: 't48', at: remAt },
  });
  // The bot answered an FAQ afterwards, ending with its own yes/no question.
  await store.conversations.appendMessage(TENANT, convo.id, {
    direction: 'outbound',
    body: { text: 'تحب تحجز موعد؟', by: 'bot' },
    ts: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });
  const clinic = store.getClinicById(TENANT);
  const res = await ingestInbound(appDeps(composed), {
    channel: 'whatsapp',
    from: appt.patientWaId,
    text: 'نعم',
    phoneNumberId: clinic.whatsapp.phoneNumberId,
    messageId: 'wamid.sup',
    timestamp: Date.now(),
  });
  assert.equal(res.reminder, undefined, 'the newer bot question owns the yes');
});

test('a PAST appointment\'s buttons are inert', async () => {
  const composed = makeTestApp();
  const { store } = composed;
  const appt = await seedAppt(store, {
    datetimeISO: new Date(Date.now() - 40 * 24 * HOUR).toISOString(), // 40 days ago
  });
  await openWindow(store, appt.patientWaId, Date.now() - HOUR);
  const clinic = store.getClinicById(TENANT);
  const res = await ingestInbound(appDeps(composed), {
    channel: 'whatsapp',
    from: appt.patientWaId,
    text: 'Annuler ❌',
    interactiveId: `rem:x:${appt.id}`,
    phoneNumberId: clinic.whatsapp.phoneNumberId,
    messageId: 'wamid.old',
    timestamp: Date.now(),
  });
  assert.equal(res.reminder, undefined);
  assert.equal((await store.appointments.get(TENANT, appt.id)).status, 'confirmed', 'past slot untouched');
});

test('scheduler never sends into a paused (emergency/takeover) conversation', async () => {
  const store = freshStore();
  const sender = fakeSender();
  const appt = await seedAppt(store);
  const convo = await openWindow(store, appt.patientWaId, new Date(APPT_ISO).getTime() - 48 * HOUR);
  await store.conversations.update(TENANT, convo.id, { aiPaused: true, status: 'needs_human' });
  const s = svc(store, sender, fakeBus());
  await s.tick(new Date(new Date(APPT_ISO).getTime() - 47 * HOUR));
  assert.equal(sender.calls.length, 0);
  assert.equal((await store.reminders.list(TENANT, {})).length, 0, 'delayed, not recorded');
});

test('a transient send failure retries next tick and succeeds (bounded attempts)', async () => {
  const store = freshStore();
  const bus = fakeBus();
  const appt = await seedAppt(store);
  await openWindow(store, appt.patientWaId, new Date(APPT_ISO).getTime() - 48 * HOUR);
  let fail = true;
  const calls = [];
  const flaky = {
    async sendButtons(tenant, to, body, buttons) {
      calls.push({ to });
      if (fail) return { ok: false, error: { message: 'http 500' } };
      return { ok: true, waMessageId: 'm-ok' };
    },
    async sendText() { return { ok: true }; },
  };
  const s = svc(store, flaky, bus);
  const t0 = new Date(new Date(APPT_ISO).getTime() - 47 * HOUR);
  await s.tick(t0);
  let rows = await store.reminders.list(TENANT, {});
  assert.equal(rows[0].status, 'failed');
  fail = false;
  await s.tick(new Date(t0.getTime() + 60000));
  rows = await store.reminders.list(TENANT, {});
  assert.equal(rows.length, 1, 'same row updated, not duplicated');
  assert.equal(rows[0].status, 'sent');
  assert.equal(rows[0].attempts, 2);
});

test('an emergency message NEVER resolves as a reminder cancel', async () => {
  const composed = makeTestApp();
  const { store } = composed;
  const appt = await seedAppt(store);
  const convo = await openWindow(store, appt.patientWaId, Date.now() - HOUR);
  await store.conversations.update(TENANT, convo.id, {
    lastReminder: { apptId: appt.id, ref: appt.ref, at: new Date().toISOString() },
  });

  const clinic = store.getClinicById(TENANT);
  const res = await ingestInbound(appDeps(composed), {
    channel: 'whatsapp',
    from: appt.patientWaId,
    // Contains a "no"-like token but IS an emergency — the preflight must win.
    text: 'لا نجم نتنفس صدري يوجعني برشا',
    phoneNumberId: clinic.whatsapp.phoneNumberId,
    messageId: 'wamid.test4',
    timestamp: Date.now(),
  });
  assert.ok(res.emergency, 'emergency preflight handled the turn');
  assert.equal((await store.appointments.get(TENANT, appt.id)).status, 'confirmed');
});

// ── misc unit surfaces ───────────────────────────────────────────────────────

test('parseReminderAction parses ids and rejects garbage', () => {
  assert.deepEqual(parseReminderAction('rem:c:abc'), { action: 'confirm', apptId: 'abc' });
  assert.deepEqual(parseReminderAction('rem:x:a-b'), { action: 'cancel', apptId: 'a-b' });
  assert.deepEqual(parseReminderAction('rem:r:42'), { action: 'reschedule', apptId: '42' });
  assert.equal(parseReminderAction('btn_1'), null);
  assert.equal(parseReminderAction(null), null);
});

test('REMINDER_KINDS windows: t48 [48h,24h), t3 [3h,30min)', () => {
  assert.equal(REMINDER_KINDS.t48.offsetMs, 48 * HOUR);
  assert.equal(REMINDER_KINDS.t48.notAfterMs, 24 * HOUR);
  assert.equal(REMINDER_KINDS.t3.offsetMs, 3 * HOUR);
  assert.equal(REMINDER_KINDS.t3.notAfterMs, 0.5 * HOUR);
});

test('stats: reminder outcomes + weekly no-show trend math', () => {
  const tenant = { id: TENANT, timezone: 'Africa/Tunis', config: {} };
  const mk = (status, daysAgo) => ({
    status,
    tenantId: TENANT,
    createdAt: new Date(Date.now() - daysAgo * 24 * HOUR).toISOString(),
  });
  const appt = (status, daysAgo) => ({
    status,
    tenantId: TENANT,
    patientWaId: '21600000000',
    channel: 'whatsapp',
    createdAt: new Date(Date.now() - daysAgo * 24 * HOUR).toISOString(),
    datetimeISO: new Date(Date.now() - daysAgo * 24 * HOUR).toISOString(),
  });
  const stats = computeAnalytics(
    {
      tenant,
      appointments: [appt('done', 3), appt('done', 3), appt('no_show', 3), appt('done', 30)],
      reminders: [mk('sent', 2), mk('confirmed', 2), mk('cancelled', 1), mk('no_answer', 1), mk('skipped_window', 1)],
    },
    { from: new Date(Date.now() - 14 * 24 * HOUR), to: new Date() }
  );
  assert.equal(stats.reminderOutcomes.sent, 4); // all but skipped_window reached the patient
  assert.equal(stats.reminderOutcomes.confirmed, 1);
  assert.equal(stats.reminderOutcomes.cancelled, 1);
  assert.equal(stats.reminderOutcomes.no_answer, 1);
  assert.equal(stats.reminderOutcomes.skipped_window, 1);
  const week = stats.noShowTrend.find((w) => w.noShow === 1);
  assert.ok(week, 'trend bucket exists');
  assert.equal(week.done, 2);
  assert.equal(week.ratePct, 33);
});

test('sweep closes (not no_answer) reminders whose appointment staff already resolved', async () => {
  const store = freshStore();
  const sender = fakeSender();
  const appt = await seedAppt(store);
  const apptMs = new Date(APPT_ISO).getTime();
  await openWindow(store, appt.patientWaId, apptMs - 3 * HOUR);
  const s = svc(store, sender, fakeBus());
  await s.tick(new Date(apptMs - 2 * HOUR));
  // Staff cancels from the dashboard before the appointment time.
  await store.appointments.updateStatus(TENANT, appt.id, 'cancelled');
  await s.tick(new Date(apptMs + HOUR));
  const rows = await store.reminders.list(TENANT, {});
  assert.equal(rows[0].status, 'closed', 'not counted as a patient no-answer');
});

// ── settings persistence ─────────────────────────────────────────────────────

test('owner settings survive a restart: persisted tenant config hydrates the registry', async () => {
  // Same runtimeDir across two store builds = a restart.
  const base = getConfig();
  const runtimeDir = path.join(os.tmpdir(), `omen-rehydrate-${randomUUID()}`);
  const store1 = createStore({ clinicsFile: base.clinicsFile, runtimeDir, reset: true });
  const t = await store1.tenants.getByPhoneNumberId(
    store1.getClinicById(TENANT).whatsapp.phoneNumberId
  );
  await store1.tenants.upsert({
    ...t,
    config: { ...t.config, reminders: { enabled: true, t48: false, t3: true } },
  });

  const store2 = createStore({ clinicsFile: base.clinicsFile, runtimeDir }); // no reset
  const { hydrateAllClinicsKb } = await import('../src/store/kbLive.js');
  await hydrateAllClinicsKb(store2);
  const clinic = store2.getClinicById(TENANT);
  assert.deepEqual(clinic.reminders, { enabled: true, t48: false, t3: true });
});

test('PUT /api/tenant persists reminder toggles as booleans only', async () => {
  const { app } = makeTestApp();
  const server = await listen(app);
  try {
    const { cookie } = await setupOwner(server, { tenantId: TENANT, email: `o-${randomUUID()}@t.tn` });
    const put = await request(server, 'PUT', '/api/tenant', {
      cookie,
      body: { reminders: { t48: false, t3: true, enabled: true, sneaky: { nested: 1 } } },
    });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.tenant.config.reminders, { enabled: true, t48: false, t3: true });
  } finally {
    server.close();
  }
});
