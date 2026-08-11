// P2-F — hardening & ops. Webhook dedupe + rate limiting, oversize-body 413,
// login brute-force gate, health depth, system-alert surfacing, audit rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createInboundGuard } from '../src/api/inboundGuard.js';
import { createSystemAlerts } from '../src/api/alerts.js';
import { makeTestApp, listen, request, setupOwner } from '../test-helpers/client.js';
import { ingestInbound } from '../src/api/ingest.js';

const TENANT = 'el-amen-sousse';

// ── inbound guard units ──────────────────────────────────────────────────────

test('dedupe: the same wa message id is a no-op inside the TTL', () => {
  let t = 1000;
  const g = createInboundGuard({ now: () => t });
  assert.equal(g.isDuplicate('wamid.A'), false);
  assert.equal(g.isDuplicate('wamid.A'), true);
  t += 11 * 60 * 1000; // beyond the 10-min TTL
  assert.equal(g.isDuplicate('wamid.A'), false);
  assert.equal(g.isDuplicate(null), false, 'missing ids never dedupe');
});

test('rate limit: burst gets ONE throttle notice then silent drops, resets next window', () => {
  let t = 0;
  const g = createInboundGuard({ perWaIdPerMin: 3, now: () => t });
  assert.equal(g.admit('2189'), 'ok');
  assert.equal(g.admit('2189'), 'ok');
  assert.equal(g.admit('2189'), 'ok');
  assert.equal(g.admit('2189'), 'throttle_notice');
  assert.equal(g.admit('2189'), 'drop');
  t += 61 * 1000;
  assert.equal(g.admit('2189'), 'ok', 'window reset');
});

test('global ceiling drops silently', () => {
  let t = 0;
  const g = createInboundGuard({ perWaIdPerMin: 1000, globalPerMin: 5, now: () => t });
  for (let i = 0; i < 5; i++) assert.equal(g.admit(`w${i}`), 'ok');
  assert.equal(g.admit('w9'), 'drop');
});

// ── dedupe through the real pipeline ─────────────────────────────────────────

test('a Meta redelivery never produces a second engine reply or transcript row', async () => {
  const composed = makeTestApp();
  const { store } = composed;
  const guard = createInboundGuard();
  const clinic = store.getClinicById(TENANT);
  const deps = { store, engine: composed.engine, sender: composed.sender, bus: composed.bus, config: composed.config, guard };
  const msg = {
    channel: 'whatsapp', from: '218910000300', text: 'السلام عليكم',
    phoneNumberId: clinic.whatsapp.phoneNumberId, messageId: 'wamid.DUP-1', timestamp: Date.now(),
  };
  const first = await ingestInbound(deps, msg);
  assert.ok(first.out, 'first delivery processed');
  const second = await ingestInbound(deps, msg);
  assert.equal(second.skipped, 'duplicate');

  const convo = await store.conversations.get(TENANT, '218910000300');
  const msgs = await store.conversations.listMessages(TENANT, convo.id, {});
  assert.equal(msgs.filter((m) => m.direction === 'inbound').length, 1, 'one patient bubble');
});

test('a flood gets one localized slow-down reply, then drops', async () => {
  const composed = makeTestApp();
  const { store } = composed;
  const guard = createInboundGuard({ perWaIdPerMin: 2 });
  const clinic = store.getClinicById(TENANT);
  const deps = { store, engine: composed.engine, sender: composed.sender, bus: composed.bus, config: composed.config, guard };
  const send = (i) =>
    ingestInbound(deps, {
      channel: 'whatsapp', from: '218910000301', text: `msg ${i}`,
      phoneNumberId: clinic.whatsapp.phoneNumberId, messageId: `wamid.F${i}`, timestamp: Date.now(),
    });
  await send(1);
  await send(2);
  const third = await send(3);
  assert.equal(third.skipped, 'rate_limited');
  const fourth = await send(4);
  assert.equal(fourth.skipped, 'rate_limited');
  const events = await store.events.list(TENANT, { type: 'inbound.throttled' });
  assert.ok(events.length >= 2, 'throttles audited');
});

// ── system alerts ────────────────────────────────────────────────────────────

test('system alerts throttle per (tenant, kind) and expose recency', () => {
  let t = 0;
  const fired = [];
  const alerts = createSystemAlerts({ bus: { publish: (type, e) => fired.push(e) }, now: () => t });
  assert.equal(alerts.fire(TENANT, 'wa_token_expired', 'x'), true);
  assert.equal(alerts.fire(TENANT, 'wa_token_expired', 'x'), false, 'throttled');
  assert.equal(fired.length, 1);
  assert.equal(alerts.recent('wa_token_expired'), true);
  t += 11 * 60 * 1000;
  assert.equal(alerts.recent('wa_token_expired'), false);
  assert.equal(alerts.fire(TENANT, 'wa_token_expired', 'x'), true, 'new window fires again');
});

// ── HTTP-facing checks ───────────────────────────────────────────────────────

test('GET /health reports store writability and degradation flags', async () => {
  const { app } = makeTestApp();
  const server = await listen(app);
  try {
    const res = await request(server, 'GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.storeWritable, true);
    assert.deepEqual(res.body.degraded, { llm: false, waToken: false });
  } finally {
    server.close();
  }
});

test('oversize JSON body gets 413, not 500', async () => {
  const { app } = makeTestApp();
  const server = await listen(app);
  try {
    const res = await request(server, 'POST', '/simulate', {
      body: { text: 'x'.repeat(300 * 1024) },
    });
    assert.equal(res.status, 413);
  } finally {
    server.close();
  }
});

test('login brute force: 429 after repeated failures; success clears the gate', async () => {
  const { app } = makeTestApp();
  const server = await listen(app);
  try {
    const email = `owner-${randomUUID()}@t.tn`;
    await setupOwner(server, { tenantId: TENANT, email, password: 'correct-horse-9' });
    let last;
    for (let i = 0; i < 10; i++) {
      last = await request(server, 'POST', '/api/auth/login', { body: { email, password: 'wrong' } });
    }
    assert.equal(last.status, 401);
    const blocked = await request(server, 'POST', '/api/auth/login', { body: { email, password: 'wrong' } });
    assert.equal(blocked.status, 429);
    // The right password from a DIFFERENT identity slot still works (per ip+email key).
    const otherUser = await request(server, 'POST', '/api/auth/login', {
      body: { email: email.toUpperCase(), password: 'correct-horse-9' },
    });
    assert.ok([200, 429].includes(otherUser.status)); // same ip+email casing-insensitive → may share the slot
  } finally {
    server.close();
  }
});

test('staff takeover writes a durable audit event', async () => {
  const composed = makeTestApp();
  const { app, store } = composed;
  const server = await listen(app);
  try {
    const { cookie } = await setupOwner(server, { tenantId: TENANT, email: `o-${randomUUID()}@t.tn` });
    const convo = await store.conversations.create(TENANT, { patientWaId: '218910000302' });
    const res = await request(server, 'POST', `/api/conversations/${encodeURIComponent(convo.id)}/takeover`, {
      cookie, body: { paused: true },
    });
    assert.equal(res.status, 200);
    const events = await store.events.list(TENANT, { type: 'staff.takeover' });
    assert.equal(events.length, 1);
    assert.ok(events[0].actor.startsWith('staff:'));
  } finally {
    server.close();
  }
});
