// V4 — smart follow-ups. One nudge per conversation EVER, only inside the 24h
// service window, quiet-hours aware, persona-aware, opt-out instant and
// permanent, with a sent → replied → converted funnel in stats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../src/config.js';
import { createStore } from '../src/store/index.js';
import { createFollowupService, buildNudge } from '../src/followups/index.js';
import { computeAnalytics } from '../src/stats/index.js';
import { makeTestApp } from '../test-helpers/client.js';
import { ingestInbound } from '../src/api/ingest.js';

const HOUR = 3600 * 1000;
const TENANT = 'el-amen-sousse';

function freshStore() {
  const base = getConfig();
  const runtimeDir = path.join(os.tmpdir(), `omen-fu-${randomUUID()}`);
  return createStore({ clinicsFile: base.clinicsFile, runtimeDir, reset: true });
}

function fakeSender() {
  const calls = [];
  return {
    calls,
    async sendText(tenant, to, text) {
      calls.push({ to, text });
      return { ok: true, waMessageId: `m${calls.length}` };
    },
    async sendButtons() { return { ok: true }; },
  };
}

const bus = () => ({ events: [], publish(type, e) { this.events.push({ type, ...e }); } });

/** Seed a conversation whose LAST message is outbound `agoMs` ago (bot spoke last). */
async function seedConvo(store, waId, { agoMs, state = null, tenant = TENANT } = {}) {
  const convo = await store.conversations.create(tenant, { patientWaId: waId, lang: 'ar' });
  const inboundTs = new Date(Date.now() - agoMs - 60 * 1000).toISOString();
  const outboundTs = new Date(Date.now() - agoMs).toISOString();
  await store.conversations.appendMessage(tenant, convo.id, {
    direction: 'inbound', body: { text: 'قداش السعر؟', by: 'patient' }, ts: inboundTs,
  });
  await store.conversations.appendMessage(tenant, convo.id, {
    direction: 'outbound', body: { text: 'الأسعار تبدأ من …', by: 'bot' }, ts: outboundTs,
  });
  if (state) await store.conversations.update(tenant, convo.id, { state });
  return store.conversations.get(tenant, waId);
}

async function seedLead(store, convo, tenant = TENANT) {
  return store.leads.upsertOpen(tenant, {
    conversationId: convo.id,
    patientWaId: convo.waId,
    procedure: 'dental',
    details: { reason: 'pricing_high_value' },
  });
}

test('a silent lead gets exactly ONE contextual nudge — and never a second', async () => {
  const store = freshStore();
  const sender = fakeSender();
  const convo = await seedConvo(store, '218910000200', { agoMs: 5 * HOUR });
  await seedLead(store, convo);

  const svc = createFollowupService({ store, sender, bus: bus(), config: {} });
  const first = await svc.tick(new Date());
  assert.equal(first.sent, 1);
  assert.ok(sender.calls[0].text.includes('طب الأسنان') || sender.calls[0].text.includes('نطمن'), 'contextual AR nudge');

  const second = await svc.tick(new Date());
  assert.equal(second.sent, 0, 'one nudge per conversation, ever');
  const fresh = await store.conversations.get(TENANT, '218910000200');
  assert.equal(fresh.nudge.type, 'leadSilent');
});

test('too-recent silence does not nudge (default 4h threshold)', async () => {
  const store = freshStore();
  const sender = fakeSender();
  const convo = await seedConvo(store, '218910000201', { agoMs: 2 * HOUR });
  await seedLead(store, convo);
  const svc = createFollowupService({ store, sender, bus: bus(), config: {} });
  assert.equal((await svc.tick(new Date())).sent, 0);
});

test('an abandoned booking flow gets a resume nudge that re-asks the pending question', async () => {
  const store = freshStore();
  const sender = fakeSender();
  await seedConvo(store, '218910000202', {
    agoMs: 3 * HOUR,
    state: { flow: 'booking', step: 'datetime', data: { specialty: 'dental' } },
  });
  const svc = createFollowupService({ store, sender, bus: bus(), config: {} });
  assert.equal((await svc.tick(new Date())).sent, 1);
  const text = sender.calls[0].text;
  assert.ok(text.includes('كل شيء محفوظ'), 'resume framing');
  assert.ok(text.includes('أي نهار وأي ساعة'), 're-asks the datetime question');
});

test('closed 24h window: nudge is skipped and logged, never sent', async () => {
  const store = freshStore();
  const sender = fakeSender();
  const convo = await seedConvo(store, '218910000203', { agoMs: 30 * HOUR }); // window long closed
  await seedLead(store, convo);
  const svc = createFollowupService({ store, sender, bus: bus(), config: {} });
  const res = await svc.tick(new Date());
  assert.equal(res.sent, 0);
  assert.equal(res.skipped_window, 1);
  assert.equal(sender.calls.length, 0);
});

test('paused (takeover/emergency) conversations are never nudged', async () => {
  const store = freshStore();
  const sender = fakeSender();
  const convo = await seedConvo(store, '218910000204', { agoMs: 5 * HOUR });
  await seedLead(store, convo);
  await store.conversations.update(TENANT, convo.id, { aiPaused: true, status: 'needs_human' });
  const svc = createFollowupService({ store, sender, bus: bus(), config: {} });
  assert.equal((await svc.tick(new Date())).sent, 0);
});

test('quiet hours delay nudges', async () => {
  const store = freshStore();
  const sender = fakeSender();
  const clinic = store.getClinicById(TENANT);
  clinic.notifications = { ...(clinic.notifications || {}), quietHours: { enabled: true, from: '00:00', to: '23:59' } };
  const convo = await seedConvo(store, '218910000205', { agoMs: 5 * HOUR });
  await seedLead(store, convo);
  const svc = createFollowupService({ store, sender, bus: bus(), config: {} });
  assert.equal((await svc.tick(new Date())).sent, 0);
});

test('post-visit care nudge fires for a done appointment', async () => {
  const store = freshStore();
  const sender = fakeSender();
  await seedConvo(store, '218910000206', { agoMs: 5 * HOUR });
  await store.appointments.create(TENANT, {
    patientWaId: '218910000206', patientName: 'محمد', specialty: 'dental',
    datetimeISO: new Date(Date.now() - 6 * HOUR).toISOString(), status: 'done', lang: 'ar',
  });
  const svc = createFollowupService({ store, sender, bus: bus(), config: {} });
  assert.equal((await svc.tick(new Date())).sent, 1);
  assert.ok(sender.calls[0].text.includes('نتمناو تكون بخير'));
});

test('persona: a cabinet nudge speaks as the doctor, a facilitator nudge as the agency', () => {
  const base = getConfig();
  const runtimeDir = path.join(os.tmpdir(), `omen-fu-p-${randomUUID()}`);
  const store = createStore({ clinicsFile: base.clinicsFile, runtimeDir, reset: true });
  const cabinet = store.getClinicById('cabinet-bensalem-sousse');
  const agency = store.getClinicById('medtour-tripoli-sousse');
  const cabNudge = buildNudge({ clinic: cabinet, convo: {}, lead: { procedure: 'cardiology' }, type: 'leadSilent', lang: 'ar' });
  assert.ok(cabNudge.includes('الدكتور بن سالم'));
  const facNudge = buildNudge({ clinic: agency, convo: {}, lead: { procedure: 'dental' }, type: 'leadSilent', lang: 'ar' });
  assert.ok(facNudge.includes('MedTour'));
});

test('opt-out: "لا شكراً" right after a nudge is permanent + acked; engine skipped', async () => {
  const composed = makeTestApp();
  const { store } = composed;
  const clinic = store.getClinicById(TENANT);
  const convo = await seedConvo(store, '218910000207', { agoMs: 1 * HOUR });
  await store.conversations.update(TENANT, convo.id, {
    nudge: { type: 'leadSilent', at: new Date().toISOString() },
  });
  const deps = { store, engine: composed.engine, sender: composed.sender, bus: composed.bus, config: composed.config };
  const res = await ingestInbound(deps, {
    channel: 'whatsapp', from: '218910000207', text: 'لا شكراً',
    phoneNumberId: clinic.whatsapp.phoneNumberId, messageId: 'wamid.nud1', timestamp: Date.now(),
  });
  assert.equal(res.nudge, 'opt_out');
  const fresh = await store.conversations.get(TENANT, '218910000207');
  assert.equal(fresh.nudgeOptOut, true);
  assert.equal(fresh.nudge.replied, true);
  const msgs = await store.conversations.listMessages(TENANT, convo.id, {});
  assert.ok(msgs.filter((m) => m.direction === 'outbound').pop().body.text.includes('ماشي مشكل'));
});

test('a positive reply after a nudge marks it replied and still reaches the engine', async () => {
  const composed = makeTestApp();
  const { store } = composed;
  const clinic = store.getClinicById(TENANT);
  const convo = await seedConvo(store, '218910000208', { agoMs: 1 * HOUR });
  await store.conversations.update(TENANT, convo.id, {
    nudge: { type: 'leadSilent', at: new Date().toISOString() },
  });
  const deps = { store, engine: composed.engine, sender: composed.sender, bus: composed.bus, config: composed.config };
  const res = await ingestInbound(deps, {
    channel: 'whatsapp', from: '218910000208', text: 'نحب نحجز موعد',
    phoneNumberId: clinic.whatsapp.phoneNumberId, messageId: 'wamid.nud2', timestamp: Date.now(),
  });
  assert.ok(res.out, 'engine handled the actual message');
  assert.equal(res.out.intent, 'book_appointment');
  const fresh = await store.conversations.get(TENANT, '218910000208');
  assert.equal(fresh.nudge.replied, true);
  assert.ok(!fresh.nudgeOptOut);
});

test('an emergency right after a nudge goes to the SAFETY path, never the opt-out path', async () => {
  const composed = makeTestApp();
  const { store } = composed;
  const clinic = store.getClinicById(TENANT);
  const convo = await seedConvo(store, '218910000209', { agoMs: 1 * HOUR });
  await store.conversations.update(TENANT, convo.id, {
    nudge: { type: 'leadSilent', at: new Date().toISOString() },
  });
  const deps = { store, engine: composed.engine, sender: composed.sender, bus: composed.bus, config: composed.config };
  const res = await ingestInbound(deps, {
    channel: 'whatsapp', from: '218910000209', text: 'لا نجم نتنفس صدري يوجعني برشا',
    phoneNumberId: clinic.whatsapp.phoneNumberId, messageId: 'wamid.nud3', timestamp: Date.now(),
  });
  assert.ok(res.emergency, 'emergency preflight won');
  const fresh = await store.conversations.get(TENANT, '218910000209');
  assert.ok(!fresh.nudgeOptOut, 'a cry for help is not an opt-out');
});

test('a mid-flow correction containing "لا" is NOT an opt-out — the flow handles it', async () => {
  const composed = makeTestApp();
  const { store } = composed;
  const clinic = store.getClinicById(TENANT);
  const convo = await seedConvo(store, '218910000210', {
    agoMs: 1 * HOUR,
    state: { flow: 'booking', step: 'datetime', data: { specialty: 'dental' } },
  });
  await store.conversations.update(TENANT, convo.id, {
    nudge: { type: 'resumeFlow', at: new Date().toISOString() },
  });
  const deps = { store, engine: composed.engine, sender: composed.sender, bus: composed.bus, config: composed.config };
  const res = await ingestInbound(deps, {
    channel: 'whatsapp', from: '218910000210', text: 'لا نجمش الخميس، الاثنين أحسن',
    phoneNumberId: clinic.whatsapp.phoneNumberId, messageId: 'wamid.nud4', timestamp: Date.now(),
  });
  assert.notEqual(res.nudge, 'opt_out', 'not consumed as an opt-out');
  const fresh = await store.conversations.get(TENANT, '218910000210');
  assert.ok(!fresh.nudgeOptOut, 'no permanent opt-out from a correction');
  assert.ok(res.out, 'the booking flow handled the turn');
});

test('a patient who already booked never gets the leadSilent nudge', async () => {
  const store = freshStore();
  const sender = fakeSender();
  const convo = await seedConvo(store, '218910000211', { agoMs: 5 * HOUR });
  await seedLead(store, convo);
  await store.appointments.create(TENANT, {
    patientWaId: '218910000211', specialty: 'dental', status: 'confirmed',
    datetimeISO: new Date(Date.now() + 48 * HOUR).toISOString(), lang: 'ar',
  });
  const svc = createFollowupService({ store, sender, bus: bus(), config: {} });
  assert.equal((await svc.tick(new Date())).sent, 0, 'the lead did not die — no nudge');
});

test('a flow abandoned AT THE CONFIRM STEP resumes with the recap', async () => {
  const store = freshStore();
  const sender = fakeSender();
  await seedConvo(store, '218910000212', {
    agoMs: 3 * HOUR,
    state: {
      flow: 'booking', step: 'confirm',
      data: {
        specialty: 'dental', slotIso: new Date(Date.now() + 72 * HOUR).toISOString(),
        name: 'محمد', originCity: 'Tripoli', originCountry: 'Libya', contact: '+218910000212',
      },
    },
  });
  const svc = createFollowupService({ store, sender, bus: bus(), config: {} });
  assert.equal((await svc.tick(new Date())).sent, 1);
  assert.ok(sender.calls[0].text.includes('نراجعو الحجز'), 'recap re-rendered');
});

test('stats: nudge funnel counts sent/replied/converted/optOut', () => {
  const tenant = { id: TENANT, timezone: 'Africa/Tunis', config: {} };
  const mkConvo = (nudge, optOut = false) => ({
    clinicId: TENANT, waId: `21891${Math.random()}`, lastMessageAt: new Date().toISOString(),
    nudge, nudgeOptOut: optOut,
  });
  // One minute back: rangePredicate's upper bound is EXCLUSIVE, and a
  // same-millisecond `at`/`to` pair would flakily fall outside the window.
  const now = new Date(Date.now() - 60 * 1000).toISOString();
  const stats = computeAnalytics(
    {
      tenant,
      conversations: [
        mkConvo({ type: 'leadSilent', at: now, replied: true, converted: true }),
        mkConvo({ type: 'resumeFlow', at: now, replied: true }, true),
        mkConvo({ type: 'postVisit', at: now }),
        mkConvo(null),
      ],
    },
    { from: new Date(Date.now() - 24 * HOUR), to: new Date() }
  );
  assert.deepEqual(stats.nudges, { sent: 3, replied: 2, converted: 1, optOut: 1 });
});
