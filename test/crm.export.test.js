// V7 — CRM sync v1. Signature correctness, retry behavior, tenant scoping and
// config gating for the outbound webhooks; UTF-8 BOM + Arabic integrity +
// range/role for the CSV exports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { createBus } from '../src/events/bus.js';
import { createCrmSync, signBody } from '../src/crm/index.js';
import { makeTestApp, listen, request, setupOwner } from '../test-helpers/client.js';

const TENANT = 'el-amen-sousse';

function fakeStore(crmByTenant = {}) {
  const events = [];
  return {
    events: { append: async (tid, e) => (events.push({ tid, ...e }), e), list: async () => events },
    getClinicById: (id) => (crmByTenant[id] ? { id, crm: crmByTenant[id] } : { id }),
    _events: events,
  };
}

test('a configured tenant gets a signed POST; signature verifies over the exact body', async () => {
  const bus = createBus();
  const store = fakeStore({ [TENANT]: { webhookUrl: 'https://crm.example/hook', secret: 's3cret' } });
  const calls = [];
  const crm = createCrmSync({
    bus, store,
    fetchImpl: async (url, opts) => (calls.push({ url, opts }), { status: 200 }),
  });
  bus.publish('appointment.created', {
    tenantId: TENANT, conversationId: 'c1',
    appointment: { ref: 'EAS-1', status: 'confirmed', specialty: 'dental', patientName: 'محمد' },
  });
  await crm.settled();

  assert.equal(calls.length, 1);
  const { url, opts } = calls[0];
  assert.equal(url, 'https://crm.example/hook');
  const expected = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(opts.body, 'utf8').digest('hex');
  assert.equal(opts.headers['X-Omen-Signature'], expected);
  assert.equal(signBody('s3cret', opts.body), expected, 'helper matches');
  const parsed = JSON.parse(opts.body);
  assert.equal(parsed.event, 'appointment.created');
  assert.equal(parsed.data.ref, 'EAS-1');
  assert.equal(parsed.data.patientName, 'محمد', 'Arabic survives the JSON body');
  // Audit row recorded.
  assert.equal(store._events[0].type, 'crm.delivery');
  assert.equal(store._events[0].payload.ok, true);
  crm.stop();
});

test('network failures retry with backoff; success on the 3rd attempt', async () => {
  const bus = createBus();
  const store = fakeStore({ [TENANT]: { webhookUrl: 'http://crm.local/hook', secret: 'x' } });
  let n = 0;
  const waits = [];
  const crm = createCrmSync({
    bus, store,
    sleep: async (ms) => waits.push(ms),
    fetchImpl: async () => {
      n += 1;
      if (n < 3) throw new Error('ECONNREFUSED');
      return { status: 200 };
    },
  });
  bus.publish('lead.hot', { tenantId: TENANT, lead: { reason: 'pricing_high_value' } });
  await crm.settled();
  assert.equal(n, 3);
  assert.deepEqual(waits, [1000, 5000]);
  assert.equal(store._events[0].payload.ok, true);
  assert.equal(store._events[0].payload.attempts, 3);
  crm.stop();
});

test('a 4xx from the receiver is NOT retried; a 5xx is', async () => {
  const bus = createBus();
  const store = fakeStore({ [TENANT]: { webhookUrl: 'http://crm.local/hook', secret: 'x' } });
  let n = 0;
  const crm = createCrmSync({
    bus, store, sleep: async () => {},
    fetchImpl: async () => (n += 1, { status: n === 1 ? 422 : 200 }),
  });
  bus.publish('lead.hot', { tenantId: TENANT, lead: {} });
  await crm.settled();
  assert.equal(n, 1, '4xx stops immediately');
  assert.equal(store._events[0].payload.ok, false);

  n = 0;
  const store2 = fakeStore({ [TENANT]: { webhookUrl: 'http://crm.local/hook', secret: 'x' } });
  const crm2 = createCrmSync({
    bus, store: store2, sleep: async () => {},
    fetchImpl: async () => (n += 1, { status: n < 2 ? 503 : 200 }),
  });
  bus.publish('lead.hot', { tenantId: TENANT, lead: {} });
  await crm2.settled();
  assert.equal(n, 2, '5xx retried');
  assert.equal(store2._events[0].payload.ok, true);
  crm.stop();
  crm2.stop();
});

test('unconfigured tenants and other tenants never trigger a POST', async () => {
  const bus = createBus();
  const store = fakeStore({ [TENANT]: { webhookUrl: 'https://crm.example/hook', secret: 's' } });
  const calls = [];
  const crm = createCrmSync({ bus, store, fetchImpl: async (u) => (calls.push(u), { status: 200 }) });
  bus.publish('appointment.created', { tenantId: 'ennour-sfax', appointment: { ref: 'X' } }); // not configured
  bus.publish('appointment.created', { appointment: { ref: 'Y' } }); // no tenant
  await crm.settled();
  assert.equal(calls.length, 0);
  crm.stop();
});

test('SSRF guard: private/loopback webhook URLs are rejected; public ones accepted', async () => {
  const { app } = makeTestApp();
  const server = await listen(app);
  try {
    const { cookie } = await setupOwner(server, { tenantId: TENANT, email: `s-${randomUUID()}@t.tn` });
    for (const bad of [
      'http://localhost:3000/api/auth/setup',
      'http://127.0.0.1/x',
      'http://192.168.1.1/x',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.5/x',
      'http://172.16.0.1/x',
      'ftp://crm.example/x',
    ]) {
      const res = await request(server, 'PUT', '/api/tenant', { cookie, body: { crm: { webhookUrl: bad } } });
      assert.equal(res.status, 400, `${bad} must be rejected`);
    }
    const ok = await request(server, 'PUT', '/api/tenant', {
      cookie, body: { crm: { webhookUrl: 'https://script.google.com/macros/x/exec', secret: 's' } },
    });
    assert.equal(ok.status, 200);
  } finally {
    server.close();
  }
});

// ── CSV exports through the real app ─────────────────────────────────────────

test('appointments CSV: owner-only, BOM + Arabic intact, range filter works', async () => {
  const composed = makeTestApp();
  const { app, store } = composed;
  const server = await listen(app);
  try {
    await store.appointments.create(TENANT, {
      ref: 'CSV-1', patientWaId: '218910000500', specialty: 'dental', specialtyLabel: 'طب الأسنان',
      patientName: 'محمد العبيدي', status: 'confirmed',
      datetimeISO: new Date('2026-08-05T10:00:00Z').toISOString(), createdAt: new Date().toISOString(),
    });
    await store.appointments.create(TENANT, {
      ref: 'CSV-OLD', patientWaId: '218910000501', specialty: 'dental', status: 'done',
      datetimeISO: new Date('2026-01-05T10:00:00Z').toISOString(), createdAt: new Date().toISOString(),
    });

    const anon = await request(server, 'GET', '/api/export/appointments.csv');
    assert.equal(anon.status, 401);

    const { cookie } = await setupOwner(server, { tenantId: TENANT, email: `e-${randomUUID()}@t.tn` });
    const res = await request(server, 'GET', '/api/export/appointments.csv?from=2026-08-01&to=2026-08-31', { cookie });
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/csv'));
    assert.ok(res.raw.startsWith('﻿'), 'UTF-8 BOM for Excel-Arabic');
    assert.ok(res.raw.includes('محمد العبيدي'), 'Arabic intact');
    assert.ok(res.raw.includes('CSV-1'));
    assert.ok(!res.raw.includes('CSV-OLD'), 'range filter applied');
  } finally {
    server.close();
  }
});

test('leads CSV quotes commas/quotes correctly and stays tenant-scoped', async () => {
  const composed = makeTestApp();
  const { app, store } = composed;
  const server = await listen(app);
  try {
    await store.leads.upsertOpen(TENANT, {
      conversationId: `${TENANT}:218910000502`, patientWaId: '218910000502',
      procedure: 'dental', details: { snippet: 'قال: "نحب زرع أسنان, بسرعة"', reason: 'pricing_high_value' },
    });
    await store.leads.upsertOpen('ennour-sfax', {
      conversationId: 'ennour-sfax:218000', patientWaId: '218000', procedure: 'OTHER', details: {},
    });
    const { cookie } = await setupOwner(server, { tenantId: TENANT, email: `l-${randomUUID()}@t.tn` });
    const res = await request(server, 'GET', '/api/export/leads.csv', { cookie });
    assert.equal(res.status, 200);
    assert.ok(res.raw.includes('"قال: ""نحب زرع أسنان, بسرعة"""'), 'RFC-4180 quoting');
    assert.ok(!res.raw.includes('OTHER'), 'tenant-scoped');
  } finally {
    server.close();
  }
});
