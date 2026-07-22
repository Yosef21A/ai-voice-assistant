// Notification service + pipeline tests (P1-E). Uses fake bus / sender / store so
// the whole fan-out is deterministic and offline:
//   • correct recipients + formatted text per event
//   • quiet hours suppress a booking but NEVER an emergency
//   • dedupe window (same conversation + type inside 10 min)
//   • per-recipient event toggles + per-recipient language
//   • the service never throws into a bus handler (records an error event)
//   • computeDigestStats math + the money line
//   • pipeline: emergency returns an overrideReply and emits emergency.detected;
//     a hot lead emits lead.hot
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createNotificationService,
  computeDigestStats,
  resolveRecipients,
  inQuietHours,
  isAfterHours,
} from '../src/notifications/service.js';
import { formatDailyDigest } from '../src/notifications/formatter.js';
import { analyzeInbound } from '../src/notifications/pipeline.js';

const CLINICS = JSON.parse(readFileSync(new URL('../data/clinics.json', import.meta.url), 'utf8')).clinics;
const EL = CLINICS.find((c) => c.id === 'el-amen-sousse');
const TENANT_ID = EL.id;
// Default owner recipient, derived from the seed (notifications.recipients wins
// over handoff.phone in resolveRecipients) so the test follows the registry.
const OWNER = String(EL.notifications?.recipients?.[0] || EL.handoff.phone).replace(/\D/g, '');

// ── test doubles ───────────────────────────────────────────────────────────────
function makeBus() {
  const handlers = {};
  return {
    on(type, fn) {
      (handlers[type] || (handlers[type] = [])).push(fn);
    },
    off(type, fn) {
      handlers[type] = (handlers[type] || []).filter((f) => f !== fn);
    },
    publish(type, evt) {
      const env = { at: new Date().toISOString(), ...evt, type };
      for (const fn of handlers[type] || []) fn(env);
    },
  };
}

function makeSender({ throws = false } = {}) {
  return {
    sent: [],
    async sendText(tenant, to, text) {
      if (throws) throw new Error('boom');
      this.sent.push({ to, text, from: tenant?.phoneNumberId ?? null });
      return { ok: true, waMessageId: `wamid.${this.sent.length}` };
    },
  };
}

function makeTenantRecord(configPatch = {}) {
  return {
    id: EL.id,
    name: EL.name,
    phoneNumberId: EL.whatsapp.phoneNumberId,
    timezone: EL.timezone,
    currency: EL.currency,
    config: { ...EL, ...configPatch },
  };
}

// A minimal store implementing exactly the surface the service touches. Appended
// audit events land in `.records` for assertions.
function storeWithEvents({ prefs = [], tenant = makeTenantRecord(), seed = {} } = {}) {
  const records = [];
  return {
    records,
    tenants: {
      async getById(id) {
        return id === tenant.id ? tenant : null;
      },
    },
    notificationPrefs: {
      async list(id) {
        return id === tenant.id ? prefs : [];
      },
    },
    conversations: { async list() { return seed.conversations || []; } },
    appointments: { async list() { return seed.appointments || []; } },
    leads: { async list() { return seed.leads || []; } },
    events: {
      async append(tid, evt) {
        records.push({ tid, ...evt });
        return evt;
      },
    },
  };
}

const clockOf = (ref) => () => ref.now;

// ── recipients + safe defaults ─────────────────────────────────────────────────
test('resolveRecipients — defaults to escalation/owner number when no prefs', () => {
  const rcpts = resolveRecipients(makeTenantRecord(), [], { aliases: ['booking'] });
  assert.equal(rcpts.length, 1);
  assert.equal(rcpts[0].recipient, OWNER); // seed notifications.recipients[0], normalized
  assert.deepEqual(rcpts[0].events, {}); // empty ⇒ all events on
});

test('resolveRecipients — uses configured prefs (active only) over defaults', () => {
  const prefs = [
    { recipient: '21690000001', active: true, events: {} },
    { recipient: '21690000002', active: false, events: {} }, // inactive → dropped
  ];
  const rcpts = resolveRecipients(makeTenantRecord(), prefs, { aliases: ['booking'] });
  assert.deepEqual(rcpts.map((r) => r.recipient), ['21690000001']);
});

// ── instant alert: booking → default recipient, FR copy, audit event ───────────
test('booking event → default recipient gets a formatted alert + audit event', async () => {
  const ref = { now: new Date('2026-07-19T12:00:00Z') };
  const bus = makeBus();
  const sender = makeSender();
  const store = storeWithEvents();
  const svc = createNotificationService({ bus, sender, store, now: clockOf(ref) });

  bus.publish('appointment.created', {
    tenantId: TENANT_ID,
    conversationId: `${TENANT_ID}:218910000001`,
    appointment: { patientName: 'Ali', specialtyLabel: 'Cardiologie', datetimeISO: '2026-08-03T09:00:00Z', ref: 'EAS-001' },
  });
  await svc.settled();

  assert.equal(sender.sent.length, 1);
  assert.equal(sender.sent[0].to, OWNER);
  assert.equal(sender.sent[0].from, EL.whatsapp.phoneNumberId); // sent FROM the clinic number
  assert.match(sender.sent[0].text, /Nouvelle réservation/);
  assert.match(sender.sent[0].text, /EAS-001/);
  assert.equal(store.records.some((e) => e.type === 'notification.sent'), true);
  svc.stop();
});

// ── multiple recipients + per-recipient language ───────────────────────────────
test('multiple recipients each get the alert in their own language', async () => {
  const ref = { now: new Date('2026-07-19T12:00:00Z') };
  const bus = makeBus();
  const sender = makeSender();
  const prefs = [
    { recipient: '21690000001', active: true, lang: 'ar', events: {} },
    { recipient: '21690000002', active: true, lang: 'en', events: {} },
  ];
  const store = storeWithEvents({ prefs });
  const svc = createNotificationService({ bus, sender, store, now: clockOf(ref) });

  bus.publish('appointment.created', {
    tenantId: TENANT_ID,
    conversationId: 'c-multi',
    appointment: { patientName: 'Sara', specialtyLabel: 'Cardiology', datetimeISO: '2026-08-03T09:00:00Z', ref: 'EAS-002' },
  });
  await svc.settled();

  assert.equal(sender.sent.length, 2);
  const ar = sender.sent.find((s) => s.to === '21690000001');
  const en = sender.sent.find((s) => s.to === '21690000002');
  assert.match(ar.text, /حجز جديد/); // Arabic booking header
  assert.match(en.text, /New booking/); // English booking header
  svc.stop();
});

// ── quiet hours: suppress booking, never emergency ─────────────────────────────
test('quiet hours suppress a booking but never an emergency', async () => {
  const ref = { now: new Date('2026-07-19T23:30:00Z') }; // 00:30 in Africa/Tunis → inside 22:00–07:00
  const bus = makeBus();
  const sender = makeSender();
  const prefs = [{ recipient: '21620111222', active: true, quietHours: { start: '22:00', end: '07:00' }, events: {} }];
  const store = storeWithEvents({ prefs });
  const svc = createNotificationService({ bus, sender, store, now: clockOf(ref) });

  bus.publish('appointment.created', { tenantId: TENANT_ID, conversationId: 'c-q', appointment: { ref: 'B1' } });
  await svc.settled();
  assert.equal(sender.sent.length, 0, 'booking must be suppressed during quiet hours');

  bus.publish('emergency.detected', { tenantId: TENANT_ID, conversationId: 'c-q', keyword: 'chest pain', waId: '218910000001' });
  await svc.settled();
  assert.equal(sender.sent.length, 1, 'emergency must bypass quiet hours');
  assert.match(sender.sent[0].text, /URGENCE/);
  svc.stop();
});

// ── dedupe window ──────────────────────────────────────────────────────────────
test('dedupe: same conversation + type inside the window sends once', async () => {
  const ref = { now: new Date('2026-07-19T12:00:00Z') };
  const bus = makeBus();
  const sender = makeSender();
  const store = storeWithEvents();
  const svc = createNotificationService({ bus, sender, store, now: clockOf(ref), dedupeWindowMs: 10 * 60 * 1000 });

  const evt = { tenantId: TENANT_ID, conversationId: 'dupe-1', appointment: { ref: 'D1' } };
  bus.publish('appointment.created', evt);
  await svc.settled();
  bus.publish('appointment.created', evt); // immediate repeat → deduped
  await svc.settled();
  assert.equal(sender.sent.length, 1, 'second identical event within window is deduped');

  ref.now = new Date(ref.now.getTime() + 11 * 60 * 1000); // advance past the window
  bus.publish('appointment.created', evt);
  await svc.settled();
  assert.equal(sender.sent.length, 2, 'after the window it sends again');
  svc.stop();
});

// ── per-event toggles ──────────────────────────────────────────────────────────
test('per-event toggle: booking off, but hot-lead still fires', async () => {
  const ref = { now: new Date('2026-07-19T12:00:00Z') };
  const bus = makeBus();
  const sender = makeSender();
  const prefs = [{ recipient: '21620111222', active: true, events: { booking: false } }];
  const store = storeWithEvents({ prefs });
  const svc = createNotificationService({ bus, sender, store, now: clockOf(ref) });

  bus.publish('appointment.created', { tenantId: TENANT_ID, conversationId: 't1', appointment: { ref: 'B9' } });
  await svc.settled();
  assert.equal(sender.sent.length, 0, 'booking toggle off suppresses booking');

  bus.publish('lead.hot', {
    tenantId: TENANT_ID,
    conversationId: 't1',
    lead: { reason: 'pricing_high_value', procedure: 'cosmetic_surgery', patientWaId: '218910000001' },
  });
  await svc.settled();
  assert.equal(sender.sent.length, 1, 'hot-lead is unaffected by the booking toggle');
  assert.match(sender.sent[0].text, /Lead à forte valeur/);
  svc.stop();
});

// ── never throws into a bus handler ────────────────────────────────────────────
test('a throwing sender is caught and recorded, never rethrown', async () => {
  const ref = { now: new Date('2026-07-19T12:00:00Z') };
  const bus = makeBus();
  const sender = makeSender({ throws: true });
  const store = storeWithEvents();
  const svc = createNotificationService({ bus, sender, store, now: clockOf(ref) });

  await assert.doesNotReject(async () => {
    bus.publish('appointment.created', { tenantId: TENANT_ID, conversationId: 'x', appointment: { ref: 'B1' } });
    await svc.settled();
  });
  assert.equal(store.records.some((e) => e.type === 'notification.error'), true);
  svc.stop();
});

// ── handoff enrichment (who + last message) ────────────────────────────────────
test('handoff alert includes the patient and their last message', async () => {
  const ref = { now: new Date('2026-07-19T12:00:00Z') };
  const bus = makeBus();
  const sender = makeSender();
  const store = storeWithEvents();
  const svc = createNotificationService({ bus, sender, store, now: clockOf(ref) });

  bus.publish('handoff.requested', {
    tenantId: TENANT_ID,
    conversationId: `${TENANT_ID}:218910000001`,
    handoff: { name: 'Coordination', phone: '+216 20 111 222' },
    lastMessage: 'je veux parler à un humain',
  });
  await svc.settled();
  assert.equal(sender.sent.length, 1);
  assert.match(sender.sent[0].text, /conseiller humain/);
  assert.match(sender.sent[0].text, /humain/); // last message echoed
  assert.match(sender.sent[0].text, /218910000001/); // patient recovered from conversationId
  svc.stop();
});

// ── digests ────────────────────────────────────────────────────────────────────
test('computeDigestStats — counts, after-hours share, and the money line', () => {
  const day = '2026-07-15';
  const stats = computeDigestStats(
    {
      tenant: {
        id: EL.id,
        name: EL.name,
        timezone: 'UTC',
        currency: 'EUR',
        config: {
          workingHours: { sun: ['08:00', '18:00'], mon: ['08:00', '18:00'], tue: ['08:00', '18:00'], wed: ['08:00', '18:00'], thu: ['08:00', '18:00'], fri: ['08:00', '18:00'], sat: ['08:00', '18:00'] },
          notifications: { avgProcedureValue: 3000 },
        },
      },
      conversations: [
        { lastMessageAt: `${day}T10:00:00Z` }, // business
        { lastMessageAt: `${day}T22:00:00Z` }, // after-hours
        { lastMessageAt: `${day}T06:00:00Z` }, // after-hours
        { lastMessageAt: `${day}T12:00:00Z` }, // business
      ],
      appointments: [
        { createdAt: `${day}T10:00:00Z`, status: 'confirmed' },
        { createdAt: `${day}T11:00:00Z`, status: 'confirmed' },
        { createdAt: `${day}T12:00:00Z`, status: 'confirmed' },
        { createdAt: '2026-07-14T10:00:00Z', status: 'confirmed' }, // out of range
        { createdAt: `${day}T13:00:00Z`, status: 'cancelled' }, // excluded
      ],
      leads: [{ createdAt: `${day}T09:00:00Z` }, { createdAt: `${day}T13:00:00Z` }],
    },
    { from: `${day}T00:00:00Z`, to: '2026-07-16T00:00:00Z', tz: 'UTC' }
  );

  assert.equal(stats.conversations, 4);
  assert.equal(stats.bookings, 3); // cancelled + out-of-range excluded
  assert.equal(stats.leads, 2);
  assert.equal(stats.afterHours, 2);
  assert.equal(stats.afterHoursPct, 50);
  assert.equal(stats.money, 9000); // 3 bookings × 3000

  const text = formatDailyDigest(stats, { tenant: { name: EL.name, currency: 'EUR', config: {} }, lang: 'fr' });
  assert.match(text, /Résumé quotidien/);
  assert.match(text, /50%/);
  assert.match(text, /9 000 EUR/); // grouped money line
});

test('computeDigestStats — no money line when avgProcedureValue is unset', () => {
  const stats = computeDigestStats(
    { tenant: { config: {} }, conversations: [], appointments: [{ createdAt: '2026-07-15T10:00:00Z' }], leads: [] },
    { from: '2026-07-15T00:00:00Z', to: '2026-07-16T00:00:00Z', tz: 'UTC' }
  );
  assert.equal(stats.money, null);
  const text = formatDailyDigest(stats, { tenant: { config: {} }, lang: 'fr' });
  assert.doesNotMatch(text, /captée/);
});

test('runDailyDigest — sends the digest to the default recipient', async () => {
  const ref = { now: new Date('2026-07-15T20:00:00Z') };
  const bus = makeBus();
  const sender = makeSender();
  const tenant = makeTenantRecord({
    timezone: 'UTC',
    workingHours: { sun: ['08:00', '18:00'], mon: ['08:00', '18:00'], tue: ['08:00', '18:00'], wed: ['08:00', '18:00'], thu: ['08:00', '18:00'], fri: ['08:00', '18:00'], sat: ['08:00', '18:00'] },
    notifications: { avgProcedureValue: 3000 },
  });
  const store = storeWithEvents({
    tenant,
    seed: {
      conversations: [{ lastMessageAt: '2026-07-15T10:00:00Z' }, { lastMessageAt: '2026-07-15T19:00:00Z' }],
      appointments: [{ createdAt: '2026-07-15T10:00:00Z', status: 'confirmed' }, { createdAt: '2026-07-15T11:00:00Z', status: 'confirmed' }],
      leads: [{ createdAt: '2026-07-15T09:00:00Z' }],
    },
  });
  const svc = createNotificationService({ bus, sender, store, now: clockOf(ref) });

  const res = await svc.runDailyDigest(TENANT_ID, { tz: 'UTC' });
  assert.equal(res.ok, true);
  assert.equal(res.stats.bookings, 2);
  assert.equal(res.stats.money, 6000);
  assert.equal(sender.sent.length, 1);
  assert.match(sender.sent[0].text, /6 000/);
  svc.stop();
});

// ── quiet-hours + after-hours pure helpers ─────────────────────────────────────
test('inQuietHours — overnight window wraps correctly', () => {
  const qh = { start: '22:00', end: '07:00' };
  assert.equal(inQuietHours(new Date('2026-07-19T23:00:00Z'), qh, 'UTC'), true);
  assert.equal(inQuietHours(new Date('2026-07-19T05:00:00Z'), qh, 'UTC'), true);
  assert.equal(inQuietHours(new Date('2026-07-19T12:00:00Z'), qh, 'UTC'), false);
  assert.equal(inQuietHours(new Date('2026-07-19T12:00:00Z'), null, 'UTC'), false);
});

test('isAfterHours — closed day and out-of-hours are after-hours', () => {
  const wh = { sun: null, mon: ['08:00', '18:00'] };
  assert.equal(isAfterHours('2026-07-13T10:00:00Z', wh, 'UTC'), false); // Mon 10:00 business (2026-07-13 is a Monday)
  assert.equal(isAfterHours('2026-07-13T20:00:00Z', wh, 'UTC'), true); // Mon 20:00 after-hours
  assert.equal(isAfterHours('2026-07-12T10:00:00Z', wh, 'UTC'), true); // Sun closed
});

// ── pipeline ────────────────────────────────────────────────────────────────────
test('analyzeInbound — emergency returns overrideReply and emits emergency.detected', () => {
  const events = [];
  const bus = { publish: (type, evt) => events.push({ type, evt }) };
  const out = analyzeInbound({
    tenant: makeTenantRecord({ notifications: { emergencyNumber: '190' } }),
    text: 'I have severe chest pain and I cant breathe',
    lang: 'en',
    engineResult: { intent: 'faq' },
    waId: '218910000001',
    bus,
  });
  assert.ok(out.overrideReply, 'emergency must produce an overrideReply (bot steps back)');
  assert.match(out.overrideReply, /190/);
  assert.equal(out.emergency.category, 'chest_pain');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'emergency.detected');
  assert.equal(events[0].evt.tenantId, TENANT_ID);
});

test('analyzeInbound — hot lead emits lead.hot with no overrideReply', () => {
  const events = [];
  const bus = { publish: (type, evt) => events.push({ type, evt }) };
  const out = analyzeInbound({
    tenant: makeTenantRecord(),
    text: 'combien pour une rhinoplastie ?',
    lang: 'fr',
    engineResult: { intent: 'pricing_quote' },
    waId: '21620000000',
    bus,
  });
  assert.equal(out.overrideReply, null);
  assert.equal(out.hot, true);
  assert.equal(out.lead.procedure, 'cosmetic_surgery');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'lead.hot');
});

test('analyzeInbound — benign message emits nothing', () => {
  const events = [];
  const bus = { publish: (type, evt) => events.push({ type, evt }) };
  const out = analyzeInbound({
    tenant: makeTenantRecord(),
    text: 'quelles sont vos horaires ?',
    lang: 'fr',
    engineResult: { intent: 'faq' },
    waId: '21620000000',
    bus,
  });
  assert.equal(out.overrideReply, null);
  assert.equal(out.hot, false);
  assert.equal(events.length, 0);
});
