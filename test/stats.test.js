// P2-A analytics — the shared aggregation module (src/stats) + GET /api/stats.
// All dates are fixed ISO instants; Africa/Tunis is UTC+1 with no DST, so the
// tz math is deterministic year-round. Covers: digest-parity aggregation on a
// seeded fixture, sandbox exclusion, the money-line config chain, after-hours
// across midnight, funnel math, the message.analyzed ingest event, and API
// auth + tenant scoping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  computeDigestStats,
  computeAnalytics,
  isAfterHours,
  normalizeQuestion,
} from '../src/stats/index.js';
import { makeTestApp, listen, request, setupOwner } from '../test-helpers/client.js';
import { ingestInbound } from '../src/api/ingest.js';

const TZ = 'Africa/Tunis'; // UTC+1, stable
const A = 'el-amen-sousse';
const PNID = JSON.parse(fs.readFileSync(new URL('../data/clinics.json', import.meta.url), 'utf8'))
  .clinics.find((c) => c.id === A).whatsapp.phoneNumberId;

// Window: August 1–31, 2026 (from inclusive, to exclusive).
const FROM = '2026-08-01T00:00:00.000Z';
const TO = '2026-09-01T00:00:00.000Z';
const RANGE = { from: FROM, to: TO, tz: TZ };

// Mon 2026-08-03 09:30 local (08:30Z) — inside mon 08:00–17:00.
const MON_MORNING = '2026-08-03T08:30:00.000Z';
// Mon 2026-08-03 21:00 local (20:00Z) — after hours.
const MON_NIGHT = '2026-08-03T20:00:00.000Z';
// Sun 2026-08-02 11:00 local — closed day ⇒ after hours.
const SUNDAY = '2026-08-02T10:00:00.000Z';

const WORKING_HOURS = {
  sun: null,
  mon: ['08:00', '17:00'],
  tue: ['08:00', '17:00'],
  wed: ['08:00', '17:00'],
  thu: ['08:00', '17:00'],
  fri: ['08:00', '13:00'],
  sat: ['09:00', '13:00'],
};

function fixtureTenant(configPatch = {}) {
  return {
    id: A,
    name: 'Clinique Test',
    timezone: TZ,
    currency: 'EUR',
    config: { workingHours: WORKING_HOURS, ...configPatch },
  };
}

const convo = (waId, ts, lang = 'ar') => ({
  id: `${A}:${waId}`,
  patientWaId: waId,
  lang,
  lastMessageAt: ts,
});
const appt = (patch = {}) => ({
  patientWaId: '218910000001',
  status: 'confirmed',
  createdAt: MON_MORNING,
  channel: 'whatsapp',
  ...patch,
});

// ── digest aggregate (parity numbers) ────────────────────────────────────────
test('stats — computeDigestStats: window bounds, sandbox exclusion, money line', () => {
  const data = {
    tenant: fixtureTenant({ notifications: { avgProcedureValue: 3000 } }),
    conversations: [
      convo('218910000001', MON_MORNING),
      convo('218910000002', MON_NIGHT, 'fr'),
      convo('218910000003', SUNDAY, 'en'),
      convo('218910000004', '2026-07-15T10:00:00.000Z'), // before window
      convo('218910000005', TO), // ts === to ⇒ EXCLUDED (exclusive bound)
      convo('sandbox:u1', MON_MORNING), // sandbox ⇒ excluded
    ],
    appointments: [
      appt(),
      appt({ status: 'cancelled' }), // cancelled ⇒ not a booking
      appt({ patientWaId: 'sandbox:u1' }), // sandbox ⇒ excluded
      appt({ channel: 'sandbox' }), // sandbox channel ⇒ excluded
      appt({ createdAt: '2026-07-01T00:00:00.000Z' }), // out of window
    ],
    leads: [{ createdAt: MON_MORNING }, { createdAt: '2026-06-01T00:00:00.000Z' }],
  };

  const s = computeDigestStats(data, RANGE);
  assert.equal(s.conversations, 3);
  assert.equal(s.afterHours, 2); // Monday night + Sunday
  assert.equal(s.afterHoursPct, 67);
  assert.equal(s.bookings, 1);
  assert.equal(s.leads, 1);
  assert.equal(s.avgValue, 3000);
  assert.equal(s.money, 3000); // 1 booking × 3000
  assert.equal(s.currency, 'EUR');
});

test('stats — money line config chain: avgBookingValue fallback, null hides', () => {
  const base = {
    conversations: [],
    appointments: [appt()],
    leads: [],
  };
  const viaBooking = computeDigestStats({ ...base, tenant: fixtureTenant({ avgBookingValue: 500 }) }, RANGE);
  assert.equal(viaBooking.avgValue, 500);
  assert.equal(viaBooking.money, 500);

  // notifications.avgProcedureValue wins over avgBookingValue (existing digest key).
  const both = computeDigestStats(
    { ...base, tenant: fixtureTenant({ avgBookingValue: 500, notifications: { avgProcedureValue: 900 } }) },
    RANGE
  );
  assert.equal(both.avgValue, 900);

  const none = computeDigestStats({ ...base, tenant: fixtureTenant() }, RANGE);
  assert.equal(none.money, null); // UI hides the money line
  assert.equal(none.avgValue, null);
});

// ── after-hours math, incl. a window across midnight ─────────────────────────
test('stats — isAfterHours: normal day, closed day, and overnight window', () => {
  // Normal window.
  assert.equal(isAfterHours(MON_MORNING, WORKING_HOURS, TZ), false);
  assert.equal(isAfterHours(MON_NIGHT, WORKING_HOURS, TZ), true);
  assert.equal(isAfterHours(SUNDAY, WORKING_HOURS, TZ), true); // closed day
  // Boundary: opening minute is inside, closing minute is outside.
  assert.equal(isAfterHours('2026-08-03T07:00:00.000Z', WORKING_HOURS, TZ), false); // 08:00 local
  assert.equal(isAfterHours('2026-08-03T16:00:00.000Z', WORKING_HOURS, TZ), true); // 17:00 local

  // Overnight window: Friday 20:00 → 02:00 (night shift). The window belongs to
  // the day it OPENS on; its past-midnight tail spills into Saturday.
  const overnight = { ...WORKING_HOURS, fri: ['20:00', '02:00'] };
  // Fri 21:00 local — inside the shift.
  assert.equal(isAfterHours('2026-08-07T20:00:00.000Z', overnight, TZ), false);
  // Sat 01:00 local — the tail of FRIDAY's shift ⇒ still open.
  assert.equal(isAfterHours('2026-08-08T00:00:00.000Z', overnight, TZ), false);
  // Sat 03:00 local — past the tail, before Saturday's own 09:00 ⇒ after hours.
  assert.equal(isAfterHours('2026-08-08T02:00:00.000Z', overnight, TZ), true);
  // Fri 01:00 local — nothing has been open since Thursday 17:00 ⇒ after hours.
  assert.equal(isAfterHours('2026-08-07T00:00:00.000Z', overnight, TZ), true);
  // No schedule at all ⇒ never overstate.
  assert.equal(isAfterHours(MON_NIGHT, null, TZ), false);
});

// ── dashboard aggregate ───────────────────────────────────────────────────────
test('stats — computeAnalytics: hour buckets, language split, response time, intents, funnel', () => {
  const c1 = convo('218910000001', MON_MORNING, 'ar');
  const c2 = convo('218910000002', MON_NIGHT, 'fr');
  const messagesByConvo = new Map([
    [
      c1.id,
      [
        { direction: 'inbound', ts: '2026-08-03T08:30:00.000Z' },
        { direction: 'outbound', ts: '2026-08-03T08:30:30.000Z' }, // 30s
        { direction: 'inbound', ts: '2026-08-03T08:40:00.000Z' },
        { direction: 'outbound', ts: '2026-08-03T08:41:30.000Z' }, // 90s
      ],
    ],
    [c2.id, [{ direction: 'inbound', ts: MON_NIGHT }]], // no reply yet
  ]);
  const events = [
    { type: 'message.analyzed', conversationId: c1.id, createdAt: MON_MORNING, payload: { intent: 'greeting', lang: 'ar', snippet: 'السلام عليكم' } },
    { type: 'message.analyzed', conversationId: c1.id, createdAt: MON_MORNING, payload: { intent: 'book_appointment', lang: 'ar', snippet: 'نحب نحجز' } },
    { type: 'message.analyzed', conversationId: c2.id, createdAt: MON_NIGHT, payload: { intent: 'pricing_quote', lang: 'fr', snippet: 'Combien coûte un implant ?' } },
    { type: 'message.analyzed', conversationId: c2.id, createdAt: MON_NIGHT, payload: { intent: 'pricing_quote', lang: 'fr', snippet: 'combien coute un implant' } },
    { type: 'message.analyzed', conversationId: c2.id, createdAt: MON_NIGHT, payload: { intent: 'unknown', lang: 'fr', snippet: 'xyzzy' } },
    // Out of window ⇒ ignored entirely.
    { type: 'message.analyzed', conversationId: c1.id, createdAt: '2026-07-01T00:00:00.000Z', payload: { intent: 'faq', lang: 'ar', snippet: 'old' } },
  ];

  const s = computeAnalytics(
    {
      tenant: fixtureTenant(),
      conversations: [c1, c2],
      appointments: [appt(), appt({ status: 'done' }), appt({ status: 'cancelled' })],
      leads: [],
      events,
      messagesByConvo,
    },
    RANGE
  );

  // Hour buckets: c1 at 09:30 local → hour 9; c2 at 21:00 local → hour 21.
  assert.equal(s.conversationsByHour.length, 24);
  assert.equal(s.conversationsByHour[9], 1);
  assert.equal(s.conversationsByHour[21], 1);
  assert.equal(s.conversationsByHour.reduce((a, b) => a + b, 0), 2);

  assert.deepEqual(s.languageSplit, { ar: 1, fr: 1, en: 0, other: 0 });
  assert.equal(s.messageCount, 5);
  assert.equal(s.responseTimeMedianSec, 60); // median of [30, 90]

  // Intent counts: pricing_quote ×2 tops the list; out-of-window faq ignored.
  assert.deepEqual(s.topIntents[0], { intent: 'pricing_quote', count: 2 });
  assert.equal(s.topIntents.find((i) => i.intent === 'faq'), undefined);

  // Question dedupe: accent/punctuation variants collapse into ONE entry, count 2.
  assert.equal(normalizeQuestion('Combien coûte un implant ?'), 'combien coute un implant');
  const q = s.topQuestions.find((x) => x.text.toLowerCase().includes('implant'));
  assert.ok(q, 'implant question grouped');
  assert.equal(q.count, 2);
  assert.equal(s.topQuestions.filter((x) => x.text.toLowerCase().includes('implant')).length, 1);
  assert.equal(s.unknownCount, 1);
  assert.ok(Math.abs(s.unknownRate - 1 / 5) < 1e-9);

  // Funnel: 1 convo started booking; confirmed = digest bookings (2: confirmed+done).
  assert.equal(s.funnel.conversations, 2);
  assert.equal(s.funnel.bookingStarted, 1);
  assert.equal(s.funnel.bookingConfirmed, 2);
  assert.equal(s.funnel.bookingConfirmed, s.bookings); // digest parity by construction
  assert.deepEqual(s.apptStatuses, { pending: 0, confirmed: 1, done: 1, no_show: 0, cancelled: 1 });
});

// ── ingest writes the message.analyzed event ─────────────────────────────────
test('stats — ingest persists message.analyzed with intent + lang + snippet', async (t) => {
  const app = makeTestApp();
  t.after(() => app.notifier.stop());
  await ingestInbound(
    { store: app.store, engine: app.engine, sender: app.sender, bus: app.bus },
    {
      channel: 'whatsapp',
      from: '218912223344',
      text: 'السلام عليكم',
      phoneNumberId: PNID,
      messageId: `m_${randomUUID()}`,
      timestamp: Date.now(),
    }
  );
  await app.notifier.settled();

  const events = await app.store.events.list(A, { type: 'message.analyzed' });
  assert.equal(events.length, 1);
  assert.equal(events[0].conversationId, `${A}:218912223344`);
  assert.equal(events[0].payload.intent, 'greeting');
  assert.equal(events[0].payload.lang, 'ar');
  assert.equal(events[0].payload.snippet, 'السلام عليكم');
});

// ── API: auth, shape, tenant scoping, validation ─────────────────────────────
test('stats — GET /api/stats: 401 unauth, correct shape, tenant scoping, 400 on bad range', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  t.after(() => {
    app.notifier.stop();
    server.closeAllConnections?.();
    return new Promise((r) => server.close(r));
  });

  // Unauthenticated → 401.
  const anon = await request(server, 'GET', '/api/stats');
  assert.equal(anon.status, 401);

  // Seed one real conversation for tenant A through the actual pipeline.
  await ingestInbound(
    { store: app.store, engine: app.engine, sender: app.sender, bus: app.bus },
    {
      channel: 'whatsapp',
      from: '218915556677',
      text: 'Bonjour',
      phoneNumberId: PNID,
      messageId: `m_${randomUUID()}`,
      timestamp: Date.now(),
    }
  );
  await app.notifier.settled();

  const { cookie } = await setupOwner(server, { tenantId: A, email: `o-${randomUUID()}@x.tn` });
  const ok = await request(server, 'GET', '/api/stats?days=7', { cookie });
  assert.equal(ok.status, 200);
  const s = ok.body.stats;
  assert.equal(s.conversations, 1);
  assert.equal(s.conversationsByHour.length, 24);
  assert.equal(s.funnel.conversations, 1);
  assert.equal(typeof s.messageCount, 'number');
  assert.ok(s.messageCount >= 2, 'inbound + bot reply counted');
  assert.equal(s.money, null); // no avg value configured ⇒ hidden

  // Tenant scoping: an owner of the OTHER tenant sees none of A's traffic.
  const b = await setupOwner(server, { tenantId: 'ennour-sfax', email: `o-${randomUUID()}@x.tn` });
  const other = await request(server, 'GET', '/api/stats?days=7', { cookie: b.cookie });
  assert.equal(other.status, 200);
  assert.equal(other.body.stats.conversations, 0);

  // Invalid range → 400; explicit from/to can't bypass the days cap either.
  const bad = await request(
    server,
    'GET',
    '/api/stats?from=2026-08-02T00:00:00Z&to=2026-08-01T00:00:00Z',
    { cookie }
  );
  assert.equal(bad.status, 400);
  const tooWide = await request(
    server,
    'GET',
    '/api/stats?from=2020-01-01T00:00:00Z&to=2026-08-01T00:00:00Z',
    { cookie }
  );
  assert.equal(tooWide.status, 400);
});

// ── review fixes: GDPR erase takes analytics events; JSON events ring cap ────
test('stats — conversation removal also erases its message.analyzed events (GDPR)', async (t) => {
  const app = makeTestApp();
  t.after(() => app.notifier.stop());
  const from = '218917778899';
  await ingestInbound(
    { store: app.store, engine: app.engine, sender: app.sender, bus: app.bus },
    { channel: 'whatsapp', from, text: 'نحب نحجز موعد', phoneNumberId: PNID, messageId: `m_${randomUUID()}`, timestamp: Date.now() }
  );
  await app.notifier.settled();
  const convoId = `${A}:${from}`;
  assert.equal((await app.store.events.list(A, { type: 'message.analyzed' })).length, 1);

  await app.store.conversations.remove(A, convoId);

  // The patient's snippet is gone from the audit log and therefore from stats.
  assert.equal((await app.store.events.list(A, { type: 'message.analyzed' })).length, 0);
  const stats = await (await import('../src/stats/index.js')).collectAnalytics(
    app.store,
    await app.store.tenants.getById(A),
    { from: new Date(Date.now() - 86400e3), to: new Date(Date.now() + 1000) }
  );
  assert.equal(stats.topQuestions.length, 0);
});

test('stats — JSON events collection is ring-capped (oldest dropped, newest kept)', async () => {
  const { createStore } = await import('../src/store/index.js');
  const os = await import('node:os');
  const path = await import('node:path');
  const { getConfig } = await import('../src/config.js');
  const store = createStore({
    clinicsFile: getConfig().clinicsFile,
    runtimeDir: path.join(os.tmpdir(), `omen-events-cap-${randomUUID()}`),
    reset: true,
    eventsMax: 5,
  });
  for (let i = 1; i <= 8; i += 1) {
    await store.events.append(A, { type: 'message.analyzed', payload: { intent: 'faq', snippet: `q${i}` } });
  }
  const rows = await store.events.list(A, { type: 'message.analyzed' });
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((e) => e.payload.snippet), ['q4', 'q5', 'q6', 'q7', 'q8']);
  await store.close();
});
