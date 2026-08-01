// THE EARS CHAIN — deepgram → speechmatics → liveEars → (degrade to chat).
//
// One interface for the orchestrator, three very different vendors behind it,
// and ONE rule that matters more than any of them: a call must never sit on a
// dead transcriber. If an adapter cannot connect — or dies mid-call — the next
// one is built and the caller keeps talking. When the list runs out, the chain
// says so ('lost'), and the orchestrator does what this product has always done
// when a leg dies: hang up politely and hand the patient to the chat engine in
// writing.
//
// WHAT THE CHAIN OWNS THAT AN ADAPTER CANNOT:
//
//  1. THE PRE-READY BUFFER. Media connects before any vendor has finished its
//     handshake, and the first two seconds of a call are usually the caller
//     saying "allo?" — the single most important thing they say. Audio is held
//     (oldest dropped past the cap) and released the moment a leg is ready.
//     The same lesson liveClient.js learned in V2, one layer up.
//  2. FAILOVER WITHOUT DUPLICATE SPEECH. Exactly ONE adapter is live at a time.
//     The dead one's handlers are dropped before the next is built, so a socket
//     that emits a final while it is dying cannot answer the caller twice.
//  3. ONE WARNING PER FAILURE. Not one per audio frame. A vendor outage is a
//     line in the log, not the log.
//
// Hermetic by construction: `wsFactory` and `liveFactory` are injected all the
// way down, so no test in this repo opens a socket to anybody.
import { createDeepgramStt } from './deepgram.js';
import { createSpeechmaticsStt } from './speechmatics.js';
import { createLiveEarsStt } from './liveEars.js';

/** ~2 s at 16 kHz — the caller's "allo?", held while a vendor warms up. */
export const PRE_READY_MAX_SAMPLES = 32000;

/** The doctrine order. Latency first, then coverage, then what we already own. */
export const STT_ORDER = Object.freeze(['deepgram', 'speechmatics', 'liveEars']);

/**
 * Which adapters could possibly run, given the keys present. Exported because
 * "why did my call use liveEars?" must be answerable without reading the code.
 * @returns {string[]}
 */
export function availableStt(config = {}, { liveFactory } = {}) {
  const out = [];
  if (String(config.deepgramApiKey || '')) out.push('deepgram');
  if (String(config.speechmaticsApiKey || '')) out.push('speechmatics');
  // liveEars needs the Gemini key the product already has — or an injected
  // factory, which is how the suite exercises it with no key at all.
  if (String(config.geminiApiKey || '') || typeof liveFactory === 'function') out.push('liveEars');
  return STT_ORDER.filter((n) => out.includes(n));
}

/**
 * @param {object} p
 * @param {object} p.config
 * @param {string} [p.lang]
 * @param {Function} [p.wsFactory]    injected into deepgram/speechmatics
 * @param {Function} [p.liveFactory]  injected into liveEars
 * @param {Function} [p.logger]
 * @param {number} [p.readyTimeoutMs]
 * @returns {{sendAudio:Function, on:Function, close:Function,
 *   get provider():string|null, ready:Promise<string|null>, stats:Function}}
 */
export function createSttChain({
  config = {},
  lang = 'ar',
  wsFactory,
  liveFactory,
  fetchImpl,
  logger,
  readyTimeoutMs,
} = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  const handlers = new Map();
  const order = availableStt(config, { liveFactory });

  let index = -1;
  let current = null;
  let provider = null;
  let closed = false;
  /** Has ANY leg ever come up? Settles the chain-level `ready` promise once. */
  let ready = false;
  /**
   * Is the leg we are holding RIGHT NOW able to receive audio?
   *
   * Found in review: this used to be the same flag as `ready`, so during a
   * MID-CALL failover — the exact moment a caller is most likely to be
   * repeating themselves — audio was handed to a socket that had not finished
   * its handshake and the vendor dropped it. The buffer below exists for the
   * start of a call; a failover is the same situation, so it uses the same
   * mechanism instead of a second one.
   */
  let legReady = false;
  /** Caller audio captured before any leg was ready. */
  let preReady = [];
  let preReadyCount = 0;
  const counts = { interims: 0, finals: 0, failovers: 0, samplesIn: 0 };
  let resolveReady;
  const readyPromise = new Promise((res) => {
    resolveReady = res;
  });

  function emit(event, payload) {
    for (const cb of [...(handlers.get(event) || [])]) {
      try {
        cb(payload);
      } catch (err) {
        log('[voice-cascade] stt handler threw:', err?.message || err);
      }
    }
  }

  function build(name) {
    const common = { lang, logger: log, readyTimeoutMs };
    if (name === 'deepgram') {
      return createDeepgramStt({ apiKey: config.deepgramApiKey, wsFactory, ...common });
    }
    if (name === 'speechmatics') {
      // fetchImpl: this vendor mints a short-lived JWT over HTTP before it
      // opens a socket (see speechmatics.js).
      return createSpeechmaticsStt({
        apiKey: config.speechmaticsApiKey,
        wsFactory,
        fetchImpl,
        ...common,
      });
    }
    return createLiveEarsStt({ config, liveFactory, ...common });
  }

  /**
   * Hand the live leg everything the caller said while we were connecting —
   * at the START of a call, and again after every mid-call failover.
   */
  function releasePreReady() {
    if (!preReadyCount || !current) return;
    const held = preReady;
    preReady = [];
    preReadyCount = 0;
    for (const chunk of held) current.sendAudio(chunk);
  }

  function next(why) {
    if (closed) return;
    // Drop the dead leg BEFORE building the next one: a socket mid-death can
    // still emit, and two legs transcribing one caller is two answers.
    const dying = current;
    current = null;
    // The replacement has a handshake to finish. Until it does, caller audio is
    // held rather than thrown at a socket that is not listening yet.
    legReady = false;
    try {
      dying?.close();
    } catch {
      /* best-effort */
    }

    index += 1;
    if (index >= order.length) {
      provider = null;
      log(
        `[voice-cascade] STT chain exhausted after ${order.join(' → ') || '(no adapters configured)'}` +
          `${why ? ` — last failure: ${why}` : ''}. The call degrades to the WhatsApp thread.`
      );
      if (!ready) {
        ready = true;
        resolveReady(null);
      }
      // Asynchronously: when the chain is empty from the start this runs inside
      // the constructor, and a subscriber that has not been attached yet cannot
      // hear an event. The orchestrator is covered either way (it also awaits
      // `ready`), but an emitter that fires before anyone can listen is a trap.
      const err = new Error(why || 'no STT adapter available');
      const t = setTimeout(() => emit('lost', err), 0);
      t.unref?.();
      return;
    }

    const name = order[index];
    if (why) {
      counts.failovers += 1;
      log(`[voice-cascade] STT ${order[index - 1]} failed (${why}) — failing over to ${name}`);
    }
    let leg;
    try {
      leg = build(name);
    } catch (err) {
      next(err?.message || String(err));
      return;
    }
    current = leg;
    provider = leg.provider;

    leg.on('interim', (ev) => {
      if (closed || current !== leg) return;
      counts.interims += 1;
      emit('interim', ev);
    });
    leg.on('final', (ev) => {
      if (closed || current !== leg) return;
      counts.finals += 1;
      emit('final', ev);
    });
    leg.on('error', (err) => {
      // An error BEFORE ready is a connect failure and `ready` rejects below.
      // An error after it is a mid-call death: rotate, do not sit on it.
      if (closed || current !== leg || !ready) return;
      next(err?.message || 'socket error');
    });
    leg.on('close', () => {
      if (closed || current !== leg) return;
      next('socket closed');
    });

    Promise.resolve(leg.ready).then(
      () => {
        if (closed || current !== leg) return;
        legReady = true;
        if (!ready) {
          ready = true;
          resolveReady(leg.provider);
        }
        log(`[voice-cascade] STT ears: ${leg.provider}`);
        releasePreReady();
      },
      (err) => {
        if (closed || current !== leg) return;
        next(err?.message || 'connect failed');
      }
    );
  }

  next(null);

  return {
    /** The leg currently transcribing, or null once the chain is exhausted. */
    get provider() {
      return provider;
    },
    /** Resolves with the provider that came up, or null when none did. */
    ready: readyPromise,

    /** @param {Int16Array} int16 PCM16 mono @16 kHz — never throws. */
    sendAudio(int16) {
      if (closed || !int16 || !int16.length) return;
      counts.samplesIn += int16.length;
      // `legReady`, not `ready`: the chain having come up once says nothing
      // about whether the leg we are holding this instant can take audio.
      if (!current || !legReady) {
        preReady.push(int16);
        preReadyCount += int16.length;
        while (preReadyCount > PRE_READY_MAX_SAMPLES && preReady.length > 1) {
          preReadyCount -= preReady.shift().length;
        }
        return;
      }
      try {
        current.sendAudio(int16);
      } catch (err) {
        log('[voice-cascade] stt sendAudio failed:', err?.message || err);
      }
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

    /** Idempotent, never throws. */
    close() {
      if (closed) return;
      closed = true;
      legReady = false;
      preReady = [];
      preReadyCount = 0;
      try {
        current?.close();
      } catch {
        /* best-effort */
      }
      current = null;
    },

    stats() {
      return {
        provider,
        order,
        ...counts,
        preReadySamples: preReadyCount,
        leg: current?.stats ? current.stats() : null,
      };
    },
  };
}

export default createSttChain;
