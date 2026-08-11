// V7-P1 — THE CASCADE ORCHESTRATOR, end to end, with fake providers.
//
// Same harness law as the rest of the voice suite: the REAL composed store, bus
// and mock sender, with only the three vendor legs faked (STT, LLM, TTS) plus
// the WebRTC media session. Nothing here opens a socket of any kind, and no
// provider measured in P0 is called — P0 already measured them; this file
// measures OUR behaviour.
//
// What it is actually asserting, in one line each:
//   • the emergency detector runs BEFORE the LLM — the model never sees it;
//   • a speculative turn that guessed wrong is aborted, and the caller hears
//     exactly ONE answer;
//   • barge-in reaches the socket in under the 150 ms budget;
//   • the filler covers a slow brain instead of dead air;
//   • the two-phase booking gate holds through the function-calling path;
//   • end_call hangs up AFTER the farewell has actually played;
//   • every turn produces a complete waterfall, and every call a usage row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers/client.js';
import {
  createCascadeLoop,
  diffRatio,
  materialDrift,
  sharedPrefixLength,
  levenshtein,
} from '../src/voice-call/brain-cascade/orchestrator.js';
import { createSttChain } from '../src/voice-call/brain-cascade/stt/index.js';
import { createCodecBridge } from '../src/voice-call/brain/codec.js';
import { clearGreetingCache, greetingCacheStats } from '../src/voice-call/brain/greetingCache.js';
import { normalizeSpoken } from '../src/voice-call/brain/tts/index.js';
import { buildGreetingText, buildFillerText, NOISE_POLICY } from '../src/voice-call/brain-cascade/prompt.js';
import { buildEmergencyReply, buildSpokenEmergencyReply } from '../src/notifications/pipeline.js';

const CLINIC = 'el-amen-sousse';
const WA = '218911234567';
const NOW = () => new Date(2026, 7, 5, 10, 0, 0); // Wednesday, clinic open

const OPUS_SDP =
  'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 101\r\n' +
  'a=rtpmap:111 opus/48000/2\r\na=rtpmap:101 telephone-event/8000\r\n';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn()` is truthy, or blow up with a readable message. */
async function waitFor(fn, what = 'condition', deadlineMs = 3000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (fn()) return true;
    await sleep(5);
  }
  assert.fail(`timed out waiting for ${what}`);
  return false;
}

/** ms of 440 Hz at the brain's 24 kHz output rate. */
function tone24k(ms) {
  const n = Math.round((24000 * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / 24000));
  return out;
}

// ── the three fake legs ─────────────────────────────────────────────────────

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
    interim(text) {
      api.emit('interim', { text });
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

/**
 * A brain the test scripts turn by turn. Each step is an async generator over
 * the SAME event shape the real chain yields.
 */
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

/** The simplest brain: say these fragments, then finish. */
const says = (...parts) =>
  async function* step() {
    for (const p of parts) yield { type: 'text', delta: p };
    yield { type: 'done', usage: { tokensIn: 40, tokensOut: 12 }, provider: 'gemini-flash-lite-latest' };
  };

function fakeTts({ provider = 'fish', voice = null, chunkMs = 120, failAt = 0, holdAt = 0, slowMs = 0 } = {}) {
  let n = 0;
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
    async *synthesize(text, { lang, signal } = {}) {
      n += 1;
      chain.calls.push({ text, lang, n });
      chain.chars += String(text || '').length;
      if (failAt === n) {
        const err = new Error('fake provider exploded');
        err.isTtsError = true;
        throw err;
      }
      if (holdAt === n) {
        await new Promise((_res, rej) => {
          const bail = () => rej(signal.reason || new Error('aborted'));
          if (signal.aborted) return bail();
          signal.addEventListener('abort', bail, { once: true });
        });
        return;
      }
      // A SLOW MOUTH. Real TTS time-to-first-byte is 170–570 ms measured (P0),
      // which is exactly the window in which a speculative turn is still
      // synthesizing when the caller's final arrives.
      if (slowMs) {
        await new Promise((res, rej) => {
          const timer = setTimeout(res, slowMs);
          const bail = () => {
            clearTimeout(timer);
            rej(signal?.reason || new Error('aborted'));
          };
          if (signal?.aborted) return bail();
          signal?.addEventListener('abort', bail, { once: true });
        });
      }
      yield tone24k(chunkMs);
    },
  };
  return chain;
}

/**
 * A Gemini Live client the test drives — the same shape the chain tests use.
 * Here it is wired into the ORCHESTRATOR, because "the ears have no mouth" is a
 * property of the whole loop, not of the adapter (V7-P2.1, suspect #3).
 */
function fakeLiveClient() {
  const handlers = new Map();
  const api = {
    opts: null,
    audioChunks: [],
    closed: 0,
    on(ev, cb) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(cb);
      return () => {};
    },
    emit(ev, payload) {
      for (const cb of handlers.get(ev) || []) cb(payload);
    },
    sendAudioChunk(pcm) {
      api.audioChunks.push(pcm);
    },
    sendText: () => true,
    sendToolResponse: () => true,
    close() {
      api.closed += 1;
    },
    stats: () => ({ fake: true }),
  };
  api.ready = Promise.resolve(true);
  return api;
}

function fakeMedia({ sdpAnswer = OPUS_SDP } = {}) {
  const sent = [];
  return {
    sdpAnswer,
    sent,
    sendRtp(p) {
      sent.push(p);
      return true;
    },
    close() {},
  };
}

async function setup({
  app: given,
  tenantId = CLINIC,
  waId = WA,
  llm,
  tts,
  stt,
  sttFactory,
  config = {},
  ended = [],
  clearCache = true,
} = {}) {
  // The greeting/filler tape is process-global by design; the tape tests opt out.
  if (clearCache) clearGreetingCache();
  const app = given || makeTestApp();
  const clinic = app.store.getClinicById(tenantId);
  const convo =
    (await app.store.conversations.get(tenantId, waId)) ||
    (await app.store.conversations.create(tenantId, { patientWaId: waId, status: 'open' }));
  const events = [];
  const unsub = app.bus.subscribe((e) => events.push(e));
  const sttChain = stt || fakeStt();
  const llmChain = llm || fakeLlm([says('أهلا بيك.')]);
  const ttsChain = tts || fakeTts();
  const media = fakeMedia();

  const loop = createCascadeLoop({
    clinic,
    convo,
    media,
    store: app.store,
    bus: app.bus,
    sender: app.sender,
    config: { geminiApiKey: '', ...config },
    lang: 'ar',
    patientWaId: waId,
    sdpOffer: OPUS_SDP,
    // The REAL chain, when a test wants the ears themselves under test
    // (liveEars is the leg that hears our own voice come back).
    sttFactory: sttFactory || (() => sttChain),
    llmFactory: () => llmChain,
    ttsChain,
    now: NOW,
    logger: () => {},
    onEnd: (o) => ended.push(o),
  });
  return { app, clinic, convo, events, unsub, stt: sttChain, llm: llmChain, tts: ttsChain, media, loop, ended };
}

const ofType = (events, type) => events.filter((e) => e.type === type);
const queuedOrSent = (s) => s.loop.stats().outQueue + s.media.sent.length;

// ════════════════════════════════════════════════════════════════════════════
// 1. THE GOLDEN PATH
// ════════════════════════════════════════════════════════════════════════════

test('a cascade call: composed greeting, a caller turn, a spoken answer, a full waterfall', async (t) => {
  const s = await setup({ llm: fakeLlm([says('عندي بلاصة ', 'نهار الخميس الصباح. ')]) });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });

  await s.loop.start();
  // ZERO DEAD AIR: the greeting is COMPOSED, not generated. No model round trip
  // stands between the caller picking up and hearing a voice.
  const greeting = buildGreetingText(s.clinic, 'ar');
  assert.deepEqual(s.tts.calls.map((c) => c.text), [normalizeSpoken(greeting)]);
  assert.ok(greeting.includes(s.clinic.name));
  assert.match(greeting, /المساعد الآلي/, 'the AI disclosure is in the first sentence');
  assert.equal(s.llm.turns.length, 0, 'a greeting costs no tokens at all');

  s.stt.final('نحب نحجز موعد قلب', true);
  await s.loop.settled();

  // The turn reached the brain with the system prompt the cascade builds.
  assert.equal(s.llm.turns.length, 1);
  const { system, messages } = s.llm.turns[0];
  assert.equal(messages.at(-1).text, 'نحب نحجز موعد قلب');
  assert.ok(system.includes('NEVER diagnose'), 'the medical law is imported, not re-typed');
  assert.ok(system.includes(NOISE_POLICY.split('\n')[1]), 'the V6.2 noise policy rides on every turn');
  assert.ok(system.includes(s.clinic.name));
  assert.ok(/CALLER: /.test(system), 'the derja few-shot pack is injected');

  // …and the answer was spoken, in clauses, through the TTS chain.
  assert.deepEqual(s.tts.calls.slice(1).map((c) => c.text), ['عندي بلاصة نهار الخميس الصباح.']);
  assert.ok(queuedOrSent(s) > 0, 'the synthesized audio really reached the paced queue');

  const script = s.loop.transcript();
  assert.ok(script.some((e) => e.who === 'patient' && e.text.includes('نحب نحجز')));
  assert.ok(script.some((e) => e.who === 'agent' && e.text.includes('الخميس')));

  const oc = s.loop.outcome();
  assert.equal(oc.brain, 'cascade');
  assert.deepEqual(oc.providers, { stt: 'deepgram', llm: 'gemini-flash-lite-latest', tts: 'fish' });
  assert.equal(oc.waterfalls.length, 1);
  const w = oc.waterfalls[0];
  // WATERFALL COMPLETENESS: every hop is a number and every leg is named, or
  // "the agent feels slow" stays an argument instead of a measurement.
  for (const k of ['vad_ms', 'stt_final_ms', 'llm_ttft_ms', 'tts_ttfb_ms', 'first_audio_ms', 'stt', 'llm', 'tts']) {
    assert.ok(k in w, `waterfall is missing ${k}`);
  }
  assert.equal(w.stt, 'deepgram');
  assert.equal(w.llm, 'gemini-flash-lite-latest');
  assert.equal(w.tts, 'fish');
  assert.ok(w.llm_ttft_ms >= 0 && w.tts_ttfb_ms >= 0);
});

test('METERING: tokens in/out and TTS characters are counted, and land on a call.usage row', async (t) => {
  const s = await setup({ llm: fakeLlm([says('باهي برشة.')]) });
  t.after(() => s.unsub());
  await s.loop.start();
  // TWO WORDS, deliberately: V8-D3 §3 refuses a one-word non-backchannel final
  // outside a data-capture state as a transcription fragment.
  s.stt.final('عسلامة، نحب نسأل', true);
  await s.loop.settled();

  const greetingChars = normalizeSpoken(buildGreetingText(s.clinic, 'ar')).length;
  const replyChars = 'باهي برشة.'.length;
  const oc = s.loop.stop('completed');
  assert.equal(oc.usage.llmTokensIn, 40);
  assert.equal(oc.usage.llmTokensOut, 12);
  assert.equal(oc.usage.ttsChars, greetingChars + replyChars, 'every character billed by a vendor is counted');
  assert.equal(oc.usage.ttsRequests, 2);
  assert.ok(oc.usage.sttMs >= 0);

  // Persisted best-effort, so pass-through billing is a config change later.
  await s.loop.settled();
  const rows = await s.app.store.events.list(CLINIC, { type: 'call.usage' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.brain, 'cascade');
  assert.equal(rows[0].payload.ttsChars, oc.usage.ttsChars);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. THE EMERGENCY PREFLIGHT — the model never gets a vote
// ════════════════════════════════════════════════════════════════════════════

test('THE LAW: a final naming chest pain never reaches the LLM chain at all', async (t) => {
  const ended = [];
  const s = await setup({ config: { voiceBrainEmergencyGraceMs: 40 }, ended });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  const afterGreeting = s.tts.calls.length;

  s.stt.final('عندي وجع قوي في صدري', true);
  await s.loop.settled();

  // 1) NOT ONE BYTE of it reached a model.
  assert.equal(s.llm.turns.length, 0, 'the emergency detector runs BEFORE the brain, always');

  // 2) OUR script was spoken through OUR mouth — no model may paraphrase an
  //    ambulance number.
  const spoken = buildSpokenEmergencyReply(s.clinic, 'ar');
  const said = s.tts.calls.slice(afterGreeting).map((c) => c.text);
  assert.deepEqual(said, [normalizeSpoken(spoken)]);
  assert.ok(spoken.includes('1 9 0'), 'the number is speakable, digit by digit');
  assert.ok(!spoken.includes('🚨'), 'nobody reads an emoji out loud');

  // 3) Staff are paged.
  const [alert] = ofType(s.events, 'emergency.detected');
  assert.ok(alert);
  assert.equal(alert.category, 'chest_pain');
  assert.equal(alert.channel, 'call');
  assert.equal(alert.patientWaId, WA);

  // 4) The bot steps back on EVERY channel.
  const convo = await s.app.store.conversations.getById(CLINIC, s.convo.id);
  assert.equal(convo.status, 'needs_human');
  assert.equal(convo.aiPaused, true);

  // 5) The number is IN WRITING — nobody in distress retains one heard once.
  const msgs = await s.app.store.conversations.listMessages(CLINIC, s.convo.id, {});
  const out = msgs.filter((m) => m.direction === 'outbound');
  assert.equal(out.length, 1);
  assert.equal(out[0].body.text, buildEmergencyReply(s.clinic, 'ar'));

  // 6) …and the call ends on a TIMER, whatever anything else does.
  await waitFor(() => ended.length === 1, 'the emergency hang-up');
  assert.equal(ended[0].reason, 'emergency');
  assert.equal(ended[0].emergency, true);
});

test('the emergency also kills the turn that was already running, and mutes the uplink', async (t) => {
  const s = await setup({
    config: { voiceBrainEmergencyGraceMs: 5000 },
    llm: fakeLlm([
      // A turn that is still writing when the caller says the dangerous thing.
      async function* () {
        yield { type: 'text', delta: 'خلينا نشوفو المواعيد المتاحة عندنا هالأسبوع. ' };
        await sleep(60);
        yield { type: 'text', delta: 'عندنا برشة أوقات.' };
        yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
      },
    ]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.stt.final('نحب نعرف المواعيد', true);
  await waitFor(() => s.tts.calls.length >= 2, 'the first clause to be spoken');
  s.stt.final('في صدري وجع قوي برشة', true);
  await s.loop.settled();

  assert.equal(s.loop.outcome().emergency, true);
  const spoken = normalizeSpoken(buildSpokenEmergencyReply(s.clinic, 'ar'));
  assert.equal(s.tts.calls.at(-1).text, spoken, 'the script is the LAST thing queued, ahead of the model');
  // The uplink is muted: a frightened caller talks over you, and their audio
  // must not be able to cut the ambulance number short.
  const before = s.stt.audio.length;
  s.loop.onRtp({ header: { payloadType: 111 }, payload: Buffer.from([0xd5, 0xd5, 0xd5, 0xd5]) });
  assert.equal(s.stt.audio.length, before);
});

// ════════════════════════════════════════════════════════════════════════════
// 3. SPECULATION
// ════════════════════════════════════════════════════════════════════════════

test('SPECULATION: two agreeing interims start the brain early, and the final confirms it', async (t) => {
  const s = await setup({ llm: fakeLlm([says('باهي، نشوفلك وقت.')]), config: { voiceCascadeEotMs: 20 } });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.stt.interim('نحب نحجز موعد');
  assert.equal(s.llm.turns.length, 0, 'one interim proves nothing');
  s.stt.interim('نحب نحجز موعد عند');
  assert.equal(s.llm.turns.length, 1, 'two interims that agree on the opening ARE evidence');
  assert.equal(s.loop.stats().turnSpeculative, true);

  // The final says materially the same thing ⇒ the guess is promoted, not redone.
  s.stt.final('نحب نحجز موعد عند طبيب', false);
  await sleep(40);
  await s.loop.settled();
  assert.equal(s.llm.turns.length, 1, 'the speculative turn IS the answer — no second request');
  assert.equal(s.loop.stats().speculativeRestarts, 0);
  assert.equal(s.loop.stats().speculations, 1);
  assert.deepEqual(s.tts.calls.slice(1).map((c) => c.text), ['باهي، نشوفلك وقت.']);
});

test('SPECULATION MISSED: a final that differs materially aborts the guess — ONE answer reaches the caller', async (t) => {
  const s = await setup({
    config: { voiceCascadeEotMs: 20 },
    llm: fakeLlm([
      // The speculative turn: still thinking when the abort arrives.
      async function* ({ signal }) {
        await new Promise((_res, rej) => {
          const bail = () => rej(signal.reason || new Error('aborted'));
          if (signal.aborted) return bail();
          signal.addEventListener('abort', bail, { once: true });
        });
        yield { type: 'text', delta: 'THIS MUST NEVER BE SPOKEN' };
      },
      says('العيادة مسكرة نهار الأحد.'),
    ]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  const afterGreeting = s.tts.calls.length;

  s.stt.interim('نحب نحجز موعد');
  s.stt.interim('نحب نحجز موعد عند');
  assert.equal(s.llm.turns.length, 1);

  // The caller finished saying something else entirely.
  s.stt.final('نحب نعرف إذا العيادة تخدم نهار الأحد ولا لا', true);
  await s.loop.settled();

  assert.equal(s.llm.turns.length, 2, 'the guess was discarded and the real sentence asked again');
  assert.equal(s.loop.stats().speculativeRestarts, 1);
  const said = s.tts.calls.slice(afterGreeting).map((c) => c.text);
  assert.deepEqual(said, ['العيادة مسكرة نهار الأحد.'], 'exactly ONE answer — the wrong one never reached a mouth');
  assert.equal(s.llm.turns[1].messages.at(-1).text, 'نحب نعرف إذا العيادة تخدم نهار الأحد ولا لا');
});

test('A GUESS MAY NOT WRITE: a speculative turn that reaches for a tool is abandoned', async (t) => {
  const s = await setup({
    config: { voiceCascadeEotMs: 15 },
    llm: fakeLlm([
      // The speculation hears half a name and immediately tries to stage it.
      async function* () {
        yield {
          type: 'toolCall',
          call: { id: 'x', name: 'stage_booking', args: { datetimeText: 'الخميس', name: 'مح' } },
        };
        yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
      },
      says('باهي، شنوة اسمك الكامل؟'),
    ]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.stt.interim('نحب نحجز موعد اسمي مح');
  s.stt.interim('نحب نحجز موعد اسمي محم');
  await s.loop.settled();
  assert.equal(s.loop.stats().staged, false, 'a half-heard name never reaches the booking gate');

  s.stt.final('نحب نحجز موعد اسمي محمد الهادي', true);
  await sleep(30);
  await s.loop.settled();
  assert.equal(s.llm.turns.length, 2, 'the real sentence gets its own turn');
  assert.equal(s.loop.stats().staged, false);
});

test('the drift maths: a CONTINUATION is not a contradiction, a rewrite is', () => {
  assert.equal(levenshtein('abc', 'abc'), 0);
  assert.equal(levenshtein('abc', 'abd'), 1);
  assert.equal(diffRatio('نحب نحجز موعد', 'نحب نحجز موعد'), 0);

  // The trap this function exists for: a whole-string Levenshtein scores a
  // simple continuation at 0.43 and would throw away EVERY speculation.
  assert.ok(diffRatio('نحب نحجز موعد', 'نحب نحجز موعد عند طبيب') > 0.25);
  assert.equal(materialDrift('نحب نحجز موعد', 'نحب نحجز موعد عند طبيب'), false, 'the caller just kept talking');

  // A rewrite of the opening IS a contradiction: we were about to answer a
  // sentence the caller never said.
  assert.equal(materialDrift('نحب نحجز موعد', 'نحب نمشي للعيادة اليوم'), true);
  // …and so is a guess that covers only a fragment of what they finally said.
  assert.equal(materialDrift('نحب نحجز موعد', 'نحب نحجز موعد… لا سامحني، نحب نعرف الأسعار متاع الكشفية'), true);
  assert.equal(materialDrift('', 'anything'), false, 'an empty guess is not a drift, it is a no-op');

  assert.equal(sharedPrefixLength('نحب نحجز', 'نحب نحجز موعد'), 8);
  assert.equal(sharedPrefixLength('abc', 'xyz'), 0);
});

// ════════════════════════════════════════════════════════════════════════════
// 4. BARGE-IN
// ════════════════════════════════════════════════════════════════════════════

test('BARGE-IN: the caller speaks over us and the wire goes quiet inside the 150 ms budget', async (t) => {
  const s = await setup({ llm: fakeLlm([says('عندنا مواعيد برشة هالأسبوع كامل، نجم نعطيك التفاصيل.')]), tts: fakeTts({ chunkMs: 600 }) });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  await s.loop.settled();

  s.stt.final('شنوة المواعيد؟', true);
  await waitFor(() => s.loop.stats().outQueue > 5, 'a queue of speech to interrupt');
  const queued = s.loop.stats().outQueue;
  assert.ok(queued >= 5, `expected a full queue, got ${queued}`);

  const t0 = Date.now();
  // TWO REAL WORDS (V8-D3 §1): RMS alone never yields any more, and neither
  // does a one-word interim — the ears have to confirm a person.
  s.stt.interim('سامحني، لحظة');
  const elapsed = Date.now() - t0;

  assert.equal(s.loop.stats().outQueue, 0, 'nothing queued survives the interruption');
  assert.equal(s.loop.stats().codec.pendingSamples, 0, 'not even the half-encoded frame');
  assert.ok(elapsed < 150, `the kill chain took ${elapsed}ms — the budget is 150`);
  assert.ok(s.loop.stats().lastFlushMs < 150);
  assert.equal(s.loop.stats().bargeIns, 1);
  assert.ok(s.loop.stats().bargeFramesDropped >= queued - 1);
});

test('BARGE-IN keeps the LLM context: what we already said stays in the history', async (t) => {
  const s = await setup({
    config: { voiceCascadeEotMs: 20 },
    llm: fakeLlm([
      async function* ({ signal }) {
        yield { type: 'text', delta: 'العيادة تحل من التاسعة. ' };
        await new Promise((_res, rej) => {
          const bail = () => rej(signal.reason || new Error('aborted'));
          if (signal.aborted) return bail();
          signal.addEventListener('abort', bail, { once: true });
        });
      },
      says('أكيد.'),
    ]),
    tts: fakeTts({ chunkMs: 400 }),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.stt.final('وقتاش تحلو؟', true);
  await waitFor(() => s.tts.calls.length >= 2, 'the first clause');
  s.stt.interim('طيب');
  s.stt.final('طيب و نهار السبت؟', true);
  await s.loop.settled();

  const second = s.llm.turns[1].messages;
  assert.ok(
    second.some((m) => m.role === 'assistant' && m.text.includes('التاسعة')),
    'the interrupted half-sentence is still context — the next turn must not repeat it'
  );
  assert.ok(second.some((m) => m.role === 'user' && m.text === 'وقتاش تحلو؟'));
  assert.equal(second.at(-1).text, 'طيب و نهار السبت؟');
});

// ════════════════════════════════════════════════════════════════════════════
// 5. THE FILLER
// ════════════════════════════════════════════════════════════════════════════

test('FILLER: a brain slower than 700 ms is covered by a spoken clip, not by dead air', async (t) => {
  const s = await setup({
    config: { voiceCascadeFillerTtftMs: 20 },
    llm: fakeLlm([
      async function* () {
        await sleep(120); // a slow first token — the exact failure V6.1 §3 names
        yield { type: 'text', delta: 'عندي بلاصة الخميس.' };
        yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
      },
    ]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  // Let the greeting finish first: the filler must never talk over our own
  // tail, which is why it checks the wire before it plays.
  await s.loop.settled();
  await waitFor(() => s.loop.stats().outQueue === 0, 'the greeting to drain');
  const afterGreeting = s.tts.calls.length;

  s.stt.final('وقتاش فمة بلاصة؟', true);
  await s.loop.settled();

  const said = s.tts.calls.slice(afterGreeting).map((c) => c.text);
  assert.deepEqual(said, [normalizeSpoken(buildFillerText('ar')), 'عندي بلاصة الخميس.']);
  assert.equal(s.loop.stats().fillersPlayed, 1);
});

test('a fast brain is never talked over by its own filler', async (t) => {
  const s = await setup({ config: { voiceCascadeFillerTtftMs: 400 }, llm: fakeLlm([says('توة نشوف.')]) });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  s.stt.final('وقتاش تحلو؟', true);
  await s.loop.settled();
  await sleep(60);
  assert.equal(s.loop.stats().fillersPlayed, 0);
  assert.deepEqual(s.tts.calls.slice(1).map((c) => c.text), ['توة نشوف.']);
});

test('THE TAPE: the greeting and the filler are synthesized once per tenant, then replayed', async (t) => {
  const app = makeTestApp();
  clearGreetingCache();
  const first = await setup({ app, clearCache: false, llm: fakeLlm([says('باهي.')]) });
  await first.loop.start();
  await first.loop.settled();
  assert.equal(first.loop.stats().greetingSource, 'live', 'somebody has to pay for it once');
  first.loop.stop('test');
  first.unsub();
  await waitFor(() => greetingCacheStats().size >= 1, 'the greeting to be taped');

  const second = await setup({ app, clearCache: false, llm: fakeLlm([says('باهي.')]) });
  t.after(() => {
    second.unsub();
    second.loop.stop('test');
  });
  await second.loop.start();
  assert.equal(second.loop.stats().greetingSource, 'cache');
  assert.equal(second.tts.calls.length, 0, 'the second caller costs the vendor nothing to be greeted');
  assert.ok(second.loop.stats().tapePending > 0, 'the frames are in the paced queue already');
  // The tape key carries the CODEC (Opus frames on a G.711 leg are noise) and
  // the voice, and the filler lives beside it under its own key.
  const keys = greetingCacheStats().keys;
  assert.ok(keys.some((k) => k.includes(':opus:')), keys.join(','));
});

// ════════════════════════════════════════════════════════════════════════════
// 6. THE BOOKING GATE, through the function-calling path
// ════════════════════════════════════════════════════════════════════════════

test('THE GATE: stage → recap → the caller says yes → confirm writes exactly one appointment', async (t) => {
  // The steps are per REQUEST, not per caller turn: a turn that calls a tool
  // re-enters the chain with the result appended, exactly as the real one does.
  const s = await setup({
    // V8-D2 §1: a STAGED booking is a data-capture state, so the vendor's own
    // end-of-turn is deliberately overruled by the patient endpointer — the
    // caller answering a recap may still be adding "…but make it ten". Kept
    // short here so the test measures the gate rather than the clock.
    config: { voiceCascadeEotPatientMs: 25 },
    llm: fakeLlm([
      // 1. the filler, then the stage
      async function* () {
        yield { type: 'text', delta: 'ثانية برك نشوفلك. ' };
        yield {
          type: 'toolCall',
          call: {
            id: 'c1',
            name: 'stage_booking',
            args: { specialty: 'قلب', datetimeText: 'الخميس 10', name: 'محمد الهادي', contact: '21650123456' },
          },
        };
        yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
      },
      // 2. read the recap the tool handed back, word for word
      async function* ({ messages }) {
        yield { type: 'text', delta: `${messages.at(-1).result.recap} صحيح؟ ` };
        yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
      },
      // 3. the caller said yes ⇒ confirm
      async function* () {
        yield { type: 'toolCall', call: { id: 'c2', name: 'confirm_booking', args: {} } };
        yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
      },
      // 4. say the reference back
      async function* ({ messages }) {
        yield { type: 'text', delta: `مثبت، رقم الموعد ${messages.at(-1).result.ref}. ` };
        yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
      },
    ]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.stt.final('نحب نحجز موعد قلب نهار الخميس، اسمي محمد الهادي', true);
  await s.loop.settled();
  assert.equal((await s.app.store.listAppointments({ clinicId: CLINIC })).length, 0, 'staging writes NOTHING');
  const recapSaid = s.tts.calls.map((c) => c.text).join(' ');
  assert.ok(recapSaid.includes('محمد الهادي'), 'the recap was read out loud');
  assert.ok(!/\d{2}\/\d{2}\/\d{4}/.test(recapSaid), 'no dd/mm/yyyy ever reaches a mouth');

  s.stt.final('نعم صحيح', true);
  await waitFor(() => s.loop.stats().staged === false, 'the patient endpointer to close the recap answer');
  await s.loop.settled();

  const rows = await s.app.store.listAppointments({ clinicId: CLINIC });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, 'call');
  assert.equal(rows[0].patientWaId, WA);
  assert.equal(s.loop.outcome().booked, rows[0].ref);
  assert.equal(ofType(s.events, 'appointment.created').length, 1);
});

test('REGRESSION: stage + confirm in ONE model turn books NOTHING (CX-260803-001)', async (t) => {
  const s = await setup({
    llm: fakeLlm([
      // ONE batch carrying both calls — the shape that wrote an appointment
      // nobody had heard about.
      async function* () {
        yield {
          type: 'toolCall',
          call: {
            id: 'a',
            name: 'stage_booking',
            args: { specialty: 'قلب', datetimeText: 'الخميس 10', name: 'محمد', contact: '21650123456' },
          },
        };
        yield { type: 'toolCall', call: { id: 'b', name: 'confirm_booking', args: {} } };
        yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
      },
      async function* () {
        yield { type: 'text', delta: 'سامحني، نعاود.' };
        yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
      },
    ]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.stt.final('احجزلي توة', true);
  await s.loop.settled();

  const results = s.llm.turns.at(-1).messages.filter((m) => m.role === 'tool');
  const confirm = results.find((m) => m.name === 'confirm_booking');
  assert.equal(confirm.result.ok, false);
  assert.equal(confirm.result.error, 'read_recap_first', 'one batch means the caller heard nothing');
  assert.equal((await s.app.store.listAppointments({ clinicId: CLINIC })).length, 0);
  assert.equal(s.loop.outcome().booked, null);
});

test('a facilitator cascade books nothing but captures the lead', async (t) => {
  const s = await setup({
    tenantId: 'medtour-tripoli-sousse',
    llm: fakeLlm([
      async function* ({ messages }) {
        if (messages.some((m) => m.role === 'tool')) {
          yield { type: 'text', delta: 'الفريق باش يرجعلك بعرض اليوم.' };
          yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
          return;
        }
        yield {
          type: 'toolCall',
          call: { id: 'l1', name: 'capture_lead', args: { procedure: 'زراعة أسنان', originCity: 'طرابلس' } },
        };
        yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
      },
    ]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  assert.ok(s.llm !== null);

  s.stt.final('نبي نعمل زراعة أسنان', true);
  await s.loop.settled();

  const [hot] = ofType(s.events, 'lead.hot');
  assert.ok(hot, 'the agency owner is pinged on a qualified call');
  assert.equal(s.loop.outcome().lead.procedure, 'زراعة أسنان');
  const leads = await s.app.store.leads.list('medtour-tripoli-sousse', {});
  assert.equal(leads.length, 1);
  // The system prompt for an agency states the law in its own words.
  assert.ok(s.llm.turns[0].system.includes('THE AGENCY BOOKS NOTHING'));
});

// ════════════════════════════════════════════════════════════════════════════
// 7. THE HANG-UP, DTMF, AND THE DEGRADES
// ════════════════════════════════════════════════════════════════════════════

test('END_CALL: the farewell plays in full, THEN the line drops', async (t) => {
  const ended = [];
  const s = await setup({
    ended,
    config: { voiceCallHangupGraceMs: 3000 },
    llm: fakeLlm([
      async function* ({ messages }) {
        if (messages.some((m) => m.role === 'tool')) {
          yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
          return;
        }
        yield { type: 'text', delta: 'يعطيك الصحة، بالسلامة. ' };
        yield { type: 'toolCall', call: { id: 'e', name: 'end_call', args: {} } };
        yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
      },
    ]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.stt.final('شكرا، بالسلامة', true);
  await s.loop.settled();
  assert.equal(s.loop.stats().endRequested, true);
  assert.equal(s.loop.stats().hangupArmed, true);
  assert.equal(ended.length, 0, 'the goodbye has not finished playing yet');

  await waitFor(() => ended.length === 1, 'the agent to hang up after the farewell drained', 4000);
  assert.equal(ended[0].reason, 'completed');
  assert.equal(s.loop.stats().endedBy, 'agent');
  // The farewell really did reach the wire before the line dropped.
  assert.ok(s.media.sent.length > 0);
});

test('"wait — one more thing!": a caller who speaks after the goodbye cancels the hang-up', async (t) => {
  const ended = [];
  const s = await setup({
    ended,
    config: { voiceCallHangupGraceMs: 3000 },
    llm: fakeLlm([
      async function* ({ messages }) {
        if (messages.some((m) => m.role === 'tool')) {
          yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
          return;
        }
        yield { type: 'text', delta: 'بالسلامة. ' };
        yield { type: 'toolCall', call: { id: 'e', name: 'end_call', args: {} } };
        yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
      },
      says('أكيد، قولّي.'),
    ]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  s.stt.final('شكرا، بالسلامة', true);
  await s.loop.settled();
  assert.equal(s.loop.stats().endRequested, true);

  s.stt.interim('استنى شويّة');
  assert.equal(s.loop.stats().endRequested, false, 'a goodbye is a suggestion until the line actually drops');
  assert.equal(s.loop.stats().hangupArmed, false);
  await sleep(80);
  assert.equal(ended.length, 0);
});

test('DTMF on a noisy line: 1 opens the booking flow, 2 reaches a human — once per press', async (t) => {
  const s = await setup({ llm: fakeLlm([says('باهي.')]) });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  const press = (event, end = false) => ({
    header: { payloadType: 101 },
    payload: Buffer.from([event, end ? 0x8a : 0x0a, 0x00, 0xa0]),
  });
  s.loop.onRtp(press(1));
  s.loop.onRtp(press(1));
  s.loop.onRtp(press(1));
  await s.loop.settled();
  assert.equal(s.llm.turns.length, 1, 'a held key is ONE press');
  // A keypress becomes a sentence the caller could have said, in THEIR
  // language: bracketed English meta-text made an LLM answer in English and
  // was meaningless to the scripted engine, which may own this call.
  assert.equal(s.llm.turns[0].messages.at(-1).text, 'نحب نحجز موعد');
  assert.ok(!/\[KEYPAD\]|pressed/.test(s.llm.turns[0].messages.at(-1).text));

  s.loop.onRtp(press(1, true));
  s.loop.onRtp(press(2));
  await s.loop.settled();
  const [handoff] = ofType(s.events, 'handoff.requested');
  assert.ok(handoff, 'the keypad shortcut goes through the SAME tool as the spoken one');
  assert.equal(handoff.handoff.reason, 'dtmf_2');
  assert.equal(s.loop.outcome().handoff, true);
});

test('no ears ⇒ brain_lost, and the service (not this loop) hangs up', async (t) => {
  const ended = [];
  const stt = fakeStt();
  stt.ready = Promise.resolve(null);
  const s = await setup({ stt, ended });
  t.after(() => s.unsub());

  await assert.rejects(s.loop.start(), /no STT provider/);
  s.stt.emit('lost', new Error('nothing left'));
  assert.equal(s.loop.outcome().reason, 'brain_lost');
  assert.equal(ended.length, 1);
});

test('no mouth ⇒ start() refuses loudly: the cascade has no native voice to fall back to', async (t) => {
  const s = await setup({ tts: { mode: 'native', provider: 'gemini', voice: null, synthesize: null } });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await assert.rejects(s.loop.start(), /needs a TTS provider/);
});

test('a TTS provider that dies mid-call degrades exactly like a dead brain', async (t) => {
  const ended = [];
  const s = await setup({ ended, tts: fakeTts({ failAt: 2 }), llm: fakeLlm([says('عندنا مواعيد.')]) });
  t.after(() => s.unsub());
  await s.loop.start();
  s.stt.final('وقتاش؟', true);
  await s.loop.settled();

  assert.equal(ended.length, 1);
  assert.equal(ended[0].reason, 'tts_lost');
  assert.equal(ended[0].voice.degradedMidCall, true);
  assert.equal(s.tts.degraded, true, 'the chain is told, so the cross-call breaker can count it');
});

test('stop() is idempotent, fires onEnd once, and leaves no timer behind', async (t) => {
  const ended = [];
  const s = await setup({ ended, llm: fakeLlm([says('أهلا.')]) });
  t.after(() => s.unsub());
  await s.loop.start();
  s.stt.final('عسلامة، ثمة حد؟', true);
  await s.loop.settled();
  assert.equal(s.loop.stats().pacing, true);

  const first = s.loop.stop('call_ended');
  const second = s.loop.stop('something_else');
  assert.equal(ended.length, 1);
  assert.equal(first.reason, 'call_ended');
  assert.equal(second.reason, 'call_ended', 'the first reason is the real one');
  assert.equal(s.loop.stats().pacing, false);
  assert.equal(s.loop.stats().outQueue, 0);
  assert.equal(s.stt.closed, 1);

  // A stopped loop goes inert rather than half-working.
  s.stt.final('ثمة حد؟', true);
  await s.loop.settled();
  assert.equal(s.llm.turns.length, 1, 'no new turn after the call ended');
  s.loop.onRtp({ header: { payloadType: 111 }, payload: Buffer.from([1, 2, 3]) });
});

test('V6.2 two-strike: unclear once asks warmly, twice offers the chat thread', async (t) => {
  const s = await setup({ config: { voiceCascadeEotMs: 10 }, llm: fakeLlm([says('باهي.')]) });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  const afterGreeting = s.tts.calls.length;

  s.stt.final('.', true); // a final with nothing speakable in it
  await s.loop.settled();
  s.stt.final('…', true);
  await s.loop.settled();

  const said = s.tts.calls.slice(afterGreeting).map((c) => c.text);
  assert.equal(said.length, 2);
  assert.match(said[0], /سامحني/, 'once, warmly, in their dialect');
  assert.match(said[1], /الواتساب/, 'twice ⇒ change the medium instead of asking a third time');
  assert.equal(s.llm.turns.length, 0, 'noise never becomes a turn');
});

// ════════════════════════════════════════════════════════════════════════════
// 9. V7-P2.1 — THE DOUBLE REPLY
//
// The founder's live test: "two replies — the first finishes, then a second
// dictates another reply". The instrumented call named both writers:
//
//   [rtp-out] src=spec utt=4 frames=24 (480ms)          ← a GUESS on the wire
//   [rtp-out] killed 50 queued frames (barge_in): {"spec":50}
//
// …and then the final's turn answered the same utterance a second time. Plus a
// second, quieter writer with no model behind it at all: Deepgram's UtteranceEnd
// flush frame arriving after speech_final, finding the utterance already
// consumed, and speaking the "sorry, it is noisy" line over a good answer.
//
// The laws below are what stop both, and every one of them is a number in
// stats() so the next field call is arguable rather than remembered.
// ════════════════════════════════════════════════════════════════════════════

/** Everything queued has reached the fake media, and nothing is in flight. */
async function drain(s) {
  await s.loop.settled();
  await waitFor(() => s.loop.stats().outQueue === 0, 'the wire to drain');
  await sleep(25);
  await s.loop.settled();
}

/** One reply from `fakeTts({chunkMs:120})` is 120 ms of audio = 6 RTP frames. */
const FRAMES_PER_REPLY = 6;

/**
 * A mouth that SPEAKS and then waits — and rejects with the abort reason when
 * it is killed. That is exactly what a real provider does through
 * brain/tts/wire.js, and it is the shape the process died on: frames already on
 * the wire, a synthesis still open, and a barge-in arriving from the RTP thread.
 */
function stallingTts({ chunkMs = 400, stallCall = 2 } = {}) {
  const chain = fakeTts({ chunkMs });
  const plain = chain.synthesize;
  let n = 0;
  chain.synthesize = async function* stalling(text, opts = {}) {
    n += 1;
    if (n !== stallCall) {
      yield* plain(text, opts);
      return;
    }
    chain.calls.push({ text, lang: opts.lang, n });
    chain.chars += String(text || '').length;
    yield tone24k(chunkMs);
    await new Promise((_res, rej) => {
      const bail = () => rej(opts.signal?.reason || new Error('aborted'));
      if (opts.signal?.aborted) return bail();
      opts.signal?.addEventListener('abort', bail, { once: true });
    });
  };
  return chain;
}

/**
 * `n` frames of LOUD caller audio pushed through the real inbound codec path —
 * the only way to exercise noteEnergy(), which is deliberately reachable from
 * nowhere but onRtp. One frame is 20 ms, so 12 frames is the 240 ms sustain.
 */
function feedLoud(s, frames = 14) {
  const bridge = createCodecBridge({ sdpAnswer: OPUS_SDP, sdpOffer: OPUS_SDP, logger: () => {} });
  const payloads = bridge.encodeOut(tone24k(frames * 20), 24000);
  for (const payload of payloads) s.loop.onRtp({ header: { payloadType: 111 }, payload });
  bridge.close();
  return payloads.length;
}

test('GOLDEN (V7-P2.1): a guess and the final that confirms it are ONE reply on the wire', async (t) => {
  // The exact shape of the founder's bug: interim-stable starts the brain, the
  // mouth is slow enough to still be synthesizing when the final lands, and the
  // final agrees with the guess.
  const s = await setup({
    config: { voiceCascadeEotMs: 20 },
    llm: fakeLlm([says('باهي، نشوفلك وقت.')]),
    tts: fakeTts({ chunkMs: 120, slowMs: 40 }),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  await drain(s);
  const before = { ...s.loop.stats().outBySrc };
  assert.equal(before.greeting, FRAMES_PER_REPLY, 'the greeting is tagged, and it is all that has played');

  s.stt.interim('نحب نحجز موعد');
  s.stt.interim('نحب نحجز موعد عند');
  assert.equal(s.llm.turns.length, 1, 'the brain started early — that is the whole point of speculation');
  assert.equal(s.loop.stats().turnSpeculative, true);

  // PREPARE-ONLY. The model is writing and the mouth is synthesizing, and NOT
  // ONE FRAME may reach the wire while the sentence is still a guess.
  await sleep(60);
  await s.loop.settled();
  assert.equal(s.loop.stats().outQueue, 0, 'a guess does not queue audio');
  assert.equal(s.loop.stats().outBySrc.spec, 0, "no frame is ever tagged 'spec' again — that tag is the bug");
  assert.ok(s.loop.stats().specHeld > 0 || s.tts.calls.length > 1, 'it DID pre-warm — held, not discarded');

  s.stt.final('نحب نحجز موعد عند طبيب', true);
  await drain(s);

  const st = s.loop.stats();
  assert.equal(s.llm.turns.length, 1, 'the guess IS the answer — the final never starts a second generation');
  assert.equal(st.outBySrc.spec, 0);
  assert.equal(
    st.outBySrc.turn - (before.turn || 0),
    FRAMES_PER_REPLY,
    'EXACTLY ONE reply reached the media — the held guess, flushed on promotion'
  );
  assert.ok(st.specFramesFlushed >= FRAMES_PER_REPLY, 'and those frames came out of the held buffer');
  assert.equal(st.staleFramesDropped, 0, 'nothing raced the writer on the happy path');
  assert.deepEqual(st.ledger, [{ utt: 1, answered: true, generations: 1, revokedBy: null, refused: 0 }]);
  assert.deepEqual(s.tts.calls.slice(1).map((c) => c.text), ['باهي، نشوفلك وقت.']);
  // The transcript is what the clinic can prove it SAID: one agent line, once.
  const agentLines = s.loop.transcript().filter((e) => e.who === 'agent');
  assert.equal(agentLines.filter((e) => e.text.includes('نشوفلك')).length, 1);
});

test('GOLDEN variant: the final DRIFTS — the answer is un-said and ONE new reply replaces it', async (t) => {
  const s = await setup({
    // The first answer names a DAY, so the next caller turn is endpointed
    // patiently (V8-D2 §1) — kept short here so the test measures the ledger.
    config: { voiceCascadeEotMs: 20, voiceCascadeEotPatientMs: 25 },
    llm: fakeLlm([says('عندي بلاصة نهار الخميس.'), says('الكشفية من خمسين دينار.')]),
    tts: fakeTts({ chunkMs: 600 }), // long enough that there is really audio to kill
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  await drain(s);

  s.stt.interim('نحب نحجز موعد');
  s.stt.interim('نحب نحجز موعد عند');
  // A first final CONFIRMS the guess: it is promoted and its audio hits the wire.
  s.stt.final('نحب نحجز موعد عند طبيب', false);
  await waitFor(() => s.loop.stats().outQueue > 0, 'the promoted guess to reach the queue');
  assert.equal(s.loop.stats().ledger[0].answered, true, 'this utterance now has its one reply');

  // …and then the caller corrects themselves. Not an edge case on a phone line.
  s.stt.final('لا سامحني، نحب نعرف الأسعار متاع الكشفية', true);
  assert.equal(s.loop.stats().outQueue, 0, 'the revoked answer dies under the SAME generation bump');
  await drain(s);

  const st = s.loop.stats();
  assert.equal(s.llm.turns.length, 2, 'the drift restart is the ONE legitimate second generation');
  assert.deepEqual(st.ledger, [{ utt: 1, answered: true, generations: 2, revokedBy: 'drift', refused: 0 }]);
  assert.equal(st.outBySrc.spec, 0);
  assert.deepEqual(
    s.tts.calls.slice(1).map((c) => c.text),
    ['عندي بلاصة نهار الخميس.', 'الكشفية من خمسين دينار.'],
    'two sentences were synthesized, but only ever one of them was the answer'
  );
});

test('A GUESS THAT MISSES IS NEVER HEARD: zero frames, no transcript row, no assistant history', async (t) => {
  const s = await setup({
    config: { voiceCascadeEotMs: 20 },
    // A fast guess that finishes before the caller does — then the caller says
    // something else entirely.
    llm: fakeLlm([says('عندي بلاصة نهار الخميس.'), says('العيادة مسكرة نهار الأحد.')]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  await drain(s);
  const before = { ...s.loop.stats().outBySrc };

  s.stt.interim('نحب نحجز موعد');
  s.stt.interim('نحب نحجز موعد عند');
  await s.loop.settled();
  assert.equal(s.loop.stats().specHeld > 0, true, 'the whole guessed reply is held, unspoken');
  assert.equal(s.loop.stats().outQueue, 0);

  s.stt.final('نحب نعرف إذا العيادة تخدم نهار الأحد ولا لا', true);
  await drain(s);

  const st = s.loop.stats();
  assert.equal(s.llm.turns.length, 2);
  assert.ok(st.specChunksDiscarded > 0, 'the wrong answer was thrown away unheard — it cost the caller 0 ms');
  assert.equal(st.outBySrc.spec, 0);
  assert.equal(st.outBySrc.turn - (before.turn || 0), FRAMES_PER_REPLY, 'ONE reply, and it is the right one');
  // Nothing that was never said may appear anywhere the clinic could quote it.
  const script = s.loop.transcript();
  assert.equal(script.some((e) => e.text.includes('الخميس')), false, 'a guess that missed is not in the transcript');
  assert.equal(
    s.llm.turns[1].messages.some((m) => m.role === 'assistant' && m.text.includes('الخميس')),
    false,
    'nor in the context window, where it would teach the model it had already answered'
  );
});

test('THE LEDGER: an utterance that has been answered can never be answered again', async (t) => {
  const s = await setup({ config: { voiceCascadeEotMs: 30 }, llm: fakeLlm([says('باهي، نشوفلك وقت.')]) });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  await drain(s);

  s.stt.interim('نحب نحجز موعد');
  s.stt.interim('نحب نحجز موعد عند');
  s.stt.final('نحب نحجز موعد عند طبيب', false); // promotes: the reply is on the wire
  await s.loop.settled();
  assert.equal(s.loop.stats().ledger[0].answered, true);

  // The caller keeps talking, the ears keep sending interims for the SAME
  // utterance, and the stable-prefix test is satisfied all over again. Without
  // the ledger this starts a second generation for a sentence we have already
  // answered — which is precisely the double reply.
  s.stt.interim('نحب نحجز موعد عند طبيب القلب');
  s.stt.interim('نحب نحجز موعد عند طبيب القلب من فضلك');
  await s.loop.settled();

  const st = s.loop.stats();
  assert.equal(st.ledgerRefused, 1, 'the ledger refused it, out loud and counted');
  assert.equal(st.ledger[0].refused, 1);
  assert.equal(s.llm.turns.length, 1, 'one utterance, one generation, one reply');
  assert.deepEqual(s.tts.calls.slice(1).map((c) => c.text), ['باهي، نشوفلك وقت.']);
});

test('ONE TURN-END: the UtteranceEnd flush that lands after speech_final never speaks', async (t) => {
  // The second writer, and the one with no model behind it: Deepgram sends
  // `speech_final` with the words and `UtteranceEnd` on a LATER frame. The
  // second one used to find the utterance consumed and answer the caller with
  // "sorry, it is noisy" — on top of a perfectly good reply.
  const s = await setup({ llm: fakeLlm([says('العيادة تحل من التاسعة.')]) });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  await drain(s);
  const afterGreeting = s.tts.calls.length;

  s.stt.final('وقتاش تحلو العيادة؟', true);
  await s.loop.settled();
  s.stt.final('', true); // the flush frame, milliseconds later
  await s.loop.settled();

  assert.deepEqual(
    s.tts.calls.slice(afterGreeting).map((c) => c.text),
    ['العيادة تحل من التاسعة.'],
    'ONE reply — the flush frame is the same turn-end, not a second one'
  );
  assert.equal(s.loop.stats().turnEndsDebounced, 1);
  assert.equal(s.loop.stats().unclearStrikes, 0, 'and the caller was never accused of mumbling');
});

test('the turn-end debounce never eats a REAL second turn', async (t) => {
  const s = await setup({ llm: fakeLlm([says('من التاسعة.'), says('نهار السبت من التاسعة للوسط.')]) });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  await drain(s);
  const afterGreeting = s.tts.calls.length;

  // Two real sentences, back to back inside the debounce window. New words are
  // a new turn-end however fast they arrive; only an empty repeat is a duplicate.
  s.stt.final('وقتاش تحلو؟', true);
  await s.loop.settled();
  s.stt.final('و نهار السبت؟', true);
  await s.loop.settled();

  assert.equal(s.llm.turns.length, 2);
  assert.equal(s.loop.stats().turnEndsDebounced, 0);
  assert.deepEqual(s.tts.calls.slice(afterGreeting).map((c) => c.text), [
    'من التاسعة.',
    'نهار السبت من التاسعة للوسط.',
  ]);
});

test('CRASH REGRESSION: a barge-in mid-synthesis leaves ZERO unhandled rejections (V8: word-gated)', async (t) => {
  // The founder's instrumented call did not just double-answer, it DIED:
  //   Error: barge_in  at killSpeech ← noteEnergy ← onRtp ← werift
  //   → uncaughtException (fromPromise)
  // Nothing may throw out of the RTP path, and an unhandled rejection is a
  // throw with a delay. The assertion is on the process, not on the loop.
  //
  // MUTATED AT V8-D3 §1: the loud audio no longer kills anything by itself —
  // it is EVIDENCE. The kill happens when the ears confirm two real words, and
  // it has to happen in exactly the same place (mid-synthesis, frames on the
  // wire) for this regression to still be the regression it was written for.
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const s = await setup({
    llm: fakeLlm([says('عندنا مواعيد برشة هالأسبوع.'), says('باهي.')]),
    // Call 1 is the greeting; call 2 is the reply that gets interrupted.
    tts: stallingTts({ chunkMs: 400, stallCall: 2 }),
  });
  t.after(() => {
    process.off('unhandledRejection', onUnhandled);
    s.unsub();
    s.loop.stop('test');
  });

  await s.loop.start();
  await drain(s);
  s.stt.final('شنوة المواعيد؟', true);
  await waitFor(() => s.loop.stats().outQueue > 3, 'our own speech on the wire');

  feedLoud(s, 14); // 280 ms of the caller talking over us
  assert.equal(s.loop.stats().energyHits, 1, 'the energy episode was recorded');
  assert.equal(s.loop.stats().bargeIns, 0, 'RMS ALONE NEVER YIELDS — that is the V8 law');
  assert.ok(s.loop.stats().outQueue > 0, 'the agent is still speaking, because nobody has said anything yet');

  // …and now the ears confirm it: two real words, while the audio is on the
  // wire and the mouth is still streaming. Same crash site, new trigger.
  s.stt.interim('سامحني، لحظة');
  assert.equal(s.loop.stats().bargeIns, 1);
  assert.equal(s.loop.stats().energyBargeIns, 1, 'the energy episode corroborated it');
  assert.equal(s.loop.stats().outQueue, 0, 'and the wire went quiet');

  await s.loop.settled();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(unhandled.map((e) => e?.message || String(e)), [], 'a barge-in must never end the process');
  assert.equal(s.loop.stats().energyBargeSilent, 0, 'and it did not fire into silence');

  // The call is still alive and still answers — the point of not crashing.
  s.stt.final('طيب، شكرا.', true);
  await s.loop.settled();
  assert.equal(s.llm.turns.length, 2);
});

test('THE ENERGY GATE: a loud caller while the wire is SILENT is not an interruption', async (t) => {
  const s = await setup({ llm: fakeLlm([says('باهي.')]) });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  await drain(s); // nothing of ours is queued, taped or being synthesized

  feedLoud(s, 40); // 800 ms of the caller simply talking
  const st = s.loop.stats();
  assert.equal(st.energyBargeIns, 0, 'killing silence is noise in the one counter that matters');
  assert.equal(st.bargeIns, 0);
  assert.equal(st.energyBargeSilent, 0, 'and it is not even counted as a suppressed one — it never fired');
});

test('EARS ONLY: a liveEars session that answers cannot put one frame on the wire', async (t) => {
  // Suspect #3 from the double-reply hunt. The Live session the cascade uses as
  // ears is asked to stay silent, and a system instruction is a request: the
  // server answers anyway. The guarantee has to be structural.
  const live = fakeLiveClient();
  const s = await setup({
    config: { geminiApiKey: 'g', geminiLiveModel: 'm' },
    llm: fakeLlm([says('أهلا بيك.')]),
    stt: null,
    sttFactory: (opts) => createSttChain({ ...opts, liveFactory: () => live }),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  await drain(s);
  const before = { ...s.loop.stats().outBySrc };

  // The model talks. A lot. In both modalities.
  for (let i = 0; i < 25; i += 1) {
    live.emit('audio', new Int16Array(320));
    live.emit('text', 'أهلا، نجم نعاونك؟');
  }
  await s.loop.settled();
  await sleep(30);

  const st = s.loop.stats();
  assert.deepEqual(st.outBySrc, before, 'not one frame, from any source, is attributable to the ears');
  assert.equal(st.outQueue, 0);
  assert.equal(s.llm.turns.length, 0, 'and it never became a turn either');
  assert.equal(st.stt.leg.swallowed, 50, 'every model output was counted and dropped');
  assert.equal(st.stt.leg.finals, 0);
});

test('EARS ONLY: the ears lend the orchestrator BOTH echo predicates, and use them', async (t) => {
  // The echo drop itself is asserted at the adapter, where the two predicates
  // the orchestrator lends can be held still (voicecall.cascade.chains.test.js).
  // What matters HERE is that the orchestrator really lends them: an ears leg
  // built without them cannot tell the agent's voice from a caller's.
  const live = fakeLiveClient();
  let lent = null;
  const s = await setup({
    config: { geminiApiKey: 'g', geminiLiveModel: 'm' },
    llm: fakeLlm([says('العيادة تحل من التاسعة للسادسة.')]),
    stt: null,
    sttFactory: (opts) => {
      lent = opts;
      return createSttChain({ ...opts, liveFactory: () => live });
    },
    tts: fakeTts({ chunkMs: 600 }),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  assert.equal(typeof lent.agentSpeaking, 'function', 'only the orchestrator knows if we are talking');
  assert.equal(typeof lent.agentSaid, 'function', 'only the orchestrator knows what we said');

  live.emit('inputTranscription', 'وقتاش تحلو؟');
  live.emit('turnComplete', true);
  await waitFor(() => s.loop.stats().outQueue > 0, 'our own answer on the wire');
  assert.equal(lent.agentSpeaking(), true);
  assert.match(lent.agentSaid(), /العيادة تحل/, 'the exact sentence a speakerphone could bleed back');
});
