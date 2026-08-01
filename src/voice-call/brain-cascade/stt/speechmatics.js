// Speechmatics Realtime STT — the cascade's SECOND ears.
//
// WHY IT IS THE FALLBACK AND NOT THE PRIMARY: it names Maghrebi Arabic
// (Tunisian included) and handles AR↔EN code-switching, which matters on this
// corridor, and its free tier is 50 h/month. But its endpointing is documented
// in terms of `max_delay` (seconds), not the 250–400 ms band Deepgram
// endpoints in, so on latency it starts behind.
//
// STATUS: **no key on this machine yet.** Built to the documented v2 protocol
// and key-gated — without SPEECHMATICS_API_KEY the chain skips it entirely.
// The shapes below are the documented ones; the first real key is what turns
// them from "documented" into "verified", and that line stays in this comment
// until it does.
//
// AUTH IS TWO STEPS, NOT ONE — corrected in review, and it matters:
//   1. POST https://mp.speechmatics.com/v1/api_keys?type=rt
//      Authorization: Bearer <SPEECHMATICS_API_KEY>   body: { ttl: <seconds> }
//      → { key_value: "<short-lived JWT>" }
//   2. wss://eu2.rt.speechmatics.com/v2?jwt=<key_value>
// The long-lived API key is NEVER put on the WebSocket URL. A URL is the
// leakiest place a credential can sit — proxy logs, error strings, crash
// reports — and that one would be a permanent account key rather than a token
// that expires within the hour. The minted JWT is short-lived by construction,
// and the URL is still treated as a secret (never logged).
//
// PROTOCOL (Realtime v2):
//   → { message:'StartRecognition', audio_format:{type:'raw',
//        encoding:'pcm_s16le', sample_rate:16000},
//        transcription_config:{ language, enable_partials:true, max_delay } }
//   ← { message:'RecognitionStarted' }                            — the ready gate
//   ← { message:'AddPartialTranscript', metadata:{ transcript } }  — interim
//   ← { message:'AddTranscript', metadata:{ transcript } }         — final
//   ← { message:'EndOfTranscript' | 'Error' | 'Warning' }
//   audio: raw binary frames (an implicit AddAudio).
//   close: { message:'EndOfStream', last_seq_no } flushes the tail.
import { createSocketSession, frameToObject } from './socket.js';
import { int16ToBuffer } from '../../brain/g711.js';

export const SPEECHMATICS_URL = 'wss://eu2.rt.speechmatics.com/v2';
/** The management endpoint that exchanges an API key for a short-lived JWT. */
export const SPEECHMATICS_MGMT_URL = 'https://mp.speechmatics.com/v1/api_keys?type=rt';
/** How long the minted token lives. One call, comfortably. */
export const SPEECHMATICS_JWT_TTL_SEC = 3600;
/** How long we will wait for the token before giving up and failing over. */
export const SPEECHMATICS_MINT_TIMEOUT_MS = 4000;
/** ~2 s at 16 kHz: the caller's "allo?" while the token is being minted. */
export const MINT_BUFFER_MAX_SAMPLES = 32000;

/**
 * Speechmatics takes a plain language code and picks the Maghrebi model from
 * the audio itself; there is no `ar-TN` to ask for. `ar` is therefore correct
 * for both Tunisian and Libyan callers rather than a compromise.
 */
export const SPEECHMATICS_LANGS = Object.freeze({ ar: 'ar', fr: 'fr', en: 'en' });

/** Seconds. The vendor's own latency/accuracy dial; 1.0 is its fast end. */
export const SPEECHMATICS_MAX_DELAY = 1.0;

/** The JWT — never the API key — goes on the URL. */
export function buildSpeechmaticsUrl(jwt, base = SPEECHMATICS_URL) {
  return `${base}?jwt=${encodeURIComponent(String(jwt || ''))}`;
}

/**
 * Exchange the long-lived API key for a short-lived realtime JWT.
 * @returns {Promise<string>} the token; throws on any failure so the chain
 *   fails over to the next adapter rather than opening an unauthorized socket.
 */
export async function mintRealtimeJwt({
  apiKey,
  fetchImpl,
  mgmtUrl = SPEECHMATICS_MGMT_URL,
  ttlSec = SPEECHMATICS_JWT_TTL_SEC,
  timeoutMs = SPEECHMATICS_MINT_TIMEOUT_MS,
} = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('speechmatics: no fetch implementation available');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('speechmatics token mint timed out')), timeoutMs);
  timer.unref?.();
  try {
    const res = await doFetch(mgmtUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${String(apiKey || '')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: Math.round(ttlSec) }),
      signal: ac.signal,
    });
    const status = Number(res?.status);
    if (!Number.isFinite(status) || status < 200 || status >= 300) {
      throw new Error(`speechmatics token mint returned HTTP ${Number.isFinite(status) ? status : 'n/a'}`);
    }
    const body = typeof res?.json === 'function' ? await res.json() : null;
    const jwt = String(body?.key_value || '');
    if (!jwt) throw new Error('speechmatics token mint returned no key_value');
    return jwt;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} [p.lang]
 * @param {string} [p.baseUrl]
 * @param {string} [p.mgmtUrl]
 * @param {Function} [p.fetchImpl]  minting is HTTP; tests inject it
 * @param {Function} [p.wsFactory]
 * @param {Function} [p.logger]
 * @param {number} [p.readyTimeoutMs]
 */
export function createSpeechmaticsStt({
  apiKey,
  lang = 'ar',
  baseUrl = SPEECHMATICS_URL,
  mgmtUrl = SPEECHMATICS_MGMT_URL,
  maxDelay = SPEECHMATICS_MAX_DELAY,
  fetchImpl,
  wsFactory,
  logger,
  readyTimeoutMs,
} = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  const handlers = new Map();
  const counts = { interims: 0, finals: 0 };
  let chain = Promise.resolve();
  let session = null;
  let seq = 0;
  let closed = false;
  /** Caller audio that arrived while the token was being minted. */
  let queued = [];
  let queuedSamples = 0;

  function emit(event, payload) {
    for (const cb of [...(handlers.get(event) || [])]) {
      try {
        cb(payload);
      } catch (err) {
        log('[voice-cascade] speechmatics handler threw:', err?.message || err);
      }
    }
  }

  function handle(frame) {
    if (!frame || typeof frame !== 'object') return;
    const kind = frame.message;
    if (kind === 'RecognitionStarted') {
      session?.markReady();
      return;
    }
    if (kind === 'Error') {
      // A vendor-level error is a dead leg: fail so the chain rotates rather
      // than sitting on a socket that will never transcribe anything again.
      session?.fail(new Error(`speechmatics error: ${frame.type || frame.reason || 'unknown'}`));
      return;
    }
    if (kind !== 'AddPartialTranscript' && kind !== 'AddTranscript') return;
    const text = String(frame.metadata?.transcript || '');
    if (!text.trim()) return;
    if (kind === 'AddTranscript') {
      counts.finals += 1;
      // Speechmatics has no `speech_final` equivalent on this message: a final
      // means "these words are settled", not "they stopped talking". So the
      // end-of-turn decision is left entirely to the orchestrator's timer,
      // which is exactly what that timer is for.
      emit('final', { text, endOfTurn: false });
    } else {
      counts.interims += 1;
      emit('interim', { text });
    }
  }

  /** Mint, then connect. A rejection fails the leg over, which is the point. */
  const ready = (async () => {
    const jwt = await mintRealtimeJwt({ apiKey, fetchImpl, mgmtUrl });
    if (closed) throw new Error('speechmatics closed before it connected');
    session = createSocketSession({
      url: buildSpeechmaticsUrl(jwt, baseUrl),
      provider: 'speechmatics',
      wsFactory,
      logger: log,
      readyTimeoutMs,
      onOpen: (s) => {
        s.send({
          message: 'StartRecognition',
          audio_format: { type: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
          transcription_config: {
            language: SPEECHMATICS_LANGS[lang] || SPEECHMATICS_LANGS.ar,
            enable_partials: true,
            max_delay: maxDelay,
          },
        });
      },
      onMessage: (data) => {
        // Serialized: a Blob needs an await, and reordering an interim behind
        // the final it precedes would restart a turn we had committed to.
        chain = chain
          .then(() => frameToObject(data))
          .then((obj) => handle(obj))
          .catch((err) => log('[voice-cascade] speechmatics frame failed:', err?.message || err));
      },
    });
    // The socket's events are forwarded to OUR emitter, so a consumer that
    // subscribed before the token existed still hears them.
    session.on('error', (err) => emit('error', err));
    session.on('close', (info) => emit('close', info));
    await session.ready;
    // Everything the caller said while we were authenticating.
    const held = queued;
    queued = [];
    queuedSamples = 0;
    for (const chunk of held) session.send(int16ToBuffer(chunk));
    return true;
  })();
  // Nobody may be awaiting this yet; an unhandled rejection must not take the
  // process down over a socket that failed to open.
  ready.catch(() => {});

  return {
    provider: 'speechmatics',
    ready,
    /** @param {Int16Array} int16 PCM16 mono @16 kHz */
    sendAudio(int16) {
      if (closed || !int16 || !int16.length) return;
      seq += 1;
      if (!session || !session.isOpen()) {
        // The token mint is one HTTP round trip — but "it should be quick" is
        // not a memory bound, so the hold is capped and drops oldest first.
        queued.push(int16);
        queuedSamples += int16.length;
        while (queuedSamples > MINT_BUFFER_MAX_SAMPLES && queued.length > 1) {
          queuedSamples -= queued.shift().length;
        }
        return;
      }
      session.send(int16ToBuffer(int16));
    },
    on(event, cb) {
      if (typeof cb !== 'function') return () => {};
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(cb);
      return () => {
        const list = handlers.get(event) || [];
        const i = list.indexOf(cb);
        if (i >= 0) list.splice(i, 1);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      queued = [];
      queuedSamples = 0;
      session?.send({ message: 'EndOfStream', last_seq_no: seq });
      session?.close();
    },
    stats: () => ({ provider: 'speechmatics', ...counts, ...(session ? session.stats() : {}) }),
  };
}

export default createSpeechmaticsStt;
