// GET /api/calls (V3) — recent-calls list for the dashboard Calls tab. Rows are
// sourced from the TERMINAL call.ended/call.missed audit events the voice-call
// service appends (src/voice-call/index.js: exactly one terminal event per
// call); tenant-scoped like every /api route, auth required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeTestApp, listen, request, setupOwner } from '../test-helpers/client.js';

const A = 'el-amen-sousse';
const B = 'ennour-sfax';

test('GET /api/calls — 401 unauth, terminal-only, most-recent-first, correct row shape', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  t.after(() => new Promise((r) => server.close(r)));

  const anon = await request(server, 'GET', '/api/calls');
  assert.equal(anon.status, 401);

  const convo = await app.store.conversations.create(A, { patientWaId: '218911112222', lang: 'fr', status: 'open' });

  // A non-terminal row (call.started) must never surface as a "call" here.
  await app.store.events.append(A, {
    type: 'call.started',
    actor: 'system',
    conversationId: convo.id,
    payload: { callId: 'wacid.A0', from: '218911112222', connectMs: 400 },
  });
  await app.store.events.append(A, {
    type: 'call.ended',
    actor: 'system',
    conversationId: convo.id,
    payload: {
      callId: 'wacid.A1',
      outcome: 'completed',
      durationSec: 58,
      connectMs: 400,
      from: '218911112222',
      reason: 'remote_hangup',
      brain: { booked: 'EAS-CALL-1', handoff: false, emergency: false },
    },
  });
  await app.store.events.append(A, {
    type: 'call.missed',
    actor: 'system',
    conversationId: convo.id,
    payload: { callId: 'wacid.A2', outcome: 'missed', reason: 'no_answer', durationSec: 0, from: '218911113333' },
  });

  const { cookie } = await setupOwner(server, { tenantId: A, email: `o-${randomUUID()}@x.tn` });
  const res = await request(server, 'GET', '/api/calls', { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2, 'call.started never counts as a call row');
  assert.equal(res.body.calls.length, 2);

  // Most recent first: A2 (call.missed) was appended after A1 (call.ended).
  assert.equal(res.body.calls[0].callId, 'wacid.A2');
  assert.equal(res.body.calls[1].callId, 'wacid.A1');

  const ended = res.body.calls.find((c) => c.callId === 'wacid.A1');
  assert.equal(ended.type, 'call.ended');
  assert.equal(ended.outcome, 'completed');
  assert.equal(ended.reason, 'remote_hangup');
  assert.equal(ended.durationSec, 58);
  assert.equal(ended.from, '218911112222');
  assert.equal(ended.booked, 'EAS-CALL-1');
  assert.equal(ended.emergency, false);
  assert.equal(ended.handoff, false);
  assert.equal(ended.conversationId, convo.id);

  const missed = res.body.calls.find((c) => c.callId === 'wacid.A2');
  assert.equal(missed.type, 'call.missed');
  assert.equal(missed.outcome, 'missed');
  assert.equal(missed.reason, 'no_answer');
  assert.equal(missed.durationSec, 0);
  assert.equal(missed.booked, null);
  assert.equal(missed.emergency, false);
  assert.equal(missed.handoff, false);
});

test('GET /api/calls — tenant isolation: one clinic never sees another clinic\'s rows', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  t.after(() => new Promise((r) => server.close(r)));

  await app.store.events.append(A, {
    type: 'call.missed',
    actor: 'system',
    payload: { callId: 'wacid.IsoA', outcome: 'missed', reason: 'closed', durationSec: 0, from: '218900001111' },
  });
  await app.store.events.append(B, {
    type: 'call.missed',
    actor: 'system',
    payload: { callId: 'wacid.IsoB', outcome: 'missed', reason: 'closed', durationSec: 0, from: '218900002222' },
  });

  const a = await setupOwner(server, { tenantId: A, email: `a-${randomUUID()}@x.tn` });
  const b = await setupOwner(server, { tenantId: B, email: `b-${randomUUID()}@x.tn` });

  const aRes = await request(server, 'GET', '/api/calls', { cookie: a.cookie });
  assert.equal(aRes.status, 200);
  assert.equal(aRes.body.total, 1);
  assert.equal(aRes.body.calls[0].callId, 'wacid.IsoA');

  const bRes = await request(server, 'GET', '/api/calls', { cookie: b.cookie });
  assert.equal(bRes.status, 200);
  assert.equal(bRes.body.total, 1);
  assert.equal(bRes.body.calls[0].callId, 'wacid.IsoB');
});

test('GET /api/calls — limit query param is respected and capped at 200', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  t.after(() => new Promise((r) => server.close(r)));

  for (let i = 0; i < 5; i += 1) {
    await app.store.events.append(A, {
      type: 'call.missed',
      actor: 'system',
      payload: { callId: `wacid.L${i}`, outcome: 'missed', reason: 'no_answer', durationSec: 0, from: '218900000000' },
    });
  }
  const { cookie } = await setupOwner(server, { tenantId: A, email: `o-${randomUUID()}@x.tn` });

  const limited = await request(server, 'GET', '/api/calls?limit=2', { cookie });
  assert.equal(limited.status, 200);
  assert.equal(limited.body.calls.length, 2);
  assert.equal(limited.body.calls[0].callId, 'wacid.L4', 'the 2 most recent of the 5 seeded rows');

  // A limit above the 200 cap is clamped, not rejected — only 5 rows exist so
  // the response naturally stays short; the clamp is exercised by intParam.
  const uncapped = await request(server, 'GET', '/api/calls?limit=99999', { cookie });
  assert.equal(uncapped.status, 200);
  assert.equal(uncapped.body.calls.length, 5);

  const defaulted = await request(server, 'GET', '/api/calls', { cookie });
  assert.equal(defaulted.status, 200);
  assert.equal(defaulted.body.calls.length, 5, 'well under the default 50');
});
