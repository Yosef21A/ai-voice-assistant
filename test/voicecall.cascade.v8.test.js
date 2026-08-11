// V8 — D2 (LATENCY) and D3 (INTERRUPTION-PROOF), with fake providers only.
//
// The founder sells in person on Monday. These are the two things a live demo
// call actually fails on, and every test here is one sentence of the war plan:
//
//   D2 — the wait. State-dependent endpointing (a caller pauses mid-digit and
//        must not be cut off), a pre-warm that pays the cold start before the
//        caller is listening, a clamp that stops routing turns through a
//        provider that has gone slow, and a spoken line before EVERY lookup so
//        a tool call is never silence.
//   D3 — the interruptions. RMS alone never yields; «أيوا» never stops the
//        agent; a one-word fragment is not a turn; and a caller who goes silent
//        gets one warm check-in and then a proper goodbye instead of an open
//        line that bills for nothing.
//
// Same harness law as the rest of the voice suite: the REAL composed store, bus
// and mock sender, with only the vendor legs faked. Nothing here opens a socket
// and no clock is real except the ones the code itself measures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers/client.js';
import { createCascadeLoop } from '../src/voice-call/brain-cascade/orchestrator.js';
import { createLlmChain, resetLlmBreakers, noteLlmTtft, llmTtftClamp, TTFT_WINDOW } from '../src/voice-call/brain-cascade/llm/index.js';
import { createSttChain } from '../src/voice-call/brain-cascade/stt/index.js';
import { createCodecBridge } from '../src/voice-call/brain/codec.js';
import { clearGreetingCache, greetingCacheStats } from '../src/voice-call/brain/greetingCache.js';
import { normalizeSpoken } from '../src/voice-call/brain/tts/index.js';
import {
  buildFillerText,
  buildToolStartText,
  buildSilenceCheckText,
  buildSilenceByeText,
} from '../src/voice-call/brain-cascade/prompt.js';
import {
  countWords,
  isBackchannelOnly,
  detectCaptureAsk,
  captureFromTool,
  isFarewellFragment,
  isDigitFragment,
} from '../src/voice-call/brain-cascade/turnTaking.js';
// Aliased: `t` is node:test's TestContext in every case below.
import { t as localized } from '../src/engine/responses.js';

const CLINIC = 'el-amen-sousse';
const WA = '218911234567';
const NOW = () => new Date(2026, 7, 5, 10, 0, 0); // Wednesday, clinic open

const OPUS_SDP =
  'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 101\r\n' +
  'a=rtpmap:111 opus/48000/2\r\na=rtpmap:101 telephone-event/8000\r\n';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what = 'condition', deadlineMs = 4000) {
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

const says = (...parts) =>
  async function* step() {
    for (const p of parts) yield { type: 'text', delta: p };
    yield { type: 'done', usage: { tokensIn: 10, tokensOut: 4 }, provider: 'gemini-flash-lite-latest' };
  };

function fakeTts({ provider = 'fish', voice = null, chunkMs = 120 } = {}) {
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
    async *synthesize(text, { lang } = {}) {
      n += 1;
      chain.calls.push({ text, lang, n });
      chain.chars += String(text || '').length;
      yield tone24k(chunkMs);
    },
  };
  return chain;
}

function fakeMedia() {
  const sent = [];
  return {
    sdpAnswer: OPUS_SDP,
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
  llmFactory,
  config = {},
  ended = [],
  clearCache = true,
} = {}) {
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
    sttFactory: sttFactory || (() => sttChain),
    llmFactory: llmFactory || (() => llmChain),
    ttsChain,
    now: NOW,
    logger: () => {},
    onEnd: (o) => ended.push(o),
  });
  return { app, clinic, convo, events, unsub, stt: sttChain, llm: llmChain, tts: ttsChain, media, loop, ended };
}

const spoken = (s, from = 0) => s.tts.calls.slice(from).map((c) => c.text);

// ════════════════════════════════════════════════════════════════════════════
// D2 §1 — STATE-DEPENDENT ENDPOINTING
// ════════════════════════════════════════════════════════════════════════════

test('the turn-taking predicates: words, backchannels, and what the agent just asked for', () => {
  assert.equal(countWords('نحب نحجز موعد'), 3);
  assert.equal(countWords('…'), 0);
  assert.equal(countWords('9 8 7'), 3, 'dictated digits are words — that is the whole point');

  assert.equal(isBackchannelOnly('أيوا'), true);
  assert.equal(isBackchannelOnly('ايوا'), true, 'hamza spelling is the same nod');
  assert.equal(isBackchannelOnly("d'accord"), true);
  assert.equal(isBackchannelOnly('mm-hmm'), true);
  assert.equal(isBackchannelOnly('أيوا تمام'), true);
  assert.equal(isBackchannelOnly('أيوا نحب نحجز موعد'), false, 'a nod plus a sentence is a sentence');
  assert.equal(isBackchannelOnly(''), false);

  assert.equal(detectCaptureAsk('شنوة رقم التلفون متاعك؟'), 'phone');
  assert.equal(detectCaptureAsk('شنوة اسمك الكامل؟'), 'name');
  assert.equal(detectCaptureAsk('أنهي نهار يوافيك؟'), 'date');
  assert.equal(detectCaptureAsk('العيادة في سوسة.'), null);

  assert.equal(captureFromTool('stage_booking', { ok: false, error: 'missing_contact' }), 'phone');
  assert.equal(captureFromTool('stage_booking', { ok: true, recap: '…' }), 'recap');
  assert.equal(captureFromTool('get_available_slots', { ok: true }), 'date');
  assert.equal(captureFromTool('confirm_booking', { ok: true }), 'clear');
});

test('D2 §1: asking for a phone number switches the endpointer to PATIENT mode', async (t) => {
  const s = await setup({
    config: { voiceCascadeEotMs: 10, voiceCascadeEotPatientMs: 250 },
    llm: fakeLlm([says('باهي. شنوة رقم التلفون متاعك؟'), says('تمام، سجلتها.')]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  assert.equal(s.loop.stats().captureState, null, 'nothing is being collected at pickup');
  assert.equal(s.loop.stats().eotMs, 10);

  s.stt.final('نحب نحجز موعد', true);
  await s.loop.settled();
  assert.equal(s.loop.stats().captureState, 'phone', 'the agent asked for a number — that is the state');
  assert.equal(s.loop.stats().eotMs, 250, 'and the endpointer became patient for the next turn');

  // The caller reads the first half of their number and pauses. The VENDOR says
  // the turn is over (endOfTurn: true) and we deliberately overrule it.
  s.stt.final('تسعة ثمانية سبعة', true);
  await s.loop.settled();
  assert.equal(s.llm.turns.length, 1, 'a pause mid-number is NOT the end of the number');

  // …they carry on, which cancels our timer and proves the mechanism.
  s.stt.interim('تسعة ثمانية سبعة ستة');
  s.stt.final('ستة خمسة أربعة', true);
  await waitFor(() => s.llm.turns.length === 2, 'the patient endpointer to close the number');
  assert.match(s.llm.turns[1].messages.at(-1).text, /سبعة/, 'the WHOLE number reached the brain, in one turn');
  assert.match(s.llm.turns[1].messages.at(-1).text, /أربعة/);
});

test('D2 §1: outside a data-capture state the vendor end-of-turn is trusted immediately', async (t) => {
  const s = await setup({
    config: { voiceCascadeEotMs: 10, voiceCascadeEotPatientMs: 5000 },
    llm: fakeLlm([says('العيادة في سوسة.'), says('عندنا قلب و عظام.')]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.stt.final('وين تقعد العيادة؟', true);
  await s.loop.settled();
  assert.equal(s.loop.stats().captureState, null);
  assert.equal(s.loop.stats().eotMs, 10, 'an ordinary answer is endpointed eagerly');

  s.stt.final('و شنوة الاختصاصات؟', true);
  await s.loop.settled();
  assert.equal(s.llm.turns.length, 2, 'no 5-second wait — speech_final ended the turn on the spot');
});

test('D2 §1: the ears are LENT the data-capture state (liveEars has no other endpointer)', async (t) => {
  let lent = null;
  const ears = fakeStt();
  const s = await setup({
    llm: fakeLlm([says('شنوة اسمك؟')]),
    stt: ears,
    sttFactory: (opts) => {
      lent = opts;
      return ears;
    },
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  assert.equal(typeof lent.dataCapture, 'function', 'only the orchestrator knows what it just asked for');
  assert.equal(lent.dataCapture(), false);

  s.stt.final('نحب نحجز موعد', true);
  await s.loop.settled();
  assert.equal(lent.dataCapture(), true, 'and the ears can see it change');
});

// ════════════════════════════════════════════════════════════════════════════
// D2 §2 — THE PRE-WARM
// ════════════════════════════════════════════════════════════════════════════

test('D2 §2: warm-up primes the filler tape ONCE per tenant, and never puts it on the wire', async (t) => {
  const app = makeTestApp();
  clearGreetingCache();
  const first = await setup({ app, clearCache: false, llm: fakeLlm([says('باهي.')]) });
  t.after(() => {
    first.unsub();
    first.loop.stop('test');
  });

  await first.loop.warmUp();
  await first.loop.settled();

  assert.deepEqual(
    spoken(first),
    [normalizeSpoken(buildFillerText('ar'))],
    'exactly one synthesis at accept: the filler, which warms the vendor connection with it'
  );
  assert.equal(first.loop.stats().prewarmedFiller, true);
  assert.equal(first.loop.stats().outQueue, 0, 'and NOT ONE FRAME of it reached the wire');
  assert.equal(first.media.sent.length, 0, 'the caller has not even been greeted yet');
  assert.ok(
    greetingCacheStats().keys.some((k) => k.includes('filler:')),
    greetingCacheStats().keys.join(',')
  );

  // The greeting is synthesized cleanly AFTER it — the pre-warm leaves no half
  // frame in the codec to be glued onto the front of «أهلا بيك».
  await first.loop.start();
  await first.loop.settled();
  assert.equal(first.tts.calls.length, 2);
  assert.equal(first.loop.stats().codec.encodeErrors, 0);

  // A SECOND call on the same tenant/lang/codec/voice pays nothing.
  const second = await setup({ app, clearCache: false, llm: fakeLlm([says('باهي.')]) });
  t.after(() => {
    second.unsub();
    second.loop.stop('test');
  });
  await second.loop.warmUp();
  await second.loop.settled();
  assert.deepEqual(spoken(second), [], 'the tape is already there — nothing is synthesized twice');
  assert.equal(second.loop.stats().prewarmedFiller, false);
});

test('D2 §2: VOICE_CASCADE_PREWARM=off buys nothing and costs nothing', async (t) => {
  const s = await setup({ config: { voiceCascadePrewarm: false }, llm: fakeLlm([says('باهي.')]) });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.warmUp();
  await s.loop.settled();
  assert.deepEqual(spoken(s), []);
  assert.equal(s.loop.stats().prewarmedFiller, false);
});

test('D2 §2: the LLM chain warms its primary link once, and only if the link can be warmed', async () => {
  resetLlmBreakers();
  let warms = 0;
  const chain = createLlmChain({
    links: {
      primary: {
        provider: 'primary',
        warmUp: async () => {
          warms += 1;
          return true;
        },
        async *stream() {
          yield { type: 'text', delta: 'hi' };
          yield { type: 'done', usage: {} };
        },
      },
      classic: {
        provider: 'classic',
        async *stream() {
          yield { type: 'text', delta: 'fallback' };
          yield { type: 'done', usage: {} };
        },
      },
    },
    logger: () => {},
  });
  assert.equal(await chain.warmUp(), 'primary');
  assert.equal(warms, 1);
  assert.equal(chain.stats().prewarmed, 1);
});

// ════════════════════════════════════════════════════════════════════════════
// D2 §2 — THE JITTER CLAMP
// ════════════════════════════════════════════════════════════════════════════

test('D2 §2: a provider whose rolling TTFT median passes the clamp is COOLING, then probed', () => {
  resetLlmBreakers();
  // A partial window decides nothing: the first cold request of a process must
  // not be able to demote a provider.
  for (let i = 0; i < TTFT_WINDOW - 1; i += 1) noteLlmTtft('slowpoke', 4000);
  assert.equal(llmTtftClamp('slowpoke', { clampMs: 2000 }).cooling, false, 'four samples is not a verdict');

  noteLlmTtft('slowpoke', 4000);
  const first = llmTtftClamp('slowpoke', { clampMs: 2000, probeEvery: 5 });
  assert.equal(first.cooling, true);
  assert.equal(first.justCooled, true, 'said ONCE, not once per turn');
  assert.equal(first.median, 4000);
  assert.equal(llmTtftClamp('slowpoke', { clampMs: 2000, probeEvery: 5 }).justCooled, false);

  // Every Nth turn goes through anyway: a clamp nobody ever retries is a
  // permanent demotion decided by five samples.
  const verdicts = [];
  for (let i = 0; i < 3; i += 1) verdicts.push(llmTtftClamp('slowpoke', { clampMs: 2000, probeEvery: 5 }));
  assert.deepEqual(verdicts.map((v) => v.cooling), [true, true, false]);
  assert.equal(verdicts.at(-1).probe, true);

  // …and a provider that got quick again clears itself, without a special case.
  for (let i = 0; i < TTFT_WINDOW; i += 1) noteLlmTtft('slowpoke', 300);
  assert.equal(llmTtftClamp('slowpoke', { clampMs: 2000 }).cooling, false);
});

test('D2 §2: the chain SKIPS a clamped provider, and the waterfall names it', async (t) => {
  resetLlmBreakers();
  for (let i = 0; i < TTFT_WINDOW; i += 1) noteLlmTtft('slow', 5000);

  let slowCalls = 0;
  const links = {
    slow: {
      provider: 'slow',
      async *stream() {
        slowCalls += 1;
        yield { type: 'text', delta: 'too late' };
        yield { type: 'done', usage: {} };
      },
    },
    fast: {
      provider: 'fast',
      async *stream() {
        yield { type: 'text', delta: 'عندنا مواعيد الخميس.' };
        yield { type: 'done', usage: {} };
      },
    },
  };
  const s = await setup({
    config: { voiceCascadeTtftClampMs: 2000 },
    llmFactory: (opts) => createLlmChain({ ...opts, links, logger: () => {} }),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
    resetLlmBreakers();
  });
  await s.loop.start();

  s.stt.final('وقتاش فمة مواعيد؟', true);
  await s.loop.settled();

  assert.equal(slowCalls, 0, 'a cold provider is not given a NEW turn');
  assert.deepEqual(spoken(s, 1), ['عندنا مواعيد الخميس.'], 'the caller is answered by the fast one');
  const [w] = s.loop.outcome().waterfalls;
  assert.equal(w.clamped, 'slow', 'a slow call has to be able to NAME the reason it was slow');
  assert.equal(w.llm, 'fast');
  assert.deepEqual(s.loop.stats().clamped, ['slow']);
});

// ════════════════════════════════════════════════════════════════════════════
// D2 §4 — THE GUARANTEED REQUEST-START LINE
// ════════════════════════════════════════════════════════════════════════════

test('D2 §4: EVERY tool call is covered by a spoken line, BEFORE the executor runs', async (t) => {
  const s = await setup({
    llm: fakeLlm([
      async function* ({ messages }) {
        if (messages.some((m) => m.role === 'tool')) {
          yield { type: 'text', delta: 'عندي الخميس على التسعة.' };
          yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
          return;
        }
        yield {
          type: 'toolCall',
          call: { id: 'g1', name: 'get_available_slots', args: { dayText: 'الخميس' } },
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
  const afterGreeting = s.tts.calls.length;

  s.stt.final('شنوة فمة نهار الخميس؟', true);
  await s.loop.settled();

  const said = spoken(s, afterGreeting);
  assert.equal(said[0], normalizeSpoken(buildToolStartText('ar', 0)), 'the cover line is spoken FIRST');
  assert.equal(said[1], 'عندي الخميس على التسعة.', '…and the lookup result second');
  assert.equal(s.loop.stats().toolStartLines, 1);
  // It is COVER, not the answer: it is tagged on the wire as its own source, so
  // it can never be counted as the reply the caller's latency is measured to.
  await waitFor(() => s.loop.stats().outQueue === 0, 'the wire to drain');
  assert.ok(s.loop.stats().outBySrc.toolstart > 0);
  assert.equal(s.loop.outcome().waterfalls.length, 1);
});

test('D2 §4: the phrasing rotates — nothing in this call is said the same way twice', async (t) => {
  const s = await setup({
    // Offering slots is a data-capture state (the caller answers with a day),
    // so the endpointer is patient — kept short so this measures the phrasing.
    // BOTH values: the patient budget is never shorter than the default one.
    config: { voiceCascadeEotMs: 10, voiceCascadeEotPatientMs: 20 },
    llm: fakeLlm([
      async function* ({ messages }) {
        if (messages.some((m) => m.role === 'tool')) {
          yield { type: 'text', delta: 'باهي.' };
          yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
          return;
        }
        yield { type: 'toolCall', call: { id: 'g', name: 'get_available_slots', args: { dayText: 'الخميس' } } };
        yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
      },
    ]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  const variants = new Set([0, 1, 2].map((i) => normalizeSpoken(buildToolStartText('ar', i))));
  for (const line of ['شنوة فمة نهار الخميس؟', 'و نهار الجمعة؟', 'و نهار السبت؟']) {
    s.stt.final(line, true);
    await s.loop.settled();
    await sleep(30);
    await s.loop.settled();
  }
  await waitFor(() => s.loop.stats().toolStartLines === 3, 'three covered lookups');
  const starts = s.tts.calls.map((c) => c.text).filter((x) => variants.has(x));
  assert.equal(new Set(starts).size, 3, 'three lookups, three different phrasings');
});

test('D2 §4: confirm_booking and end_call are SILENT — the recap and the goodbye own those beats', async (t) => {
  const s = await setup({
    config: { voiceCascadeEotPatientMs: 25 },
    llm: fakeLlm([
      async function* () {
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
      async function* ({ messages }) {
        yield { type: 'text', delta: `${messages.at(-1).result.recap} ` };
        yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
      },
      async function* () {
        yield { type: 'toolCall', call: { id: 'c2', name: 'confirm_booking', args: {} } };
        yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
      },
      async function* ({ messages }) {
        yield { type: 'text', delta: `مثبت، رقم الموعد ${messages.at(-1).result.ref}.` };
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
  const afterStage = s.tts.calls.length;
  assert.equal(s.loop.stats().toolStartLines, 1, 'the STAGE was covered');

  s.stt.final('نعم صحيح', true);
  await waitFor(() => s.loop.stats().staged === false, 'the booking to be written');
  await s.loop.settled();

  assert.equal(s.loop.stats().toolStartLines, 1, 'and confirm_booking added NOTHING');
  const said = spoken(s, afterStage);
  assert.ok(said.every((x) => !x.startsWith('ثانية') && !x.startsWith('لحظة')), said.join(' | '));
  assert.equal((await s.app.store.listAppointments({ clinicId: CLINIC })).length, 1);
});

// ════════════════════════════════════════════════════════════════════════════
// D3 §1 — THE WORD GATE
// ════════════════════════════════════════════════════════════════════════════

/** `n` frames of LOUD caller audio through the real inbound codec path. */
function feedLoud(s, frames = 14) {
  const bridge = createCodecBridge({ sdpAnswer: OPUS_SDP, sdpOffer: OPUS_SDP, logger: () => {} });
  const payloads = bridge.encodeOut(tone24k(frames * 20), 24000);
  for (const payload of payloads) s.loop.onRtp({ header: { payloadType: 111 }, payload });
  bridge.close();
  return payloads.length;
}

test('D3 §1: RMS alone NEVER yields — energy is evidence, the ears are the verdict', async (t) => {
  const s = await setup({
    llm: fakeLlm([says('عندنا مواعيد برشة هالأسبوع كامل، نجم نعطيك التفاصيل.')]),
    tts: fakeTts({ chunkMs: 600 }),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  await s.loop.settled();
  s.stt.final('شنوة المواعيد؟', true);
  await waitFor(() => s.loop.stats().outQueue > 5, 'our own speech on the wire');

  feedLoud(s, 20); // 400 ms of loud room, a TV, a relative — or a nod
  const hot = s.loop.stats();
  assert.ok(hot.energyHits >= 1, 'the episode is recorded');
  assert.equal(hot.bargeIns, 0, 'and it stops NOTHING on its own');
  assert.ok(hot.outQueue > 0, 'the agent finishes its sentence');

  // One word is still not a person: a streaming transcriber emits those on its
  // way to a sentence.
  s.stt.interim('سامحني');
  assert.equal(s.loop.stats().bargeIns, 0);
  assert.equal(s.loop.stats().bargeFragmentsIgnored, 1);
  assert.ok(s.loop.stats().outQueue > 0);

  // Two words, and the wire goes quiet.
  s.stt.interim('سامحني، لحظة');
  const st = s.loop.stats();
  assert.equal(st.bargeIns, 1);
  assert.equal(st.outQueue, 0);
  assert.equal(st.energyBargeIns, 1, 'the energy episode corroborated the interruption');
});

test('D3 §1: an EMERGENCY word in an interim yields instantly — zero words needed', async (t) => {
  const s = await setup({
    config: { voiceBrainEmergencyGraceMs: 5000 },
    llm: fakeLlm([says('عندنا مواعيد برشة هالأسبوع كامل، نجم نعطيك التفاصيل.')]),
    tts: fakeTts({ chunkMs: 600 }),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  await s.loop.settled();
  s.stt.final('شنوة المواعيد؟', true);
  await waitFor(() => s.loop.stats().outQueue > 5, 'our own speech on the wire');

  s.stt.interim('نزيف'); // ONE word, and it outranks every rule in this file
  assert.equal(s.loop.stats().outQueue, 0, 'the wire is quiet before the ambulance number is even composed');
  await s.loop.settled();
  assert.equal(s.loop.outcome().emergency, true);
  assert.equal(s.events.filter((e) => e.type === 'emergency.detected').length, 1);
});

// ════════════════════════════════════════════════════════════════════════════
// D3 §2 — BACKCHANNEL IMMUNITY
// ════════════════════════════════════════════════════════════════════════════

test('D3 §2: «أيوا» over the top of a sentence stops nothing and answers nothing', async (t) => {
  const s = await setup({
    llm: fakeLlm([says('العيادة تحل من التاسعة للسادسة، و نخدمو من الاثنين للسبت.')]),
    tts: fakeTts({ chunkMs: 600 }),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  await s.loop.settled();
  s.stt.final('وقتاش تحلو العيادة؟', true);
  await waitFor(() => s.loop.stats().outQueue > 5, 'our own answer on the wire');
  const queued = s.loop.stats().outQueue;

  s.stt.interim('أيوا');
  s.stt.final('تمام', true);
  await s.loop.settled();

  const st = s.loop.stats();
  assert.equal(st.bargeIns, 0, 'a nod is not an interruption');
  assert.ok(st.outQueue >= queued - 3, 'the sentence is still playing');
  assert.equal(s.llm.turns.length, 1, 'and it never became a turn');
  assert.ok(st.backchannels >= 2);
});

test('D3 §2: on a quiet wire a bare «أيوا» is an acknowledgment — recorded, not answered', async (t) => {
  const s = await setup({ llm: fakeLlm([says('العيادة تحل من التاسعة.'), says('لا لازم')]) });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  await s.loop.settled();
  await waitFor(() => s.loop.stats().outQueue === 0, 'the greeting to drain');

  s.stt.final('باهي، شكرا برشة', true);
  await s.loop.settled();
  await waitFor(() => s.loop.stats().outQueue === 0, 'the answer to drain');
  const afterAnswer = s.tts.calls.length;

  s.stt.final('أيوا', true);
  await s.loop.settled();
  await sleep(30);

  assert.equal(s.llm.turns.length, 1, 'no model round trip to say something back to a nod');
  assert.deepEqual(spoken(s, afterAnswer), [], 'and nothing was said at all');
  assert.ok(s.loop.stats().backchannels >= 1);
  // It IS on the record, and it IS in the context window: the caller did speak.
  assert.ok(s.loop.transcript().some((e) => e.who === 'patient' && e.text.includes('أيوا')));
});

test('D3 §2: …EXCEPT when it is the answer — «نعم» to a staged recap still books', async (t) => {
  const s = await setup({
    config: { voiceCascadeEotPatientMs: 25 },
    llm: fakeLlm([
      async function* () {
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
      async function* ({ messages }) {
        yield { type: 'text', delta: `${messages.at(-1).result.recap} ` };
        yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
      },
      async function* () {
        yield { type: 'toolCall', call: { id: 'c2', name: 'confirm_booking', args: {} } };
        yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
      },
      says('مثبت.'),
    ]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  s.stt.final('نحب نحجز موعد قلب نهار الخميس، اسمي محمد الهادي', true);
  await s.loop.settled();
  await waitFor(() => s.loop.stats().outQueue === 0, 'the recap to drain');

  // A bare yes. On the ignore-list, and the most important word of the call.
  s.stt.final('نعم', true);
  await waitFor(() => s.loop.stats().staged === false, 'the confirm turn');
  await s.loop.settled();

  const rows = await s.app.store.listAppointments({ clinicId: CLINIC });
  assert.equal(rows.length, 1, 'a backchannel rule that swallowed this would stall every booking');
  assert.equal(s.loop.outcome().booked, rows[0].ref);
});

// ════════════════════════════════════════════════════════════════════════════
// D3 §3 — FRAGMENTS AND SILENCE
// ════════════════════════════════════════════════════════════════════════════

test('D3 §3: a one-word fragment never starts a turn — the agent asks instead of guessing', async (t) => {
  const s = await setup({ llm: fakeLlm([says('باهي.')]) });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  const afterGreeting = s.tts.calls.length;

  s.stt.final('نحب', true); // the opening of a sentence, endpointed too early
  await s.loop.settled();

  assert.equal(s.llm.turns.length, 0, 'half a sentence never reaches a model');
  assert.equal(s.loop.stats().fragmentsRefused, 1);
  assert.match(spoken(s, afterGreeting)[0], /سامحني/, 'it reuses the V6.2 two-strike ladder, warmly');
});

test('D3 §3: …but in a data-capture state one token IS the answer', async (t) => {
  const s = await setup({
    config: { voiceCascadeEotMs: 10, voiceCascadeEotPatientMs: 20 },
    llm: fakeLlm([says('أنهي نهار يوافيك؟'), says('باهي، الخميس.')]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  s.stt.final('نحب نحجز موعد', true);
  await s.loop.settled();
  assert.equal(s.loop.stats().captureState, 'date');

  s.stt.final('الخميس', true); // ONE word, and it is exactly what we asked for
  await waitFor(() => s.llm.turns.length === 2, 'the one-word answer to become a turn');
  assert.equal(s.loop.stats().fragmentsRefused, 0);
  assert.equal(s.llm.turns[1].messages.at(-1).text, 'الخميس');
});

test('D3 §3: caller silence ⇒ ONE warm check-in, then a goodbye and the WhatsApp follow-up', async (t) => {
  const ended = [];
  const s = await setup({
    ended,
    config: {
      voiceCascadeSilenceCheckMs: 60,
      voiceCascadeSilenceByeMs: 60,
      voiceCallHangupGraceMs: 3000,
    },
    llm: fakeLlm([says('باهي.')]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  await waitFor(() => s.loop.stats().silenceChecks === 1, 'the check-in');
  assert.equal(s.tts.calls.at(-1).text, normalizeSpoken(buildSilenceCheckText('ar')));
  assert.equal(s.llm.turns.length, 0, 'the check-in is deterministic — no model, no tokens');

  await waitFor(() => s.loop.stats().silenceEnded === true, 'the goodbye');
  assert.equal(s.tts.calls.at(-1).text, normalizeSpoken(buildSilenceByeText('ar')));
  assert.equal(s.loop.stats().silenceChecks, 1, 'asked ONCE — never twice');
  assert.equal(s.loop.stats().endRequested, true, 'and it goes through the ordinary end_call flow');

  await waitFor(() => ended.length === 1, 'the line to drop after the goodbye played', 5000);
  assert.equal(ended[0].reason, 'completed');

  // The patient lands back in the thread they are already on.
  await s.loop.settled();
  const msgs = await s.app.store.conversations.listMessages(CLINIC, s.convo.id, {});
  const out = msgs.filter((m) => m.direction === 'outbound');
  assert.equal(out.length, 1);
  assert.equal(out[0].body.text, localized('ar', 'callBrainLost'));
});

test('D3 §3: a caller who answers the check-in resets the ladder completely', async (t) => {
  const s = await setup({
    config: { voiceCascadeSilenceCheckMs: 60, voiceCascadeSilenceByeMs: 10000 },
    llm: fakeLlm([says('أكيد، قولّي.')]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  await waitFor(() => s.loop.stats().silenceChecks === 1, 'the check-in');

  s.stt.final('أيوا، مازلت هوني', true);
  await s.loop.settled();
  await sleep(80);

  assert.equal(s.loop.stats().silenceEnded, false, 'nobody hangs up on a caller who answered');
  assert.equal(s.loop.stats().endRequested, false);
  assert.equal(s.llm.turns.length, 1);
});


// ════════════════════════════════════════════════════════════════════════════
// REVIEW REGRESSIONS (V8 round) — the three real-caller failures, locked
// ════════════════════════════════════════════════════════════════════════════

test('REGRESSION: the Deepgram empty flush final does NOT commit a half-typed phone number in capture mode', async (t) => {
  const s = await setup({
    config: { voiceCascadeEotMs: 10, voiceCascadeEotPatientMs: 250 },
    llm: fakeLlm([says('باهي. شنوة رقم التلفون متاعك؟'), says('تمام، سجلتها.')]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.stt.final('نحب نحجز موعد', true);
  await waitFor(() => s.llm.turns.length === 1, 'the phone question turn');
  // Wait for the QUESTION sentence itself — the chunker splits the reply, and
  // the capture-ask arms on the sentence that contains the ask, not on «باهي.».
  await waitFor(() => s.tts.calls.some((c) => c.text.includes('رقم التلفون')), 'the phone question spoken');
  await sleep(30); // let the capture state settle after the sentence lands

  // The caller reads HALF the number, Deepgram sends speech_final AND the
  // empty flush frame right behind it — the exact sequence from the review.
  s.stt.final('تسعة ثمانية سبعة', true);
  s.stt.final('', true); // UtteranceEnd / empty speech_final: the flush
  await sleep(100); // well inside the 250ms patient budget
  assert.equal(s.llm.turns.length, 1, 'the flush frame must NOT commit the half number');

  // The second half arrives; the patient endpointer then commits ONE turn.
  s.stt.final('أربعة تسعة ستة', true);
  await waitFor(() => s.llm.turns.length === 2, 'the full-number turn', 4000);
  const userText = s.llm.turns[1].messages.filter((m) => m.role === 'user').map((m) => m.text).join(' ');
  assert.ok(userText.includes('تسعة ثمانية سبعة') && userText.includes('أربعة تسعة ستة'),
    `one turn carries the WHOLE number, got: ${userText}`);
});

test('REGRESSION: a bare «نعم» answering the silence check-in never triggers the goodbye', async (t) => {
  const s = await setup({
    config: { voiceCascadeEotMs: 10, voiceCascadeSilenceCheckMs: 120, voiceCascadeSilenceByeMs: 200 },
    llm: fakeLlm([says('أهلا بيك، كيفاش نجم نعاونك؟')]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.stt.final('أهلا', true);
  await waitFor(() => s.tts.calls.length >= 1, 'the first reply spoken');

  // Silence → the check-in line plays.
  await waitFor(
    () => s.tts.calls.some((c) => c.text === buildSilenceCheckText('ar')),
    'the check-in line',
    4000
  );

  // The caller answers the check-in with a bare nod.
  s.stt.final('نعم', true);
  await sleep(450); // well past the 200ms bye window
  assert.equal(s.ended.length, 0, 'the ladder must reset — no goodbye on a caller who said yes');
  assert.ok(
    !s.tts.calls.some((c) => c.text === buildSilenceByeText('ar')),
    'the goodbye line was never spoken'
  );
});

test('REGRESSION: a trailing «باهي» never destroys the pending real utterance', async (t) => {
  const s = await setup({
    config: { voiceCascadeEotMs: 120 },
    llm: fakeLlm([says('باهي، أنهي نهار يوافيك؟')]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  // A real final that is NOT end-of-turn, then a backchannel-only final inside
  // the EOT window — the review-reproduced booking-loss sequence.
  s.stt.final('نحب نحجز موعد غدوة', false);
  await sleep(30);
  s.stt.final('باهي', true);

  await waitFor(() => s.llm.turns.length >= 1, 'the booking turn', 4000);
  assert.equal(s.llm.turns.length, 1, 'exactly one turn');
  const userText = s.llm.turns[0].messages.filter((m) => m.role === 'user').map((m) => m.text).join(' ');
  assert.ok(userText.includes('نحب نحجز موعد غدوة'), `the booking request survived, got: ${userText}`);
});

// ════════════════════════════════════════════════════════════════════════════
// THE SELF-TEST'S OWN FINDINGS (2026-08-02) — three ways the last beat of a
// booking call was lost, every one of them reproduced from a scored run.
// ════════════════════════════════════════════════════════════════════════════

test('the fragment exemptions: a goodbye and a run of digits are turns, everything else is not', () => {
  // Farewells — including the truncation the ears actually returned («بسلام»)
  // and the Latin spellings liveEars emits for derja.
  assert.equal(isFarewellFragment('بسلامة'), true);
  assert.equal(isFarewellFragment('بسلام'), true, 'the ears drop the ة — that is the observed final');
  assert.equal(isFarewellFragment('bslama'), true);
  assert.equal(isFarewellFragment('bye'), true);
  // V8 — the predicate now also ARMS THE HANG-UP BACKSTOP, so the two languages
  // in which nobody says a goodbye in one bare word had to be covered: the
  // politeness that rides along («au», «merci», «thank you») is stripped, and a
  // real farewell token is still required.
  assert.equal(isFarewellFragment('revoir'), true);
  assert.equal(isFarewellFragment('au revoir'), true, 'the whole of the French goodbye');
  assert.equal(isFarewellFragment('merci, au revoir'), true);
  assert.equal(isFarewellFragment('thank you, bye'), true);
  assert.equal(isFarewellFragment('شكرا بالسلامة'), true);
  assert.equal(isFarewellFragment('merci'), false, 'a thank-you is not the end of the call');
  assert.equal(isFarewellFragment('thank you'), false);
  assert.equal(isFarewellFragment('نحب'), false, 'half a word is still half a word');
  assert.equal(isFarewellFragment('نحب نبدل النهار'), false);
  assert.equal(isFarewellFragment(''), false);

  // Digits — a transcriber emits half-WORDS, never a spurious number.
  assert.equal(isDigitFragment('21'), true);
  assert.equal(isDigitFragment('4 9 6 7'), true);
  assert.equal(isDigitFragment('٢١'), true, 'Arabic-Indic digits are digits');
  assert.equal(isDigitFragment('21 ماي'), false, 'a number plus a word is a sentence');
  assert.equal(isDigitFragment('نحب'), false);
  assert.equal(isDigitFragment(''), false);
});

test('a one-word «بسلام» is a goodbye, not a fragment — the model gets the turn that ends the call', async (t) => {
  const s = await setup({ llm: fakeLlm([says('شكرا و بالسلامة.')]) });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.stt.final('بسلام', true);
  await waitFor(() => s.llm.turns.length === 1, 'the farewell to become a turn');
  assert.equal(s.loop.stats().fragmentsRefused, 0, 'the last beat of the call is never an artefact');
  assert.equal(s.llm.turns[0].messages.at(-1).text, 'بسلام');
});

test('digits are data even when nothing said we were collecting them', async (t) => {
  // The reproduced shape: the agent answered with a bare disfluency — no
  // question, no tool — so `captureState` was null and the number the caller
  // read off a card arrived into a state that called it noise.
  const s = await setup({ llm: fakeLlm([says('لحظة وحدة نتثبت…'), says('وباقي الرقم؟')]) });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.stt.final('نحب نحجز موعد', true);
  await waitFor(() => s.llm.turns.length === 1, 'the opening turn');
  await s.loop.settled();
  assert.equal(s.loop.stats().captureState, null, 'a disfluency asks for nothing — this is the bad state');

  s.stt.final('21', true);
  await waitFor(() => s.llm.turns.length === 2, 'the digits to become a turn anyway');
  assert.equal(s.loop.stats().fragmentsRefused, 0);
  assert.equal(s.llm.turns[1].messages.at(-1).text, '21');
});

test('the caller saying goodbye back does NOT cancel the hang-up', async (t) => {
  const ended = [];
  const s = await setup({
    ended,
    config: { voiceCallHangupGraceMs: 3000 },
    llm: fakeLlm([
      async function* () {
        yield { type: 'text', delta: 'شكرا و بالسلامة!' };
        yield { type: 'toolCall', call: { id: 'c1', name: 'end_call', args: {} } };
        yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
      },
    ]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.stt.final('بسلامة', true);
  await waitFor(() => s.loop.stats().endRequested === true, 'end_call to arm the hang-up');

  // The caller's own «بسلام» comes back through the ears. It is them AGREEING
  // the call is over — cancelling on it held the line open forever (run 3).
  s.stt.final('بسلام', true);
  await waitFor(() => ended.length === 1, 'the line to drop anyway', 6000);
  assert.equal(s.loop.stats().endRequested, true, 'the hang-up was never cancelled');

  // …and a real "wait, one more thing" still cancels it.
  const s2 = await setup({
    config: { voiceCallHangupGraceMs: 3000 },
    llm: fakeLlm([
      async function* () {
        yield { type: 'text', delta: 'شكرا و بالسلامة!' };
        yield { type: 'toolCall', call: { id: 'c1', name: 'end_call', args: {} } };
        yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
      },
      says('أيوا، نسمعك.'),
    ]),
  });
  t.after(() => {
    s2.unsub();
    s2.loop.stop('test');
  });
  await s2.loop.start();
  s2.stt.final('بسلامة', true);
  await waitFor(() => s2.loop.stats().endRequested === true, 'the second hang-up to arm');
  s2.stt.final('استنى، عندي سؤال آخر', true);
  await waitFor(() => s2.loop.stats().endRequested === false, 'a real "one more thing" to cancel it');
});

// ════════════════════════════════════════════════════════════════════════════
// V8 §1 — DETERMINISTIC CONFIRM-ON-CONSENT
//
// The two-phase gate's law is unchanged: nothing is written unless the values
// survived stage_booking's deterministic validation, the recap was spoken, and
// the caller said yes AFTER hearing it. What these hold still is that the THIRD
// condition is now judged in code — because on a scored self-test run
// (2026-08-02, run 4) the recap was word-perfect, the caller said «نعم صحيح»,
// and `gemini-flash-lite-latest` answered «ثانية برك نأكدلك الحجز…» and emitted
// no tool call at all. The consent existed; the booking did not.
// ════════════════════════════════════════════════════════════════════════════

const STAGE_ARGS = {
  specialty: 'قلب',
  datetimeText: 'الخميس 10',
  name: 'محمد الهادي',
  contact: '21650123456',
};

/** Round 1 of the model's turn: it stages. Writes nothing, by construction. */
const stageStep = async function* () {
  yield { type: 'toolCall', call: { id: 'c1', name: 'stage_booking', args: STAGE_ARGS } };
  yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
};
/** Round 2: it reads the recap the tool returned, word for word. */
const recapStep = async function* ({ messages }) {
  yield { type: 'text', delta: `${messages.at(-1).result.recap} ` };
  yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
};

/** Drive a call to "staged, and the recap has actually left for the wire". */
async function toRecapRead(t, { llm, config = {} } = {}) {
  const s = await setup({
    config: { voiceCascadeEotPatientMs: 25, ...config },
    llm: llm || fakeLlm([stageStep, recapStep, says('ثانية برك نأكدلك الحجز…')]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  s.stt.final('نحب نحجز موعد قلب نهار الخميس، اسمي محمد الهادي', true);
  await s.loop.settled();
  await waitFor(() => s.loop.stats().outQueue === 0, 'the recap to drain onto the wire');
  return s;
}

test('V8 §1: a «نعم صحيح» to a recap the caller HEARD books deterministically — the model gets no vote', async (t) => {
  const s = await toRecapRead(t);
  assert.equal(s.loop.stats().staged, true, 'the two-phase gate staged it and wrote nothing');
  assert.equal(s.loop.stats().recapSpoken, true, 'and the recap really left this process');
  const turnsBefore = s.llm.turns.length;
  const saidBefore = s.tts.calls.length;

  s.stt.final('نعم صحيح', true);
  await waitFor(() => s.loop.stats().deterministicConfirms === 1, 'the loop to fire confirm_booking itself');
  await s.loop.settled();

  const rows = await s.app.store.listAppointments({ clinicId: CLINIC });
  assert.equal(rows.length, 1, 'exactly one appointment');
  assert.equal(rows[0].patientName, 'محمد الهادي');
  assert.equal(rows[0].contact, '21650123456');
  assert.equal(s.loop.stats().staged, false, 'the stage is consumed');
  assert.equal(s.loop.outcome().booked, rows[0].ref);
  assert.equal(s.llm.turns.length, turnsBefore, 'the yes never reached a model — that is the whole point');

  // The reference is spoken from responses.js carrying the value the STORE
  // wrote. A reference a model paraphrases is a reference nobody can use.
  const said = spoken(s, saidBefore).join(' ');
  assert.ok(said.includes(rows[0].ref), `the reference is read out deterministically (${said})`);
});

test('V8 §1: the recap still counts when the model SPELLS the number out (self-test 11:22)', async (t) => {
  // Caught on the rig: a word-perfect recap read «ورقم التلفون واحد وعشرين تسعة
  // وعشرين…». A matcher that demanded the digits saw nothing, the deterministic
  // path never armed, and the booking went back to depending on the model.
  const spellItOut = async function* ({ messages }) {
    const recap = String(messages.at(-1).result.recap).replace(
      '21650123456',
      'واحد وعشرين ستة خمسة صفر واحد اثنين ثلاثة أربعة خمسة ستة'
    );
    yield { type: 'text', delta: `${recap} ` };
    yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
  };
  const s = await toRecapRead(t, { llm: fakeLlm([stageStep, spellItOut, says('تم.')]) });
  assert.equal(s.loop.stats().recapSpoken, true, 'the read-back is the read-back in any notation');

  s.stt.final('نعم صحيح', true);
  await waitFor(() => s.loop.stats().deterministicConfirms === 1, 'the deterministic confirm');
  await s.loop.settled();
  const rows = await s.app.store.listAppointments({ clinicId: CLINIC });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].contact, '21650123456', 'the value written is the STAGED one, never a spoken one');
});

test('V8 §1: half a recap is not a recap — coverage is required, not just the name', async (t) => {
  const halfStep = async function* () {
    // The name, and nothing else the caller could have checked.
    yield { type: 'text', delta: 'باسم محمد الهادي، ثانية برك…' };
    yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
  };
  const s = await toRecapRead(t, { llm: fakeLlm([stageStep, halfStep, says('سامحني.')]) });
  assert.equal(s.loop.stats().recapSpoken, false, 'a name on its own is not a read-back');

  s.stt.final('نعم صحيح', true);
  await s.loop.settled();
  assert.equal(s.loop.stats().deterministicConfirms, 0);
  assert.equal((await s.app.store.listAppointments({ clinicId: CLINIC })).length, 0);
});

test('V8 §1: it does NOT fire without a stage — a yes on its own books nothing', async (t) => {
  const s = await setup({ llm: fakeLlm([says('أهلا بيك، شنوة نجم نعمل؟')]) });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.stt.final('نعم صحيح', true);
  await waitFor(() => s.llm.turns.length === 1, 'the yes to go to the model like any other sentence');
  await s.loop.settled();

  assert.equal(s.loop.stats().deterministicConfirms, 0);
  assert.equal((await s.app.store.listAppointments({ clinicId: CLINIC })).length, 0);
});

test('V8 §1: it does NOT fire on a yes the caller gave BEFORE the recap was read', async (t) => {
  // The model staged and then said something that is not the recap. Nothing the
  // caller could have consented to has been read to them.
  const s = await toRecapRead(t, {
    llm: fakeLlm([stageStep, says('ثانية برك…'), says('سامحني، نعاودو.')]),
  });
  assert.equal(s.loop.stats().staged, true);
  assert.equal(s.loop.stats().recapSpoken, false, 'no recap on the wire ⇒ no consent to act on');

  s.stt.final('نعم صحيح', true);
  await waitFor(() => s.llm.turns.length === 3, 'the yes to go to the model instead');
  await s.loop.settled();

  assert.equal(s.loop.stats().deterministicConfirms, 0);
  assert.equal((await s.app.store.listAppointments({ clinicId: CLINIC })).length, 0, 'nothing was written');
  assert.equal(s.loop.stats().staged, true, 'and the stage still stands');
});

test('V8 §1: it does NOT fire on an ambiguous answer — «يمكن» is not consent', async (t) => {
  const s = await toRecapRead(t, {
    llm: fakeLlm([stageStep, recapStep, says('تحب نأكدو ولا نبدلو؟')]),
  });
  const turnsBefore = s.llm.turns.length;

  s.stt.final('يمكن', true);
  await waitFor(() => s.llm.turns.length === turnsBefore + 1, 'the model to handle the ambiguity');
  await s.loop.settled();

  assert.equal(s.loop.stats().deterministicConfirms, 0);
  assert.equal((await s.app.store.listAppointments({ clinicId: CLINIC })).length, 0);
  assert.equal(s.loop.stats().staged, true, 'an ambiguous answer decides nothing, in either direction');
});

test('V8 §1: an explicit «لا» after the recap clears the stage and books nothing', async (t) => {
  const s = await toRecapRead(t, {
    llm: fakeLlm([stageStep, recapStep, says('سامحني، شنوة نبدلو؟')]),
  });
  const turnsBefore = s.llm.turns.length;

  s.stt.final('آه لا', true);
  await waitFor(() => s.loop.stats().staged === false, 'the stage to be dropped deterministically');
  await waitFor(() => s.llm.turns.length === turnsBefore + 1, 'the model to re-collect');
  await s.loop.settled();

  assert.equal(s.loop.stats().deterministicConfirms, 0);
  assert.equal(s.loop.stats().deterministicDeclines, 1);
  assert.equal((await s.app.store.listAppointments({ clinicId: CLINIC })).length, 0, 'a no writes nothing');
  assert.equal(s.loop.stats().recapSpoken, false, 'and the recap evidence starts over');
});

test('V8 §1: IDEMPOTENCE — a model confirm AFTER the deterministic one still leaves ONE appointment', async (t) => {
  const toolResults = [];
  const s = await toRecapRead(t, {
    llm: fakeLlm([
      stageStep,
      recapStep,
      // The caller says something else; the model, catching up, confirms again.
      async function* () {
        yield { type: 'toolCall', call: { id: 'c2', name: 'confirm_booking', args: {} } };
        yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
      },
      async function* ({ messages }) {
        toolResults.push(messages.at(-1).result);
        yield { type: 'text', delta: 'الحجز مثبت.' };
        yield { type: 'done', usage: {}, provider: 'gemini-flash-lite-latest' };
      },
    ]),
  });

  s.stt.final('نعم صحيح', true);
  await waitFor(() => s.loop.stats().deterministicConfirms === 1, 'the deterministic confirm');
  await s.loop.settled();
  const rows = await s.app.store.listAppointments({ clinicId: CLINIC });
  assert.equal(rows.length, 1);

  s.stt.final('طيب، شكرا برشة على المساعدة', true);
  await waitFor(() => toolResults.length === 1, 'the model to confirm a second time');
  await s.loop.settled();

  assert.equal((await s.app.store.listAppointments({ clinicId: CLINIC })).length, 1, 'still ONE row');
  assert.equal(toolResults[0].ok, true, 'the gate answers, it does not error at the model');
  assert.equal(toolResults[0].already, true, 'a no-op');
  assert.equal(toolResults[0].ref, rows[0].ref, 'the SAME reference, never a second one');
  assert.equal(
    s.events.filter((e) => e.type === 'appointment.created').length,
    1,
    'and one publish, not two'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// V8 §2 — THE HANG-UP BACKSTOP
// `end_call` lives inside a model turn, and on four scored rehearsal runs in a
// row the model said its farewell and never called it. The line stayed open.
// ════════════════════════════════════════════════════════════════════════════

test('V8 §2: the caller says goodbye, the model forgets end_call, and the line is released anyway', async (t) => {
  const ended = [];
  const s = await setup({
    ended,
    config: { voiceCascadeFarewellHangupMs: 60, voiceCallHangupGraceMs: 3000 },
    // Exactly what the model did on all four runs: the farewell, no end_call.
    llm: fakeLlm([says('شكرا و بالسلامة.')]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.stt.final('بسلامة', true);
  await waitFor(() => ended.length === 1, 'the line to drop without a single end_call', 8000);
  assert.equal(s.loop.stats().farewellHangups, 1, 'the backstop, not a model');
  assert.equal(ended[0].reason, 'completed');
  assert.equal(s.llm.turns.length, 1, 'the model still got its goodbye turn');
});

test('V8 §2: «wait, one more thing» inside the grace cancels the release', async (t) => {
  const ended = [];
  const s = await setup({
    ended,
    config: { voiceCascadeFarewellHangupMs: 400, voiceCallHangupGraceMs: 3000 },
    llm: fakeLlm([says('بالسلامة.'), says('أيوا، نسمعك.')]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.stt.final('بسلامة', true);
  await waitFor(() => s.loop.stats().farewellArmed === true, 'the backstop to arm');
  s.stt.final('استنى، عندي سؤال آخر', true);
  await waitFor(() => s.loop.stats().farewellArmed === false, 'the caller to cancel it');
  await sleep(700);
  assert.equal(ended.length, 0, 'the line stays open for the caller who is still talking');
  assert.equal(s.loop.stats().farewellHangups, 0);
});

test('V8 §2: a staged, unconfirmed booking SUPPRESSES the backstop — never hang up mid-booking', async (t) => {
  const ended = [];
  const s = await setup({
    ended,
    config: { voiceCascadeFarewellHangupMs: 60, voiceCallHangupGraceMs: 3000, voiceCascadeEotPatientMs: 25 },
    llm: fakeLlm([stageStep, recapStep, says('بالسلامة.')]),
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  s.stt.final('نحب نحجز موعد قلب نهار الخميس، اسمي محمد الهادي', true);
  await s.loop.settled();
  await waitFor(() => s.loop.stats().outQueue === 0, 'the recap to drain');
  assert.equal(s.loop.stats().staged, true);

  // A goodbye is NOT a booking. The caller is one word away from an appointment.
  s.stt.final('بسلامة', true);
  await sleep(600);
  assert.equal(s.loop.stats().farewellHangups, 0, 'the backstop stood down');
  assert.equal(s.loop.stats().endRequested, false);
  assert.equal(ended.length, 0, 'the line is still there for the yes');
});
