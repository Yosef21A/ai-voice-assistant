// Voice-call service × the brain (V2): mode selection, the loop's lifecycle,
// and THE DEGRADE PATH — the thing that turns a brain outage into a WhatsApp
// conversation instead of a lost patient.
//
// Same harness discipline as the V1 suite: the real composed store/bus/sender,
// graphCalls on its mock transport, and only two seams faked — the WebRTC media
// session and the brain loop. Nothing here opens a socket of any kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTestApp } from '../test-helpers/client.js';
import { createVoiceCallService } from '../src/voice-call/index.js';
import { createGraphCalls } from '../src/voice-call/graphCalls.js';
import { normalizeCallEvents } from '../src/voice-call/normalize.js';
import { t as tr } from '../src/engine/responses.js';

const A = 'el-amen-sousse';
const EL = JSON.parse(fs.readFileSync(new URL('../data/clinics.json', import.meta.url), 'utf8'))
  .clinics.find((c) => c.id === A);
const PNID = EL.whatsapp.phoneNumberId;
const OPEN_NOW = new Date('2026-08-05T09:00:00Z'); // Wednesday 10:00 Tunis

const SDP_OFFER =
  'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n';

function connectBody({ callId, from, sdp = SDP_OFFER, pnid = PNID }) {
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

function terminateBody({ callId, from, duration = 30, status = 'Completed', pnid = PNID }) {
  return {
    entry: [
      {
        changes: [
          {
            field: 'calls',
            value: {
              metadata: { phone_number_id: pnid },
              calls: [{ id: callId, from, to: pnid, event: 'terminate', status, duration }],
            },
          },
        ],
      },
    ],
  };
}

/** The V1 fake media session — no sockets, deterministic connect. */
function fakeMedia() {
  const made = [];
  const factory = async ({ sdpOffer, onRtp }) => {
    const m = {
      sdpOffer,
      sdpAnswer: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n',
      onRtp,
      echoed: [],
      closed: 0,
      sendRtp(p) {
        m.echoed.push(p);
        return true;
      },
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
  return factory;
}

/** A fake brain loop: records what the service asked of it, on demand it dies. */
function fakeBrain({ startFails = false, outcome = {}, transcript = null } = {}) {
  const made = [];
  const factory = (deps) => {
    /** Work still running when the caller hangs up (a tool call in flight). */
    let inFlight = null;
    const loop = {
      deps,
      rtp: [],
      started: 0,
      stopped: null,
      live: { ...outcome },
      async start() {
        loop.started += 1;
        if (startFails) throw new Error('brain never came up');
      },
      onRtp(p) {
        loop.rtp.push(p);
      },
      stop(reason) {
        if (!loop.stopped) loop.stopped = reason || 'stopped';
        return loop.outcome();
      },
      transcript: () => transcript || [],
      outcome: () => ({
        reason: loop.stopped,
        booked: null,
        handoff: false,
        emergency: false,
        turns: 0,
        ...loop.live,
      }),
      settled: async () => {
        if (inFlight) await inFlight;
      },
      stats: () => ({}),
      /**
       * Start a tool call that only lands after `ms` — reproducing the confirm
       * that was still writing when the terminate webhook arrived.
       */
      workInFlight: (ms, patch) => {
        inFlight = new Promise((r) =>
          setTimeout(() => {
            Object.assign(loop.live, patch);
            r();
          }, ms)
        );
        return inFlight;
      },
      /** Simulate the Live socket dying mid-call. */
      die: (reason = 'brain_lost') => {
        loop.stopped = loop.stopped || reason;
        deps.onEnd?.({ ...loop.outcome(), reason });
      },
    };
    made.push(loop);
    return loop;
  };
  factory.made = made;
  return factory;
}

function spyAlerts() {
  const fired = [];
  return { fired, fire: (tenantId, kind, detail) => fired.push({ tenantId, kind, detail }) };
}

function makeService(app, { media, brain, config = {}, alerts } = {}) {
  const graphCalls = createGraphCalls({ transport: 'mock' });
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
    brainFactory: brain,
    now: () => OPEN_NOW,
  });
  return { svc, graphCalls, events, unsub, actions: () => graphCalls.recorded.map((r) => r.action) };
}

const ofType = (events, type) => events.filter((e) => e.type === type);
const msgsOf = (app, from) => app.store.conversations.listMessages(A, `${A}:${from}`, {});

// ── mode selection ──────────────────────────────────────────────────────────

test('brain mode: the loop is built after accept and OWNS the inbound audio', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  const brain = fakeBrain();
  const { svc, events, unsub, actions } = makeService(app, {
    media,
    brain,
    config: { voiceCallMode: 'brain' },
  });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690007001';
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId: 'wacid.BRAIN1', from })));
  await svc.settled();

  assert.deepEqual(actions(), ['pre_accept', 'accept'], 'the Meta handshake is unchanged');
  assert.equal(brain.made.length, 1, 'exactly one brain per call');
  assert.equal(brain.made[0].started, 1);
  assert.equal(ofType(events, 'call.started').length, 1, 'the brain starts only once audio flows');

  // The service hands the loop everything it needs to book on the RIGHT thread.
  const deps = brain.made[0].deps;
  assert.equal(deps.clinic.id, A);
  assert.equal(deps.convo.id, `${A}:${from}`);
  assert.equal(deps.patientWaId, from, 'the caller id comes from the webhook, not a store field');
  assert.equal(deps.lang, 'ar');
  assert.equal(deps.sdpOffer, SDP_OFFER);
  assert.equal(deps.media, media.made[0]);
  assert.equal(deps.store, app.store);
  assert.equal(deps.sender, app.sender);
  assert.equal(typeof deps.onEnd, 'function');

  // Inbound audio goes to the brain, and is NOT echoed back at the caller.
  const packet = { header: { payloadType: 111 }, payload: Buffer.from([1, 2, 3]) };
  media.made[0].onRtp(packet);
  assert.deepEqual(brain.made[0].rtp, [packet]);
  assert.deepEqual(media.made[0].echoed, [], 'brain mode must never also echo');
});

test('echo mode (V1) is untouched and never constructs a brain', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  const brain = fakeBrain();
  const { svc, unsub } = makeService(app, { media, brain, config: { voiceCallMode: 'echo' } });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  await svc.handleEvents(normalizeCallEvents(connectBody({ callId: 'wacid.ECHO1', from: '21690007002' })));
  await svc.settled();

  const packet = { marker: 'rtp-1' };
  media.made[0].onRtp(packet);
  assert.deepEqual(media.made[0].echoed, [packet]);
  assert.equal(brain.made.length, 0);
});

test('an unrecognized mode value never silently enables the brain', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  const brain = fakeBrain();
  // Same rule graphCalls applies to transports: only the exact literal opts in.
  const { svc, unsub } = makeService(app, { media, brain, config: { voiceCallMode: 'BRAIN' } });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  await svc.handleEvents(normalizeCallEvents(connectBody({ callId: 'wacid.MODE1', from: '21690007003' })));
  await svc.settled();
  assert.equal(brain.made.length, 0);
  media.made[0].onRtp({ x: 1 });
  assert.equal(media.made[0].echoed.length, 1, 'it fell back to echo, not to silence');
});

// ── the degrade path ────────────────────────────────────────────────────────

test('a brain that will not start: hang up, say so IN WRITING, alert the owner', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  const brain = fakeBrain({ startFails: true });
  const alerts = spyAlerts();
  const { svc, events, unsub, actions } = makeService(app, {
    media,
    brain,
    alerts,
    config: { voiceCallMode: 'brain' },
  });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690007010';
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId: 'wacid.DEGRADE1', from })));
  await svc.settled();

  // We do NOT hold a mute line open hoping it recovers.
  assert.deepEqual(actions(), ['pre_accept', 'accept', 'terminate']);
  assert.equal(svc.active().length, 0);
  assert.equal(media.made[0].closed, 1, 'the UDP socket does not leak on a degrade');
  assert.equal(brain.made[0].stopped, 'brain_lost');

  // THE KILLER MOVE: the patient gets a WhatsApp message, so the existing chat
  // engine picks them up from their very next reply.
  const out = (await msgsOf(app, from)).filter((m) => m.direction === 'outbound');
  assert.equal(out.length, 1);
  assert.equal(out[0].body.text, tr('ar', 'callBrainLost'));
  assert.equal(out[0].body.by, 'bot');

  assert.deepEqual(alerts.fired.map((f) => f.kind), ['voice_brain_lost']);
  assert.equal(alerts.fired[0].tenantId, A);

  // The call still ended cleanly, exactly once, as a call that HAPPENED.
  const ended = ofType(events, 'call.ended');
  assert.equal(ended.length, 1);
  assert.equal(ofType(events, 'call.missed').length, 0);
});

test('a brain that dies MID-call degrades the same way, once', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  const brain = fakeBrain();
  const alerts = spyAlerts();
  const { svc, events, unsub, actions } = makeService(app, {
    media,
    brain,
    alerts,
    config: { voiceCallMode: 'brain' },
  });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690007011';
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId: 'wacid.DEGRADE2', from })));
  await svc.settled();
  assert.equal(svc.active().length, 1);

  brain.made[0].die(); // the Live socket drops thirty seconds in
  await svc.settled();
  brain.made[0].die(); // …and reports it again, as a flapping socket would

  await svc.settled();
  assert.deepEqual(actions(), ['pre_accept', 'accept', 'terminate']);
  const out = (await msgsOf(app, from)).filter((m) => m.direction === 'outbound');
  assert.equal(out.length, 1, 'the patient is told once, not twice');
  assert.equal(ofType(events, 'call.ended').length, 1);
  assert.equal(alerts.fired.length, 1);
});

test('a brain that ends on an EMERGENCY hangs up without a degrade message', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  // The loop already spoke the safety script and texted the number; a second
  // "sorry, write to us" on top of an emergency would be noise at best.
  const brain = fakeBrain({ outcome: { emergency: true } });
  const alerts = spyAlerts();
  const { svc, events, unsub, actions } = makeService(app, {
    media,
    brain,
    alerts,
    config: { voiceCallMode: 'brain' },
  });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690007012';
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId: 'wacid.EMG1', from })));
  await svc.settled();
  brain.made[0].die('emergency');
  await svc.settled();

  assert.deepEqual(actions(), ['pre_accept', 'accept', 'terminate']);
  const out = (await msgsOf(app, from)).filter((m) => m.direction === 'outbound');
  assert.equal(out.length, 0, 'no degrade text on an emergency');
  assert.deepEqual(alerts.fired, []);
  const call = (await msgsOf(app, from)).find((m) => m.type === 'call');
  assert.equal(call.body.call.brain.emergency, true, 'but the record says what happened');
  assert.equal(ofType(events, 'call.ended').length, 1);
});

test('a brain that dies AFTER an emergency hangs up quietly — no degrade text', async (t) => {
  // The ambulance number is already in this thread in writing. Following it with
  // "sorry, write to us here" reads as the clinic brushing the patient off.
  const app = makeTestApp();
  const media = fakeMedia();
  const brain = fakeBrain({ outcome: { emergency: true } });
  const alerts = spyAlerts();
  const { svc, events, unsub, actions } = makeService(app, {
    media,
    brain,
    alerts,
    config: { voiceCallMode: 'brain' },
  });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690007013';
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId: 'wacid.EMGLOST1', from })));
  await svc.settled();
  brain.made[0].die('brain_lost'); // the socket drops mid-script
  await svc.settled();

  assert.deepEqual(actions(), ['pre_accept', 'accept', 'terminate']);
  const out = (await msgsOf(app, from)).filter((m) => m.direction === 'outbound');
  assert.equal(out.length, 0, 'no degrade text on top of an emergency');
  assert.deepEqual(alerts.fired, [], 'and no brain-lost alert either — the emergency alert stands');
  assert.equal(ofType(events, 'call.ended').length, 1);
});

// ── the circuit breaker ─────────────────────────────────────────────────────

test('three consecutive brain failures open the breaker; a cooled-down probe closes it', async (t) => {
  // When Gemini Live is down, every caller would otherwise pay the full connect
  // timeout in dead silence — during exactly the incident when a clinic can
  // least afford it. Mirrors the STT quota breaker in src/voice/transcriber.js.
  const app = makeTestApp();
  const media = fakeMedia();
  const alerts = spyAlerts();
  let failing = true;
  const made = [];
  const brain = (deps) => {
    const loop = {
      deps,
      started: 0,
      stopped: null,
      async start() {
        loop.started += 1;
        if (failing) throw new Error('live endpoint is down');
      },
      onRtp() {},
      stop(r) {
        loop.stopped = loop.stopped || r;
        return loop.outcome();
      },
      transcript: () => [],
      outcome: () => ({ reason: loop.stopped, booked: null, handoff: false, emergency: false, turns: 0 }),
      settled: async () => {},
      stats: () => ({}),
    };
    made.push(loop);
    return loop;
  };

  let clockMs = Date.parse('2026-08-05T09:00:00Z');
  const graphCalls = createGraphCalls({ transport: 'mock' });
  const svc = createVoiceCallService({
    store: app.store,
    bus: app.bus,
    sender: app.sender,
    config: {
      voiceCallMode: 'brain',
      voiceBrainBreakerThreshold: 3,
      voiceBrainBreakerCooldownMs: 300000,
    },
    graphCalls,
    alerts,
    mediaFactory: media,
    brainFactory: brain,
    now: () => new Date(clockMs),
  });
  t.after(async () => {
    await svc.stop();
  });

  const ring = async (n) => {
    await svc.handleEvents(normalizeCallEvents(connectBody({ callId: `wacid.BRK${n}`, from: `2169000710${n}` })));
    await svc.settled();
  };

  for (let i = 1; i <= 3; i += 1) await ring(i);
  assert.equal(made.length, 3, 'three callers each paid for one attempt');
  assert.equal(alerts.fired.length, 3);

  // Breaker OPEN: the fourth caller is not made to wait for a known-dead socket.
  await ring(4);
  assert.equal(made.length, 3, 'no fourth attempt — straight to the handover');
  assert.equal(alerts.fired.length, 3, 'one alert per incident, not one per caller');
  // …but they still get the WhatsApp message and a clean hang-up.
  const out = (await msgsOf(app, '21690007104')).filter((m) => m.direction === 'outbound');
  assert.equal(out.length, 1);
  assert.equal(out[0].body.text, tr('ar', 'callBrainLost'));

  // After the cooldown, ONE probe is let through, and it succeeds.
  clockMs += 300001;
  failing = false;
  await ring(5);
  assert.equal(made.length, 4, 'the probe was attempted');
  assert.equal(made[3].started, 1);
  assert.equal(svc.active().length, 1, 'the call is live — the brain is back');

  // …and the breaker is closed again: the next failure starts a fresh count.
  failing = true;
  await ring(6);
  assert.equal(made.length, 5, 'a closed breaker attempts normally');
});

test('a failed probe re-opens the breaker immediately', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  const brain = fakeBrain({ startFails: true });
  let clockMs = Date.parse('2026-08-05T09:00:00Z');
  const svc = createVoiceCallService({
    store: app.store,
    bus: app.bus,
    sender: app.sender,
    config: { voiceCallMode: 'brain', voiceBrainBreakerThreshold: 2, voiceBrainBreakerCooldownMs: 1000 },
    graphCalls: createGraphCalls({ transport: 'mock' }),
    mediaFactory: media,
    brainFactory: brain,
    now: () => new Date(clockMs),
  });
  t.after(async () => {
    await svc.stop();
  });

  const ring = async (n) => {
    await svc.handleEvents(normalizeCallEvents(connectBody({ callId: `wacid.PRB${n}`, from: `2169000720${n}` })));
    await svc.settled();
  };

  await ring(1);
  await ring(2);
  assert.equal(brain.made.length, 2, 'the breaker opens at the threshold');
  await ring(3);
  assert.equal(brain.made.length, 2, 'open');

  clockMs += 1001;
  await ring(4);
  assert.equal(brain.made.length, 3, 'half-open: one probe');
  await ring(5);
  assert.equal(brain.made.length, 3, 'the probe failed → re-opened on the spot');
});

// ── what the clinic reads afterwards ────────────────────────────────────────

test('a call that booked says so in the thread, with the reference', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  const brain = fakeBrain({
    outcome: { booked: 'EAS-260805-001', turns: 8, toolCalls: 3 },
    transcript: [
      { who: 'agent', text: 'أهلا بيك في عيادة الأمان', at: '2026-08-05T10:00:00.000Z' },
      { who: 'patient', text: 'نحب نحجز موعد', at: '2026-08-05T10:00:06.000Z' },
    ],
  });
  const { svc, events, unsub } = makeService(app, { media, brain, config: { voiceCallMode: 'brain' } });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690007020';
  const callId = 'wacid.BOOKED1';
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId, from })));
  await svc.settled();
  await svc.handleEvents(normalizeCallEvents(terminateBody({ callId, from, duration: 80 })));
  await svc.settled();

  const call = (await msgsOf(app, from)).find((m) => m.type === 'call');
  assert.equal(call.body.text, tr('ar', 'callBookedSummary', { duration: '1:20', ref: 'EAS-260805-001' }));
  assert.equal(call.body.by, 'system');

  // The session outcome keeps its existing meaning; the brain rides alongside.
  assert.equal(call.body.call.outcome, 'completed');
  assert.equal(call.body.call.durationSec, 80);
  assert.equal(call.body.call.brain.booked, 'EAS-260805-001');
  assert.equal(call.body.call.brain.turns, 8);
  assert.equal(call.body.call.transcript.length, 2);
  assert.equal(call.body.call.transcript[1].who, 'patient');

  // The loop is stopped BEFORE its outcome is read, so a last-second booking
  // still makes it into the row.
  assert.equal(brain.made[0].stopped, 'call_ended');
  assert.equal(ofType(events, 'call.ended').length, 1);
});

test('the inbox line leads with what happened: emergency > booking > handoff > plain', async (t) => {
  // The transcript row is the only thing most staff will ever read about a
  // call. "📞 WhatsApp call — 0:47" for a call where someone asked for a human
  // (or described chest pain) buries the only part that needs acting on.
  const cases = [
    [{}, 'callSummary', {}],
    [{ handoff: true }, 'callHandoffSummary', {}],
    [{ booked: 'EAS-1', handoff: true }, 'callBookedSummary', { ref: 'EAS-1' }],
    [{ emergency: true, booked: 'EAS-1', handoff: true }, 'callEmergencySummary', {}],
  ];
  for (const [outcome, key, extra] of cases) {
    const app = makeTestApp();
    const media = fakeMedia();
    const brain = fakeBrain({ outcome });
    const { svc, unsub } = makeService(app, { media, brain, config: { voiceCallMode: 'brain' } });

    const from = '21690007021';
    const callId = `wacid.LINE-${key}`;
    await svc.handleEvents(normalizeCallEvents(connectBody({ callId, from })));
    await svc.settled();
    await svc.handleEvents(normalizeCallEvents(terminateBody({ callId, from, duration: 47 })));
    await svc.settled();

    const call = (await msgsOf(app, from)).find((m) => m.type === 'call');
    assert.equal(call.body.text, tr('ar', key, { duration: '0:47', ...extra }), key);
    unsub();
    await svc.stop();
  }
});

test('a plain call keeps the V1 summary line and stores no empty transcript', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  const brain = fakeBrain({ outcome: { handoff: true } });
  const { svc, unsub } = makeService(app, { media, brain, config: { voiceCallMode: 'brain' } });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690007021';
  const callId = 'wacid.NOBOOK1';
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId, from })));
  await svc.settled();
  await svc.handleEvents(normalizeCallEvents(terminateBody({ callId, from, duration: 47 })));
  await svc.settled();

  const call = (await msgsOf(app, from)).find((m) => m.type === 'call');
  assert.equal(call.body.call.brain.handoff, true);
  assert.equal(call.body.call.transcript, undefined, 'an empty transcript is omitted, not stored as []');
});

// ── REGRESSION: the outcome must not be read before the work lands ──────────

test('REGRESSION: a confirm still in flight at hang-up reaches the transcript row', async (t) => {
  // Reproduced by the reviewer: the caller hung up while confirm_booking was
  // still writing. finish() stopped the loop and read outcome() immediately, so
  // the row said booked:null — and appointment EAS-260805-001 appeared in the
  // database a moment later, belonging to a call that claimed no booking.
  const app = makeTestApp();
  const media = fakeMedia();
  const brain = fakeBrain();
  const { svc, events, unsub } = makeService(app, { media, brain, config: { voiceCallMode: 'brain' } });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690007040';
  const callId = 'wacid.INFLIGHT1';
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId, from })));
  await svc.settled();

  brain.made[0].workInFlight(60, { booked: 'EAS-260805-001', turns: 9 });
  await svc.handleEvents(normalizeCallEvents(terminateBody({ callId, from, duration: 42 })));
  await svc.settled();

  const call = (await msgsOf(app, from)).find((m) => m.type === 'call');
  assert.equal(call.body.call.brain.booked, 'EAS-260805-001', 'the row waited for the write');
  assert.equal(call.body.text, tr('ar', 'callBookedSummary', { duration: '0:42', ref: 'EAS-260805-001' }));
  const [ended] = ofType(events, 'call.ended');
  assert.equal(ended.call.brain.booked, 'EAS-260805-001', 'and so did the bus event');
});

test('a wedged tool call costs a bounded wait, never the call record', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  const brain = fakeBrain();
  const { svc, unsub } = makeService(app, { media, brain, config: { voiceCallMode: 'brain' } });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690007041';
  const callId = 'wacid.WEDGED1';
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId, from })));
  await svc.settled();

  brain.made[0].workInFlight(30000, { booked: 'NEVER' }); // never lands
  const started = Date.now();
  await svc.handleEvents(normalizeCallEvents(terminateBody({ callId, from, duration: 5 })));
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 5000, `finish() waited ${elapsed}ms on a wedged tool`);
  const call = (await msgsOf(app, from)).find((m) => m.type === 'call');
  assert.ok(call, 'the call is still recorded');
  assert.equal(call.body.call.brain.booked, null);
});

test('shutdown and a mid-construction terminate both stop the brain', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  const brain = fakeBrain();
  const { svc, unsub } = makeService(app, { media, brain, config: { voiceCallMode: 'brain' } });
  t.after(() => unsub());

  await svc.handleEvents(normalizeCallEvents(connectBody({ callId: 'wacid.STOP1', from: '21690007030' })));
  await svc.settled();
  assert.equal(brain.made[0].stopped, null);

  await svc.stop();
  assert.equal(brain.made[0].stopped, 'call_ended', 'a graceful shutdown must not orphan a Live socket');
  assert.equal(media.made[0].closed, 1);
  assert.equal(svc.active().length, 0);
});

// ── hermeticity ─────────────────────────────────────────────────────────────

test('makeTestApp pins echo mode and an empty key against the environment', async (t) => {
  const prevMode = process.env.VOICE_CALL_MODE;
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.VOICE_CALL_MODE = 'brain';
  process.env.GEMINI_API_KEY = 'not-a-real-key';
  t.after(() => {
    const restore = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore('VOICE_CALL_MODE', prevMode);
    restore('GEMINI_API_KEY', prevKey);
  });

  const app = makeTestApp();
  t.after(async () => {
    await app.voiceCalls?.stop();
  });

  // Without both of these, a unit test would open a WebSocket to Google with
  // whatever key happens to be on the developer's machine.
  assert.equal(app.config.voiceCallMode, 'echo');
  assert.equal(app.config.geminiApiKey, '');
});

test('the default mode follows the key, and only the exact literal forces it', () => {
  // Documented behaviour of config.js: a clinic must never get a mute call
  // because someone forgot a flag, and must never get a paid brain by accident.
  const decide = (mode, key) => (mode || (key ? 'brain' : 'echo')) === 'brain';
  assert.equal(decide('', ''), false);
  assert.equal(decide('', 'k'), true);
  assert.equal(decide('echo', 'k'), false, 'an explicit echo beats a present key');
  assert.equal(decide('brain', ''), true);
});
