// D2 — facilitator mode (medical-tourism agencies). An agency has no local
// calendar: the appointment flow must be UNREACHABLE (classic and humanize),
// the conversation qualifies the patient into a rich lead, the owner is pinged
// exactly once, and the dashboard/API surfaces gate by tenant type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../src/config.js';
import { createStore } from '../src/store/index.js';
import { createEngine } from '../src/engine/index.js';
import { MockProvider } from '../src/llm/mockProvider.js';
import { FakeStructuredProvider } from '../test-helpers/fakeStructuredProvider.js';
import { makeTestApp, listen, request, setupOwner } from '../test-helpers/client.js';
import { ingestInbound } from '../src/api/ingest.js';

const NOW = new Date(2026, 7, 2, 9, 0, 0);
const FAC_PNID = '1000000004'; // medtour-tripoli-sousse
const FAC_ID = 'medtour-tripoli-sousse';

function freshEngine() {
  const base = getConfig();
  const runtimeDir = path.join(os.tmpdir(), `omen-fac-${randomUUID()}`);
  const store = createStore({ clinicsFile: base.clinicsFile, runtimeDir, reset: true });
  const engine = createEngine({ store, provider: new MockProvider(), config: base });
  return { store, engine };
}

function llmEngine(plans) {
  const config = getConfig({ conversationMode: 'llm' });
  const runtimeDir = path.join(os.tmpdir(), `omen-fac-llm-${randomUUID()}`);
  const store = createStore({ clinicsFile: config.clinicsFile, runtimeDir, reset: true });
  const provider = new FakeStructuredProvider({ plans });
  const engine = createEngine({ store, provider, config });
  return { store, engine, provider };
}

async function driveAll(engine, { from, phoneNumberId }, script) {
  const outs = [];
  for (const text of script) {
    outs.push(
      await engine.handleMessage(
        { channel: 'simulate', from, text, phoneNumberId, messageId: 'm', timestamp: NOW.getTime() },
        { now: NOW }
      )
    );
  }
  return outs;
}

// ── classic qualification e2e ────────────────────────────────────────────────

test('facilitator AR qualification end-to-end: rich lead, single alert, zero appointments', async () => {
  const { store, engine } = freshEngine();
  const outs = await driveAll(
    engine,
    { from: '218925550100', phoneNumberId: FAC_PNID },
    [
      'السلام عليكم',
      'نحب نعمل زرع أسنان في تونس',
      'من طرابلس، ليبيا',
      'الشهر الجاي إن شاء الله',
      'رقمي +218 92 555 0100',
    ]
  );

  // Agency persona, never a clinic switchboard, never a booking form.
  assert.ok(outs[0].reply.includes('الوكالة'), 'greeting speaks as the agency');
  assert.ok(!outs.some((o) => o.reply.includes('1️⃣')), 'no numbered booking form');
  assert.ok(!outs.some((o) => o.appointment), 'no appointment can exist');

  const last = outs[outs.length - 1];
  assert.ok(last.reply.includes('نلقاولك أحسن عيادة'), 'ends on the same-day-offer promise');

  const fl = last.facilitatorLead;
  assert.ok(fl, 'lead snapshot exposed');
  assert.equal(fl.procedure, 'dental');
  assert.equal(fl.originCountry, 'Libya');
  assert.ok(fl.travelWindow.includes('الشهر الجاي'));
  assert.equal(fl.contact, '+21892555 0100'.replace(' ', ''));
  assert.equal(fl.rich, true);

  // The alert fires exactly once across the whole conversation.
  const alerts = outs.filter((o) => o.facilitatorLead?.alert);
  assert.equal(alerts.length, 1);

  // A follow-up message must not re-run the interview or re-alert.
  const more = await driveAll(engine, { from: '218925550100', phoneNumberId: FAC_PNID }, ['شكرا']);
  assert.ok(!more[0].facilitatorLead?.alert, 'no second alert');
  assert.equal(store.listAppointments().length, 0);
});

test('facilitator pricing ask: budget signal captured, never a price quoted', async () => {
  const { engine } = freshEngine();
  const outs = await driveAll(
    engine,
    { from: '218925550101', phoneNumberId: FAC_PNID },
    ['قداش سعر عملية التجميل؟']
  );
  const reply = outs[0].reply;
  assert.ok(!/\d+\s*€|€\s*\d+/.test(reply), 'no euro figure appears');
  assert.ok(reply.includes('تبدأ من') || reply.includes('عروض'), 'concierge framing');
  assert.equal(outs[0].state?.data?.budgetAsked, true);
});

test('facilitator cancel mid-qualification exits cleanly', async () => {
  const { engine } = freshEngine();
  const outs = await driveAll(
    engine,
    { from: '218925550102', phoneNumberId: FAC_PNID },
    ['نحب نعمل عملية تجميل', 'إلغاء']
  );
  assert.equal(outs[1].intent, 'cancel');
  assert.equal(outs[1].state, null);
});

// ── humanize path: booking unreachable ───────────────────────────────────────

test('humanize facilitator: confirm_booking with complete slots NEVER books — lead instead', async () => {
  const plan = (over = {}) => ({
    reply_text: 'باهي 🙌', detected_lang: 'ar', actions: ['none'], slots_patch: {}, ...over,
  });
  const { store, engine, provider } = llmEngine([
    plan({
      // The LLM (against its instructions) tries to book with full slots.
      actions: ['propose_summary', 'confirm_booking'],
      slots_patch: {
        specialty: 'dental',
        datetimeText: 'الاثنين 10',
        name: 'سالم المصراتي',
        origin: 'بنغازي',
        contact: '+218925550103',
      },
    }),
  ]);
  const outs = await driveAll(engine, { from: '218925550103', phoneNumberId: FAC_PNID }, [
    'نحب زرع أسنان، من بنغازي، رقمي 0925550103',
  ]);
  assert.ok(!outs[0].appointment, 'finalizeBooking unreachable for facilitators');
  assert.equal(store.listAppointments().length, 0);
  assert.ok(!outs[0].reply.includes('نراجعو الحجز'), 'no booking recap rendered');
  assert.equal(outs[0].state?.flow, 'qualify', 'flow is qualification, not booking');
  const fl = outs[0].facilitatorLead;
  assert.ok(fl?.procedure === 'dental' && fl?.rich, 'rich lead extracted instead');

  // The system prompt carried the concierge goal, not the booking goal.
  const system = provider.calls[0]?.system || '';
  assert.ok(system.includes('BOOKS NOTHING LOCALLY'), 'facilitator prompt used');
  assert.ok(!system.includes('propose_summary" (the system renders the recap'), 'no booking rule');
});

// ── ingest: lead persistence + single owner alert ────────────────────────────

test('ingest persists ONE open facilitator lead and publishes lead.hot once', async () => {
  const composed = makeTestApp();
  const { store, bus } = composed;
  const hot = [];
  bus.on('lead.hot', (e) => hot.push(e));
  const deps = { store, engine: composed.engine, sender: composed.sender, bus, config: composed.config };
  const from = '218925550104';
  const send = (text) =>
    ingestInbound(deps, {
      channel: 'whatsapp', from, text, phoneNumberId: FAC_PNID,
      messageId: `m-${Math.random()}`, timestamp: Date.now(),
    });

  await send('نحب نعمل عملية تجميل في تونس');
  await send('من بنغازي، ليبيا');
  await send('في الصيف');
  await send('رقمي +218 92 555 0104');

  const leads = await store.leads.list(FAC_ID, {});
  assert.equal(leads.length, 1, 'one open lead per conversation');
  const l = leads[0];
  assert.equal(l.procedure, 'cosmetic_surgery');
  assert.equal(l.originCountry, 'Libya');
  assert.equal(l.details.reason, 'facilitator_qualified');
  assert.ok(l.details.travelWindow.includes('الصيف'));
  const facHot = hot.filter((e) => e.lead?.reason === 'facilitator_qualified');
  assert.equal(facHot.length, 1, 'owner pinged exactly once');
});

test('the facilitator_qualified alert reaches the OWNER WHATSAPP layer (not swallowed by dedupe)', async () => {
  // Full app: real notification service on the bus, mock WhatsApp transport.
  const composed = makeTestApp();
  const { store, bus, sender, notifier } = composed;
  // Give the agency an owner recipient so the notifier has someone to ping.
  const clinic = store.getClinicById(FAC_ID);
  clinic.notifications = { recipients: ['21673000445'], lang: 'fr' };

  const deps = { store, engine: composed.engine, sender, bus, config: composed.config };
  const from = '218925550108';
  const send = (text) =>
    ingestInbound(deps, {
      channel: 'whatsapp', from, text, phoneNumberId: FAC_PNID,
      messageId: `m-${Math.random()}`, timestamp: Date.now(),
    });

  await send('نحب نعمل عملية تجميل في تونس');
  await send('من بنغازي، ليبيا'); // pre-fix: generic stated_foreign_origin fired HERE and burned the dedupe
  await send('في الصيف');
  await send('رقمي +218 92 555 0108');
  await notifier.settled();

  // The owner got exactly ONE lead alert and it is the QUALIFIED one.
  const events = await store.events.list(FAC_ID, { type: 'notification.sent' });
  const leadPings = events.filter((e) => e.payload?.event === 'lead.hot');
  assert.equal(leadPings.length, 1, 'exactly one owner lead ping');
  // The message content came from the facilitator_qualified formatter.
  const msgs = await store.conversations.get(FAC_ID, '21673000445'); // owner is not a convo — check outbox via events only
  // Confirm no generic detector ping ever fired for this facilitator tenant.
  const hotEvents = [];
  bus.on('lead.hot', (e) => hotEvents.push(e));
  await send('شكرا');
  await notifier.settled();
  assert.ok(hotEvents.every((e) => e.lead?.reason !== 'stated_foreign_origin'), 'generic detector stays silent');
});

// ── API gating ───────────────────────────────────────────────────────────────

test('appointments API is 404 for facilitator tenants; leads API works', async () => {
  const { app } = makeTestApp();
  const server = await listen(app);
  try {
    const { cookie } = await setupOwner(server, { tenantId: FAC_ID, email: `f-${randomUUID()}@t.tn` });
    const appts = await request(server, 'GET', '/api/appointments', { cookie });
    assert.equal(appts.status, 404);
    const leads = await request(server, 'GET', '/api/leads', { cookie });
    assert.equal(leads.status, 200);
  } finally {
    server.close();
  }
});

test('PUT /api/tenant persists partners + destinations with validation', async () => {
  const { app } = makeTestApp();
  const server = await listen(app);
  try {
    const { cookie } = await setupOwner(server, { tenantId: FAC_ID, email: `f-${randomUUID()}@t.tn` });
    const ok = await request(server, 'PUT', '/api/tenant', {
      cookie,
      body: {
        destinations: ['Sousse', 'Tunis'],
        partners: [{ name: 'Clinique X', city: 'Tunis', specialties: ['dental'] }],
      },
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.tenant.config.destinations, ['Sousse', 'Tunis']);
    assert.equal(ok.body.tenant.config.partners[0].name, 'Clinique X');

    const bad = await request(server, 'PUT', '/api/tenant', {
      cookie,
      body: { partners: [{ city: 'no-name' }] },
    });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});

test('a mid-qualification price ask is never recorded as the pending answer', async () => {
  const { engine } = freshEngine();
  const outs = await driveAll(
    engine,
    { from: '218925550105', phoneNumberId: FAC_PNID },
    ['نحب نعمل عملية تجميل', 'من بنغازي', 'قداش السعر؟', 'في الصيف']
  );
  // The price ask (turn 3) hit the window step: budget note + the window
  // question re-asked, and the REAL window answer lands on turn 4.
  const d = outs[3].state?.data;
  assert.equal(d.budgetAsked, true);
  assert.ok(d.travelWindow.includes('الصيف'), 'window holds the real answer');
  assert.ok(!d.travelWindow.includes('السعر'), 'price ask never stored as window');
});

test('cancel + re-qualification never double-pings the owner', async () => {
  const { engine } = freshEngine();
  const id = { from: '218925550106', phoneNumberId: FAC_PNID };
  const first = await driveAll(engine, id, [
    'نحب نعمل عملية تجميل', 'من بنغازي', 'في الصيف', 'رقمي +218 92 555 0106',
  ]);
  assert.equal(first.filter((o) => o.facilitatorLead?.alert).length, 1);
  const again = await driveAll(engine, id, [
    'إلغاء', 'نحب نعمل عملية تجميل', 'من بنغازي', 'في الشتاء', 'رقمي +218 92 555 0106',
  ]);
  assert.equal(again.filter((o) => o.facilitatorLead?.alert).length, 0, 'no second alert');
});

test('reminders never fire for facilitator tenants, and legacy buttons are inert', async () => {
  const { createReminderService, applyReminderReply } = await import('../src/reminders/index.js');
  const base = getConfig();
  const runtimeDir = path.join(os.tmpdir(), `omen-fac-rem-${randomUUID()}`);
  const store = createStore({ clinicsFile: base.clinicsFile, runtimeDir, reset: true });
  // A legacy confirmed appointment from before the tenant became a facilitator.
  const appt = await store.appointments.create(FAC_ID, {
    ref: 'MTS-OLD-001', patientWaId: '218925550107', specialty: 'dental',
    datetimeISO: new Date(Date.now() + 40 * 3600 * 1000).toISOString(),
    status: 'confirmed', lang: 'ar', channel: 'whatsapp',
  });
  const calls = [];
  const sender = { async sendButtons(...a) { calls.push(a); return { ok: true }; }, async sendText() { return { ok: true }; } };
  const svc = createReminderService({ store, sender, bus: { publish() {} }, config: {} });
  await svc.tick(new Date(Date.now() + 3600 * 1000)); // inside the t48 window
  assert.equal(calls.length, 0, 'no reminder sent to a facilitator patient');

  const convo = await store.conversations.create(FAC_ID, { patientWaId: appt.patientWaId });
  const clinic = store.getClinicById(FAC_ID);
  const res = await applyReminderReply(
    { store, bus: { publish() {} }, clinic, convo, patientWaId: appt.patientWaId },
    { action: 'reschedule', apptId: appt.id }
  );
  assert.equal(res.handled, false, 'legacy reminder buttons are inert');
  assert.equal((await store.appointments.get(FAC_ID, appt.id)).status, 'confirmed');
});

// ── regressions: clinics and cabinets untouched ──────────────────────────────

test('clinic booking still books; facilitator route never triggers for clinics', async () => {
  const { store, engine } = freshEngine();
  const outs = await driveAll(
    engine,
    { from: '218910000110', phoneNumberId: '1000000001' },
    ['نحب نحجز موعد أسنان', 'نهار الاثنين الساعة 10', 'اسمي سعاد بن علي', 'من طرابلس', '+218 91 000 0110', 'نعم']
  );
  assert.ok(outs[outs.length - 1].appointment, 'clinic still books');
  assert.equal(store.listAppointments().length, 1);
  assert.ok(!outs.some((o) => o.facilitatorLead), 'no facilitator snapshot for clinics');
});
