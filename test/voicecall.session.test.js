// Call state machine (V1) — the pure core of the voice tier.
//
// Everything the service does under load is decided here, so this suite walks
// EVERY transition, including the ones that only happen when things go wrong:
// the caller hangs up while ringing, media never connects, the call runs
// forever, and Meta redelivers a terminate webhook we already processed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCallSession, TERMINAL_STATES } from '../src/voice-call/session.js';

const T0 = 1_800_000_000_000; // fixed epoch — every assertion is arithmetic

const mk = (now = T0) =>
  createCallSession({
    callId: 'wacid.TEST1',
    tenantId: 'el-amen-sousse',
    from: '21690000001',
    phoneNumberId: '1153135121224452',
    now,
  });

test('happy path: ringing → answering → connecting → active → completed', () => {
  const s = mk();
  assert.equal(s.state, 'ringing');
  assert.equal(s.startedAt, T0);
  assert.equal(s.wasActive, false);

  assert.deepEqual(s.decideAnswer({ open: true }), { action: 'pre_accept' });
  assert.equal(s.state, 'answering');

  const prep = s.onAnswerPrepared('v=0 answer', T0 + 100);
  assert.equal(prep.action, 'send_pre_accept');
  assert.equal(prep.sdp, 'v=0 answer');
  assert.equal(s.state, 'connecting');

  assert.deepEqual(s.onMediaConnected(T0 + 900), { action: 'accept' });
  assert.equal(s.state, 'active');
  assert.equal(s.wasActive, true);

  assert.deepEqual(
    s.onTerminateWebhook({ status: 'Completed', durationSec: 47, now: T0 + 48_000 }),
    { action: 'cleanup' }
  );
  assert.equal(s.state, 'completed');

  const sum = s.summary();
  assert.equal(sum.callId, 'wacid.TEST1');
  assert.equal(sum.outcome, 'completed');
  assert.equal(sum.durationSec, 47, "Meta's reported duration wins — it is the billed number");
  assert.equal(sum.connectMs, 900, 'connectMs = connect webhook → media connected');
});

test('media can connect straight from "answering" (accept before pre_accept lands)', () => {
  const s = mk();
  s.decideAnswer({ open: true });
  assert.deepEqual(s.onMediaConnected(T0 + 300), { action: 'accept' });
  assert.equal(s.state, 'active');
});

test('closed clinic: decideAnswer rejects and is terminal', () => {
  const s = mk();
  assert.deepEqual(s.decideAnswer({ open: false }), { action: 'reject', reason: 'closed' });
  assert.equal(s.state, 'rejected');
  assert.ok(s.isTerminal());
  assert.equal(s.summary().outcome, 'rejected');
  assert.equal(s.summary().reason, 'closed');
  assert.equal(s.summary().durationSec, 0);
  assert.equal(s.summary().connectMs, null, 'a rejected call never connected');
  // Absorbing: a redelivered connect cannot re-open a rejected call.
  assert.deepEqual(s.decideAnswer({ open: true }), { action: null });
  assert.equal(s.state, 'rejected');
});

test('the machine is 100% clock-free: decideAnswer records the INJECTED time', () => {
  const s = mk();
  s.decideAnswer({ open: false, at: T0 + 500 });
  assert.equal(s.endedAt, T0 + 500, 'the reject branch must not reach for Date.now()');
  // Omitting `at` still degrades sanely rather than producing NaN/null.
  const bare = mk();
  bare.decideAnswer({ open: false });
  assert.ok(Number.isFinite(bare.endedAt));
});

test('connect timeout → missed, and cannot fire twice', () => {
  const s = mk();
  s.decideAnswer({ open: true });
  s.onAnswerPrepared('sdp', T0 + 50);
  assert.deepEqual(s.onTimeout(T0 + 20_000), { action: 'terminate', outcome: 'missed' });
  assert.equal(s.state, 'missed');
  assert.equal(s.summary().durationSec, 0, 'ring time is NOT talk time');
  assert.deepEqual(s.onTimeout(T0 + 30_000), { action: null });
});

test('timeout is a no-op once the call is active', () => {
  const s = mk();
  s.decideAnswer({ open: true });
  s.onMediaConnected(T0 + 400);
  assert.deepEqual(s.onTimeout(T0 + 20_000), { action: null });
  assert.equal(s.state, 'active');
});

test('max duration terminates an active call, and only an active call', () => {
  const s = mk();
  s.decideAnswer({ open: true });
  assert.deepEqual(s.onMaxDuration(T0 + 1000), { action: null }, 'not active yet');
  s.onMediaConnected(T0 + 1000);
  assert.deepEqual(s.onMaxDuration(T0 + 601_000), {
    action: 'terminate',
    outcome: 'completed',
    reason: 'max_duration',
  });
  assert.equal(s.state, 'completed');
  assert.equal(s.summary().durationSec, 600, 'measured from media-connect when Meta told us nothing');
  assert.equal(s.summary().reason, 'max_duration');
});

test('caller hangs up while ringing → missed (never active)', () => {
  const s = mk();
  s.decideAnswer({ open: true });
  s.onAnswerPrepared('sdp', T0 + 40);
  assert.deepEqual(s.onTerminateWebhook({ status: 'Completed', now: T0 + 9000 }), { action: 'cleanup' });
  assert.equal(s.state, 'missed');
  assert.equal(s.summary().outcome, 'missed');
  assert.equal(s.summary().connectMs, null);
});

test('terminate with status Failed → failed, even after media connected', () => {
  const s = mk();
  s.decideAnswer({ open: true });
  s.onMediaConnected(T0 + 500);
  s.onTerminateWebhook({ status: 'Failed', now: T0 + 5000 });
  assert.equal(s.state, 'failed');
  assert.equal(s.summary().outcome, 'failed');
});

test('redelivered terminate on a terminal session is a free no-op', () => {
  const s = mk();
  s.decideAnswer({ open: true });
  s.onMediaConnected(T0 + 500);
  s.onTerminateWebhook({ status: 'Completed', durationSec: 12, now: T0 + 12_500 });
  const first = s.summary();
  assert.deepEqual(s.onTerminateWebhook({ status: 'Completed', durationSec: 999, now: T0 + 99_000 }), {
    action: null,
  });
  assert.deepEqual(s.summary(), first, 'a redelivery must not rewrite the record');
});

test('localHangup: completed when active, missed when not', () => {
  const a = mk();
  a.decideAnswer({ open: true });
  a.onMediaConnected(T0 + 200);
  assert.deepEqual(a.localHangup(T0 + 5200), { action: 'terminate', outcome: 'completed' });
  assert.equal(a.summary().durationSec, 5);

  const b = mk();
  b.decideAnswer({ open: true });
  assert.deepEqual(b.localHangup(T0 + 800), { action: 'terminate', outcome: 'missed' });
  assert.equal(b.state, 'missed');
  assert.deepEqual(b.localHangup(T0 + 900), { action: null });
});

test('every terminal state absorbs every transition', () => {
  for (const target of TERMINAL_STATES) {
    const s = mk();
    if (target === 'rejected') {
      s.decideAnswer({ open: false });
    } else if (target === 'missed') {
      s.decideAnswer({ open: true });
      s.onTimeout(T0 + 20_000);
    } else if (target === 'failed') {
      s.decideAnswer({ open: true });
      s.onTerminateWebhook({ status: 'Failed', now: T0 + 900 });
    } else {
      s.decideAnswer({ open: true });
      s.onMediaConnected(T0 + 400);
      s.onTerminateWebhook({ status: 'Completed', durationSec: 3, now: T0 + 3400 });
    }
    assert.equal(s.state, target);
    assert.deepEqual(s.decideAnswer({ open: true }), { action: null }, target);
    assert.deepEqual(s.onAnswerPrepared('x', T0), { action: null }, target);
    assert.deepEqual(s.onMediaConnected(T0), { action: null }, target);
    assert.deepEqual(s.onTerminateWebhook({ status: 'Completed', now: T0 }), { action: null }, target);
    assert.deepEqual(s.onTimeout(T0), { action: null }, target);
    assert.deepEqual(s.onMaxDuration(T0), { action: null }, target);
    assert.deepEqual(s.localHangup(T0), { action: null }, target);
    assert.equal(s.state, target, 'state never moved');
  }
});

test('a Date is accepted anywhere a timestamp is', () => {
  const s = createCallSession({ callId: 'c1', now: new Date(T0) });
  assert.equal(s.startedAt, T0);
  s.decideAnswer({ open: true });
  s.onMediaConnected(new Date(T0 + 1500));
  assert.equal(s.summary().connectMs, 1500);
});
