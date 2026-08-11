// G.711 A-law (PCMA) codec + PCM rate conversion — pure JS, ZERO dependencies.
//
// WHY THIS FILE EXISTS: the brain (Gemini Live) speaks raw PCM16LE mono —
// 16 kHz going in, 24 kHz coming out — while the wire speaks whatever WhatsApp
// negotiated (Opus 48 kHz, or PCMA 8 kHz on a G.711 leg). Something has to be
// the honest, boring bridge between the two. This module is the half that needs
// no dependency at all; ./codec.js wires it (and opusscript) to a live call.
//
// Everything here is a PURE function over typed arrays: no clock, no I/O, no
// state, nothing that can throw on a well-formed input. That is deliberate —
// audio defects are close to undebuggable once they are inside a UDP socket, so
// every conversion is unit-testable on its own, offline, in microseconds.
//
// Reference: ITU-T G.711 and the Sun `g711.c` reference implementation. Both
// lookup tables are built ONCE at module load (256 entries to decode, 64 KB to
// encode) so the per-packet path is a single array index, never a branch tree.
//
// Rate conversion policy (the four ratios a call actually needs):
//   48000 → 16000  wire Opus → brain      : average of 3 (a cheap anti-alias)
//    8000 → 16000  wire PCMA → brain      : ×2 linear interpolation
//   24000 → 48000  brain → wire Opus      : ×2 linear interpolation
//   24000 →  8000  brain → wire PCMA      : average of 3
// Integer ratios are handled exactly; anything else falls back to a generic
// linear resampler so a future codec cannot dead-end the bridge.

/** The one empty result every failure path returns (never null, never throw). */
export const EMPTY_INT16 = new Int16Array(0);

/** Clamp to the signed 16-bit range. */
export function clampInt16(v) {
  if (v > 32767) return 32767;
  if (v < -32768) return -32768;
  return v | 0;
}

// ── G.711 A-law tables ───────────────────────────────────────────────────────

const SEG_AEND = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];

function alawSegment(value) {
  for (let i = 0; i < SEG_AEND.length; i += 1) {
    if (value <= SEG_AEND[i]) return i;
  }
  return SEG_AEND.length;
}

/** One 16-bit linear sample → one A-law byte (Sun g711.c `linear2alaw`). */
function linearToAlawSlow(sample) {
  let pcm = clampInt16(sample) >> 3; // A-law works on a 13-bit magnitude
  let mask;
  if (pcm >= 0) {
    mask = 0xd5; // sign bit set for positives, plus the odd-bit inversion
  } else {
    mask = 0x55;
    pcm = -pcm - 1;
  }
  const seg = alawSegment(pcm);
  if (seg >= 8) return 0x7f ^ mask; // saturated
  let aval = seg << 4;
  aval |= seg < 2 ? (pcm >> 1) & 0x0f : (pcm >> seg) & 0x0f;
  return (aval ^ mask) & 0xff;
}

/** One A-law byte → one 16-bit linear sample (Sun g711.c `alaw2linear`). */
function alawToLinearSlow(byte) {
  const a = (byte & 0xff) ^ 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) t += 8;
  else if (seg === 1) t += 0x108;
  else {
    t += 0x108;
    t <<= seg - 1;
  }
  return (a & 0x80) !== 0 ? t : -t;
}

/** 256 entries: A-law byte → linear sample. */
export const ALAW_DECODE_TABLE = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i += 1) table[i] = alawToLinearSlow(i);
  return table;
})();

/** 65536 entries: (sample + 32768) → A-law byte. 64 KB, built once. */
export const ALAW_ENCODE_TABLE = (() => {
  const table = new Uint8Array(65536);
  for (let i = 0; i < 65536; i += 1) table[i] = linearToAlawSlow(i - 32768);
  return table;
})();

/**
 * Decode an A-law payload into linear PCM.
 * @param {Buffer|Uint8Array} buf
 * @returns {Int16Array}
 */
export function alawDecode(buf) {
  if (!buf || buf.length === 0) return EMPTY_INT16;
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i += 1) out[i] = ALAW_DECODE_TABLE[buf[i] & 0xff];
  return out;
}

/**
 * Encode linear PCM into an A-law payload (one byte per sample).
 * @param {Int16Array|Array<number>} int16
 * @returns {Buffer}
 */
export function alawEncode(int16) {
  const len = int16 ? int16.length : 0;
  const out = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) {
    out[i] = ALAW_ENCODE_TABLE[clampInt16(int16[i]) + 32768];
  }
  return out;
}

// ── PCM <-> bytes (little endian, the only layout Gemini Live and Opus use) ──

/**
 * @param {Int16Array|Array<number>} int16
 * @returns {Buffer} 2 bytes per sample, little endian
 */
export function int16ToBuffer(int16) {
  const len = int16 ? int16.length : 0;
  const out = Buffer.allocUnsafe(len * 2);
  for (let i = 0; i < len; i += 1) out.writeInt16LE(clampInt16(int16[i]), i * 2);
  return out;
}

/**
 * @param {Buffer|Uint8Array} buf  little-endian PCM16
 * @returns {Int16Array} a trailing odd byte is dropped rather than misread
 */
export function bufferToInt16(buf) {
  if (!buf || buf.length < 2) return EMPTY_INT16;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = Math.floor(b.length / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) out[i] = b.readInt16LE(i * 2);
  return out;
}

/** Join Int16Array chunks into one. */
export function concatInt16(chunks = []) {
  let total = 0;
  for (const c of chunks) total += c ? c.length : 0;
  if (total === 0) return EMPTY_INT16;
  const out = new Int16Array(total);
  let at = 0;
  for (const c of chunks) {
    if (!c || !c.length) continue;
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// ── rate conversion ──────────────────────────────────────────────────────────

function decimateAverage(int16, factor) {
  const n = Math.floor(int16.length / factor);
  const out = new Int16Array(n);
  for (let j = 0; j < n; j += 1) {
    let sum = 0;
    const base = j * factor;
    for (let k = 0; k < factor; k += 1) sum += int16[base + k];
    out[j] = clampInt16(Math.round(sum / factor));
  }
  return out;
}

function interpolateInteger(int16, factor) {
  const n = int16.length;
  const out = new Int16Array(n * factor);
  for (let i = 0; i < n; i += 1) {
    const a = int16[i];
    const b = i + 1 < n ? int16[i + 1] : a; // hold the last sample
    for (let k = 0; k < factor; k += 1) {
      out[i * factor + k] = clampInt16(Math.round(a + ((b - a) * k) / factor));
    }
  }
  return out;
}

function linearResample(int16, fromRate, toRate) {
  const n = int16.length;
  const outLen = Math.max(0, Math.round((n * toRate) / fromRate));
  const out = new Int16Array(outLen);
  const step = fromRate / toRate;
  for (let j = 0; j < outLen; j += 1) {
    const pos = j * step;
    const i = Math.floor(pos);
    const frac = pos - i;
    const a = i < n ? int16[i] : int16[n - 1] || 0;
    const b = i + 1 < n ? int16[i + 1] : a;
    out[j] = clampInt16(Math.round(a + (b - a) * frac));
  }
  return out;
}

/**
 * Convert a mono PCM16 buffer between sample rates. Named `downsample` for
 * historical reasons (it is the call the wire→brain path makes first) but it
 * upsamples just as happily; the ratio decides the algorithm.
 *
 * @param {Int16Array} int16
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Int16Array}
 */
export function downsample(int16, fromRate, toRate) {
  if (!int16 || int16.length === 0) return EMPTY_INT16;
  const from = Number(fromRate);
  const to = Number(toRate);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return EMPTY_INT16;
  if (from === to) return int16.slice();
  if (from > to && from % to === 0) return decimateAverage(int16, from / to);
  if (to > from && to % from === 0) return interpolateInteger(int16, to / from);
  return linearResample(int16, from, to);
}

/** Readable alias — the same function, for call sites that are upsampling. */
export const resample = downsample;

export default {
  alawDecode,
  alawEncode,
  int16ToBuffer,
  bufferToInt16,
  concatInt16,
  downsample,
  resample,
  clampInt16,
};
