// Per-call audio codec bridge: the WIRE on one side, the BRAIN on the other.
//
//   caller ──RTP payload──▶ decodeIn()  ──▶ Int16Array @16 kHz ──▶ Gemini Live
//   caller ◀──RTP payload── encodeOut() ◀── Int16Array @24 kHz ◀── Gemini Live
//
// The negotiated codec is read from the SDP rather than assumed: src/voice-call/
// media.js pins `audio/opus 48000/2` on the answer, but Meta has shipped G.711
// (PCMA) legs and a hard-coded Opus assumption would produce a call that sounds
// like a fax machine — the single most expensive kind of bug to diagnose over a
// phone line. We look at the ANSWER first (that is what was actually agreed)
// and fall back to the OFFER.
//
// Contract, non-negotiable because it sits in the RTP hot path:
//   • decodeIn / encodeOut NEVER throw. A malformed packet is counted and
//     skipped. One corrupt frame must not tear down a live medical call.
//   • encodeOut buffers a remainder: Gemini sends audio in ~arbitrary chunk
//     sizes and the wire wants exact 20 ms frames, so partial frames are held
//     until they fill. resetOut() drops that remainder — that is barge-in.
//   • opusscript is loaded LAZILY on the first Opus bridge. It is a WASM blob;
//     `npm test` and `npm run simulate` must not pay for it, and a PCMA-only
//     deployment never needs it at all.
import { createRequire } from 'node:module';
import {
  alawDecode,
  alawEncode,
  bufferToInt16,
  int16ToBuffer,
  downsample,
  EMPTY_INT16,
} from './g711.js';

const require = createRequire(import.meta.url);

/** What Gemini Live consumes / produces (verified 2026-07). */
export const BRAIN_IN_RATE = 16000;
export const BRAIN_OUT_RATE = 24000;

/** One packet is 20 ms — the RTP frame size every soft-phone on earth uses. */
export const FRAME_MS = 20;
export const FRAMES_PER_SECOND = 1000 / FRAME_MS;

const OPUS_RATE = 48000;
const OPUS_FRAME_SAMPLES = (OPUS_RATE * FRAME_MS) / 1000; // 960
const PCMA_RATE = 8000;
const PCMA_FRAME_SAMPLES = (PCMA_RATE * FRAME_MS) / 1000; // 160
const PCMA_STATIC_PT = 8; // RFC 3551 static payload type; often has no rtpmap

let opusModule = null;
function loadOpus() {
  if (opusModule === null) opusModule = require('opusscript');
  return opusModule;
}

/**
 * Pull the audio codecs out of an SDP blob. Tolerant by design: a half-written
 * or fake SDP yields nulls, never an exception.
 * @param {string} sdp
 * @returns {{opus:object|null, pcma:object|null, dtmf:object|null, payloadTypes:number[]}}
 */
export function parseAudioCodecs(sdp) {
  const out = { opus: null, pcma: null, dtmf: null, payloadTypes: [] };
  const text = typeof sdp === 'string' ? sdp : '';
  if (!text) return out;

  // m=audio <port> <proto> <pt> <pt> …  — the offered payload-type list.
  const mLine = text.split(/\r?\n/).find((l) => l.startsWith('m=audio'));
  if (mLine) {
    const parts = mLine.trim().split(/\s+/).slice(3);
    for (const p of parts) {
      const n = Number(p);
      if (Number.isInteger(n) && n >= 0 && n <= 127) out.payloadTypes.push(n);
    }
  }

  const re = /^a=rtpmap:(\d+)\s+([A-Za-z0-9._-]+)\/(\d+)(?:\/(\d+))?/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const pt = Number(m[1]);
    const name = m[2].toLowerCase();
    const clockRate = Number(m[3]);
    const channels = m[4] ? Number(m[4]) : 1;
    if (name === 'opus' && !out.opus) out.opus = { pt, clockRate, channels };
    else if (name === 'pcma' && !out.pcma) out.pcma = { pt, clockRate, channels };
    else if (name === 'telephone-event' && !out.dtmf) out.dtmf = { pt, clockRate };
  }
  // PCMA is a STATIC payload type: a minimal SDP may list `8` on the m-line and
  // never emit an rtpmap for it. Honour that, or a G.711 leg reads as "no codec".
  if (!out.pcma && out.payloadTypes.includes(PCMA_STATIC_PT)) {
    out.pcma = { pt: PCMA_STATIC_PT, clockRate: PCMA_RATE, channels: 1 };
  }
  return out;
}

/**
 * Build the codec bridge for ONE call.
 *
 * @param {object} p
 * @param {string} [p.sdpAnswer]  our answer (authoritative — it is what we agreed)
 * @param {string} [p.sdpOffer]   Meta's offer (fallback)
 * @param {Function} [p.logger]
 * @returns {{codec:string, payloadType:number, clockRate:number,
 *   frameSamples:number, timestampIncrement:number, framesPerSecond:number,
 *   dtmfPayloadType:number|null, decodeIn:Function, encodeOut:Function,
 *   resetOut:Function, stats:Function, close:Function}}
 */
export function createCodecBridge({ sdpAnswer, sdpOffer, logger } = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  const fromAnswer = parseAudioCodecs(sdpAnswer);
  const fromOffer = parseAudioCodecs(sdpOffer);
  // The ANSWER is authoritative WHOLESALE, not field by field. Merging the two
  // (`fromAnswer.opus || fromOffer.opus`) looks harmless and is not: an offer
  // that advertised Opus would then override an answer that settled on PCMA,
  // and we would put A-law bytes inside an Opus packet — a call that is noise
  // in one direction and impossible to diagnose from a log. We consult the
  // offer only when the answer named no audio codec at all (a stub SDP).
  const negotiated = fromAnswer.opus || fromAnswer.pcma ? fromAnswer : fromOffer;
  const opus = negotiated.opus;
  const pcma = negotiated.pcma;
  // DTMF is additive rather than exclusive — either side may carry the rtpmap.
  const dtmf = fromAnswer.dtmf || fromOffer.dtmf;

  // Opus wins whenever it is on the table (it is what media.js pins). PCMA is
  // the explicit G.711 leg. With neither in evidence we still choose Opus: the
  // answer we hand Meta always offers it, so "no rtpmap parsed" means the SDP
  // was a stub (tests, harness), not that the call is really PCMA.
  const usePcma = !opus && !!pcma;
  const codec = usePcma ? 'pcma' : 'opus';
  const payloadType = usePcma ? pcma.pt : opus ? opus.pt : 111;
  const clockRate = usePcma ? PCMA_RATE : OPUS_RATE;
  const frameSamples = usePcma ? PCMA_FRAME_SAMPLES : OPUS_FRAME_SAMPLES;

  const state = {
    decodeErrors: 0,
    encodeErrors: 0,
    packetsIn: 0,
    framesOut: 0,
    closed: false,
  };

  let decoder = null;
  let encoder = null;
  const wireRate = usePcma ? PCMA_RATE : OPUS_RATE;
  // Rate conversion is only exact on a whole number of input samples: 24 kHz →
  // 8 kHz averages groups of THREE, so a chunk whose length is not a multiple of
  // 3 silently loses its last one or two samples. Do that fifty times a second
  // and the outbound stream drifts and clicks. So the remainder is held at the
  // BRAIN rate (pendingIn) and only the largest divisible prefix is converted;
  // pendingOut then holds whatever does not fill a 20 ms frame at the wire rate.
  const inDivisor = wireRate < BRAIN_OUT_RATE ? BRAIN_OUT_RATE / wireRate : 1;
  /** Un-resampled remainder, at the BRAIN's 24 kHz output rate. */
  let pendingIn = EMPTY_INT16;
  /** Resampled remainder, at the WIRE rate, awaiting a full 20 ms frame. */
  let pending = EMPTY_INT16;

  function opusCodecs() {
    if (decoder && encoder) return true;
    try {
      const OpusScript = loadOpus();
      // Mono both ways. libopus decodes a stereo stream into a mono decoder
      // perfectly well, and the brain has no use for a second channel.
      if (!decoder) decoder = new OpusScript(OPUS_RATE, 1, OpusScript.Application.VOIP);
      if (!encoder) encoder = new OpusScript(OPUS_RATE, 1, OpusScript.Application.VOIP);
      return true;
    } catch (err) {
      log('[voice-brain] opus codec unavailable:', err?.message || err);
      return false;
    }
  }

  function concat(head, tail) {
    if (!tail || !tail.length) return head;
    if (!head.length) return tail;
    const merged = new Int16Array(head.length + tail.length);
    merged.set(head, 0);
    merged.set(tail, head.length);
    return merged;
  }

  /** Buffer brain audio, convert only what converts EXACTLY, keep the rest. */
  function feedOutbound(int16) {
    pendingIn = concat(pendingIn, int16);
    const usable = Math.floor(pendingIn.length / inDivisor) * inDivisor;
    if (usable === 0) return;
    const prefix = usable === pendingIn.length ? pendingIn : pendingIn.subarray(0, usable);
    pending = concat(pending, downsample(prefix, BRAIN_OUT_RATE, wireRate));
    pendingIn = usable === pendingIn.length ? EMPTY_INT16 : pendingIn.slice(usable);
  }

  return {
    codec,
    payloadType,
    clockRate,
    frameSamples,
    /** RTP timestamp units per 20 ms frame: 960 for Opus@48k, 160 for PCMA@8k. */
    timestampIncrement: frameSamples,
    framesPerSecond: FRAMES_PER_SECOND,
    dtmfPayloadType: dtmf ? dtmf.pt : null,

    /**
     * One inbound RTP payload → PCM16 mono @16 kHz for the brain.
     * Returns an EMPTY array (never throws) on any decode failure.
     * @param {Buffer|Uint8Array} payload
     * @returns {Int16Array}
     */
    decodeIn(payload) {
      if (state.closed || !payload || !payload.length) return EMPTY_INT16;
      state.packetsIn += 1;
      try {
        if (usePcma) {
          return downsample(alawDecode(payload), PCMA_RATE, BRAIN_IN_RATE);
        }
        if (!opusCodecs()) {
          state.decodeErrors += 1;
          return EMPTY_INT16;
        }
        const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        const pcm = decoder.decode(buf); // Buffer, PCM16LE @48 kHz mono
        return downsample(bufferToInt16(pcm), OPUS_RATE, BRAIN_IN_RATE);
      } catch (err) {
        // A single bad packet on a lossy mobile leg is normal. Count it, drop
        // it, keep the call alive; the stats() ring is where it becomes visible.
        state.decodeErrors += 1;
        return EMPTY_INT16;
      }
    },

    /**
     * Brain PCM16 mono @24 kHz → zero or more 20 ms RTP payloads.
     * Whatever does not fill a frame is held for the next call.
     * @param {Int16Array} int16
     * @returns {Buffer[]}
     */
    encodeOut(int16) {
      if (state.closed || !int16 || !int16.length) return [];
      const out = [];
      try {
        feedOutbound(int16);
        if (!usePcma && !opusCodecs()) {
          state.encodeErrors += 1;
          pending = EMPTY_INT16;
          pendingIn = EMPTY_INT16;
          return [];
        }
        let at = 0;
        while (pending.length - at >= frameSamples) {
          const frame = pending.subarray(at, at + frameSamples);
          at += frameSamples;
          try {
            const payload = usePcma
              ? alawEncode(frame)
              : encoder.encode(int16ToBuffer(frame), frameSamples);
            if (payload && payload.length) {
              out.push(Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
              state.framesOut += 1;
            }
          } catch (err) {
            state.encodeErrors += 1; // drop THIS frame only, keep draining
          }
        }
        pending = at > 0 ? pending.slice(at) : pending;
      } catch (err) {
        state.encodeErrors += 1;
      }
      return out;
    },

    /** Barge-in: throw away everything we had queued up to say — both buffers. */
    resetOut() {
      pending = EMPTY_INT16;
      pendingIn = EMPTY_INT16;
    },

    stats() {
      return {
        codec,
        payloadType,
        packetsIn: state.packetsIn,
        framesOut: state.framesOut,
        decodeErrors: state.decodeErrors,
        encodeErrors: state.encodeErrors,
        pendingSamples: pending.length,
        pendingInSamples: pendingIn.length,
        closed: state.closed,
      };
    },

    /** Idempotent, never throws — mirrors media.close(). */
    close() {
      if (state.closed) return;
      state.closed = true;
      pending = EMPTY_INT16;
      pendingIn = EMPTY_INT16;
      for (const c of [decoder, encoder]) {
        try {
          c?.delete?.();
        } catch {
          /* freeing WASM memory is best-effort */
        }
      }
      decoder = null;
      encoder = null;
    },
  };
}

export default createCodecBridge;
