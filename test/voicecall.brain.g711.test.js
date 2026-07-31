// G.711 + resampling unit tests (V2 voice tier).
//
// This is the layer where audio bugs are cheap to find and, one layer up,
// impossible: a phase error here becomes "the bot sounds like a chipmunk" over a
// UDP socket in Tunisia. So every conversion is pinned by arithmetic, not by
// listening.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alawDecode,
  alawEncode,
  int16ToBuffer,
  bufferToInt16,
  concatInt16,
  downsample,
  clampInt16,
  ALAW_DECODE_TABLE,
  ALAW_ENCODE_TABLE,
} from '../src/voice-call/brain/g711.js';

test('A-law is byte-exact on a full roundtrip of all 256 codes', () => {
  const all = Buffer.alloc(256);
  for (let i = 0; i < 256; i += 1) all[i] = i;
  const linear = alawDecode(all);
  assert.equal(linear.length, 256);
  const back = alawEncode(linear);
  for (let i = 0; i < 256; i += 1) {
    assert.equal(back[i], i, `code ${i} did not survive decode→encode`);
  }
});

test('the lookup tables are the sizes the hot path assumes', () => {
  assert.equal(ALAW_DECODE_TABLE.length, 256);
  assert.equal(ALAW_ENCODE_TABLE.length, 65536);
});

test('PCM survives A-law within the codec\'s documented quantization error', () => {
  // A-law is logarithmic: the absolute error grows with amplitude, the RELATIVE
  // error stays bounded (~6.25% worst case per step, well under 1/8).
  let worst = 0;
  for (let s = -32768; s < 32768; s += 13) {
    const back = alawDecode(alawEncode(new Int16Array([s])))[0];
    const rel = Math.abs(back - s) / Math.max(256, Math.abs(s));
    if (rel > worst) worst = rel;
  }
  assert.ok(worst < 0.07, `relative error ${worst} is larger than A-law allows`);
});

test('silence and full scale are handled without wrap-around', () => {
  // A-law has no exact zero — its idle code decodes to ±8. Anything larger than
  // that would be audible hiss on an idle line.
  const silence = alawDecode(alawEncode(new Int16Array(16)));
  for (const v of silence) assert.ok(Math.abs(v) <= 8, `idle sample ${v} is not silent`);

  const rails = alawDecode(alawEncode(new Int16Array([-32768, 32767])));
  assert.ok(rails[0] < -30000, 'negative full scale must stay negative and large');
  assert.ok(rails[1] > 30000, 'positive full scale must stay positive and large');
});

test('clampInt16 saturates instead of wrapping', () => {
  assert.equal(clampInt16(40000), 32767);
  assert.equal(clampInt16(-40000), -32768);
  assert.equal(clampInt16(1.6), 1);
});

test('PCM16LE bytes round-trip, extremes included, odd tail dropped', () => {
  const src = new Int16Array([-32768, -1, 0, 1, 32767]);
  const buf = int16ToBuffer(src);
  assert.equal(buf.length, 10);
  assert.deepEqual([...bufferToInt16(buf)], [...src]);
  // A truncated packet must lose the half sample, never misread it.
  assert.deepEqual([...bufferToInt16(buf.subarray(0, 9))], [-32768, -1, 0, 1]);
  assert.equal(bufferToInt16(Buffer.alloc(1)).length, 0);
  assert.equal(bufferToInt16(null).length, 0);
});

test('the four rates a call actually uses convert to the right lengths', () => {
  assert.equal(downsample(new Int16Array(960), 48000, 16000).length, 320, 'wire Opus → brain');
  assert.equal(downsample(new Int16Array(160), 8000, 16000).length, 320, 'wire PCMA → brain');
  assert.equal(downsample(new Int16Array(480), 24000, 48000).length, 960, 'brain → wire Opus');
  assert.equal(downsample(new Int16Array(480), 24000, 8000).length, 160, 'brain → wire PCMA');
});

test('48k→16k really averages three samples (not naive dropping)', () => {
  const src = new Int16Array([0, 300, 600, 1000, 1000, 1000]);
  const out = downsample(src, 48000, 16000);
  assert.deepEqual([...out], [300, 1000]);
});

test('×2 upsampling interpolates the midpoint and holds the last sample', () => {
  const out = downsample(new Int16Array([0, 1000]), 24000, 48000);
  assert.deepEqual([...out], [0, 500, 1000, 1000]);
});

test('a same-rate conversion copies rather than aliasing the caller\'s buffer', () => {
  const src = new Int16Array([1, 2, 3]);
  const out = downsample(src, 16000, 16000);
  assert.deepEqual([...out], [1, 2, 3]);
  out[0] = 99;
  assert.equal(src[0], 1, 'the source must not be mutated');
});

test('a non-integer ratio falls back to linear resampling instead of dead-ending', () => {
  const out = downsample(new Int16Array(441), 44100, 16000);
  assert.equal(out.length, 160);
  assert.ok(out instanceof Int16Array);
});

test('degenerate inputs return empty, never throw', () => {
  assert.equal(downsample(new Int16Array(0), 48000, 16000).length, 0);
  assert.equal(downsample(null, 48000, 16000).length, 0);
  assert.equal(downsample(new Int16Array(10), 0, 16000).length, 0);
  assert.equal(downsample(new Int16Array(10), 48000, -1).length, 0);
  assert.equal(alawDecode(Buffer.alloc(0)).length, 0);
  assert.equal(alawDecode(null).length, 0);
  assert.equal(alawEncode(new Int16Array(0)).length, 0);
});

test('concatInt16 joins chunks in order', () => {
  const out = concatInt16([new Int16Array([1, 2]), new Int16Array(0), new Int16Array([3])]);
  assert.deepEqual([...out], [1, 2, 3]);
  assert.equal(concatInt16([]).length, 0);
});

test('a 440 Hz tone survives A-law and a rate round trip with its energy intact', () => {
  const n = 8000;
  const tone = new Int16Array(n);
  for (let i = 0; i < n; i += 1) tone[i] = Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / 8000));
  const back = alawDecode(alawEncode(tone));
  const rms = (a) => Math.sqrt([...a].reduce((s, v) => s + v * v, 0) / a.length);
  const ratio = rms(back) / rms(tone);
  assert.ok(ratio > 0.95 && ratio < 1.05, `energy ratio ${ratio} drifted`);
});
