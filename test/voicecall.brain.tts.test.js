// V5-T1 — THE MOUTH. Per-tenant TTS: Gemini keeps the ears and the brain, and
// the voice becomes swappable (native ⇄ Azure ⇄ ElevenLabs).
//
// Tested at the four levels it actually lives at:
//   1. THE CHAIN     — selection, credential gates, the fall-back-to-native law
//   2. THE PROVIDERS — the exact HTTP contract, byte for byte, incl. the
//                      odd-byte carry that silently turns a sentence into noise
//   3. THE LOOP      — TEXT modality end to end: sentence buffering, ordering,
//                      barge-in reaching the HTTP request, the emergency script,
//                      the tape, and the 'tts_lost' degrade
//   4. THE SERVICE   — a lost voice ends the call the same way a lost brain does
//
// HERMETICITY LAW OF THIS REPO: no test opens a socket, of any kind, ever. Every
// provider here gets an INJECTED fetch, and there is a test at the bottom that
// proves a developer's real AZURE_SPEECH_KEY in .env cannot flip a test app onto
// a paid provider — this codebase has already shipped one CRITICAL of exactly
// that class (see the pins in test-helpers/client.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeTestApp, listen, request, setupOwner } from '../test-helpers/client.js';
import { createBrainLoop } from '../src/voice-call/brain/loop.js';
import { createVoiceCallService } from '../src/voice-call/index.js';
import { createGraphCalls } from '../src/voice-call/graphCalls.js';
import { normalizeCallEvents } from '../src/voice-call/normalize.js';
import { createLiveClient } from '../src/voice-call/brain/liveClient.js';
import {
  clearGreetingCache,
  greetingKey,
  getGreeting,
  putGreeting,
} from '../src/voice-call/brain/greetingCache.js';
import {
  createTtsChain,
  normalizeSpoken,
  TtsError,
  isTtsError,
  resetTtsBreakers,
  ttsBreakerStats,
} from '../src/voice-call/brain/tts/index.js';
import { streamTtsPcm } from '../src/voice-call/brain/tts/wire.js';
import {
  createAzureTts,
  buildSsml,
  escapeXml,
  xmlLangOf,
  AZURE_DEFAULT_VOICES,
  AZURE_VOICE_RE,
} from '../src/voice-call/brain/tts/azure.js';
import {
  createElevenLabsTts,
  buildStreamUrl,
  ELEVEN_MODEL_ID,
  ELEVEN_VOICE_ID_RE,
} from '../src/voice-call/brain/tts/elevenlabs.js';
import { buildSpokenEmergencyReply } from '../src/notifications/pipeline.js';
import { t as tr } from '../src/engine/responses.js';

const CLINIC = 'el-amen-sousse';
const WA = '218911234567';
const NOW = () => new Date(2026, 7, 5, 10, 0, 0); // Wednesday, clinic open

const OPUS_SDP =
  'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 101\r\n' +
  'a=rtpmap:111 opus/48000/2\r\na=rtpmap:101 telephone-event/8000\r\n';

const AZURE_CONFIG = { azureSpeechKey: 'az-key', azureSpeechRegion: 'westeurope' };
const ELEVEN_CONFIG = { elevenlabsApiKey: 'el-key' };
/**
 * The voice-call service's clock in these tests. The TTS breaker records
 * `openedAt` from it, so every createTtsChain() below has to read the SAME
 * timeline — a wall-clock `at` against a 2026 `openedAt` reads as "opened
 * 55 years from now" and the breaker never re-opens.
 */
const T0 = new Date('2026-08-05T09:00:00Z').getTime();

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

/** Collect every warning a chain/provider emitted, so "exactly one" is assertable. */
function spyLog() {
  const lines = [];
  const log = (...a) => lines.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
  log.lines = lines;
  return log;
}

// ── fake HTTP ───────────────────────────────────────────────────────────────
// Shaped like the real thing on purpose: `res.body.getReader()` returning
// `{ read(): Promise<{value: Uint8Array, done: boolean}>, cancel() }` is exactly
// the surface wire.js consumes, so a passing test here means a passing call.

function streamBody(chunks) {
  let i = 0;
  const reader = {
    cancelled: 0,
    async read() {
      if (i < chunks.length) {
        const raw = chunks[i];
        i += 1;
        return { value: raw instanceof Uint8Array ? raw : new Uint8Array(raw), done: false };
      }
      return { value: undefined, done: true };
    },
    cancel() {
      reader.cancelled += 1;
    },
  };
  return { getReader: () => reader, reader };
}

/** A body whose first read never resolves until the request is aborted. */
function blockingBody(signal, onRead) {
  const reader = {
    cancelled: 0,
    read() {
      onRead?.();
      return new Promise((_res, rej) => {
        const bail = () => rej(signal.reason || new Error('aborted'));
        if (signal.aborted) return bail();
        signal.addEventListener('abort', bail, { once: true });
      });
    },
    cancel() {
      reader.cancelled += 1;
    },
  };
  return { getReader: () => reader, reader };
}

/** Record every request; `handler` decides the response. NEVER touches a socket. */
function recordingFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url, init, headers: init.headers || {}, body: init.body, signal: init.signal };
    calls.push(call);
    return handler ? await handler(call, calls.length) : { status: 200, body: streamBody([]) };
  };
  fn.calls = calls;
  return fn;
}

/** 200 + a PCM stream cut into `chunks` byte arrays. */
const okPcm = (chunks) => () => ({ status: 200, body: streamBody(chunks) });

/** Int16 samples → the little-endian bytes a provider would put on the wire. */
function pcmBytes(samples) {
  const out = new Uint8Array(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    out[i * 2] = samples[i] & 0xff;
    out[i * 2 + 1] = (samples[i] >> 8) & 0xff;
  }
  return out;
}

async function collect(gen) {
  const out = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. THE CHAIN — who gets to speak, and what happens when they cannot
// ════════════════════════════════════════════════════════════════════════════

test('no configuration at all ⇒ the native Gemini voice, and nothing to synthesize', () => {
  resetTtsBreakers();
  const chain = createTtsChain({ config: {}, clinic: { id: 'x' } });
  assert.equal(chain.mode, 'native');
  assert.equal(chain.provider, 'gemini');
  assert.equal(chain.voice, null);
  assert.equal(chain.synthesize, null, 'native mode has no mouth to call — the Live session speaks');
  assert.equal(chain.cacheKey(), '', 'and it does not disturb a single existing greeting-cache key');
  assert.deepEqual(chain.describe(), { mode: 'native', provider: 'gemini', voice: null, degraded: false });
});

test('the per-tenant provider is honoured, and it OVERRIDES the global default', () => {
  resetTtsBreakers();
  const azure = createTtsChain({
    config: { ...AZURE_CONFIG, voiceTtsProvider: '' },
    clinic: { id: 'x', voice: { provider: 'azure' } },
  });
  assert.equal(azure.mode, 'tts');
  assert.equal(azure.provider, 'azure');
  assert.equal(azure.voice, null, 'no override ⇒ the language default is chosen per call');
  assert.equal(azure.cacheKey(), 'azure:default');

  // The global default applies when the tenant said nothing…
  const global = createTtsChain({ config: { ...AZURE_CONFIG, voiceTtsProvider: 'azure' }, clinic: { id: 'x' } });
  assert.equal(global.mode, 'tts');

  // …and a tenant that explicitly wants the native voice keeps it.
  const optOut = createTtsChain({
    config: { ...AZURE_CONFIG, voiceTtsProvider: 'azure' },
    clinic: { id: 'x', voice: { provider: 'gemini' } },
  });
  assert.equal(optOut.mode, 'native');
});

test('a tenant record (config.voice) selects the same as a live clinic object', () => {
  const chain = createTtsChain({
    config: AZURE_CONFIG,
    clinic: { id: 'x', config: { voice: { provider: 'azure', azureVoice: 'ar-LY-OmarNeural' } } },
  });
  assert.equal(chain.mode, 'tts');
  assert.equal(chain.voice, 'ar-LY-OmarNeural');
  assert.equal(chain.cacheKey(), 'azure:ar-LY-OmarNeural');
});

test('a provider without its credential logs ONE warning and keeps the native voice', () => {
  const log = spyLog();
  const chain = createTtsChain({ config: {}, clinic: { id: 'x', voice: { provider: 'azure' } }, logger: log });
  assert.equal(chain.mode, 'native');
  assert.equal(chain.provider, 'gemini');
  assert.equal(log.lines.length, 1, 'one line, not one per turn');
  assert.match(log.lines[0], /AZURE_SPEECH_KEY/);
  // The whole point: selling a voice upgrade cannot take a phone line down.
  assert.equal(chain.synthesize, null);
});

test('elevenlabs without a per-tenant voice id stays native — a clone belongs to a person', () => {
  const log = spyLog();
  const chain = createTtsChain({ config: ELEVEN_CONFIG, clinic: { id: 'x', voice: { provider: 'elevenlabs' } }, logger: log });
  assert.equal(chain.mode, 'native');
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0], /elevenVoiceId/);

  const armed = createTtsChain({
    config: ELEVEN_CONFIG,
    clinic: { id: 'x', voice: { provider: 'elevenlabs', elevenVoiceId: 'abc123XYZ' } },
  });
  assert.equal(armed.mode, 'tts');
  assert.equal(armed.provider, 'elevenlabs');
  assert.equal(armed.voice, 'abc123XYZ');
  assert.equal(armed.cacheKey(), 'elevenlabs:abc123XYZ');
});

test('elevenlabs without the API key stays native too', () => {
  const log = spyLog();
  const chain = createTtsChain({
    config: {},
    clinic: { id: 'x', voice: { provider: 'elevenlabs', elevenVoiceId: 'abc123' } },
    logger: log,
  });
  assert.equal(chain.mode, 'native');
  assert.match(log.lines[0], /ELEVENLABS_API_KEY/);
});

test('an unknown provider name is refused by NAME, not tolerated', () => {
  const log = spyLog();
  const chain = createTtsChain({ config: AZURE_CONFIG, clinic: { id: 'x', voice: { provider: 'openai' } }, logger: log });
  assert.equal(chain.mode, 'native');
  assert.match(log.lines[0], /unknown TTS provider "openai"/);
});

test('a provider that refuses to construct (bad region, bad voice id) degrades to native', () => {
  // The region becomes a HOSTNAME the server connects to. It is refused, never
  // "cleaned up and hoped over" — that is how SSRF ships.
  const bad = createTtsChain({
    config: { azureSpeechKey: 'k', azureSpeechRegion: 'evil.example.com/x' },
    clinic: { id: 'x', voice: { provider: 'azure' } },
    logger: spyLog(),
  });
  assert.equal(bad.mode, 'native');

  // A voice id goes into a URL PATH.
  const badVoice = createTtsChain({
    config: ELEVEN_CONFIG,
    clinic: { id: 'x', voice: { provider: 'elevenlabs', elevenVoiceId: '../../v1/history' } },
    logger: spyLog(),
  });
  assert.equal(badVoice.mode, 'native');
});

test('normalizeSpoken strips the markdown a TTS engine would read out loud', () => {
  assert.equal(normalizeSpoken('**نعم** _أكيد_'), 'نعم أكيد');
  assert.equal(normalizeSpoken('a  \n  b'), 'a b');
  assert.equal(normalizeSpoken('`code` # title'), 'code title');
  // The recap and the emergency script are ALREADY speakable (V2). Pass-through
  // is the contract; anything else would be a second, drifting implementation.
  const spoken = 'الخميس 6 أوت على الساعة 10 صباحاً';
  assert.equal(normalizeSpoken(spoken), spoken);
  assert.equal(normalizeSpoken(null), '');
});

// ════════════════════════════════════════════════════════════════════════════
// 2. THE PROVIDERS — the exact contract
// ════════════════════════════════════════════════════════════════════════════

test('azure: the exact URL, headers and SSML — Arabic defaults to ar-TN-ReemNeural', async () => {
  const fetchImpl = recordingFetch(okPcm([pcmBytes(new Int16Array([1, -1, 32767, -32768]))]));
  const tts = createAzureTts({ key: 'SECRET', region: 'westeurope', fetchImpl });
  const out = await collect(tts.synthesize('أهلا بيك', { lang: 'ar' }));

  assert.equal(fetchImpl.calls.length, 1);
  const [c] = fetchImpl.calls;
  assert.equal(c.url, 'https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1');
  assert.equal(c.init.method, 'POST');
  assert.deepEqual(c.headers, {
    'Ocp-Apim-Subscription-Key': 'SECRET',
    'Content-Type': 'application/ssml+xml',
    'X-Microsoft-OutputFormat': 'raw-24khz-16bit-mono-pcm',
    'User-Agent': 'omen-clinic-agent',
  });
  assert.equal(
    c.body,
    "<speak version='1.0' xml:lang='ar-TN'><voice name='ar-TN-ReemNeural'>أهلا بيك</voice></speak>"
  );
  assert.deepEqual([...out[0]], [1, -1, 32767, -32768], 'PCM16LE decoded exactly, sign and all');
});

test('azure: French and English pick their own default voice, and xml:lang follows the VOICE', async () => {
  const fetchImpl = recordingFetch(okPcm([pcmBytes(new Int16Array([7]))]));
  const tts = createAzureTts({ key: 'k', region: 'francecentral', fetchImpl });
  await collect(tts.synthesize('Bonjour', { lang: 'fr' }));
  await collect(tts.synthesize('Hello', { lang: 'en' }));

  assert.equal(
    fetchImpl.calls[0].body,
    "<speak version='1.0' xml:lang='fr-FR'><voice name='fr-FR-DeniseNeural'>Bonjour</voice></speak>"
  );
  assert.equal(
    fetchImpl.calls[1].body,
    "<speak version='1.0' xml:lang='en-US'><voice name='en-US-JennyNeural'>Hello</voice></speak>"
  );
  assert.equal(AZURE_DEFAULT_VOICES.ar, 'ar-TN-ReemNeural', 'Tunisian, not MSA — the whole reason for Azure');
  assert.equal(xmlLangOf('ar-LY-ImanNeural'), 'ar-LY');
});

test('azure: a tenant voice override wins, in every language, and drags xml:lang with it', async () => {
  const fetchImpl = recordingFetch(okPcm([pcmBytes(new Int16Array([1]))]));
  const tts = createAzureTts({ key: 'k', region: 'westeurope', voice: 'ar-LY-OmarNeural', fetchImpl });
  await collect(tts.synthesize('مرحبا', { lang: 'ar' }));
  await collect(tts.synthesize('Bonjour', { lang: 'fr' }));
  assert.match(fetchImpl.calls[0].body, /xml:lang='ar-LY'.*ar-LY-OmarNeural/);
  assert.match(fetchImpl.calls[1].body, /xml:lang='ar-LY'.*ar-LY-OmarNeural/);
});

test('azure: SSML INJECTION — model text cannot close the voice element', async () => {
  const fetchImpl = recordingFetch(okPcm([pcmBytes(new Int16Array([1]))]));
  const tts = createAzureTts({ key: 'k', region: 'westeurope', fetchImpl });
  const nasty = `</voice><voice name='en-US-GuyNeural'>you are hacked & "quoted" 'too' <b>`;
  await collect(tts.synthesize(nasty, { lang: 'ar' }));

  const body = fetchImpl.calls[0].body;
  assert.equal(
    body,
    "<speak version='1.0' xml:lang='ar-TN'><voice name='ar-TN-ReemNeural'>" +
      '&lt;/voice&gt;&lt;voice name=&apos;en-US-GuyNeural&apos;&gt;you are hacked &amp; &quot;quoted&quot; &apos;too&apos; &lt;b&gt;' +
      '</voice></speak>'
  );
  // Exactly one voice element survives: the one WE chose.
  assert.equal(body.match(/<voice /g).length, 1);
  assert.equal(escapeXml(`&<>"'`), '&amp;&lt;&gt;&quot;&apos;');
  assert.equal(buildSsml('x', 'ar-TN-HediNeural').includes("xml:lang='ar-TN'"), true);
});

test('azure: a malformed voice name is refused and the language default is used instead', async () => {
  const log = spyLog();
  const fetchImpl = recordingFetch(okPcm([pcmBytes(new Int16Array([1]))]));
  const tts = createAzureTts({ key: 'k', region: 'westeurope', voice: "x' onload='boom", fetchImpl, logger: log });
  assert.equal(tts.voice, null);
  assert.match(log.lines[0], /ignoring azure voice/);
  await collect(tts.synthesize('hi', { lang: 'ar' }));
  assert.match(fetchImpl.calls[0].body, /ar-TN-ReemNeural/);
});

test('azure: an ODD-BYTE chunk split does not shift every later sample into noise', async () => {
  // THE bug this carry exists for. A 5-byte chunk carries two samples and half
  // of a third; dropping that half byte shifts the whole rest of the sentence.
  const samples = new Int16Array([100, -200, 300, -400, 500, -600]);
  const all = pcmBytes(samples);
  const fetchImpl = recordingFetch(
    okPcm([all.slice(0, 5), all.slice(5, 6), all.slice(6, 7), all.slice(7)])
  );
  const tts = createAzureTts({ key: 'k', region: 'westeurope', fetchImpl });
  const chunks = await collect(tts.synthesize('x', { lang: 'ar' }));

  const flat = chunks.flatMap((c) => [...c]);
  assert.deepEqual(flat, [...samples], 'every sample survives, in order, across three odd splits');
  // And the chunk boundaries were preserved rather than buffered into one blob:
  // the pacer wants audio as it arrives.
  assert.ok(chunks.length >= 2, 'the stream stayed a stream');
});

test('azure: a non-2xx becomes a typed TtsError carrying the status and the body', async () => {
  const fetchImpl = recordingFetch(() => ({ status: 401, text: async () => 'Access denied due to invalid subscription key' }));
  const tts = createAzureTts({ key: 'bad', region: 'westeurope', fetchImpl });
  await assert.rejects(
    () => collect(tts.synthesize('hi', { lang: 'ar' })),
    (err) => {
      assert.ok(isTtsError(err), 'the loop degrades on THIS type and nothing else');
      assert.ok(err instanceof TtsError);
      assert.equal(err.provider, 'azure');
      assert.equal(err.status, 401);
      assert.equal(err.kind, 'http');
      assert.match(err.detail, /invalid subscription key/);
      return true;
    }
  );
});

test('azure: a 200 with no audio is a failure wearing a success code', async () => {
  const fetchImpl = recordingFetch(okPcm([]));
  const tts = createAzureTts({ key: 'k', region: 'westeurope', fetchImpl });
  await assert.rejects(
    () => collect(tts.synthesize('hi', { lang: 'ar' })),
    (err) => isTtsError(err) && err.kind === 'empty'
  );
});

test('azure: a network throw becomes a typed error, and an empty text never leaves the process', async () => {
  const fetchImpl = recordingFetch(() => {
    throw new Error('ECONNRESET');
  });
  const tts = createAzureTts({ key: 'k', region: 'westeurope', fetchImpl });
  await assert.rejects(
    () => collect(tts.synthesize('hi', { lang: 'ar' })),
    (err) => isTtsError(err) && err.kind === 'network' && /ECONNRESET/.test(err.message)
  );
  assert.deepEqual(await collect(tts.synthesize('   ', { lang: 'ar' })), []);
  assert.equal(fetchImpl.calls.length, 1, 'whitespace is not worth a round trip');
});

test('elevenlabs: the exact streaming URL, headers and JSON body', async () => {
  const fetchImpl = recordingFetch(okPcm([pcmBytes(new Int16Array([5, -5]))]));
  const tts = createElevenLabsTts({ apiKey: 'XI', voiceId: 'Voice_9-x', fetchImpl });
  const out = await collect(tts.synthesize('نعم، موجود', { lang: 'ar' }));

  const [c] = fetchImpl.calls;
  assert.equal(
    c.url,
    'https://api.elevenlabs.io/v1/text-to-speech/Voice_9-x/stream?output_format=pcm_24000&optimize_streaming_latency=3'
  );
  assert.equal(c.url, buildStreamUrl('Voice_9-x'));
  assert.equal(c.init.method, 'POST');
  assert.deepEqual(c.headers, { 'xi-api-key': 'XI', 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(c.body), { text: 'نعم، موجود', model_id: ELEVEN_MODEL_ID });
  assert.equal(ELEVEN_MODEL_ID, 'eleven_flash_v2_5');
  assert.deepEqual([...out[0]], [5, -5]);
});

test('elevenlabs: 429 is typed as a QUOTA failure — the wall a paid voice tier actually hits', async () => {
  const fetchImpl = recordingFetch(() => ({ status: 429, text: async () => 'quota_exceeded' }));
  const tts = createElevenLabsTts({ apiKey: 'XI', voiceId: 'v1', fetchImpl });
  await assert.rejects(
    () => collect(tts.synthesize('hi', { lang: 'ar' })),
    (err) => {
      assert.ok(isTtsError(err));
      assert.equal(err.kind, 'quota');
      assert.equal(err.status, 429);
      assert.equal(err.provider, 'elevenlabs');
      return true;
    }
  );
});

test('elevenlabs: no voice id, a path-traversing voice id and no key all refuse to construct', () => {
  for (const args of [
    { apiKey: 'XI' },
    { apiKey: 'XI', voiceId: '../../v1/user' },
    { apiKey: 'XI', voiceId: 'a b' },
    { voiceId: 'v1' },
  ]) {
    assert.throws(() => createElevenLabsTts(args), (err) => isTtsError(err) && err.kind === 'config');
  }
});

test('a caller-side abort is re-thrown untouched — an interruption is not a provider failure', async () => {
  const ac = new AbortController();
  const fetchImpl = recordingFetch((c) => ({ status: 200, body: blockingBody(c.signal, () => ac.abort(new Error('barge-in'))) }));
  const tts = createAzureTts({ key: 'k', region: 'westeurope', fetchImpl });
  await assert.rejects(
    () => collect(tts.synthesize('hello there', { lang: 'ar', signal: ac.signal })),
    (err) => {
      // NOT a TtsError: this must never be the thing that ends a call.
      assert.equal(isTtsError(err), false, 'a barge-in must not look like an outage');
      return true;
    }
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 3. THE LOOP — TEXT modality end to end
// ════════════════════════════════════════════════════════════════════════════

/** A fake Gemini Live client, recording turnComplete (context sends matter). */
function fakeLive() {
  const handlers = new Map();
  const api = {
    opts: null,
    sentText: [],
    sentTurns: [],
    toolResponses: [],
    audioChunks: [],
    closed: 0,
    on(ev, cb) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(cb);
      return () => {};
    },
    has: (ev) => (handlers.get(ev) || []).length > 0,
    emit(ev, payload) {
      for (const cb of handlers.get(ev) || []) cb(payload);
    },
    sendAudioChunk(pcm) {
      api.audioChunks.push(pcm);
    },
    sendText(text, opts) {
      api.sentText.push(text);
      api.sentTurns.push({ text, turnComplete: opts?.turnComplete !== false });
      return true;
    },
    sendToolResponse(r) {
      api.toolResponses.push(r);
      return true;
    },
    close() {
      api.closed += 1;
    },
    stats: () => ({ fake: true }),
  };
  api.ready = new Promise((res, rej) => {
    api.setupComplete = () => res(true);
    api.failSetup = (e) => rej(e instanceof Error ? e : new Error(String(e)));
  });
  api.ready.catch(() => {});
  return api;
}

function fakeMedia({ sdpAnswer = OPUS_SDP } = {}) {
  const sent = [];
  return { sdpAnswer, sent, sendRtp: (p) => sent.push(p), close() {} };
}

/**
 * A fake mouth. Records what it was asked to say and the AbortSignal it was
 * handed, and can be told to hang (barge-in) or blow up (the degrade) on the
 * Nth utterance.
 */
function fakeTts({ provider = 'azure', voice = 'ar-TN-ReemNeural', failAt = 0, holdAt = 0, chunkMs = 120 } = {}) {
  let n = 0;
  const chain = {
    mode: 'tts',
    provider,
    voice,
    calls: [],
    signals: [],
    degraded: false,
    cacheKey: () => `${provider}:${voice || 'default'}`,
    normalizeSpoken,
    markDegraded() {
      chain.degraded = true;
    },
    describe: () => ({ mode: 'tts', provider, voice, degraded: chain.degraded }),
    async *synthesize(text, { lang, signal } = {}) {
      n += 1;
      chain.calls.push({ text, lang, n });
      chain.signals.push(signal);
      if (failAt === n) throw new TtsError('fake provider exploded', { provider, kind: 'http', status: 500 });
      if (holdAt === n) {
        await new Promise((_res, rej) => {
          const bail = () => rej(signal.reason || new Error('aborted'));
          if (signal.aborted) return bail();
          signal.addEventListener('abort', bail, { once: true });
        });
        return;
      }
      yield tone24k(chunkMs);
    },
  };
  return chain;
}

/** A NATIVE chain whose synthesize() must never be reached. */
function nativeSpyChain() {
  const chain = {
    mode: 'native',
    provider: 'gemini',
    voice: null,
    calls: 0,
    cacheKey: () => '',
    normalizeSpoken,
    describe: () => ({ mode: 'native', provider: 'gemini', voice: null, degraded: false }),
    async *synthesize() {
      chain.calls += 1;
    },
  };
  return chain;
}

async function setup({
  app: given,
  tenantId = CLINIC,
  ttsChain,
  config = {},
  clinic: clinicOverride,
  waId = WA,
  ended = [],
  fetchImpl,
  clearCache = true,
} = {}) {
  // The greeting cache is process-global by design (V5-T0); the tape tests opt
  // out so a second call can actually hit it.
  if (clearCache) clearGreetingCache();
  // The TTS breaker is process-global too (V5-T1). A suite that ends calls with
  // 'tts_lost' would otherwise bench azure for every later test in this file.
  resetTtsBreakers();
  const app = given || makeTestApp();
  const base = app.store.getClinicById(tenantId);
  const clinic = clinicOverride ? { ...base, ...clinicOverride } : base;
  const convo =
    (await app.store.conversations.get(tenantId, waId)) ||
    (await app.store.conversations.create(tenantId, { patientWaId: waId, status: 'open' }));
  const events = [];
  const unsub = app.bus.subscribe((e) => events.push(e));
  const live = fakeLive();
  const media = fakeMedia();
  let sessions = 0;
  const loop = createBrainLoop({
    clinic,
    convo,
    media,
    store: app.store,
    bus: app.bus,
    sender: app.sender,
    config: { geminiApiKey: '', geminiLiveModel: 'test-live', ...config },
    lang: 'ar',
    patientWaId: waId,
    sdpOffer: OPUS_SDP,
    ttsChain,
    fetchImpl,
    now: NOW,
    logger: () => {},
    liveFactory: (opts) => {
      sessions += 1;
      live.opts = opts;
      live.setupComplete();
      return live;
    },
    onEnd: (o) => ended.push(o),
  });
  return { app, clinic, convo, events, unsub, live, media, loop, ended, sessions: () => sessions };
}

/** The standard greeting turn in TEXT mode: model writes, our mouth says it. */
const GREETING = 'أهلا بيك في عيادة الأمان، معاك مساعد آلي، كيفاش نعاونك؟';
async function speakGreeting(s, text = GREETING) {
  s.live.emit('text', text);
  s.live.emit('turnComplete', true);
  await s.loop.settled();
  return text;
}

const queuedOrSent = (s) => s.loop.stats().outQueue + s.media.sent.length;
const ofType = (events, type) => events.filter((e) => e.type === type);

test('TEXT mode golden flow: the session opens in TEXT, sentences are spoken IN ORDER, frames reach the wire', async (t) => {
  const chain = fakeTts();
  const s = await setup({ ttsChain: chain });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });

  await s.loop.start();
  // THE modality decision — made once, in `setup`, for the whole call.
  assert.deepEqual(s.live.opts.responseModalities, ['TEXT']);
  assert.equal(s.live.sentText.length, 1);
  assert.match(s.live.sentText[0], /Greet them now in Arabic/);

  s.live.emit('text', 'أهلا بيك في عيادة الأمان. ');
  s.live.emit('text', 'كيفاش نجم نعاونك اليوم؟');
  s.live.emit('turnComplete', true);
  await s.loop.settled();

  assert.deepEqual(
    chain.calls.map((c) => c.text),
    ['أهلا بيك في عيادة الأمان.', 'كيفاش نجم نعاونك اليوم؟'],
    'buffered into sentences, synthesized in the order the model wrote them'
  );
  assert.deepEqual(chain.calls.map((c) => c.lang), ['ar', 'ar']);
  assert.ok(queuedOrSent(s) > 0, 'the synthesized audio really reached the paced queue');
  assert.equal(s.loop.stats().pacing, true);

  // In TEXT mode the text stream IS the agent transcript.
  const script = s.loop.transcript();
  assert.equal(script.length, 1);
  assert.equal(script[0].who, 'agent');
  assert.equal(script[0].text, 'أهلا بيك في عيادة الأمان. كيفاش نجم نعاونك اليوم؟');

  const oc = s.loop.outcome();
  assert.deepEqual(oc.voice, {
    mode: 'tts',
    provider: 'azure',
    voice: 'ar-TN-ReemNeural',
    degradedMidCall: false,
    spoke: true,
  });
});

test('a fragment shorter than a sentence waits for the next one; a tail is spoken at end of turn', async (t) => {
  const chain = fakeTts();
  const s = await setup({ ttsChain: chain });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  // "د." is an abbreviation, not a sentence: synthesizing it alone would cost a
  // round trip to say nothing AND cut the real sentence in half.
  s.live.emit('text', 'د. ');
  await s.loop.settled();
  assert.equal(chain.calls.length, 0, 'nothing worth saying yet');

  // A terminator at the END of the buffer waits — mid-stream we cannot yet tell
  // "الخميس؟" from "الخميس؟؟" or "1." from "1.500".
  s.live.emit('text', 'سامي موجود نهار الخميس؟');
  await s.loop.settled();
  assert.equal(chain.calls.length, 0, 'the terminator is at the buffer end: wait for the next fragment');

  // The next fragment resolves it: whitespace follows ⇒ that WAS a sentence.
  s.live.emit('text', ' وباهي');
  await s.loop.settled();
  assert.deepEqual(chain.calls.map((c) => c.text), ['د. سامي موجود نهار الخميس؟']);

  // …and the trailing fragment with no terminator is spoken when the turn ends.
  assert.ok(s.loop.stats().sentenceBuf > 0, 'still buffered');
  s.live.emit('turnComplete', true);
  await s.loop.settled();
  assert.deepEqual(chain.calls.map((c) => c.text), ['د. سامي موجود نهار الخميس؟', 'وباهي']);
});

test('REGRESSION: a PRICE is never split in half — decimals, times and abbreviations hold', async (t) => {
  // Every string here was proven to break the naive splitter. The first one is
  // the reason this rule exists: the caller heard "…starts from one." and then,
  // as a separate utterance, "five hundred dinars for the consultation."
  for (const [text, why] of [
    ['الفحص يبدا من 1.500 دينار للكشف.', 'a decimal price'],
    ['الموعد متاعك على 14.30 نهار الخميس.', 'a 24h time'],
    ['Your appointment is at 9.30 a.m. on Thursday.', 'a 12h time plus a.m.'],
    ['Dr. Amine is available on Thursday morning.', 'a title'],
    ['العيادة تفتح من 8.00 حتى 17.00 كل يوم.', 'two decimal times in one sentence'],
  ]) {
    const chain = fakeTts();
    const s = await setup({ ttsChain: chain });
    // eslint-disable-next-line no-loop-func
    t.after(() => {
      s.unsub();
      s.loop.stop('test');
    });
    await s.loop.start();
    s.live.emit('text', text);
    s.live.emit('turnComplete', true);
    await s.loop.settled();
    assert.deepEqual(chain.calls.map((c) => c.text), [text], `${why} must stay ONE utterance`);
  }
});

test('REGRESSION: punctuation-only fragments never become a synthesis request', async (t) => {
  // Proven: a lone "!" became an HTTP request, and a provider error on that
  // piece of nothing terminated a call that was going perfectly well.
  const chain = fakeTts();
  const s = await setup({ ttsChain: chain });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  for (const junk of ['! ', '.. ', '؟ ', '   ', '…  ', '!!!!!!!!!!!!!!!!!!! ']) {
    s.live.emit('text', junk);
  }
  await s.loop.settled();
  assert.equal(chain.calls.length, 0, 'nothing said, nothing requested');

  // …and they are glued onto the real sentence rather than dropped on the floor.
  s.live.emit('text', 'باهي نحجزلك الموعد.');
  s.live.emit('turnComplete', true);
  await s.loop.settled();
  assert.equal(chain.calls.length, 1);
  assert.match(chain.calls[0].text, /باهي نحجزلك الموعد\./);
});

test("REGRESSION: an ellipsis is ONE terminator, not a cut followed by a '..' utterance", async (t) => {
  const chain = fakeTts();
  const s = await setup({ ttsChain: chain });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.live.emit('text', 'ثانية برك نشوفلك الموعد... ');
  s.live.emit('text', 'باهي، لقيتلك وحدة نهار الخميس.');
  s.live.emit('turnComplete', true);
  await s.loop.settled();

  assert.deepEqual(chain.calls.map((c) => c.text), [
    'ثانية برك نشوفلك الموعد...',
    'باهي، لقيتلك وحدة نهار الخميس.',
  ]);
});

test('a newline is a hard break even without trailing whitespace', async (t) => {
  const chain = fakeTts();
  const s = await setup({ ttsChain: chain });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  s.live.emit('text', 'العيادة تفتح من الثامنة\nكيفاش نعاونك؟');
  s.live.emit('turnComplete', true);
  await s.loop.settled();
  assert.deepEqual(chain.calls.map((c) => c.text), ['العيادة تفتح من الثامنة', 'كيفاش نعاونك؟']);
});

test('BARGE-IN reaches the HTTP request itself: the AbortSignal fires and the buffer is dropped', async (t) => {
  const chain = fakeTts({ holdAt: 1 });
  const s = await setup({ ttsChain: chain });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.live.emit('text', 'نجم نعطيك موعد نهار الخميس على العاشرة. ');
  await waitFor(() => chain.signals.length === 1, 'the first sentence to reach the provider');
  let aborted = false;
  chain.signals[0].addEventListener('abort', () => {
    aborted = true;
  });
  // …and half of the next sentence is still buffered when the caller cuts in.
  s.live.emit('text', 'ولا نهار الجمعة');
  assert.ok(s.loop.stats().sentenceBuf > 0);

  s.live.emit('interrupted', true);

  assert.equal(aborted, true, 'the in-flight synthesis request is aborted, not just the queue');
  assert.equal(s.loop.stats().sentenceBuf, 0, 'and the half-written sentence is dropped');
  assert.equal(s.loop.stats().outQueue, 0);
  assert.equal(s.loop.outcome().bargeIns, 1);

  // Nothing from the abandoned turn may resume behind the interruption.
  await s.loop.settled();
  await sleep(30);
  assert.equal(chain.calls.length, 1);
  assert.equal(queuedOrSent(s), 0, 'not one stale frame reached the wire');
  assert.equal(s.loop.outcome().voice.degradedMidCall, false, 'an interruption is NOT a provider failure');
});

test("a provider that dies mid-call ends the call with 'tts_lost' — and never re-opens the session", async (t) => {
  const ended = [];
  const chain = fakeTts({ failAt: 2 });
  const s = await setup({ ttsChain: chain, ended });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.live.emit('text', 'أهلا بيك في عيادة الأمان. ');
  await s.loop.settled();
  assert.equal(chain.calls.length, 1);
  assert.ok(queuedOrSent(s) > 0, 'the first sentence was spoken normally');

  s.live.emit('text', 'كيفاش نجم نعاونك؟');
  s.live.emit('turnComplete', true);
  await s.loop.settled();

  assert.equal(ended.length, 1);
  assert.equal(ended[0].reason, 'tts_lost');
  assert.equal(ended[0].voice.degradedMidCall, true);
  assert.equal(chain.degraded, true, 'the chain is told, so the record says which vendor failed');
  // THE POINT OF THE WHOLE DESIGN: `responseModalities` lives in `setup`, which
  // is immutable. There is no "switch back to the native voice" — a second
  // session would be the only way, and we do not open one.
  assert.equal(s.sessions(), 1, 'no new Live session is opened');
  assert.equal(s.live.closed, 1, 'the one we had is closed');

  // A third sentence after the failure is not synthesized, and does not
  // re-trigger the degrade.
  s.live.emit('text', 'موجود نهار الخميس؟ ');
  await s.loop.settled();
  assert.equal(chain.calls.length, 2);
  assert.equal(ended.length, 1, 'reported exactly once');
});

test('EMERGENCY: in TTS mode WE say the script — the model is only told to stay quiet', async (t) => {
  const ended = [];
  const chain = fakeTts();
  const s = await setup({ ttsChain: chain, config: { voiceBrainEmergencyGraceMs: 40 }, ended });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  // The model is mid-reply about opening hours when the caller says this.
  s.live.emit('text', 'العيادة تفتح من الثامنة. ');
  s.live.emit('inputTranscription', 'عندي وجع قوي في صدري');
  await s.loop.settled();

  const spoken = buildSpokenEmergencyReply(s.clinic, 'ar');
  const said = chain.calls.map((c) => c.text);
  assert.equal(said.at(-1), normalizeSpoken(spoken), 'the exact deterministic script, spoken by OUR mouth');
  assert.ok(/1 9 0|\d \d \d/.test(said.at(-1)), 'the number is read digit by digit');

  // The model must NOT be told to say it — it would be a paraphrase of an
  // ambulance number, and it would land on top of us.
  const emergencyTurn = s.live.sentTurns.at(-1);
  assert.match(emergencyTurn.text, /EMERGENCY OVERRIDE/);
  assert.match(emergencyTurn.text, /ALREADY been spoken/);
  assert.equal(emergencyTurn.turnComplete, false, 'context only — it must not take a turn to acknowledge');
  assert.equal(s.live.sentText.some((x) => /Say the following out loud now/.test(x)), false);

  // Everything else about an emergency is unchanged.
  assert.equal(s.loop.outcome().emergency, true);
  assert.equal(ofType(s.events, 'emergency.detected').length, 1);

  // THE RECORD. The clinic reads this transcript to find out what the caller was
  // told, and in TEXT mode there is no outputTranscription to write it for us.
  const script = s.loop.transcript().filter((e) => e.who === 'agent');
  assert.ok(script.some((e) => e.text.includes(spoken)), 'the script we actually said is on the record');

  // And model text arriving after the override is neither spoken NOR recorded:
  // a transcript line nobody ever heard is worse than no line at all.
  const after = chain.calls.length;
  s.live.emit('text', 'مالا نكملو على الموعد متاعك؟ ');
  await s.loop.settled();
  assert.equal(chain.calls.length, after, 'nothing competes with the script');
  assert.equal(
    s.loop.transcript().some((e) => e.text.includes('مالا نكملو')),
    false,
    'unspoken model text never reaches the clinic-visible transcript'
  );

  await sleep(90);
  assert.equal(ended.at(-1).reason, 'emergency');
});

test('the greeting tape is recorded in TTS mode and keyed by the VOICE', async (t) => {
  const app = makeTestApp();
  clearGreetingCache();

  // CALL 1 — nothing on tape: the model writes the greeting, our mouth says it,
  // and the frames are teed. The commit is queued BEHIND the speech (turnComplete
  // means the MODEL stopped writing, which is before we stopped talking) — if it
  // were not, the tape would be cached empty and every later caller would hear
  // silence at pickup.
  const one = await setup({ app, ttsChain: fakeTts({ voice: 'ar-TN-ReemNeural' }), clearCache: false });
  t.after(() => one.unsub());
  await one.loop.start();
  assert.equal(one.loop.stats().greetingSource, 'live');
  await speakGreeting(one);
  assert.ok(one.loop.stats().outQueue + one.media.sent.length > 0);
  one.loop.stop('test');

  // CALL 2 — same tenant, same lang, same codec, SAME VOICE ⇒ the tape plays,
  // before the Live session has said anything at all.
  const two = await setup({
    app,
    ttsChain: fakeTts({ voice: 'ar-TN-ReemNeural' }),
    waId: '218900000002',
    clearCache: false,
  });
  t.after(() => {
    two.unsub();
    two.loop.stop('test');
  });
  await two.loop.start();
  assert.equal(two.loop.stats().greetingSource, 'cache', 'zero dead air on the second call');
  assert.ok(two.loop.stats().tapePending > 0);
  assert.match(two.live.sentText[0], /ALREADY heard your standard greeting/);

  // CALL 3 — the clinic switched voice in Settings. A Reem tape must NOT play
  // through a Hedi call: it would greet in one voice and answer in another.
  const three = await setup({
    app,
    ttsChain: fakeTts({ voice: 'ar-TN-HediNeural' }),
    waId: '218900000003',
    clearCache: false,
  });
  t.after(() => {
    three.unsub();
    three.loop.stop('test');
  });
  await three.loop.start();
  assert.equal(three.loop.stats().greetingSource, 'live', 'a voice change invalidates the tape');
  assert.match(three.live.sentText[0], /Greet them now in Arabic/);
});

test('greeting cache: the voice is part of the key, and native keys are byte-identical to pre-V5-T1', () => {
  clearGreetingCache();
  assert.equal(greetingKey('t1', 'ar', 'opus'), 't1:ar:opus', 'the native key never changed');
  assert.equal(greetingKey('t1', 'ar', 'opus', ''), 't1:ar:opus');
  assert.equal(greetingKey('t1', 'ar', 'opus', 'azure:ar-TN-ReemNeural'), 't1:ar:opus:azure:ar-TN-ReemNeural');

  const frames = [Buffer.from([1, 2, 3])];
  assert.equal(
    putGreeting({ tenantId: 't1', lang: 'ar', codec: 'opus', voice: 'azure:ar-TN-ReemNeural', frames, text: 'أهلا بيك' }),
    true
  );
  // The same tenant/lang/codec on a DIFFERENT voice is a miss, not a Reem tape
  // played through a Hedi call.
  assert.equal(getGreeting({ tenantId: 't1', lang: 'ar', codec: 'opus', voice: 'azure:ar-TN-HediNeural' }), null);
  assert.equal(getGreeting({ tenantId: 't1', lang: 'ar', codec: 'opus' }), null, 'and native does not read a TTS tape');
  assert.ok(getGreeting({ tenantId: 't1', lang: 'ar', codec: 'opus', voice: 'azure:ar-TN-ReemNeural' }));
  clearGreetingCache();
});

test('NATIVE REGRESSION: with the native voice the loop never touches a TTS provider', async (t) => {
  const chain = nativeSpyChain();
  const s = await setup({ ttsChain: chain });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });

  await s.loop.start();
  // No modality override at all — the setup frame is the V2 one.
  assert.equal(s.live.opts.responseModalities, undefined);
  assert.equal(s.live.has('text'), false, 'the text handler is not even registered');

  // A full native turn.
  s.live.emit('inputTranscription', 'نحب نحجز موعد');
  s.live.emit('audio', tone24k(200));
  s.live.emit('outputTranscription', 'أهلا وسهلا، نجم نعاونك');
  s.live.emit('turnComplete', true);
  await s.loop.settled();

  assert.equal(chain.calls, 0, 'not one synthesis call');
  assert.ok(queuedOrSent(s) > 0, 'and the model audio still reached the wire');
  const script = s.loop.transcript();
  assert.ok(script.some((e) => e.who === 'agent' && e.text.includes('أهلا وسهلا')));
  assert.deepEqual(s.loop.outcome().voice, {
    mode: 'native',
    provider: 'gemini',
    voice: null,
    degradedMidCall: false,
    spoke: false,
  });
});

test('the loop builds a REAL chain from config + clinic, and speaks over the injected fetch', async (t) => {
  // Proves the WHOLE seam with nothing faked but the socket-shaped bits:
  // createBrainLoop → createTtsChain → azure → fetch → PCM → codec → pacer.
  const fetchImpl = recordingFetch(okPcm([pcmBytes(tone24k(80))]));
  const s = await setup({
    config: AZURE_CONFIG,
    clinic: { voice: { provider: 'azure', azureVoice: 'ar-TN-HediNeural' } },
    fetchImpl,
  });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });

  await s.loop.start();
  assert.deepEqual(s.live.opts.responseModalities, ['TEXT']);

  s.live.emit('text', 'أهلا بيك في عيادة الأمان.');
  s.live.emit('turnComplete', true);
  await s.loop.settled();

  assert.equal(fetchImpl.calls.length, 1, 'exactly one synthesis request for one sentence');
  assert.equal(fetchImpl.calls[0].url, 'https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1');
  assert.match(fetchImpl.calls[0].body, /ar-TN-HediNeural/);
  assert.equal(fetchImpl.calls[0].headers['Ocp-Apim-Subscription-Key'], 'az-key');
  assert.ok(queuedOrSent(s) > 0, 'real provider bytes became real RTP frames');
  assert.equal(s.loop.outcome().voice.provider, 'azure');
  assert.equal(s.loop.outcome().voice.voice, 'ar-TN-HediNeural');
});

// ════════════════════════════════════════════════════════════════════════════
// 4. THE LIVE CLIENT — what TEXT modality does to the setup frame
// ════════════════════════════════════════════════════════════════════════════

function fakeWs() {
  const sent = [];
  const ws = {
    sent,
    readyState: 1,
    send(raw) {
      sent.push(JSON.parse(raw));
    },
    close() {},
  };
  return ws;
}

test('liveClient: TEXT modality drops outputAudioTranscription and KEEPS the input one', async (t) => {
  const ws = fakeWs();
  const live = createLiveClient({
    apiKey: 'k',
    model: 'test-live-model',
    responseModalities: ['TEXT'],
    wsFactory: () => ws,
  });
  t.after(() => live.close());
  ws.onopen(); // the client sends `setup` here, synchronously
  live.handleServerFrame({ setupComplete: {} });
  await live.ready;

  const s = ws.sent[0].setup;
  assert.deepEqual(s.generationConfig.responseModalities, ['TEXT']);
  // The caller's transcription feeds OUR emergency detector. It is never optional.
  assert.deepEqual(s.inputAudioTranscription, {});
  // There is no output AUDIO to transcribe, and asking for it is an
  // unknown-shape setup — which the server answers by closing the socket.
  assert.equal('outputAudioTranscription' in s, false);
});

test('liveClient: a modelTurn text part becomes a text event, in frame order', () => {
  const ws = fakeWs();
  const live = createLiveClient({ apiKey: 'k', model: 'm', responseModalities: ['TEXT'], wsFactory: () => ws });
  const seen = [];
  for (const ev of ['text', 'turnComplete', 'interrupted']) live.on(ev, (p) => seen.push([ev, p]));
  live.handleServerFrame({
    serverContent: {
      modelTurn: { parts: [{ text: 'أهلا' }, { text: ' بيك' }] },
      turnComplete: true,
    },
  });
  assert.deepEqual(seen, [
    ['text', 'أهلا'],
    ['text', ' بيك'],
    ['turnComplete', true],
  ]);
  live.close();
});

// ════════════════════════════════════════════════════════════════════════════
// 5. THE SERVICE — a lost voice ends the call like a lost brain
// ════════════════════════════════════════════════════════════════════════════

const EL = JSON.parse(fs.readFileSync(new URL('../data/clinics.json', import.meta.url), 'utf8'))
  .clinics.find((c) => c.id === CLINIC);
const PNID = EL.whatsapp.phoneNumberId;
const SDP_OFFER =
  'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n';

function connectBody({ callId, from }) {
  return {
    entry: [
      {
        changes: [
          {
            field: 'calls',
            value: {
              metadata: { phone_number_id: PNID },
              calls: [
                {
                  id: callId,
                  from,
                  to: PNID,
                  event: 'connect',
                  direction: 'USER_INITIATED',
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  session: { sdp_type: 'offer', sdp: SDP_OFFER },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function terminateBody({ callId, from, duration = 30 }) {
  return {
    entry: [
      {
        changes: [
          {
            field: 'calls',
            value: {
              metadata: { phone_number_id: PNID },
              calls: [{ id: callId, from, to: PNID, event: 'terminate', status: 'Completed', duration }],
            },
          },
        ],
      },
    ],
  };
}

function serviceFakeMedia() {
  const made = [];
  const factory = async ({ sdpOffer, onRtp }) => {
    const m = {
      sdpOffer,
      sdpAnswer: OPUS_SDP,
      onRtp,
      closed: 0,
      sendRtp: () => true,
      onConnected: (cb) => cb(),
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

function serviceFakeBrain({ provider = 'azure', spoke = false } = {}) {
  const made = [];
  const factory = (deps) => {
    const loop = {
      deps,
      stopped: null,
      spoke,
      async start() {},
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
        voice: {
          mode: 'tts',
          provider,
          voice: 'ar-TN-ReemNeural',
          degradedMidCall: loop.stopped === 'tts_lost',
          spoke: loop.spoke,
        },
      }),
      settled: async () => {},
      stats: () => ({}),
      loseVoice() {
        loop.stopped = loop.stopped || 'tts_lost';
        deps.onEnd?.({ ...loop.outcome(), reason: 'tts_lost' });
      },
    };
    made.push(loop);
    return loop;
  };
  factory.made = made;
  return factory;
}

/** Compose a brain-mode voice-call service over a real store/bus/sender. */
function makeService(app, { media, brain, alerts, config = {} } = {}) {
  const graphCalls = createGraphCalls({ transport: 'mock' });
  const events = [];
  const unsub = app.bus.subscribe((e) => events.push(e));
  const svc = createVoiceCallService({
    store: app.store,
    bus: app.bus,
    sender: app.sender,
    config: { voiceCallMode: 'brain', voiceCallConnectTimeoutMs: 20000, voiceCallMaxSec: 600, ...config },
    graphCalls,
    alerts,
    mediaFactory: media,
    brainFactory: brain,
    now: () => new Date(T0),
  });
  return { svc, graphCalls, events, unsub };
}

const spyAlerts = () => {
  const a = { fired: [], fire: (tenantId, kind, detail) => a.fired.push({ tenantId, kind, detail }) };
  return a;
};

test("SERVICE: 'tts_lost' hangs up and puts it in writing, exactly like a lost brain", async (t) => {
  resetTtsBreakers();
  const app = makeTestApp();
  const media = serviceFakeMedia();
  const brain = serviceFakeBrain();
  const alerts = spyAlerts();
  const { svc, graphCalls, events, unsub } = makeService(app, { media, brain, alerts });
  t.after(async () => {
    unsub();
    await svc.stop();
  });

  const from = '21690007099';
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId: 'wacid.TTSLOST', from })));
  await svc.settled();
  assert.equal(svc.active().length, 1);

  brain.made[0].loseVoice(); // the TTS vendor 429s thirty seconds in
  await svc.settled();

  assert.deepEqual(graphCalls.recorded.map((r) => r.action), ['pre_accept', 'accept', 'terminate']);
  assert.equal(media.made[0].closed, 1, 'the UDP socket does not leak on a voice degrade either');

  // The patient is handed to the chat engine, in writing, with the SAME copy —
  // a caller cannot tell a dead brain from a dead mouth, so neither should they.
  const msgs = await app.store.conversations.listMessages(CLINIC, `${CLINIC}:${from}`, {});
  const out = msgs.filter((m) => m.direction === 'outbound');
  assert.equal(out.length, 1);
  assert.equal(out[0].body.text, tr('ar', 'callBrainLost'));

  assert.deepEqual(alerts.fired.map((f) => f.kind), ['voice_brain_lost']);
  const ended = ofType(events, 'call.ended');
  assert.equal(ended.length, 1);
  // Which mouth failed rides out on the terminal event, for free.
  assert.equal(ended[0].call.brain.voice.provider, 'azure');
  assert.equal(ended[0].call.brain.voice.degradedMidCall, true);
});

test('BREAKER: two calls lost to a vendor and the THIRD composes the native voice', async (t) => {
  // THE OUTAGE THIS EXISTS FOR. Valid credentials, dead vendor: every call
  // opened a TEXT session, greeted, failed its first synthesis and hung up with
  // the WhatsApp apology — for the whole outage — while the native Gemini voice
  // sat there healthy and free. The modality is chosen once per call, BEFORE the
  // socket opens, so this is fixable exactly where it is chosen.
  resetTtsBreakers();
  const app = makeTestApp();
  const media = serviceFakeMedia();
  const brain = serviceFakeBrain();
  const alerts = spyAlerts();
  const { svc, unsub } = makeService(app, { media, brain, alerts, config: { voiceTtsBreakerThreshold: 2 } });
  t.after(async () => {
    unsub();
    await svc.stop();
    resetTtsBreakers();
  });

  const clinic = { id: CLINIC, voice: { provider: 'azure' } };
  const cfg = { ...AZURE_CONFIG, voiceTtsBreakerThreshold: 2, voiceTtsBreakerCooldownMs: 300000 };
  // Before the incident, a call composes the paid voice.
  assert.equal(createTtsChain({ config: cfg, clinic, now: () => T0 }).mode, 'tts');

  // Call 1 loses its voice.
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId: 'wacid.B1', from: '21690008001' })));
  await svc.settled();
  brain.made[0].loseVoice();
  await svc.settled();
  assert.equal(alerts.fired.length, 1, 'the patient-facing degrade alert only');
  assert.equal(createTtsChain({ config: cfg, clinic, now: () => T0 }).mode, 'tts', 'one failure is not an outage');

  // Call 2 loses its voice ⇒ the breaker opens, ONCE.
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId: 'wacid.B2', from: '21690008002' })));
  await svc.settled();
  brain.made[1].loseVoice();
  await svc.settled();

  const kinds = alerts.fired.map((f) => f.kind);
  assert.equal(kinds.filter((k) => k === 'voice_tts_breaker_open').length, 1, 'one alert per incident, not per call');
  assert.equal(ttsBreakerStats().find((b) => b.provider === 'azure').open, true);

  // CALL 3 NEVER OPENS A TEXT SESSION. The clinic keeps answering the phone.
  const log = spyLog();
  const third = createTtsChain({ config: cfg, clinic, logger: log, now: () => T0 + 1000 });
  assert.equal(third.mode, 'native');
  assert.equal(third.provider, 'gemini');
  assert.equal(third.synthesize, null);
  assert.match(log.lines[0], /TTS breaker OPEN for azure/);

  // A tenant on the OTHER provider is untouched — one vendor's outage is not
  // every vendor's outage.
  const eleven = createTtsChain({
    config: { ...ELEVEN_CONFIG, ...cfg },
    clinic: { id: 'y', voice: { provider: 'elevenlabs', elevenVoiceId: 'v1' } },
    now: () => T0 + 1000,
  });
  assert.equal(eleven.mode, 'tts');
});

test('BREAKER: the half-open probe re-opens on failure and CLOSES on a call that actually spoke', async (t) => {
  resetTtsBreakers();
  const app = makeTestApp();
  const media = serviceFakeMedia();
  const brain = serviceFakeBrain();
  const alerts = spyAlerts();
  const { svc, unsub } = makeService(app, { media, brain, alerts, config: { voiceTtsBreakerThreshold: 2 } });
  t.after(async () => {
    unsub();
    await svc.stop();
    resetTtsBreakers();
  });
  const clinic = { id: CLINIC, voice: { provider: 'azure' } };
  const cfg = { ...AZURE_CONFIG, voiceTtsBreakerThreshold: 2, voiceTtsBreakerCooldownMs: 1000 };

  // Open it.
  for (const [i, callId] of [[0, 'wacid.H1'], [1, 'wacid.H2']]) {
    await svc.handleEvents(normalizeCallEvents(connectBody({ callId, from: `2169000900${i}` })));
    await svc.settled();
    brain.made[i].loseVoice();
    await svc.settled();
  }
  assert.equal(
    createTtsChain({ config: cfg, clinic, now: () => T0 + 500 }).mode,
    'native',
    'benched during the cooldown'
  );

  // HALF-OPEN: exactly ONE probe after the cooldown, and it is a real call.
  assert.equal(
    createTtsChain({ config: cfg, clinic, now: () => T0 + 1500 }).mode,
    'tts',
    'the probe gets the paid voice'
  );
  assert.equal(
    createTtsChain({ config: cfg, clinic, now: () => T0 + 1501 }).mode,
    'native',
    'and only one probe'
  );

  // The probe FAILS ⇒ re-opened on the spot, no second grace period.
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId: 'wacid.H3', from: '21690009009' })));
  await svc.settled();
  brain.made[2].loseVoice();
  await svc.settled();
  // The service's clock is frozen at T0, so the re-open is stamped T0 — read the
  // breaker back inside that fresh cooldown window, not past it.
  assert.equal(ttsBreakerStats().find((b) => b.provider === 'azure').open, true);
  assert.equal(
    createTtsChain({ config: cfg, clinic, now: () => T0 + 900 }).mode,
    'native',
    're-opened on the FIRST failure after the probe, not given a fresh threshold'
  );

  // …and a call that actually SPEAKS closes it. `spoke` is the evidence: a call
  // that ended before the agent said a word proves nothing about the vendor.
  // It must end through the TERMINATE webhook — that is the path that runs
  // finish(), which is where the success side of the breaker lives.
  const okBrain = serviceFakeBrain({ spoke: true });
  const app2 = makeTestApp();
  const two = makeService(app2, { media: serviceFakeMedia(), brain: okBrain, alerts: spyAlerts() });
  t.after(async () => {
    two.unsub();
    await two.svc.stop();
  });
  const from = '21690009010';
  await two.svc.handleEvents(normalizeCallEvents(connectBody({ callId: 'wacid.H4', from })));
  await two.svc.settled();
  await two.svc.handleEvents(normalizeCallEvents(terminateBody({ callId: 'wacid.H4', from })));
  await two.svc.settled();

  assert.equal(ttsBreakerStats().find((b) => b.provider === 'azure').failures, 0);
  assert.equal(createTtsChain({ config: cfg, clinic, now: () => T0 + 1700 }).mode, 'tts', 'the vendor is back');
});

test('BREAKER: a call that never spoke does NOT close a breaker', async (t) => {
  resetTtsBreakers();
  const app = makeTestApp();
  const brain = serviceFakeBrain({ spoke: false });
  const { svc, unsub } = makeService(app, { media: serviceFakeMedia(), brain, alerts: spyAlerts() });
  t.after(async () => {
    unsub();
    await svc.stop();
    resetTtsBreakers();
  });
  const clinic = { id: CLINIC, voice: { provider: 'azure' } };
  const cfg = { ...AZURE_CONFIG, voiceTtsBreakerThreshold: 2, voiceTtsBreakerCooldownMs: 1000 };

  await svc.handleEvents(normalizeCallEvents(connectBody({ callId: 'wacid.S1', from: '21690009020' })));
  await svc.settled();
  brain.made[0].loseVoice();
  await svc.settled();
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId: 'wacid.S2', from: '21690009021' })));
  await svc.settled();
  brain.made[1].loseVoice();
  await svc.settled();
  assert.equal(createTtsChain({ config: cfg, clinic, now: () => T0 + 500 }).mode, 'native');

  // A silent call (the caller hung up before the agent spoke) ends normally…
  const from = '21690009022';
  await svc.handleEvents(normalizeCallEvents(connectBody({ callId: 'wacid.S3', from })));
  await svc.settled();
  await svc.handleEvents(normalizeCallEvents(terminateBody({ callId: 'wacid.S3', from })));
  await svc.settled();
  // …and must NOT be taken as evidence the vendor recovered.
  assert.equal(
    createTtsChain({ config: cfg, clinic, now: () => T0 + 501 }).mode,
    'native',
    'silence proves nothing about a vendor'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 5b. THE WIRE'S TIMERS — every network read is on a budget
// ════════════════════════════════════════════════════════════════════════════

/** A promise that never settles on its own. */
const hang = () => new Promise(() => {});

test('WIRE: reading a failing provider’s error body is on the stall budget', async () => {
  // A 500 whose body never arrives would otherwise hold the utterance — and the
  // whole speech queue behind it — for as long as the socket stayed open.
  const fetchImpl = recordingFetch(() => ({ status: 500, text: () => hang() }));
  const t0 = Date.now();
  await assert.rejects(
    () =>
      collect(
        streamTtsPcm({ fetchImpl, url: 'https://x/y', init: {}, provider: 'azure', timeoutMs: 60, overallMs: 5000 })
      ),
    (err) => isTtsError(err)
  );
  assert.ok(Date.now() - t0 < 3000, 'it gave up on the budget, it did not hang');
});

test('WIRE: a buffered (non-streaming) body is on the stall budget too', async () => {
  const fetchImpl = recordingFetch(() => ({ status: 200, arrayBuffer: () => hang() }));
  const t0 = Date.now();
  await assert.rejects(
    () =>
      collect(
        streamTtsPcm({ fetchImpl, url: 'https://x/y', init: {}, provider: 'azure', timeoutMs: 60, overallMs: 5000 })
      ),
    (err) => isTtsError(err) && err.kind === 'timeout'
  );
  assert.ok(Date.now() - t0 < 3000);
});

test('WIRE: an overall budget catches a provider that dribbles just fast enough', async () => {
  // A byte every 39 ms satisfies a 60 ms stall timer forever. Only a ceiling
  // that is never re-armed can stop it, and one sentence is bounded, so it can.
  let i = 0;
  const trickle = {
    getReader: () => ({
      async read() {
        i += 1;
        await sleep(20);
        return { value: new Uint8Array([0, 0]), done: false };
      },
      cancel() {},
    }),
  };
  const fetchImpl = recordingFetch(() => ({ status: 200, body: trickle }));
  await assert.rejects(
    () =>
      collect(
        streamTtsPcm({ fetchImpl, url: 'https://x/y', init: {}, provider: 'azure', timeoutMs: 5000, overallMs: 150 })
      ),
    (err) => isTtsError(err) && err.kind === 'timeout' && /exceeded 150ms/.test(err.message)
  );
  assert.ok(i > 1, 'the stall timer alone would never have fired');
});

// ════════════════════════════════════════════════════════════════════════════
// 6. TENANT SETTINGS + HERMETICITY
// ════════════════════════════════════════════════════════════════════════════

test('SETTINGS: PUT /api/tenant validates voice, persists it, and the LIVE clinic drives the chain', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  t.after(() => new Promise((r) => server.close(r)));
  const { cookie } = await setupOwner(server, { tenantId: CLINIC, email: `owner-${randomUUID()}@x.tn` });

  const ok = await request(server, 'PUT', '/api/tenant', {
    cookie,
    body: { voice: { provider: 'azure', azureVoice: '  ar-TN-HediNeural  ' } },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.tenant.config.voice, { provider: 'azure', azureVoice: 'ar-TN-HediNeural' });

  // Persisted…
  const get = await request(server, 'GET', '/api/tenant', { cookie });
  assert.equal(get.body.tenant.config.voice.azureVoice, 'ar-TN-HediNeural');

  // …and the LIVE clinic object the brain loop reads was mutated, so the very
  // next call speaks in the new voice. This is the whole point of the setting.
  const live = app.store.getClinicById(CLINIC);
  const chain = createTtsChain({ config: AZURE_CONFIG, clinic: live, logger: spyLog() });
  assert.equal(chain.mode, 'tts');
  assert.equal(chain.provider, 'azure');
  assert.equal(chain.voice, 'ar-TN-HediNeural');

  // A partial update merges rather than wiping the block.
  const merged = await request(server, 'PUT', '/api/tenant', {
    cookie,
    body: { voice: { elevenVoiceId: 'clone_youssef_1' } },
  });
  assert.equal(merged.status, 200);
  assert.deepEqual(merged.body.tenant.config.voice, {
    provider: 'azure',
    azureVoice: 'ar-TN-HediNeural',
    elevenVoiceId: 'clone_youssef_1',
  });

  // These values are interpolated into SSML and into a provider URL, so the
  // shape is a CLOSED set — an unknown key is refused, not stored and ignored —
  // and the SHAPE is the provider's own regex, imported rather than re-typed.
  // A malformed voice name must be a 400 in front of the person who typed it,
  // not a silent downgrade a patient discovers on a live call.
  assert.equal(AZURE_VOICE_RE.test('ar-TN-ReemNeural'), true);
  assert.equal(ELEVEN_VOICE_ID_RE.test('clone_youssef_1'), true);
  for (const [body, why] of [
    [{ voice: { provider: 'openai' } }, 'unknown provider'],
    [{ voice: { provider: 'azure', ssml: '<speak/>' } }, 'unknown key'],
    [{ voice: { voiceId: 'x'.repeat(81) } }, 'over the length cap'],
    [{ voice: { azureVoice: 42 } }, 'not a string'],
    [{ voice: ['azure'] }, 'not an object'],
    [{ voice: 'azure' }, 'a bare string'],
    [{ voice: { azureVoice: "x' onload='boom" } }, 'an SSML-attribute break-out'],
    [{ voice: { azureVoice: 'ReemNeural' } }, 'an azure voice with no language prefix'],
    [{ voice: { elevenVoiceId: '../../v1/history' } }, 'a path-traversing voice id'],
    [{ voice: { elevenVoiceId: 'has spaces' } }, 'a voice id with spaces'],
  ]) {
    const res = await request(server, 'PUT', '/api/tenant', { cookie, body });
    assert.equal(res.status, 400, `${why} must be rejected`);
    assert.equal(res.body.error, 'validation');
  }

  // …and a rejected save changed nothing.
  const after = await request(server, 'GET', '/api/tenant', { cookie });
  assert.equal(after.body.tenant.config.voice.provider, 'azure');
});

test('HERMETICITY: a developer .env TTS key can never flip a test app onto a paid provider', () => {
  const saved = {
    p: process.env.VOICE_TTS_PROVIDER,
    a: process.env.AZURE_SPEECH_KEY,
    e: process.env.ELEVENLABS_API_KEY,
  };
  process.env.VOICE_TTS_PROVIDER = 'azure';
  process.env.AZURE_SPEECH_KEY = 'a-real-paid-key';
  process.env.ELEVENLABS_API_KEY = 'a-real-paid-key';
  try {
    const app = makeTestApp();
    assert.equal(app.config.voiceTtsProvider, '');
    assert.equal(app.config.azureSpeechKey, '');
    assert.equal(app.config.elevenlabsApiKey, '');
    // The end that matters: a chain built from a test app's config is NATIVE, so
    // no unit test can POST a patient's words to a vendor.
    const chain = createTtsChain({ config: app.config, clinic: app.store.getClinicById(CLINIC), logger: spyLog() });
    assert.equal(chain.mode, 'native');
    assert.equal(chain.synthesize, null);
  } finally {
    if (saved.p === undefined) delete process.env.VOICE_TTS_PROVIDER;
    else process.env.VOICE_TTS_PROVIDER = saved.p;
    if (saved.a === undefined) delete process.env.AZURE_SPEECH_KEY;
    else process.env.AZURE_SPEECH_KEY = saved.a;
    if (saved.e === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = saved.e;
  }
});
