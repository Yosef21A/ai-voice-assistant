// V7-P2 — THE CASCADE, WIRED. Which brain answers the phone, and what the
// clinic's record says about it afterwards.
//
// The incumbent's own behaviour is NOT re-tested here: voicecall.brain.service
// .test.js already owns mode selection, the degrade path and the breaker, and
// those suites staying green on an untouched `live` path is the regression
// proof. What this file adds is only what P2 introduced:
//
//   1. resolveVoiceBrainMode() — the precedence matrix and the composition-level
//      fallback, as a pure function, because it decides which pipeline a paying
//      clinic's phone line runs on.
//   2. The fallback is LOUD and it happens ONCE per call — a cascade with no
//      mouth composes LIVE and says so, rather than answering with dead air.
//   3. A REAL cascade orchestrator driven through the REAL service, with only
//      the three vendor legs faked: connect → greet → one turn → end_call →
//      terminate, and a call record carrying brain.mode, the waterfalls and the
//      usage meter.
//
// Same harness law as the rest of the voice suite: the real composed store, bus
// and mock sender; nothing here opens a socket of any kind and no vendor is
// called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeTestApp, listen, request, setupOwner } from '../test-helpers/client.js';
import {
  createVoiceCallService,
  resolveVoiceBrainMode,
  MAX_RECORDED_WATERFALLS,
} from '../src/voice-call/index.js';
import { createGraphCalls } from '../src/voice-call/graphCalls.js';
import { normalizeCallEvents } from '../src/voice-call/normalize.js';
import { clearGreetingCache } from '../src/voice-call/brain/greetingCache.js';
import { normalizeSpoken } from '../src/voice-call/brain/tts/index.js';
import { buildGreetingText } from '../src/voice-call/brain-cascade/prompt.js';

const A = 'el-amen-sousse';
const EL = JSON.parse(fs.readFileSync(new URL('../data/clinics.json', import.meta.url), 'utf8')).clinics.find(
  (c) => c.id === A
);
const PNID = EL.whatsapp.phoneNumberId;
const OPEN_NOW = new Date('2026-08-05T09:00:00Z'); // Wednesday 10:00 Tunis

const SDP_OFFER =
  'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' +
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 101\r\na=rtpmap:111 opus/48000/2\r\na=rtpmap:101 telephone-event/8000\r\n';

/** Keys that make the cascade composable at all (mouth + ears). */
const CASCADE_KEYS = Object.freeze({ fishAudioApi: 'fish-key', deepgramApiKey: 'dg-key' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, deadlineMs = 8000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (fn()) return true;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${what}`);
  return false;
}

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
      // An OPUS answer, so the cascade's codec bridge negotiates a real codec.
      sdpAnswer:
        'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 101\r\na=rtpmap:111 opus/48000/2\r\na=rtpmap:101 telephone-event/8000\r\n',
      onRtp,
      sent: [],
      closed: 0,
      sendRtp(p) {
        m.sent.push(p);
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

/** A minimal fake brain loop — used only where the FACTORY choice is the subject. */
function fakeBrain({ outcome = {} } = {}) {
  const made = [];
  const factory = (deps) => {
    const loop = {
      deps,
      started: 0,
      stopped: null,
      async start() {
        loop.started += 1;
      },
      warmUp: async () => true,
      onRtp() {},
      stop(reason) {
        if (!loop.stopped) loop.stopped = reason || 'stopped';
        return loop.outcome();
      },
      transcript: () => [],
      outcome: () => ({
        reason: loop.stopped,
        booked: null,
        handoff: false,
        emergency: false,
        turns: 0,
        ...outcome,
      }),
      settled: async () => {},
      stats: () => ({}),
    };
    made.push(loop);
    return loop;
  };
  factory.made = made;
  return factory;
}

// ── the three cascade legs, faked (copied idioms from the P1 loop suite) ────

function fakeStt() {
  const handlers = new Map();
  const api = {
    provider: 'deepgram',
    ready: Promise.resolve('deepgram'),
    audio: [],
    closed: 0,
    sendAudio(pcm) {
      api.audio.push(pcm);
    },
    on(ev, cb) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(cb);
      return () => {};
    },
    emit(ev, payload) {
      for (const cb of handlers.get(ev) || []) cb(payload);
    },
    final(text, endOfTurn = true) {
      api.emit('final', { text, endOfTurn });
    },
    close() {
      api.closed += 1;
    },
    stats: () => ({ provider: 'deepgram' }),
  };
  return api;
}

function fakeLlm(steps, { provider = 'gemini-flash-lite-latest' } = {}) {
  const api = {
    provider,
    order: [provider, 'classic'],
    turns: [],
    noteResult() {},
    stats: () => ({ provider }),
    async *streamTurn({ system = '', messages = [], signal } = {}) {
      const i = api.turns.length;
      api.turns.push({ system, messages: messages.map((m) => ({ ...m })), signal });
      const step = steps[Math.min(i, steps.length - 1)];
      yield* step({ messages, signal, index: i, api });
    },
  };
  return api;
}

/** ms of 440 Hz at 24 kHz — the shape a TTS provider streams back. */
function tone24k(ms) {
  const n = Math.round((24000 * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / 24000));
  return out;
}

function fakeTts({ provider = 'fish', voice = null, chunkMs = 400 } = {}) {
  const chain = {
    mode: 'tts',
    provider,
    voice,
    sampleRate: 24000,
    calls: [],
    chars: 0,
    degraded: false,
    cacheKey: () => `${provider}:${voice || 'default'}`,
    normalizeSpoken,
    markDegraded() {
      chain.degraded = true;
    },
    meter: () => ({ chars: chain.chars, requests: chain.calls.length }),
    describe: () => ({ mode: 'tts', provider, voice, degraded: chain.degraded }),
    async *synthesize(text) {
      chain.calls.push({ text });
      chain.chars += String(text || '').length;
      yield tone24k(chunkMs);
    },
  };
  return chain;
}

function makeService(app, { media, brain, cascadeFactories, config = {}, alerts, logs } = {}) {
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
    cascadeFactories,
    logger: logs ? (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ')) : () => {},
    now: () => OPEN_NOW,
  });
  return { svc, graphCalls, events, unsub, actions: () => graphCalls.recorded.map((r) => r.action) };
}

const ofType = (events, type) => events.filter((e) => e.type === type);
const msgsOf = (app, from) => app.store.conversations.listMessages(A, `${A}:${from}`, {});
const callRow = async (app, from) => (await msgsOf(app, from)).find((m) => m.type === 'call');

// ════════════════════════════════════════════════════════════════════════════
// 1. THE MODE MATRIX — a pure function, because it picks a pipeline
// ════════════════════════════════════════════════════════════════════════════

test('mode matrix: nothing configured means the incumbent, always', () => {
  assert.equal(resolveVoiceBrainMode({}).mode, 'live');
  assert.equal(resolveVoiceBrainMode({ config: {} }).mode, 'live');
  assert.equal(resolveVoiceBrainMode({ config: { voiceBrain: 'live', ...CASCADE_KEYS } }).mode, 'live');
});

test('mode matrix: VOICE_BRAIN=cascade WITH a mouth and ears selects the cascade', () => {
  const r = resolveVoiceBrainMode({ config: { voiceBrain: 'cascade', ...CASCADE_KEYS } });
  assert.equal(r.mode, 'cascade');
  assert.equal(r.source, 'config');
  assert.equal(r.reason, null);
});

test('mode matrix: any of the three STT credentials counts as ears', () => {
  for (const key of ['deepgramApiKey', 'speechmaticsApiKey', 'geminiApiKey']) {
    const r = resolveVoiceBrainMode({
      config: { voiceBrain: 'cascade', fishAudioApi: 'f', [key]: 'k' },
    });
    assert.equal(r.mode, 'cascade', `${key} should be enough ears (liveEars is the free fallback)`);
  }
});

test('mode matrix: a cascade with NO MOUTH composes live, and says why', () => {
  const r = resolveVoiceBrainMode({ config: { voiceBrain: 'cascade', deepgramApiKey: 'd' } });
  assert.equal(r.mode, 'live');
  assert.equal(r.requested, 'cascade', 'what was asked for is still reported');
  assert.match(r.reason, /TTS credential/);
  assert.match(r.reason, /FISH_AUDIO_API/);
});

test('mode matrix: a cascade with NO EARS composes live, and says why', () => {
  const r = resolveVoiceBrainMode({ config: { voiceBrain: 'cascade', fishAudioApi: 'f' } });
  assert.equal(r.mode, 'live');
  assert.match(r.reason, /STT credential/);
});

test('mode matrix: neither leg present reports BOTH, not just the first', () => {
  const r = resolveVoiceBrainMode({ config: { voiceBrain: 'cascade' } });
  assert.equal(r.mode, 'live');
  assert.match(r.reason, /TTS credential/);
  assert.match(r.reason, /STT credential/);
});

test('mode matrix: an EXPLICIT provider with its own credential is a mouth (Azure is parked, not banned)', () => {
  const base = { voiceBrain: 'cascade', deepgramApiKey: 'd', azureSpeechKey: 'k', azureSpeechRegion: 'westeurope' };
  // Azure is deliberately absent from the automatic fallback order, so it only
  // counts when somebody NAMED it — per tenant…
  assert.equal(resolveVoiceBrainMode({ config: base, clinic: { voice: { provider: 'azure' } } }).mode, 'cascade');
  // …or globally.
  assert.equal(resolveVoiceBrainMode({ config: { ...base, voiceTtsProvider: 'azure' } }).mode, 'cascade');
  // Nobody named it ⇒ it is not a mouth, and the cascade is not composed.
  assert.equal(resolveVoiceBrainMode({ config: base }).mode, 'live');
  // Named WITHOUT its credential is not a mouth either — that would compose a
  // cascade whose first sentence 4xx's, i.e. a hung-up call.
  assert.equal(
    resolveVoiceBrainMode({
      config: { voiceBrain: 'cascade', deepgramApiKey: 'd' },
      clinic: { voice: { provider: 'azure' } },
    }).mode,
    'live'
  );
});

test('mode matrix: the TENANT override beats the global default, both ways', () => {
  const on = resolveVoiceBrainMode({ config: CASCADE_KEYS, clinic: { voiceBrain: 'cascade' } });
  assert.equal(on.mode, 'cascade');
  assert.equal(on.source, 'tenant');

  const off = resolveVoiceBrainMode({
    config: { voiceBrain: 'cascade', ...CASCADE_KEYS },
    clinic: { voiceBrain: 'live' },
  });
  assert.equal(off.mode, 'live', 'a tenant pinned to live is never migrated by a global flag');
  assert.equal(off.source, 'tenant');

  // The tenant-RECORD shape (config.voiceBrain) is read too — api/tenant.js
  // persists it there, and the legacy clinic object is the merged view.
  assert.equal(
    resolveVoiceBrainMode({ config: CASCADE_KEYS, clinic: { config: { voiceBrain: 'cascade' } } }).mode,
    'cascade'
  );
});

test('mode matrix: only the EXACT literal opts in — no case folding, no trimming', () => {
  for (const junk of ['CASCADE', 'Cascade', 'cascade ', ' cascade', 'fast', 'casc', 1, true, null]) {
    const r = resolveVoiceBrainMode({ config: { voiceBrain: junk, ...CASCADE_KEYS } });
    assert.equal(r.mode, 'live', `${JSON.stringify(junk)} must never enable the experimental path`);
  }
  // …and the same at the tenant rung, where a hand-edited clinics.json lands.
  assert.equal(
    resolveVoiceBrainMode({ config: CASCADE_KEYS, clinic: { voiceBrain: 'CASCADE' } }).mode,
    'live'
  );
  // An unrecognized TENANT value falls through to the global flag rather than
  // pinning the tenant to live — it is junk, not a choice.
  assert.equal(
    resolveVoiceBrainMode({ config: { voiceBrain: 'cascade', ...CASCADE_KEYS }, clinic: { voiceBrain: 'nope' } })
      .mode,
    'cascade'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 2. THE COMPOSITION-LEVEL FALLBACK — loud, once, never dead air
// ════════════════════════════════════════════════════════════════════════════

test('a cascade that cannot be fed falls back to LIVE with exactly ONE warning per call', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  const brain = fakeBrain();
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  t.after(() => {
    console.warn = realWarn;
  });

  // cascade asked for, no FISH/EL key and no STT key anywhere.
  const { svc, events, unsub, actions } = makeService(app, {
    media,
    brain,
    config: { voiceCallMode: 'brain', voiceBrain: 'cascade' },
  });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690009001';
  const callId = 'wacid.P2FALLBACK1';
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId, from })));
  await svc.settled();

  const cascadeWarns = warns.filter((w) => w.includes('[voice-call] cascade unavailable'));
  assert.equal(cascadeWarns.length, 1, 'warm-up AND start must not each warn — it is one decision per call');
  assert.match(cascadeWarns[0], /live mode for this call/);
  assert.match(cascadeWarns[0], /FISH_AUDIO_API/);

  // The caller still gets a working phone line: the incumbent answered.
  assert.deepEqual(actions(), ['pre_accept', 'accept']);
  assert.equal(brain.made.length, 1, 'a brain was still built — the fallback is to LIVE, not to silence');
  assert.equal(svc.active()[0].brain, 'live');

  await svc.handleEvents(normalizeCallEvents(terminateBody({ callId, from, duration: 12 })));
  await svc.settled();

  const [ended] = ofType(events, 'call.ended');
  assert.equal(ended.call.brain.mode, 'live', 'and the record says which brain actually answered');
});

test('the fallback warns once PER CALL, not once per process', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  const brain = fakeBrain();
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  t.after(() => {
    console.warn = realWarn;
  });

  const { svc, unsub } = makeService(app, {
    media,
    brain,
    config: { voiceCallMode: 'brain', voiceBrain: 'cascade' },
  });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  for (const n of [1, 2]) {
    await svc.handleEvents(
      normalizeCallEvents(connectBody({ callId: `wacid.P2WARN${n}`, from: `2169000901${n}` }))
    );
    await svc.settled();
  }
  assert.equal(
    warns.filter((w) => w.includes('[voice-call] cascade unavailable')).length,
    2,
    'a misconfiguration that costs every caller their fast brain must be visible on every call'
  );
});

test('an injected brainFactory still wins, and the record still names the resolved mode', async (t) => {
  const app = makeTestApp();
  const media = fakeMedia();
  const brain = fakeBrain();
  const { svc, events, unsub } = makeService(app, {
    media,
    brain,
    // Fully composable cascade — and yet the injected factory is what runs.
    config: { voiceCallMode: 'brain', voiceBrain: 'cascade', ...CASCADE_KEYS },
    cascadeFactories: { ttsChain: fakeTts() },
  });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690009020';
  const callId = 'wacid.P2INJECT1';
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId, from })));
  await svc.settled();
  assert.equal(brain.made.length, 1, 'the injected factory built the loop');
  assert.equal(brain.made[0].started, 1);

  await svc.handleEvents(normalizeCallEvents(terminateBody({ callId, from, duration: 20 })));
  await svc.settled();
  const [ended] = ofType(events, 'call.ended');
  assert.equal(ended.call.brain.mode, 'cascade', 'the resolved mode is reported even when the loop was faked');
});

// ════════════════════════════════════════════════════════════════════════════
// 3. A REAL CASCADE CALL, THROUGH THE REAL SERVICE
// ════════════════════════════════════════════════════════════════════════════

/**
 * The brain for the e2e: answer, then hang up. Round 2 (after the tool result)
 * says nothing more — the same shape brain-cascade's own suite uses.
 */
function farewellBrain() {
  return fakeLlm([
    async function* ({ messages }) {
      if (messages.some((m) => m.role === 'tool')) {
        yield { type: 'done', usage: { tokensIn: 12, tokensOut: 0 }, provider: 'gemini-flash-lite-latest' };
        return;
      }
      yield { type: 'text', delta: 'عندي بلاصة نهار الخميس الصباح. ' };
      yield { type: 'text', delta: 'يعطيك الصحة، بالسلامة. ' };
      yield { type: 'toolCall', call: { id: 'e1', name: 'end_call', args: {} } };
      yield { type: 'done', usage: { tokensIn: 120, tokensOut: 34 }, provider: 'gemini-flash-lite-latest' };
    },
  ]);
}

test('cascade e2e: connect → greet → one turn → end_call → terminate, with a full record', async (t) => {
  clearGreetingCache(); // the tape is process-global by design
  const app = makeTestApp();
  const media = fakeMedia();
  const stt = fakeStt();
  const llm = farewellBrain();
  const tts = fakeTts();
  const logs = [];
  const { svc, events, unsub, actions } = makeService(app, {
    media,
    logs,
    config: {
      voiceCallMode: 'brain',
      voiceBrain: 'cascade',
      ...CASCADE_KEYS,
      voiceCallHangupGraceMs: 4000,
      voiceGreetingCache: false, // one tenant, one call: never serve a tape here
    },
    cascadeFactories: {
      sttFactory: () => stt,
      llmFactory: () => llm,
      ttsChain: tts,
    },
  });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690009030';
  const callId = 'wacid.P2CASCADE1';
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId, from })));
  await svc.settled();

  // The REAL orchestrator is on this call, and it greeted without a model turn.
  assert.equal(svc.active()[0]?.brain, 'cascade');
  const clinic = app.store.getClinicById(A);
  assert.deepEqual(
    tts.calls.map((c) => c.text),
    [normalizeSpoken(buildGreetingText(clinic, 'ar'))],
    'zero dead air: the greeting is composed, not generated'
  );
  assert.equal(llm.turns.length, 0, 'a greeting costs no tokens');
  await waitFor(() => media.made[0].sent.length > 0, 'the greeting to reach the wire');

  // ── one caller turn ─────────────────────────────────────────────────────
  stt.final('نحب نحجز موعد قلب', true);
  await waitFor(() => llm.turns.length >= 1, 'the turn to reach the brain');
  await svc.settled();
  assert.equal(llm.turns[0].messages.at(-1).text, 'نحب نحجز موعد قلب');
  assert.ok(
    tts.calls.some((c) => c.text.includes('بالسلامة')),
    'the answer was spoken through the TTS chain'
  );

  // ── the agent hangs itself up, AFTER the farewell has drained ───────────
  await waitFor(() => ofType(events, 'call.ended').length === 1, 'the agent to hang up', 10000);
  await svc.settled();

  assert.deepEqual(actions(), ['pre_accept', 'accept', 'terminate'], 'the service owns the Graph terminate');
  assert.equal(svc.active().length, 0);
  assert.equal(media.made[0].closed, 1, 'no UDP socket is left behind');
  assert.equal(stt.closed, 1, 'and no STT socket either');

  // ── what the clinic reads afterwards ────────────────────────────────────
  const row = await callRow(app, from);
  assert.ok(row, 'the call landed on the patient thread');
  const brain = row.body.call.brain;
  assert.equal(brain.mode, 'cascade', 'a quality complaint is attributable to a pipeline');
  assert.equal(brain.brain, 'cascade', "the loop's own label rides along unchanged");
  assert.equal(brain.reason, 'completed');
  assert.deepEqual(brain.providers, { stt: 'deepgram', llm: 'gemini-flash-lite-latest', tts: 'fish' });

  // THE WATERFALL: one row per turn, every hop a number, every leg NAMED.
  assert.ok(Array.isArray(brain.waterfalls), 'the waterfalls ride the record');
  assert.equal(brain.waterfalls.length, 1, 'one completed turn, one waterfall');
  const w = brain.waterfalls[0];
  assert.deepEqual(
    { stt: w.stt, llm: w.llm, tts: w.tts },
    { stt: 'deepgram', llm: 'gemini-flash-lite-latest', tts: 'fish' }
  );
  assert.ok(Number.isFinite(w.llm_ttft_ms), 'the LLM leg is timed');
  assert.ok(Number.isFinite(w.tts_ttfb_ms), 'and so is the mouth');

  // THE METER: this is what makes pass-through billing a config change.
  assert.ok(brain.usage, 'the usage meter rides the record');
  assert.equal(brain.usage.llmTokensIn, 132);
  assert.equal(brain.usage.llmTokensOut, 34);
  assert.ok(brain.usage.ttsChars > 0);
  assert.ok(brain.usage.ttsRequests >= 2, 'greeting + answer');

  // The transcript is on the conversation row, not on the bus event.
  assert.ok(row.body.call.transcript.length >= 2);

  // The per-turn log line names the chain, so "it feels slow" is arguable.
  const waterfallLine = logs.find((l) => l.includes('[voice-cascade] waterfall'));
  assert.ok(waterfallLine, 'the per-turn waterfall line is logged through the service logger');
  assert.match(waterfallLine, /deepgram → gemini-flash-lite-latest → fish/);

  // The bus event carries the same brain block — the notification, CRM and
  // analytics consumers subscribe there.
  const [ended] = ofType(events, 'call.ended');
  assert.equal(ended.call.brain.mode, 'cascade');
  assert.equal(ended.call.brain.waterfalls.length, 1);
  assert.equal(ofType(events, 'call.missed').length, 0);
});

test('a cascade with no mouth at RUN time degrades to WhatsApp — it never holds a mute line', async (t) => {
  // The credentials said "cascade is composable"; the chain still came back
  // native (a breaker, a malformed voice id). The orchestrator refuses the call
  // rather than answering with silence, and the service does what it does for a
  // dead Gemini socket: hang up, and put it in writing.
  clearGreetingCache();
  const app = makeTestApp();
  const media = fakeMedia();
  const alerts = { fired: [], fire: (tenantId, kind, detail) => alerts.fired.push({ tenantId, kind, detail }) };
  const { svc, events, unsub, actions } = makeService(app, {
    media,
    alerts,
    config: { voiceCallMode: 'brain', voiceBrain: 'cascade', ...CASCADE_KEYS },
    cascadeFactories: {
      sttFactory: () => fakeStt(),
      llmFactory: () => fakeLlm([]),
      // mode 'native' ⇒ the cascade has no voice at all.
      ttsChain: { mode: 'native', provider: 'gemini', voice: null, synthesize: null },
    },
  });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690009040';
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId: 'wacid.P2NOMOUTH1', from })));
  await svc.settled();

  assert.deepEqual(actions(), ['pre_accept', 'accept', 'terminate']);
  const out = (await msgsOf(app, from)).filter((m) => m.direction === 'outbound');
  assert.equal(out.length, 1, 'the patient is handed to the chat engine in writing');
  assert.deepEqual(alerts.fired.map((f) => f.kind), ['voice_brain_lost']);
  const [ended] = ofType(events, 'call.ended');
  assert.equal(ended.call.brain.mode, 'cascade', 'the record still names the brain that failed');
});

test('the stored waterfall keeps the TAIL of a long call, capped', async (t) => {
  // The loop keeps up to 120 turns; the RECORD fans out to every open SSE
  // stream, so only the last MAX_RECORDED_WATERFALLS are persisted — and it is
  // the LAST ones, because the end of a call is what a complaint is about.
  const app = makeTestApp();
  const media = fakeMedia();
  const many = Array.from({ length: MAX_RECORDED_WATERFALLS + 12 }, (_, i) => ({ llm_ttft_ms: i, stt: 'deepgram' }));
  const brain = fakeBrain({ outcome: { waterfalls: many, usage: { llmTokensIn: 9, ttsChars: 4 } } });
  const { svc, events, unsub } = makeService(app, {
    media,
    brain,
    config: { voiceCallMode: 'brain', voiceBrain: 'cascade', ...CASCADE_KEYS },
    cascadeFactories: { ttsChain: fakeTts() },
  });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690009050';
  const callId = 'wacid.P2CAP1';
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId, from })));
  await svc.settled();
  await svc.handleEvents(normalizeCallEvents(terminateBody({ callId, from, duration: 600 })));
  await svc.settled();

  const row = await callRow(app, from);
  assert.equal(row.body.call.brain.waterfalls.length, MAX_RECORDED_WATERFALLS);
  assert.equal(
    row.body.call.brain.waterfalls[MAX_RECORDED_WATERFALLS - 1].llm_ttft_ms,
    many.length - 1,
    'the tail is kept, not the head'
  );
  assert.equal(row.body.call.brain.usage.llmTokensIn, 9, 'the meter is not touched by the cap');
  // The loop's own array is never mutated by the service.
  assert.equal(brain.made[0].outcome().waterfalls.length, many.length);
  assert.equal(ofType(events, 'call.ended').length, 1);
});

// ════════════════════════════════════════════════════════════════════════════
// 4. THE TENANT OVERRIDE, THROUGH THE DASHBOARD
// ════════════════════════════════════════════════════════════════════════════

test('PUT /api/tenant validates voiceBrain, persists it, and the resolver reads it live', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  t.after(() => new Promise((r) => server.close(r)));
  t.after(async () => {
    await app.voiceCalls?.stop();
  });
  const { cookie } = await setupOwner(server, { tenantId: A, email: `owner-${randomUUID()}@x.tn` });

  // A CLOSED set, exactly like voice.provider: the call-time resolver validates
  // it a second time, because a hand-edited clinics.json never comes past here.
  // (`null` is deliberately absent: like every other field in this validator it
  // means "not supplied", not "supplied as junk".)
  for (const junk of ['CASCADE', 'fast', 'gemini', 'echo', 7, true, ['cascade']]) {
    const bad = await request(server, 'PUT', '/api/tenant', { cookie, body: { voiceBrain: junk } });
    assert.equal(bad.status, 400, `voiceBrain=${JSON.stringify(junk)} must be rejected`);
    assert.match(bad.body.details.join(' '), /voiceBrain must be live\|cascade/);
  }

  const put = await request(server, 'PUT', '/api/tenant', { cookie, body: { voiceBrain: 'cascade' } });
  assert.equal(put.status, 200);
  assert.equal(put.body.tenant.config.voiceBrain, 'cascade');

  // Persisted…
  const get = await request(server, 'GET', '/api/tenant', { cookie });
  assert.equal(get.body.tenant.config.voiceBrain, 'cascade');
  // …and visible to the LIVE clinic object the voice service resolves against.
  const live = app.store.getClinicById(A);
  assert.equal(live.voiceBrain, 'cascade');
  assert.equal(resolveVoiceBrainMode({ config: CASCADE_KEYS, clinic: live }).mode, 'cascade');

  // '' clears the override — and it is STORED as '', because Object.assign onto
  // the live clinic can add a key but never remove one.
  const cleared = await request(server, 'PUT', '/api/tenant', { cookie, body: { voiceBrain: '' } });
  assert.equal(cleared.status, 200);
  assert.equal(app.store.getClinicById(A).voiceBrain, '');
  assert.equal(
    resolveVoiceBrainMode({ config: CASCADE_KEYS, clinic: app.store.getClinicById(A) }).mode,
    'live',
    'a cleared override falls back to the global default'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 5. HERMETICITY
// ════════════════════════════════════════════════════════════════════════════

test('makeTestApp pins the LIVE brain and empty cascade keys against the environment', async (t) => {
  const prev = {};
  const set = (k, v) => {
    prev[k] = process.env[k];
    process.env[k] = v;
  };
  set('VOICE_BRAIN', 'cascade');
  set('FISH_AUDIO_API', 'not-a-real-key');
  set('DEEPGRAM_API_KEY', 'not-a-real-key');
  set('SPEECHMATICS_API_KEY', 'not-a-real-key');
  set('CEREBRAS_API_KEY', 'not-a-real-key');
  set('GROQ_API_KEY', 'not-a-real-key');
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const app = makeTestApp();
  t.after(async () => {
    await app.voiceCalls?.stop();
  });

  // Without these, a machine-global VOICE_BRAIN would swap the brain under every
  // existing voice suite — and a real key would let a unit test post a patient's
  // audio to a vendor.
  assert.equal(app.config.voiceBrain, 'live');
  assert.equal(app.config.fishAudioApi, '');
  assert.equal(app.config.deepgramApiKey, '');
  assert.equal(app.config.speechmaticsApiKey, '');
  assert.equal(app.config.cerebrasApiKey, '');
  assert.equal(app.config.groqApiKey, '');
  assert.equal(resolveVoiceBrainMode({ config: app.config }).mode, 'live');
});
