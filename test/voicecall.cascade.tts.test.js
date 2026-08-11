// V7-P1 — THE ZERO-BUDGET MOUTH (Fish Audio) and the shared chunker.
//
// Three things are tested here, and each is a place a mistake is inaudible in
// code review and unmistakable on a phone call:
//
//  1. THE FISH CONTRACT, byte for byte. The `model:` HEADER is the only model
//     selector and only `s2.1-pro-free` works on a free key (everything else
//     402s). `sample_rate: 8000` is honoured — which is what deletes the
//     resample stage from a G.711 leg — and a reference must NEVER be uploaded
//     per request (+858 ms every turn, P0-measured).
//  2. THE RATE. 8 kHz samples played as if they were 24 kHz are a voice at a
//     third speed. The codec bridge now takes a source rate, and on a PCMA leg
//     at 8 kHz it does no conversion at all.
//  3. THE CHUNKER, now shared by both brains. It is a MEDICAL-SAFETY surface:
//     a naive split on '.' turned "1.500 دينار" into two utterances and a
//     patient heard a wrong price. Its rules are asserted here against the pure
//     function, and brain/loop.js's own suite proves the incumbent still cuts
//     speech identically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeTestApp, listen, request, setupOwner } from '../test-helpers/client.js';
import {
  createFishAudioTts,
  FISH_TTS_URL,
  FISH_MODEL,
  FISH_SAMPLE_RATE,
  FISH_REFERENCE_ID_RE,
} from '../src/voice-call/brain/tts/fishAudio.js';
import { createTtsChain, TTS_PROVIDERS, TTS_FALLBACK_ORDER, resetTtsBreakers, noteTtsFailure } from '../src/voice-call/brain/tts/index.js';
import { createCodecBridge, BRAIN_OUT_RATE } from '../src/voice-call/brain/codec.js';
import { alawDecode } from '../src/voice-call/brain/g711.js';
import {
  takeSentences,
  MIN_SENTENCE_CHARS,
  MAX_SENTENCE_CHARS,
  SPEAKABLE_RE,
} from '../src/voice-call/brain/chunker.js';
import { msgpackEncode } from '../scripts/fish-create-voice.js';

const PCMA_SDP = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 8 101\r\na=rtpmap:101 telephone-event/8000\r\n';
const OPUS_SDP =
  'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 101\r\n' +
  'a=rtpmap:111 opus/48000/2\r\na=rtpmap:101 telephone-event/8000\r\n';

function spyLog() {
  const lines = [];
  const log = (...a) => lines.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
  log.lines = lines;
  return log;
}

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
// 1. THE FISH CONTRACT
// ════════════════════════════════════════════════════════════════════════════

test('fish: the exact URL, the model HEADER, and 8 kHz PCM asked for by name', async () => {
  const fetchImpl = recordingFetch(() => ({
    status: 200,
    body: streamBody([pcmBytes(new Int16Array([1, -1, 32767, -32768]))]),
  }));
  const tts = createFishAudioTts({ apiKey: 'SECRET', fetchImpl, logger: spyLog() });
  const out = await collect(tts.synthesize('أهلا بيك', { lang: 'ar' }));

  assert.equal(fetchImpl.calls.length, 1);
  const [c] = fetchImpl.calls;
  assert.equal(c.url, FISH_TTS_URL);
  assert.equal(c.init.method, 'POST');
  assert.deepEqual(c.headers, {
    Authorization: 'Bearer SECRET',
    'Content-Type': 'application/json',
    // Not a body field and not a typo: the model rides in a header, and
    // `s2.1-pro-free` is the ONLY one a free key may use — every other id
    // returns 402 Insufficient API credit.
    model: 's2.1-pro-free',
  });
  assert.deepEqual(JSON.parse(c.body), {
    text: 'أهلا بيك',
    format: 'pcm',
    sample_rate: 8000,
    latency: 'balanced',
  });
  assert.equal(FISH_MODEL, 's2.1-pro-free');
  assert.equal(tts.sampleRate, FISH_SAMPLE_RATE);
  assert.equal(tts.voice, null, 'no reference id ⇒ the stock Arabic voice, which is a working phone line');
  assert.deepEqual([...out[0]], [1, -1, 32767, -32768], 'PCM16LE decoded exactly, sign and all');
});

test('fish: a PRE-CREATED voice model is addressed by id — a reference is NEVER uploaded per request', async () => {
  const fetchImpl = recordingFetch(() => ({ status: 200, body: streamBody([pcmBytes(new Int16Array([5]))]) }));
  const tts = createFishAudioTts({
    apiKey: 'k',
    referenceId: 'b5390e1a1ca542dfa80d9fed13a76581',
    fetchImpl,
    logger: spyLog(),
  });
  await collect(tts.synthesize('مرحبا'));
  const body = JSON.parse(fetchImpl.calls[0].body);
  assert.equal(body.reference_id, 'b5390e1a1ca542dfa80d9fed13a76581');
  // The 858 ms trap: `references:[{audio,text}]` in the body is the shape that
  // re-uploads a 240 KB clip on every single sentence. It must never appear.
  assert.equal(body.references, undefined);
  assert.equal(tts.voice, 'b5390e1a1ca542dfa80d9fed13a76581');
});

test('fish: a malformed reference id or model is refused at construction, not on a live call', () => {
  assert.throws(() => createFishAudioTts({ apiKey: '' }), /FISH_AUDIO_API/);
  assert.throws(() => createFishAudioTts({ apiKey: 'k', referenceId: '../../v1/models' }), /not a valid voice model/);
  assert.throws(() => createFishAudioTts({ apiKey: 'k', referenceId: 'has spaces' }), /not a valid voice model/);
  assert.throws(() => createFishAudioTts({ apiKey: 'k', model: 's2.1 pro; rm -rf' }), /not a valid model id/);
  assert.equal(FISH_REFERENCE_ID_RE.test('b5390e1a1ca542dfa80d9fed13a76581'), true);
});

test('fish inherits the shared wire hardening: HTTP errors typed, caller aborts re-thrown untouched', async () => {
  const fail = recordingFetch(() => ({ status: 402, text: async () => 'Insufficient API credit' }));
  const paid = createFishAudioTts({ apiKey: 'k', model: 's2.1-pro', fetchImpl: fail, logger: spyLog() });
  await assert.rejects(collect(paid.synthesize('x')), (err) => {
    assert.equal(err.name, 'TtsError');
    assert.equal(err.status, 402);
    assert.equal(err.provider, 'fish');
    assert.match(err.detail, /Insufficient API credit/, 'the free-tier wall is quoted back, not guessed at');
    return true;
  });

  // A 200 with no audio is a vendor failure wearing a success code — saying
  // nothing at all is the one outcome this tier exists to prevent.
  const empty = createFishAudioTts({ apiKey: 'k', fetchImpl: recordingFetch(() => ({ status: 200, body: streamBody([]) })) });
  await assert.rejects(collect(empty.synthesize('x')), /empty audio stream/);

  // A BARGE-IN is not an outage: the caller's own abort comes back untouched,
  // because a TtsError is what ENDS a call (loop.js, 'tts_lost') and a caller
  // who interrupted the agent must never hang up the phone for themselves.
  const ac = new AbortController();
  ac.abort(new Error('barge-in'));
  const interrupted = createFishAudioTts({
    apiKey: 'k',
    fetchImpl: recordingFetch(async (call) => {
      // A real fetch rejects with the abort reason on an already-aborted signal.
      if (call.signal?.aborted) throw call.signal.reason;
      return { status: 200, body: streamBody([]) };
    }),
  });
  await assert.rejects(collect(interrupted.synthesize('x', { signal: ac.signal })), (err) => {
    assert.notEqual(err.name, 'TtsError', 'a caller abort must never look like a provider outage');
    assert.match(String(err.message), /barge-in/);
    return true;
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. THE CHAIN
// ════════════════════════════════════════════════════════════════════════════

test('fish is selectable per tenant, declares 8 kHz, and meters every character', async () => {
  resetTtsBreakers();
  const fetchImpl = recordingFetch(() => ({ status: 200, body: streamBody([pcmBytes(new Int16Array([1, 2]))]) }));
  const chain = createTtsChain({
    config: { fishAudioApi: 'fk' },
    clinic: { id: 'x', voice: { provider: 'fish', fishVoiceId: 'clone_youssef' } },
    fetchImpl,
    logger: spyLog(),
  });
  assert.equal(chain.mode, 'tts');
  assert.equal(chain.provider, 'fish');
  assert.equal(chain.voice, 'clone_youssef');
  assert.equal(chain.sampleRate, 8000, 'declared, not assumed — the codec bridge converts from here');
  assert.equal(chain.cacheKey(), 'fish:clone_youssef');

  await collect(chain.synthesize('أهلا بيك في العيادة'));
  assert.deepEqual(chain.meter(), { chars: 'أهلا بيك في العيادة'.length, requests: 1 });
  assert.equal(TTS_PROVIDERS.has('fish'), true);
});

test('a native chain still reports the brain rate — nothing pre-V7 changes shape', () => {
  const chain = createTtsChain({ config: {}, clinic: { id: 'x' } });
  assert.equal(chain.mode, 'native');
  assert.equal(chain.sampleRate, BRAIN_OUT_RATE);
  assert.deepEqual(chain.meter(), { chars: 0, requests: 0 });
});

test('THE DOCTRINE ORDER: a provider that cannot run falls to fish, then elevenlabs, then native', () => {
  resetTtsBreakers();
  assert.deepEqual([...TTS_FALLBACK_ORDER], ['fish', 'elevenlabs']);

  // Azure named without its key, but a Fish key present ⇒ the call still gets a
  // real voice instead of dropping to native.
  const log = spyLog();
  const fell = createTtsChain({
    config: { fishAudioApi: 'fk' },
    clinic: { id: 'x', voice: { provider: 'azure' } },
    logger: log,
  });
  assert.equal(fell.provider, 'fish');
  assert.equal(log.lines.filter((l) => /unusable/.test(l)).length, 1, 'ONE line about the provider that was asked for');
  assert.match(log.lines.join('\n'), /fell back from azure to fish/);

  // Nothing configured at all ⇒ native, and no noise about vendors nobody chose.
  const quiet = spyLog();
  const native = createTtsChain({ config: {}, clinic: { id: 'x', voice: { provider: 'azure' } }, logger: quiet });
  assert.equal(native.mode, 'native');
  assert.equal(quiet.lines.length, 1, 'a fallback candidate never earns its own warning');

  // An open breaker on the chosen provider takes the NEXT voice, not silence.
  resetTtsBreakers();
  noteTtsFailure('fish', { threshold: 1, at: 1000 });
  const benched = createTtsChain({
    config: { fishAudioApi: 'fk', voiceTtsBreakerCooldownMs: 60000 },
    clinic: { id: 'x', voice: { provider: 'fish' } },
    logger: spyLog(),
    now: () => 2000,
  });
  assert.equal(benched.mode, 'native', 'no elevenlabs key here, so the native voice answers the phone');
  resetTtsBreakers();
});

test('SETTINGS: a tenant can be put on the fish voice, and a malformed id is a 400 at save time', async (t) => {
  const app = makeTestApp();
  assert.equal(app.config.fishAudioApi, '', 'pinned empty under test, like every other vendor key');
  const server = await listen(app.app);
  t.after(() => new Promise((r) => server.close(r)));
  const { cookie } = await setupOwner(server, { tenantId: 'el-amen-sousse', email: `owner-${randomUUID()}@x.tn` });

  const ok = await request(server, 'PUT', '/api/tenant', {
    cookie,
    body: { voice: { provider: 'fish', fishVoiceId: '  b5390e1a1ca542dfa80d9fed13a76581  ' } },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.tenant.config.voice.provider, 'fish');
  assert.equal(ok.body.tenant.config.voice.fishVoiceId, 'b5390e1a1ca542dfa80d9fed13a76581', 'trimmed on the way in');

  // …and the LIVE clinic object the loop reads was mutated, so the very next
  // call speaks in the new voice.
  const chain = createTtsChain({
    config: { fishAudioApi: 'fk' },
    clinic: app.store.getClinicById('el-amen-sousse'),
    logger: spyLog(),
  });
  assert.equal(chain.provider, 'fish');
  assert.equal(chain.voice, 'b5390e1a1ca542dfa80d9fed13a76581');

  // A reference id is interpolated into a vendor request body: the shape is a
  // whitelist, refused in front of the person who typed it.
  for (const [body, why] of [
    [{ voice: { fishVoiceId: '../../v1/models' } }, 'a path-traversing id'],
    [{ voice: { fishVoiceId: 'has spaces' } }, 'an id with spaces'],
    [{ voice: { provider: 'openai' } }, 'an unknown provider'],
  ]) {
    const res = await request(server, 'PUT', '/api/tenant', { cookie, body });
    assert.equal(res.status, 400, `${why} must be rejected`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 3. THE RATE — 8 kHz into a G.711 leg must not be resampled at all
// ════════════════════════════════════════════════════════════════════════════

test('CODEC: 8 kHz PCM on a PCMA leg is A-law encoded with NO rate conversion', () => {
  const codec = createCodecBridge({ sdpAnswer: PCMA_SDP });
  assert.equal(codec.codec, 'pcma');
  // Exactly one 20 ms frame at 8 kHz: 160 samples.
  const samples = new Int16Array(160);
  for (let i = 0; i < 160; i += 1) samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 300 * i) / 8000));
  const [frame] = codec.encodeOut(samples, 8000);
  assert.equal(frame.length, 160, 'one A-law byte per sample, one frame, no interpolation in between');

  // Round-tripping through A-law is lossy by design, but the SHAPE has to
  // survive: a resample bug shows up as a completely different waveform.
  const back = alawDecode(frame);
  let worst = 0;
  for (let i = 0; i < 160; i += 1) worst = Math.max(worst, Math.abs(back[i] - samples[i]) / 32768);
  assert.ok(worst < 0.05, `A-law quantization drifted ${(worst * 100).toFixed(1)}% — that is not quantization`);
});

test('CODEC: the same 8 kHz audio on an Opus leg is upsampled, and 24 kHz callers are unchanged', () => {
  const opus = createCodecBridge({ sdpAnswer: OPUS_SDP });
  assert.equal(opus.codec, 'opus');
  // 20 ms at 8 kHz = 160 samples → 960 samples at 48 kHz = exactly one frame.
  const frames = opus.encodeOut(new Int16Array(160), 8000);
  assert.equal(frames.length, 1, '8 kHz is upsampled to the Opus wire rate rather than played short');

  // The pre-V7 call site passes no rate at all and must behave identically.
  const legacy = createCodecBridge({ sdpAnswer: PCMA_SDP });
  const a = legacy.encodeOut(new Int16Array(480)); // 20 ms at 24 kHz
  assert.equal(a.length, 1);
  assert.equal(a[0].length, 160);
});

test('CODEC: a mouth swap mid-call converts what is held at the rate it was captured at', () => {
  const codec = createCodecBridge({ sdpAnswer: PCMA_SDP });
  // Half a frame at 24 kHz (240 samples = 10 ms), then the mouth changes to a
  // provider at 8 kHz. The held remainder must not be reinterpreted.
  codec.encodeOut(new Int16Array(240), 24000);
  const out = codec.encodeOut(new Int16Array(80), 8000); // another 10 ms
  assert.equal(out.length, 1, 'the two halves add up to exactly one 20 ms frame');
  assert.equal(out[0].length, 160);
});

// ════════════════════════════════════════════════════════════════════════════
// 4. THE SHARED CHUNKER
// ════════════════════════════════════════════════════════════════════════════

test('REGRESSION: the shared chunker never splits a PRICE, a TIME or an abbreviation', () => {
  // Every string here was proven to break a naive splitter. The first one is
  // the reason the rule exists: a caller heard "…starts from one." and then,
  // separately, "five hundred dinars for the consultation."
  for (const text of [
    'الفحص يبدا من 1.500 دينار للكشف. ',
    'الموعد على 14.30 نهار الخميس الجاي. ',
    'د. سامي موجود نهار الخميس الصباح. ',
    'The clinic opens at 9.30 a.m. every weekday. ',
  ]) {
    const { pieces } = takeSentences(text);
    assert.equal(pieces.length, 1, `"${text}" was cut into ${pieces.length} utterances`);
  }

  // A terminator at the very END of the buffer is undecidable — mid-stream we
  // cannot yet tell "1." from "1.500". It WAITS for the next fragment.
  const held = takeSentences('سامي موجود نهار الخميس؟');
  assert.deepEqual(held.pieces, []);
  assert.equal(held.rest, 'سامي موجود نهار الخميس؟');
  const resolved = takeSentences('سامي موجود نهار الخميس؟ وباهي');
  assert.deepEqual(resolved.pieces, ['سامي موجود نهار الخميس؟']);
  assert.equal(resolved.rest, ' وباهي', 'the remainder is kept VERBATIM — a trim would glue two words together');

  // A run of terminators is ONE terminator, and a letterless piece is glued
  // forward rather than becoming an HTTP request that says nothing.
  assert.deepEqual(takeSentences('يا سلام… شنوة نعملو؟ ').pieces, ['يا سلام… شنوة نعملو؟']);
  assert.deepEqual(takeSentences('... ').pieces, []);

  // Below the minimum, a "sentence" is an initial, not a clause.
  assert.deepEqual(takeSentences('د. ').pieces, []);
  assert.ok(MIN_SENTENCE_CHARS > 1 && MAX_SENTENCE_CHARS > MIN_SENTENCE_CHARS);

  // A run-on with no punctuation is spoken anyway rather than becoming dead air.
  const runOn = `${'ا'.repeat(300)}`;
  const forced = takeSentences(runOn);
  assert.equal(forced.pieces.length, 1);
  assert.ok(forced.pieces[0].length <= MAX_SENTENCE_CHARS);
  assert.equal(SPEAKABLE_RE.test('؟!'), false);
  assert.equal(SPEAKABLE_RE.test('a'), true);
});

// ════════════════════════════════════════════════════════════════════════════
// 5. THE ONBOARDING SCRIPT'S ENCODER
// ════════════════════════════════════════════════════════════════════════════

test('the inline msgpack encoder produces the shapes Fish accepts (no dependency needed)', () => {
  // These are the four types the /model body actually contains. The JSON form
  // of the same payload is rejected with 400 "Reference Audio is not valid";
  // msgpack with RAW BYTES returns 200, which is why this exists at all.
  assert.equal(msgpackEncode({ a: 1 }).toString('hex'), '81a16101'); // fixmap, fixstr, fixint
  assert.equal(msgpackEncode('hi').toString('hex'), 'a26869'); // fixstr
  assert.equal(msgpackEncode(Buffer.from([1, 2, 3])).toString('hex'), 'c403010203'); // bin8 — RAW audio
  assert.equal(msgpackEncode([1, true, null]).toString('hex'), '9301c3c0');
  // A 256-byte reference crosses the bin8 boundary — the length prefix has to
  // grow with it or the server reads a truncated clip.
  const big = msgpackEncode(Buffer.alloc(300));
  assert.equal(big[0], 0xc5, 'bin16 once the audio is over 255 bytes');
  assert.equal(big.readUInt16BE(1), 300);
  assert.throws(() => msgpackEncode(() => {}), /unsupported value type/);
});
