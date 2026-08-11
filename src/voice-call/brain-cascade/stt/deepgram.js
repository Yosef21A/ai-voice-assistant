// Deepgram Nova-3 streaming STT — the cascade's PRIMARY ears.
//
// WHY IT IS PRIMARY: it is the only vendor on the board with an explicit
// Tunisian code (`ar-TN`), it endpoints in the 250–400 ms band the whole V7
// latency thesis rests on, and its signup credit ($200 ≈ 690 h, card-free) is
// effectively free under the zero-budget doctrine.
//
// STATUS, stated plainly: **there is no key on this machine yet.** This adapter
// is built to the documented contract and is key-gated — without
// DEEPGRAM_API_KEY the chain never constructs it and falls through to
// Speechmatics, then to liveEars. The moment the founder signs up, this is the
// leg that gets measured on the same 8-run method as the rest of P0.
//
// CONTRACT (Deepgram Streaming v1, documented shape):
//   wss://api.deepgram.com/v1/listen
//     ?model=nova-3&language=ar-TN&interim_results=true&endpointing=300
//     &encoding=linear16&sample_rate=16000&channels=1
//   auth: `Authorization: Token <key>` header, or the `['token', <key>]`
//         subprotocol — see stt/socket.js for why both are handed over.
//   audio: raw little-endian PCM16 binary frames.
//   results: { type:'Results', channel:{ alternatives:[{ transcript }] },
//              is_final, speech_final }
//     • is_final     — this text will not change any more
//     • speech_final — Deepgram's own endpointer says the caller STOPPED. This
//                      is the fast path to end-of-turn, and the orchestrator's
//                      300 ms timer is only the belt for when it never comes.
//   close: { type:'CloseStream' } flushes the tail before the socket goes.
import { createSocketSession, frameToObject } from './socket.js';
import { int16ToBuffer } from '../../brain/g711.js';

export const DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen';
export const DEEPGRAM_MODEL = 'nova-3';

/**
 * `ar-TN` is the ONLY explicit Maghrebi code any vendor publishes. There is no
 * `ar-LY` anywhere, so a Libyan caller gets it too: a Tunisian model on Libyan
 * derja is much closer than MSA is, and that is the honest state of the market.
 */
export const DEEPGRAM_LANGS = Object.freeze({ ar: 'ar-TN', fr: 'fr', en: 'en-US' });

/**
 * The endpointing band the V7 latency budget is built on (ms).
 *
 * THE LAYERING, stated once because it is the thing everybody gets wrong
 * (V8-D2 §1): `endpointing=N` is a CONNECTION-TIME query parameter. The socket
 * is opened at call setup and lives for the whole call, so this number cannot
 * be changed when the conversation reaches a phone number and the caller starts
 * pausing mid-digit. Therefore:
 *
 *   • the VENDOR's endpointer stays at 300 ms — the FLOOR signal, the fastest
 *     honest "they stopped" this transport can produce;
 *   • the ORCHESTRATOR's own EOT timer is the state-dependent one
 *     (voiceCascadeEotMs 400 → voiceCascadeEotPatientMs 900 while collecting a
 *     name/number/date). It is armed on every final and it is what actually
 *     ends a turn.
 *
 * A vendor `speech_final` still short-cuts the timer on ordinary turns, which
 * is where the 400 ms is bought back. In a data-capture state the orchestrator
 * holds the turn open past the vendor's opinion, ON PURPOSE — the vendor cannot
 * know that the silence it just heard is a caller reading the next three digits.
 */
export const DEEPGRAM_ENDPOINTING_MS = 300;

/**
 * How long a silence has to last before Deepgram sends `UtteranceEnd`. It is
 * the vendor's own "they have stopped" signal and it arrives even when the last
 * words produced no transcript at all — which is exactly the turn where our own
 * timer is the only thing left. Requires `interim_results=true`.
 */
export const DEEPGRAM_UTTERANCE_END_MS = 1000;

export function buildDeepgramUrl({
  lang = 'ar',
  sampleRate = 16000,
  endpointingMs = DEEPGRAM_ENDPOINTING_MS,
  utteranceEndMs = DEEPGRAM_UTTERANCE_END_MS,
} = {}) {
  const q = new URLSearchParams({
    model: DEEPGRAM_MODEL,
    language: DEEPGRAM_LANGS[lang] || DEEPGRAM_LANGS.ar,
    interim_results: 'true',
    endpointing: String(Math.round(endpointingMs)),
    utterance_end_ms: String(Math.round(utteranceEndMs)),
    encoding: 'linear16',
    sample_rate: String(sampleRate),
    channels: '1',
  });
  return `${DEEPGRAM_URL}?${q.toString()}`;
}

/**
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} [p.lang]
 * @param {number} [p.endpointingMs]
 * @param {Function} [p.wsFactory]
 * @param {Function} [p.logger]
 * @param {number} [p.readyTimeoutMs]
 * @returns {{provider:string, ready:Promise, sendAudio:Function, on:Function,
 *   close:Function, stats:Function}}
 */
export function createDeepgramStt({
  apiKey,
  lang = 'ar',
  endpointingMs = DEEPGRAM_ENDPOINTING_MS,
  wsFactory,
  logger,
  readyTimeoutMs,
} = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  const key = String(apiKey || '');
  const url = buildDeepgramUrl({ lang, endpointingMs });
  let chain = Promise.resolve();
  const counts = { interims: 0, finals: 0, flushes: 0 };

  const session = createSocketSession({
    url,
    provider: 'deepgram',
    protocols: ['token', key],
    headers: { Authorization: `Token ${key}` },
    wsFactory,
    logger: log,
    readyTimeoutMs,
    // Deepgram is ready the moment the socket opens — there is no hello frame
    // to wait for, and holding the caller's first word for one would be pure
    // added latency.
    onOpen: (s) => s.markReady(),
    onMessage: (data, s) => {
      // Serialized: a Blob needs an await, and reordering an interim behind the
      // final it precedes would restart a turn we had already committed to.
      chain = chain
        .then(() => frameToObject(data))
        .then((obj) => handle(obj, s))
        .catch((err) => log('[voice-cascade] deepgram frame failed:', err?.message || err));
    },
  });

  function handle(frame, s) {
    if (!frame || typeof frame !== 'object') return;
    // A FLUSH SIGNAL, not a transcript. `UtteranceEnd` (and an EMPTY final
    // carrying speech_final) means "they stopped talking" — it does not mean
    // "they said nothing". Found in review: treating it as an unclear turn made
    // the agent answer a perfectly good sentence with "sorry, it is noisy"
    // whenever the vendor closed the utterance on a separate frame. It is
    // forwarded as an empty end-of-turn final, and the orchestrator uses it to
    // close the finals it has already accumulated.
    if (frame.type === 'UtteranceEnd') {
      counts.flushes += 1;
      s.emit('final', { text: '', endOfTurn: true });
      return;
    }
    if (frame.type && frame.type !== 'Results') return; // Metadata, SpeechStarted, …
    const alt = frame.channel?.alternatives?.[0];
    const text = String(alt?.transcript || '');
    if (!text.trim()) {
      if (frame.is_final && frame.speech_final) {
        counts.flushes += 1;
        s.emit('final', { text: '', endOfTurn: true });
      }
      return;
    }
    counts[frame.is_final ? 'finals' : 'interims'] += 1;
    if (frame.is_final) s.emit('final', { text, endOfTurn: !!frame.speech_final });
    else s.emit('interim', { text });
  }

  return {
    provider: 'deepgram',
    ready: session.ready,
    /** @param {Int16Array} int16 PCM16 mono @16 kHz */
    sendAudio(int16) {
      if (!int16 || !int16.length) return;
      session.send(int16ToBuffer(int16));
    },
    on: session.on,
    close() {
      // Flush the tail: the last words of a call are the ones that decide
      // whether a booking was confirmed.
      session.send({ type: 'CloseStream' });
      session.close();
    },
    stats: () => ({ provider: 'deepgram', ...counts, ...session.stats() }),
  };
}

export default createDeepgramStt;
