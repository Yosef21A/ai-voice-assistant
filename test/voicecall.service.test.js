// Voice-call service (V1) — the whole call lifecycle against the REAL composed
// app (real JSON store, real bus, real mock sender), with only two seams faked:
//
//   • mediaFactory — a fake WebRTC session, so no UDP socket is ever opened by
//     this suite (the real media plane is proven in voicecall.media.e2e.test.js);
//   • now()        — injected, so "the clinic is closed" is a deterministic fact
//     and not a function of when CI happens to run.
//
// graphCalls runs on its own MOCK transport and records every action, which is
// how we assert the Meta handshake order (pre_accept → accept) without network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTestApp, listen, request } from '../test-helpers/client.js';
import { createVoiceCallService, hoursHint, formatDuration, pickLang } from '../src/voice-call/index.js';
import { createGraphCalls } from '../src/voice-call/graphCalls.js';
import { normalizeCallEvents } from '../src/voice-call/normalize.js';
// aliased: `t` is the node:test TestContext parameter in every test below.
import { t as tr } from '../src/engine/responses.js';

const A = 'el-amen-sousse';
// Derived, not hard-coded: the registry re-keys this tenant to the real Meta
// phone_number_id when a live number is wired.
const EL = JSON.parse(fs.readFileSync(new URL('../data/clinics.json', import.meta.url), 'utf8'))
  .clinics.find((c) => c.id === A);
const PNID = EL.whatsapp.phoneNumberId;

// Africa/Tunis is UTC+1 year-round. Wed 10:00 local is inside 08:30–17:30;
// Sunday is `null` in the seed, i.e. closed all day.
const OPEN_NOW = new Date('2026-08-05T09:00:00Z'); // Wednesday 10:00 Tunis
const CLOSED_NOW = new Date('2026-08-02T09:00:00Z'); // Sunday 10:00 Tunis

const SDP_OFFER = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

function connectBody({ callId, from, sdp = SDP_OFFER, pnid = PNID }) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'calls',
            value: {
              metadata: { phone_number_id: pnid },
              calls: [
                {
                  id: callId,
                  from,
                  to: pnid,
                  event: 'connect',
                  direction: 'USER_INITIATED',
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  ...(sdp ? { session: { sdp_type: 'offer', sdp } } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function terminateBody({ callId, from, duration = 47, status = 'Completed', pnid = PNID }) {
  return {
    entry: [
      {
        changes: [
          {
            field: 'calls',
            value: {
              metadata: { phone_number_id: pnid },
              calls: [
                {
                  id: callId,
                  from,
                  to: pnid,
                  event: 'terminate',
                  direction: 'USER_INITIATED',
                  status,
                  duration,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** A fake media session: no sockets, deterministic connect, records echoes. */
function fakeMedia({ autoConnect = true, answer = 'v=0 fake-answer\r\n' } = {}) {
  const made = [];
  const factory = async ({ sdpOffer, onRtp }) => {
    const m = {
      sdpOffer,
      sdpAnswer: answer,
      onRtp,
      echoed: [],
      closed: 0,
      connectCbs: [],
      sendRtp(p) {
        m.echoed.push(p);
        return true;
      },
      onConnected(cb) {
        if (autoConnect) cb();
        else m.connectCbs.push(cb);
      },
      connect() {
        for (const cb of m.connectCbs.splice(0)) cb();
      },
      close() {
        m.closed += 1;
      },
      stats: () => ({ rtpIn: 0, rtpOut: 0, connectedAt: null }),
    };
    made.push(m);
    return m;
  };
  factory.made = made;
  return factory;
}

/**
 * A media factory whose sessions do not exist until you release the gate — the
 * only way to reproduce "the call was terminated WHILE the peer connection was
 * being built", which used to orphan a live werift peer and its UDP sockets.
 */
function gatedMedia() {
  const made = [];
  let open;
  const gate = new Promise((r) => {
    open = r;
  });
  let arrive;
  const reached = new Promise((r) => {
    arrive = r;
  });
  const factory = async () => {
    arrive();
    await gate;
    const m = {
      sdpAnswer: 'v=0 gated-answer\r\n',
      closed: 0,
      sendRtp: () => true,
      onConnected(cb) {
        cb();
      },
      close() {
        m.closed += 1;
      },
      stats: () => ({}),
    };
    made.push(m);
    return m;
  };
  factory.made = made;
  factory.reached = reached;
  factory.release = () => open();
  return factory;
}

/** Wrap a mock graph client so ONE action blocks until released. */
function gatedGraphCalls(gatedAction) {
  const inner = createGraphCalls({ transport: 'mock' });
  let open;
  const gate = new Promise((r) => {
    open = r;
  });
  let arrive;
  const reached = new Promise((r) => {
    arrive = r;
  });
  return {
    transport: inner.transport,
    recorded: inner.recorded,
    reached,
    release: () => open(),
    async callAction(args) {
      if (args?.action === gatedAction) {
        arrive();
        await gate;
      }
      return inner.callAction(args);
    },
  };
}

/** Compose the service by hand over the app's real store/bus/sender. */
function makeService(app, { now, media, config = {}, graphCalls: gc, alerts } = {}) {
  const graphCalls = gc || createGraphCalls({ transport: 'mock' });
  const events = [];
  const unsub = app.bus.subscribe((e) => events.push(e));
  const svc = createVoiceCallService({
    store: app.store,
    bus: app.bus,
    sender: app.sender,
    config: { voiceCallConnectTimeoutMs: 20000, voiceCallMaxSec: 600, ...config },
    graphCalls,
    alerts,
    mediaFactory: media,
    now: () => now,
  });
  return { svc, graphCalls, events, unsub, actions: () => graphCalls.recorded.map((r) => r.action) };
}

/** Records alerts.fire() calls so a test can prove an owner was NOT pinged. */
function spyAlerts() {
  const fired = [];
  return { fired, fire: (tenantId, kind, detail) => fired.push({ tenantId, kind, detail }) };
}

const ofType = (events, type) => events.filter((e) => e.type === type);
const terminalEvents = (events) =>
  events.filter((e) => e.type === 'call.ended' || e.type === 'call.missed');

// ── open hours: the full happy path ──────────────────────────────────────────
test('open hours: pre_accept → accept, call.started/ended, transcript + echo wiring', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  const { svc, graphCalls, events, unsub, actions } = makeService(app, { now: OPEN_NOW, media });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690000111';
  const callId = 'wacid.OPEN1';
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId, from })));
  await svc.settled();

  // Meta handshake order is the contract: pre_accept EARLY, accept once media is up.
  assert.deepEqual(actions(), ['pre_accept', 'accept']);
  assert.equal(graphCalls.recorded[0].callId, callId);
  assert.equal(graphCalls.recorded[0].sdp, '<sdp>', 'raw SDP is never recorded/logged');
  assert.equal(graphCalls.recorded[0].tenantId, A);
  assert.equal(media.made.length, 1);
  assert.equal(media.made[0].sdpOffer, SDP_OFFER);

  // V1 = echo: whatever arrives goes straight back out.
  const packet = { marker: 'rtp-1' };
  media.made[0].onRtp(packet);
  assert.deepEqual(media.made[0].echoed, [packet], 'inbound RTP is echoed verbatim');

  const started = ofType(events, 'call.started');
  assert.equal(started.length, 1);
  assert.equal(started[0].tenantId, A);
  assert.equal(started[0].call.callId, callId);
  assert.equal(started[0].call.from, from);
  assert.equal(started[0].conversationId, `${A}:${from}`);

  const live = svc.active();
  assert.equal(live.length, 1);
  assert.equal(live[0].state, 'active');

  // ── the caller hangs up ──
  await svc.handleEvents(normalizeCallEvents(terminateBody({ callId, from, duration: 47 })));
  await svc.settled();

  const ended = ofType(events, 'call.ended');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].call.outcome, 'completed');
  assert.equal(ended[0].call.durationSec, 47);
  assert.ok(ended[0].call.connectMs != null, 'answer latency is measured');
  assert.equal(ofType(events, 'call.missed').length, 0);
  assert.equal(svc.active().length, 0, 'the session is gone');
  assert.equal(media.made[0].closed, 1, 'the socket is closed exactly once');

  // The clinic sees the call in the SAME thread the patient chats in.
  const msgs = await app.store.conversations.listMessages(A, `${A}:${from}`, {});
  const callMsgs = msgs.filter((m) => m.type === 'call');
  assert.equal(callMsgs.length, 1);
  assert.equal(callMsgs[0].direction, 'inbound');
  assert.equal(callMsgs[0].body.by, 'system');
  assert.equal(callMsgs[0].body.text, tr('ar', 'callSummary', { duration: '0:47' }));
  assert.equal(callMsgs[0].body.call.outcome, 'completed');
  assert.equal(callMsgs[0].body.call.durationSec, 47);

  // A call is NOT a message: the notification/CRM pipelines must not see one.
  assert.equal(ofType(events, 'message.in').length, 0, 'calls never publish message.in');
  assert.ok(ofType(events, 'conversation.updated').length >= 1, 'the inbox still re-sorts');
});

// ── closed hours ─────────────────────────────────────────────────────────────
test('closed hours: reject + a written voicemail reply + call.missed', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  const { svc, events, unsub, actions } = makeService(app, { now: CLOSED_NOW, media });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21890000222';
  const callId = 'wacid.CLOSED1';
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId, from })));
  await svc.settled();

  assert.deepEqual(actions(), ['reject'], 'we decline fast instead of ringing out');
  assert.equal(media.made.length, 0, 'a closed clinic never opens a socket');

  const missed = ofType(events, 'call.missed');
  assert.equal(missed.length, 1);
  assert.equal(missed[0].call.reason, 'closed');
  assert.equal(missed[0].call.outcome, 'rejected');
  assert.equal(missed[0].call.from, from);
  assert.equal(ofType(events, 'call.started').length, 0);

  const msgs = await app.store.conversations.listMessages(A, `${A}:${from}`, {});
  // 1) the patient gets a written answer on WhatsApp (Sunday ⇒ the weekly window)
  const out = msgs.filter((m) => m.direction === 'outbound');
  assert.equal(out.length, 1);
  assert.equal(
    out[0].body.text,
    tr('ar', 'callClosed', { clinic: EL.name, hours: '08:30–17:30' }),
    'localized, names the clinic, states the hours, invites a written message'
  );
  // 2) staff see the missed call in the thread
  const call = msgs.find((m) => m.type === 'call');
  assert.equal(call.body.text, tr('ar', 'callMissed', { reason: 'closed' }));
  assert.equal(call.body.call.durationSec, 0);
});

// ── redelivery ───────────────────────────────────────────────────────────────
test('a redelivered connect webhook produces exactly one session', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  const { svc, events, unsub, actions } = makeService(app, { now: OPEN_NOW, media });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690000333';
  const callId = 'wacid.DUP1';
  const evs = normalizeCallEvents(connectBody({ callId, from }));
  await svc.handleEvents([...evs, ...evs]); // Meta redelivers within one POST
  await svc.handleEvents(evs); // …and again in a second POST
  await svc.settled();

  assert.deepEqual(actions(), ['pre_accept', 'accept']);
  assert.equal(media.made.length, 1, 'one media session, one socket');
  assert.equal(ofType(events, 'call.started').length, 1);
  assert.equal(svc.active().length, 1);
});

// ── watchdog ─────────────────────────────────────────────────────────────────
test('media that never connects is hung up by the watchdog → missed', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia({ autoConnect: false });
  const { svc, events, unsub, actions } = makeService(app, {
    now: OPEN_NOW,
    media,
    config: { voiceCallConnectTimeoutMs: 40 },
  });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690000444';
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId: 'wacid.TMO1', from })));
  await svc.settled();
  assert.deepEqual(actions(), ['pre_accept'], 'never accepted — no audio ever flowed');

  await new Promise((r) => setTimeout(r, 120));
  await svc.settled();

  assert.deepEqual(actions(), ['pre_accept', 'terminate']);
  const missed = ofType(events, 'call.missed');
  assert.equal(missed.length, 1);
  assert.equal(missed[0].call.outcome, 'missed');
  assert.equal(missed[0].call.reason, 'no_answer');
  assert.equal(media.made[0].closed, 1, 'the socket does not leak');
  assert.equal(svc.active().length, 0);

  // A terminate webhook arriving AFTER our watchdog closed the books is a no-op.
  await svc.handleEvents(normalizeCallEvents(terminateBody({ callId: 'wacid.TMO1', from, status: 'Failed' })));
  await svc.settled();
  assert.equal(ofType(events, 'call.missed').length, 1, 'no duplicate terminal event');
});

// ── overnight working hours (tz-aware semantics, per isAfterHours) ───────────
test('an overnight window (20:00–04:00) is OPEN at 02:00 and CLOSED at 13:00', async (t) => {
  const app = makeTestApp();
  // Mutate this store instance's in-memory clinic only (the JSON adapter parses
  // data/clinics.json fresh per store, so nothing leaks to other suites).
  const clinic = app.store.getClinicByPhoneNumberId(PNID);
  const original = clinic.workingHours;
  const overnight = ['20:00', '04:00'];
  clinic.workingHours = {
    sun: overnight, mon: overnight, tue: overnight, wed: overnight,
    thu: overnight, fri: overnight, sat: overnight,
  };
  t.after(() => {
    clinic.workingHours = original;
  });

  // 02:00 Tunis — inside YESTERDAY's window, which wrapped past midnight.
  const night = makeService(app, { now: new Date('2026-08-05T01:00:00Z'), media: fakeMedia() });
  await night.svc.handleEvents(normalizeCallEvents(connectBody({ callId: 'wacid.N1', from: '21690000555' })));
  await night.svc.settled();
  assert.deepEqual(night.actions(), ['pre_accept', 'accept'], '02:00 is inside 20:00–04:00');
  night.unsub();
  await night.svc.stop();

  // 13:00 Tunis — squarely between the windows.
  const noon = makeService(app, { now: new Date('2026-08-05T12:00:00Z'), media: fakeMedia() });
  await noon.svc.handleEvents(normalizeCallEvents(connectBody({ callId: 'wacid.N2', from: '21690000556' })));
  await noon.svc.settled();
  assert.deepEqual(noon.actions(), ['reject'], '13:00 is outside 20:00–04:00');
  noon.unsub();
  await noon.svc.stop();
});

// ── degenerate inputs ────────────────────────────────────────────────────────
test('unknown tenant / unknown event / missing SDP never throw', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  const { svc, events, unsub, actions } = makeService(app, { now: OPEN_NOW, media });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  // no such phone_number_id → ignored, nothing recorded
  await svc.handleEvents(
    normalizeCallEvents(connectBody({ callId: 'wacid.X1', from: '216900006', pnid: '999999999' }))
  );
  // an event Meta may add later
  await svc.handleEvents([{ channel: 'whatsapp-call', kind: 'other', event: 'ringing', callId: 'wacid.X2' }]);
  // a connect with no offer: we cannot answer, so we hang up and record a miss
  await svc.handleEvents(
    normalizeCallEvents(connectBody({ callId: 'wacid.X3', from: '21690000777', sdp: null }))
  );
  await svc.settled();

  assert.deepEqual(actions(), ['terminate'], 'only the un-answerable call produced an action');
  assert.equal(media.made.length, 0);
  const missed = ofType(events, 'call.missed');
  assert.equal(missed.length, 1);
  assert.equal(missed[0].call.callId, 'wacid.X3');
  assert.equal(svc.active().length, 0);
});

test('stop() hangs up every live call and leaves nothing running', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  const { svc, events, unsub, actions } = makeService(app, { now: OPEN_NOW, media });
  t.after(() => unsub());

  await svc.handleEvents(normalizeCallEvents(connectBody({ callId: 'wacid.S1', from: '21690000888' })));
  await svc.settled();
  assert.equal(svc.active().length, 1);

  await svc.stop();
  assert.equal(svc.active().length, 0);
  assert.equal(media.made[0].closed, 1);
  assert.deepEqual(actions(), ['pre_accept', 'accept', 'terminate']);
  // Shutdown deliberately writes NOTHING to the store (the temp dir may be gone).
  assert.equal(ofType(events, 'call.ended').length, 0);
  // …and a post-stop event is ignored.
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId: 'wacid.S2', from: '21690000889' })));
  await svc.settled();
  assert.equal(svc.active().length, 0);
});

// ── HTTP wiring (the real composed app, no injection at all) ─────────────────
test('POST /webhook routes a `calls` change into the composed voice service', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  t.after(async () => {
    await app.voiceCalls?.stop();
    await new Promise((r) => server.close(r));
  });
  assert.ok(app.voiceCalls, 'createApp composes the voice-call service by default');

  const from = '21690000999';
  // No SDP ⇒ the call is un-answerable ⇒ the real service hangs up WITHOUT ever
  // opening a socket. That keeps this wiring test hermetic at any hour of day.
  const res = await request(server, 'POST', '/webhook', {
    body: connectBody({ callId: 'wacid.HTTP1', from, sdp: null }),
  });
  assert.equal(res.status, 200, 'the webhook still acknowledges fast');

  const deadline = Date.now() + 3000;
  let call = null;
  while (Date.now() < deadline && !call) {
    const msgs = await app.store.conversations.listMessages(A, `${A}:${from}`, {}).catch(() => []);
    call = msgs.find((m) => m.type === 'call') || null;
    if (!call) await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(call, 'the call was persisted on the patient thread');
  assert.equal(call.body.by, 'system');
  assert.equal(app.voiceCalls.active().length, 0);
});

// ── mid-flight races (adversarial review regressions) ───────────────────────
// Every one of these is a real bug that shipped in the first draft. They all
// have the same shape: a terminate (or a shutdown) lands while the service is
// awaiting something, and the code that resumes acts on a call that is already
// over. The fixes are `entry.finished` re-checks after each await.

test('terminate DURING the accept flight: no call.started after call.ended', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  const gc = gatedGraphCalls('accept');
  const { svc, events, unsub, actions } = makeService(app, { now: OPEN_NOW, media, graphCalls: gc });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690001111';
  const callId = 'wacid.RACE1';
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId, from })));
  await gc.reached; // we are now blocked inside graphCalls.callAction('accept')
  assert.deepEqual(ofType(events, 'call.started'), [], 'call.started has not fired yet');

  // The caller hangs up while our accept is still in flight.
  await svc.handleEvents(normalizeCallEvents(terminateBody({ callId, from, duration: 3 })));
  gc.release();
  await svc.settled();

  assert.equal(
    ofType(events, 'call.started').length,
    0,
    'a call that ended mid-accept must never announce itself as started'
  );
  assert.equal(terminalEvents(events).length, 1, 'exactly one terminal event');
  assert.equal(terminalEvents(events)[0].type, 'call.ended');
  assert.equal(svc.active().length, 0, 'no phantom active call');
  assert.equal(media.made[0].closed, 1);
  assert.deepEqual(actions(), ['pre_accept', 'accept'], 'the in-flight accept still completed');
});

test('terminate DURING makeMedia: the orphaned peer connection is closed', async (t) => {
  const app = makeTestApp();
  const media = gatedMedia();
  const { svc, events, unsub } = makeService(app, { now: OPEN_NOW, media });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690002222';
  const callId = 'wacid.RACE2';
  const inFlight = svc.handleEvents(normalizeCallEvents(connectBody({ callId, from })));
  await media.reached; // blocked inside the media factory — entry.media is still null

  await svc.handleEvents(normalizeCallEvents(terminateBody({ callId, from, duration: 0 })));
  assert.equal(svc.active().length, 0, 'the session is already closed');

  media.release(); // the werift peer finally materializes — onto a DEAD entry
  await inFlight;
  await svc.settled();

  assert.equal(media.made.length, 1);
  assert.equal(media.made[0].closed, 1, 'the late peer connection was closed, not leaked');
  assert.equal(terminalEvents(events).length, 1, 'still exactly one terminal event');
  assert.equal(terminalEvents(events)[0].type, 'call.missed', 'audio never flowed');
});

test('stop() DURING makeMedia: the orphaned peer connection is closed', async (t) => {
  const app = makeTestApp();
  const media = gatedMedia();
  const { svc, unsub } = makeService(app, { now: OPEN_NOW, media });
  t.after(() => unsub());

  const inFlight = svc.handleEvents(
    normalizeCallEvents(connectBody({ callId: 'wacid.RACE3', from: '21690003333' }))
  );
  await media.reached;

  await svc.stop(); // graceful shutdown while the peer is still being built

  media.release();
  await inFlight;
  await svc.settled();

  assert.equal(media.made.length, 1);
  assert.equal(media.made[0].closed, 1, 'shutdown must not leak a UDP socket');
  assert.equal(svc.active().length, 0);
});

// ── hermeticity (the CRITICAL finding) ──────────────────────────────────────
test('makeTestApp pins the voice-call transport and composition against env', async (t) => {
  const prevTransport = process.env.VOICE_CALL_TRANSPORT;
  const prevEnabled = process.env.VOICE_CALLS;
  const prevBase = process.env.VOICE_CALL_GRAPH_BASE;
  // The exact combination scripts/call-harness.js tells a developer to export,
  // plus the kill switch. Neither may reach a test app.
  process.env.VOICE_CALL_TRANSPORT = 'real';
  process.env.VOICE_CALLS = 'off';
  process.env.VOICE_CALL_GRAPH_BASE = 'http://localhost:3901';
  t.after(() => {
    const restore = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore('VOICE_CALL_TRANSPORT', prevTransport);
    restore('VOICE_CALLS', prevEnabled);
    restore('VOICE_CALL_GRAPH_BASE', prevBase);
  });

  const app = makeTestApp();
  t.after(async () => {
    await app.voiceCalls?.stop();
  });

  assert.ok(app.voiceCalls, 'VOICE_CALLS=off in the environment must not un-compose the service');
  assert.equal(app.config.voiceCalls, true);
  assert.equal(app.config.voiceCallTransport, 'mock');
  assert.equal(
    app.voiceCalls.graphCalls.transport,
    'mock',
    'a test app can NEVER place a real call action against graph.facebook.com'
  );
  assert.equal(app.voiceCalls.graphCalls.apiBase, 'https://graph.facebook.com');
});

test('an unrecognized transport value never silently opts into the real Graph', () => {
  assert.equal(createGraphCalls({ transport: 'REAL', token: '' }).transport, 'mock');
  assert.equal(createGraphCalls({ transport: 'production', token: '' }).transport, 'mock');
  assert.equal(createGraphCalls({ transport: '', token: '' }).transport, 'mock');
  // An explicit token still auto-selects real (documented, matches the sender).
  assert.equal(createGraphCalls({ transport: 'typo', token: 'T' }).transport, 'real');
  // …but an explicit 'mock' beats a present token, which is what pins the tests.
  assert.equal(createGraphCalls({ transport: 'mock', token: 'T' }).transport, 'mock');
});

// ── outcome vs. "did the patient actually hear us" ──────────────────────────
test('a CONNECTED call that terminates Failed is call.ended (outcome failed), not missed', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  const { svc, events, unsub } = makeService(app, { now: OPEN_NOW, media });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690004444';
  const callId = 'wacid.FAIL1';
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId, from })));
  await svc.settled();
  assert.equal(ofType(events, 'call.started').length, 1);

  await svc.handleEvents(
    normalizeCallEvents(terminateBody({ callId, from, status: 'Failed', duration: 12 }))
  );
  await svc.settled();

  assert.equal(ofType(events, 'call.missed').length, 0, 'the patient DID hold this call');
  const ended = ofType(events, 'call.ended');
  assert.equal(ended.length, 1, 'call.ended always follows call.started');
  assert.equal(ended[0].call.outcome, 'failed', 'the failure survives as data on the payload');
  assert.equal(ended[0].call.durationSec, 12);

  const msgs = await app.store.conversations.listMessages(A, `${A}:${from}`, {});
  const call = msgs.find((m) => m.type === 'call');
  assert.equal(
    call.body.text,
    tr('ar', 'callSummary', { duration: '0:12' }),
    'the transcript must not call a held conversation a missed call'
  );
});

// ── late redelivery ─────────────────────────────────────────────────────────
test('a connect redelivered AFTER the call ended is dropped (no ghost call)', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  const alerts = spyAlerts();
  const { svc, events, unsub, actions } = makeService(app, { now: OPEN_NOW, media, alerts });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690005555';
  const callId = 'wacid.GHOST1';
  const connect = normalizeCallEvents(connectBody({ callId, from }));
  await svc.handleEvents(connect);
  await svc.settled();
  await svc.handleEvents(normalizeCallEvents(terminateBody({ callId, from, duration: 5 })));
  await svc.settled();
  assert.equal(terminalEvents(events).length, 1);

  // Meta retries the ORIGINAL connect webhook minutes later.
  await svc.handleEvents(connect);
  await svc.settled();

  assert.equal(svc.active().length, 0, 'no ghost session');
  assert.equal(media.made.length, 1, 'no second socket');
  assert.deepEqual(actions(), ['pre_accept', 'accept'], 'no doomed pre_accept against a dead call');
  assert.equal(terminalEvents(events).length, 1, 'no duplicate terminal event');
  assert.deepEqual(alerts.fired, [], 'the owner is NOT alerted about a redelivery');

  const calls = (await app.store.conversations.listMessages(A, `${A}:${from}`, {})).filter(
    (m) => m.type === 'call'
  );
  assert.equal(calls.length, 1, 'one call, one transcript row');
});

// ── tenant scoping ──────────────────────────────────────────────────────────
test('a terminate carrying another tenant\'s phone_number_id is dropped', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  const { svc, events, unsub } = makeService(app, { now: OPEN_NOW, media });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690006666';
  const callId = 'wacid.XT1';
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId, from })));
  await svc.settled();
  assert.equal(svc.active().length, 1);

  // Same (guessable) callId, wrong tenant: must not hang up a live call, and
  // must not stamp its duration onto another clinic's record.
  await svc.handleEvents(
    normalizeCallEvents(terminateBody({ callId, from, duration: 9999, pnid: '999999999' }))
  );
  await svc.settled();
  assert.equal(svc.active().length, 1, 'the call is still live');
  assert.equal(terminalEvents(events).length, 0, 'nothing was ended');
  assert.equal(media.made[0].closed, 0, 'the media session is untouched');

  // The legitimate terminate still works.
  await svc.handleEvents(normalizeCallEvents(terminateBody({ callId, from, duration: 9 })));
  await svc.settled();
  assert.equal(terminalEvents(events).length, 1);
  assert.equal(terminalEvents(events)[0].call.durationSec, 9);
});

// ── small pure helpers ───────────────────────────────────────────────────────
test('formatDuration + hoursHint + pickLang', () => {
  // pickLang delegates to the engine's resolveLanguage so calls and messages
  // can never drift apart: conversation language first, then the tenant's, and
  // 'fr' as the engine's own terminal default.
  assert.equal(pickLang({ lang: 'fr' }, EL), 'fr');
  assert.equal(pickLang(null, EL), 'ar', "the tenant's first configured language");
  assert.equal(pickLang({ lang: 'de' }, EL), 'ar', 'a junk stored language is ignored');
  assert.equal(pickLang(null, { languages: [] }), 'fr', "the engine's terminal default");
  assert.equal(pickLang(null, null), 'fr');
});

test('formatDuration + hoursHint', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(47), '0:47');
  assert.equal(formatDuration(725), '12:05');
  assert.equal(formatDuration(-5), '0:00');
  assert.equal(formatDuration(undefined), '0:00');

  // Friday in the seed is 08:30–13:00 — today's window wins over the weekly mode.
  assert.equal(hoursHint(EL, new Date('2026-08-07T09:00:00Z')), '08:30–13:00');
  // Sunday is closed ⇒ fall back to the most common weekly window.
  assert.equal(hoursHint(EL, new Date('2026-08-02T09:00:00Z')), '08:30–17:30');
  assert.equal(hoursHint({}, new Date()), '', 'no configured hours ⇒ no claim');
  // "Today" is the CLINIC's day, not the server's: 22:00 UTC is still Friday in
  // Tunis but already Saturday in Auckland. A UTC VPS must not quote the wrong
  // day's hours to a patient calling just before midnight.
  const lateNight = new Date('2026-08-07T22:00:00Z');
  assert.equal(hoursHint(EL, lateNight), '08:30–13:00', 'Africa/Tunis ⇒ Friday');
  assert.equal(
    hoursHint({ workingHours: EL.workingHours, timezone: 'Pacific/Auckland' }, lateNight),
    '09:00–13:00',
    'Pacific/Auckland ⇒ Saturday'
  );
});
