// Codec bridge tests (V2 voice tier) — pure CPU, no socket, no network.
//
// The Opus path exercises the REAL opusscript WASM codec in both directions:
// mocking it would prove nothing, and the one thing that must be true is that
// what we hand the wire is a decodable 20 ms frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodecBridge, parseAudioCodecs } from '../src/voice-call/brain/codec.js';

const OPUS_SDP =
  'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' +
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 8 101\r\n' +
  'a=rtpmap:111 opus/48000/2\r\na=rtpmap:8 PCMA/8000\r\na=rtpmap:101 telephone-event/8000\r\n';

const PCMA_SDP =
  'v=0\r\nm=audio 9 RTP/AVP 8 101\r\na=rtpmap:8 PCMA/8000\r\na=rtpmap:101 telephone-event/8000\r\n';

// A minimal G.711 leg: PCMA is a STATIC payload type and may carry no rtpmap.
const PCMA_STATIC_SDP = 'v=0\r\nm=audio 9 RTP/AVP 8\r\n';

/** `ms` milliseconds of a 440 Hz tone at the brain's 24 kHz output rate. */
function tone24k(ms) {
  const n = Math.round((24000 * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / 24000));
  return out;
}

test('parseAudioCodecs reads rtpmap, the m-line and telephone-event', () => {
  const p = parseAudioCodecs(OPUS_SDP);
  assert.deepEqual(p.opus, { pt: 111, clockRate: 48000, channels: 2 });
  assert.deepEqual(p.pcma, { pt: 8, clockRate: 8000, channels: 1 });
  assert.equal(p.dtmf.pt, 101);
  assert.deepEqual(p.payloadTypes, [111, 8, 101]);

  // Static PCMA with no rtpmap at all must still be recognised.
  const s = parseAudioCodecs(PCMA_STATIC_SDP);
  assert.equal(s.opus, null);
  assert.equal(s.pcma.pt, 8);

  // Garbage in, nulls out — never an exception.
  for (const junk of ['', null, undefined, 'not an sdp at all', 42]) {
    const r = parseAudioCodecs(junk);
    assert.equal(r.opus, null);
    assert.equal(r.pcma, null);
  }
});

test('the negotiated ANSWER wins over the offer', () => {
  // Offer advertises Opus; the answer settled on PCMA. Following the offer here
  // would put A-law bytes in an Opus packet — silence, or worse, noise.
  const b = createCodecBridge({ sdpOffer: OPUS_SDP, sdpAnswer: PCMA_SDP });
  assert.equal(b.codec, 'pcma');
  assert.equal(b.payloadType, 8);
  b.close();
});

test('a stub SDP with no rtpmap defaults to Opus (what media.js always answers)', () => {
  const b = createCodecBridge({ sdpAnswer: 'v=0 fake-answer\r\n' });
  assert.equal(b.codec, 'opus');
  assert.equal(b.payloadType, 111);
  assert.equal(b.timestampIncrement, 960);
  assert.equal(b.dtmfPayloadType, null);
  b.close();
});

test('opus: 24 kHz brain audio becomes exact 20 ms frames and decodes back to 16 kHz', (t) => {
  const b = createCodecBridge({ sdpAnswer: OPUS_SDP });
  t.after(() => b.close());
  assert.equal(b.codec, 'opus');
  assert.equal(b.frameSamples, 960);
  assert.equal(b.timestampIncrement, 960);
  assert.equal(b.framesPerSecond, 50);
  assert.equal(b.dtmfPayloadType, 101);

  const frames = b.encodeOut(tone24k(100));
  assert.equal(frames.length, 5, '100 ms is exactly five 20 ms frames');
  for (const f of frames) assert.ok(Buffer.isBuffer(f) && f.length > 0);

  let samples = 0;
  for (const f of frames) samples += b.decodeIn(f).length;
  assert.equal(samples, 5 * 320, 'each 20 ms frame decodes to 320 samples @16 kHz');
  assert.equal(b.stats().decodeErrors, 0);
});

test('opus: a partial chunk is held until it fills a frame, and resetOut drops it', (t) => {
  const b = createCodecBridge({ sdpAnswer: OPUS_SDP });
  t.after(() => b.close());

  assert.deepEqual(b.encodeOut(tone24k(10)), [], '10 ms cannot fill a 20 ms frame');
  assert.equal(b.stats().pendingSamples, 480, 'the remainder is held at the wire rate');
  assert.equal(b.encodeOut(tone24k(10)).length, 1, 'the next 10 ms completes it');
  assert.equal(b.stats().pendingSamples, 0);

  // Barge-in: the half-spoken syllable must not survive into the next turn.
  b.encodeOut(tone24k(10));
  assert.ok(b.stats().pendingSamples > 0);
  b.resetOut();
  assert.equal(b.stats().pendingSamples, 0);
});

test('opus: a corrupt packet never throws and never deafens the agent', (t) => {
  const b = createCodecBridge({ sdpAnswer: OPUS_SDP });
  t.after(() => b.close());

  // NOTE, learned the hard way while writing this: libopus is built to CONCEAL
  // corruption, not to report it. Some junk byte sequences are legal TOC bytes
  // and decode to plausible silence; others raise; and which is which depends on
  // decoder state, so asserting "this exact payload errors" is a flaky test that
  // proves nothing. What the RTP path actually promises is narrower and is what
  // we pin here: never throw, always return an Int16Array, and keep working.
  for (const junk of [[0xff], [0xff, 0x00, 0x13, 0x37], [0x7f, 0xff, 0xff], [0x00], [1, 2, 3]]) {
    const out = b.decodeIn(Buffer.from(junk));
    assert.ok(out instanceof Int16Array, `junk ${junk} did not return PCM`);
  }
  assert.ok(typeof b.stats().decodeErrors === 'number', 'failures are countable for ops');

  // One bad packet on a lossy mobile leg must not deafen the agent for the rest
  // of the call — this is the assertion that would actually have caught a bug.
  const good = b.encodeOut(tone24k(20))[0];
  assert.equal(b.decodeIn(good).length, 320);
});

test('pcma: 20 ms is 160 A-law bytes each way', (t) => {
  const b = createCodecBridge({ sdpAnswer: PCMA_SDP });
  t.after(() => b.close());
  assert.equal(b.codec, 'pcma');
  assert.equal(b.frameSamples, 160);
  assert.equal(b.timestampIncrement, 160);

  const frames = b.encodeOut(tone24k(100));
  assert.equal(frames.length, 5);
  for (const f of frames) assert.equal(f.length, 160, 'A-law is one byte per sample');
  assert.equal(b.decodeIn(frames[0]).length, 320, '8 kHz in → 16 kHz for the brain');
  assert.equal(b.stats().decodeErrors, 0, 'A-law cannot fail to decode');
});

test('REGRESSION: PCMA loses NO samples when a chunk is not divisible by 3', (t) => {
  // 24 kHz → 8 kHz averages groups of THREE. Resampling each chunk whole meant
  // a chunk whose length was not a multiple of 3 silently dropped its last one
  // or two samples — fifty times a second, for the length of the call. The
  // remainder is now held at the BRAIN rate and converted on the next chunk.
  const b = createCodecBridge({ sdpAnswer: PCMA_SDP });
  t.after(() => b.close());

  const CHUNKS = 100;
  const SAMPLES = 481; // deliberately 3n+1
  let frames = 0;
  for (let i = 0; i < CHUNKS; i += 1) frames += b.encodeOut(new Int16Array(SAMPLES)).length;

  const totalIn = CHUNKS * SAMPLES; // 48100 samples @24 kHz
  const converted = Math.floor(totalIn / 3); // 16033 @8 kHz — nothing thrown away
  assert.equal(frames, Math.floor(converted / 160), 'every full 20 ms frame was produced');
  assert.equal(b.stats().pendingSamples, converted % 160, 'the sub-frame tail is held at 8 kHz');
  assert.equal(b.stats().pendingInSamples, totalIn % 3, 'and the sub-group tail at 24 kHz');

  // resetOut clears BOTH buffers — a barge-in leaves no half-sample behind.
  b.resetOut();
  assert.equal(b.stats().pendingSamples, 0);
  assert.equal(b.stats().pendingInSamples, 0);
});

test('the DTMF payload type is read from the negotiated answer', () => {
  // media.js now offers telephone-event, so the ANSWER carries the pt the
  // caller will actually stamp on keypad packets — which is what loop.js
  // compares against. Reading the offer's number instead would miss every press.
  const answer =
    'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 126\r\na=rtpmap:111 opus/48000/2\r\na=rtpmap:126 telephone-event/8000\r\n';
  const offer =
    'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 101\r\na=rtpmap:111 opus/48000/2\r\na=rtpmap:101 telephone-event/8000\r\n';
  const b = createCodecBridge({ sdpOffer: offer, sdpAnswer: answer });
  assert.equal(b.dtmfPayloadType, 126);
  b.close();

  // …and an answer that mentions no DTMF still inherits the offer's, since the
  // rtpmap can legitimately appear on either side.
  const c = createCodecBridge({ sdpOffer: offer, sdpAnswer: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n' });
  assert.equal(c.dtmfPayloadType, 101);
  c.close();
});

test('empty and absent payloads are no-ops on both directions', (t) => {
  const b = createCodecBridge({ sdpAnswer: OPUS_SDP });
  t.after(() => b.close());
  assert.equal(b.decodeIn(null).length, 0);
  assert.equal(b.decodeIn(Buffer.alloc(0)).length, 0);
  assert.deepEqual(b.encodeOut(null), []);
  assert.deepEqual(b.encodeOut(new Int16Array(0)), []);
  assert.equal(b.stats().packetsIn, 0, 'an empty payload is not a packet');
});

test('close() is idempotent and the bridge goes inert afterwards', () => {
  const b = createCodecBridge({ sdpAnswer: OPUS_SDP });
  const frame = b.encodeOut(tone24k(20))[0];
  b.close();
  b.close();
  assert.equal(b.stats().closed, true);
  assert.equal(b.decodeIn(frame).length, 0, 'a closed bridge decodes nothing');
  assert.deepEqual(b.encodeOut(tone24k(20)), [], 'a closed bridge encodes nothing');
});
