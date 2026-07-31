// Gemini Live API client — one WebSocket, one call, fully injectable.
//
// Protocol verified 2026-07 (BidiGenerateContent, v1beta):
//   • URL carries the key as a QUERY PARAM. That is not a style choice: the
//     browser-style WebSocket constructor (Node 22 ships one globally, so we add
//     no `ws` dependency) accepts no headers, and Google's Live endpoint accepts
//     no other auth. Consequence, stated plainly: the URL is a secret. It is
//     never logged, never recorded, never put on an event.
//   • First frame is `setup`; the server answers `setupComplete`. Nothing may
//     be sent before that — `ready` is the gate.
//   • Server frames arrive as JSON text OR as a Blob (the Node global WebSocket
//     delivers binary as a Blob by default). Both are handled, and frames are
//     processed through ONE promise chain so a Blob's async .text() can never
//     reorder a toolCall behind the audio that followed it.
//
// Everything is injectable — `wsFactory`, `now`, `logger` — and the frame
// dispatcher is EXPOSED as handleServerFrame() so the whole protocol surface is
// unit-testable without a socket. The hermeticity law of this repo is that no
// test may ever open a real WebSocket; this seam is how that is kept true.
//
// Never throws out of a handler. A protocol error becomes an 'error' event and
// a close, because the caller (brain/loop.js) has a real degrade path — a
// polite goodbye plus a WhatsApp text — and an exception would skip it.
import { bufferToInt16, int16ToBuffer } from './g711.js';

const LIVE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/** Batch outbound audio into ~100 ms messages (1600 samples @16 kHz). */
export const AUDIO_CHUNK_SAMPLES = 1600;
/**
 * Caller audio that arrives BEFORE setupComplete is buffered, not dropped and
 * not sent. Not sent, because anything ahead of `setupComplete` is a protocol
 * violation the server is entitled to close the socket over. Not dropped,
 * because the media path connects before the brain does and those first ~2
 * seconds are usually the caller saying "allo?" — the single most important
 * thing they say. Oldest samples fall off the front once the cap is reached.
 */
export const PRE_READY_MAX_SAMPLES = 32000; // 2 s @16 kHz
const DEFAULT_READY_TIMEOUT_MS = 6000;
const INPUT_MIME = 'audio/pcm;rate=16000';

/**
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} p.model                  e.g. 'gemini-live-2.5-flash-native-audio'
 * @param {string} [p.systemInstruction]
 * @param {Array}  [p.tools]                functionDeclarations (see ./tools.js)
 * @param {number} [p.temperature]
 * @param {Function} [p.wsFactory]          (url) => WebSocket-like; tests inject
 * @param {Function} [p.now]
 * @param {Function} [p.logger]
 * @param {number} [p.readyTimeoutMs]
 */
export function createLiveClient({
  apiKey,
  model,
  systemInstruction = '',
  tools = [],
  temperature = 0.6,
  wsFactory,
  now,
  logger,
  readyTimeoutMs,
} = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const log = typeof logger === 'function' ? logger : () => {};
  const makeWs =
    typeof wsFactory === 'function' ? wsFactory : (url) => new globalThis.WebSocket(url);
  const readyMs = Number(readyTimeoutMs) || DEFAULT_READY_TIMEOUT_MS;

  const handlers = new Map();
  const state = {
    open: false,
    setupDone: false,
    closed: false,
    sent: 0,
    received: 0,
    audioFramesIn: 0,
  };
  /** Outbound PCM waiting to reach one ~100 ms message. */
  let audioQueue = [];
  let audioQueued = 0;
  /** Caller audio captured before the session was ready to receive it. */
  let preReady = [];
  let preReadyCount = 0;
  let readyTimer = null;
  let chain = Promise.resolve();

  let resolveReady;
  let rejectReady;
  const ready = new Promise((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  // A rejection nobody is awaiting yet must not become an unhandled rejection
  // and take the process down — the loop attaches its catch a tick later.
  ready.catch(() => {});

  function emit(event, payload) {
    const list = handlers.get(event);
    if (!list) return;
    for (const cb of [...list]) {
      try {
        cb(payload);
      } catch (err) {
        log('[voice-brain] live handler threw:', err?.message || err);
      }
    }
  }

  function failReady(err) {
    if (state.setupDone) return;
    state.setupDone = true; // one-shot: ready settles exactly once
    clearReadyTimer();
    rejectReady(err instanceof Error ? err : new Error(String(err || 'live session failed')));
  }

  function clearReadyTimer() {
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
  }

  let ws;
  try {
    ws = makeWs(`${LIVE_URL}?key=${encodeURIComponent(apiKey || '')}`);
  } catch (err) {
    // The factory itself blew up (bad URL, no global WebSocket). Fail the ready
    // promise rather than throwing into whoever is composing the call.
    failReady(err);
  }

  /**
   * @param {object} obj
   * @param {boolean} [isSetup] the ONE frame allowed before setupComplete
   */
  function rawSend(obj, isSetup = false) {
    if (!ws || state.closed || !state.open) return false;
    // THE PROTOCOL GATE. Everything except `setup` must wait for the server's
    // `setupComplete`; sending audio or a clientContent turn before it is a
    // violation that the endpoint may answer by closing the socket outright.
    if (!isSetup && !state.setupDone) return false;
    try {
      ws.send(JSON.stringify(obj));
      state.sent += 1;
      return true;
    } catch (err) {
      emit('error', err);
      return false;
    }
  }

  function sendSetup() {
    const setup = {
      setup: {
        model: String(model || '').startsWith('models/') ? model : `models/${model}`,
        generationConfig: { responseModalities: ['AUDIO'], temperature },
        // Server-side VAD. It is what makes barge-in work: the server tells us
        // `interrupted` the moment the caller speaks over the model.
        realtimeInputConfig: { automaticActivityDetection: {} },
        // BOTH transcriptions are required, not optional: the caller's side is
        // what our deterministic emergency detector reads (the model is never
        // allowed to make that call), and the agent's side is the transcript the
        // clinic reads in the inbox afterwards.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    };
    if (systemInstruction) setup.setup.systemInstruction = { parts: [{ text: systemInstruction }] };
    if (Array.isArray(tools) && tools.length) {
      setup.setup.tools = [{ functionDeclarations: tools }];
    }
    rawSend(setup, true);
  }

  /** Hand the server everything the caller said while we were still connecting. */
  function releasePreReady() {
    if (!preReadyCount) return;
    const held = preReady;
    preReady = [];
    preReadyCount = 0;
    for (const chunk of held) {
      audioQueue.push(chunk);
      audioQueued += chunk.length;
    }
    flushAudio(); // the tail matters more than the batch size here
  }

  /** Decode one server frame body into an object. Blob/binary tolerated. */
  async function toObject(data) {
    if (data == null) return null;
    if (typeof data === 'string') return JSON.parse(data);
    if (typeof Blob !== 'undefined' && data instanceof Blob) return JSON.parse(await data.text());
    if (Buffer.isBuffer(data)) return JSON.parse(data.toString('utf8'));
    if (data instanceof ArrayBuffer) return JSON.parse(Buffer.from(data).toString('utf8'));
    if (ArrayBuffer.isView(data)) {
      return JSON.parse(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8'));
    }
    if (typeof data === 'object') return data; // a fake transport may hand us the object
    return JSON.parse(String(data));
  }

  /**
   * THE protocol dispatcher. Exposed for direct unit tests: drive it with canned
   * frames and assert the events, no socket required.
   * @param {object} frame a parsed server frame
   */
  function handleServerFrame(frame) {
    if (!frame || typeof frame !== 'object') return;
    // A frame that lands after close() belongs to a call that is over. Emitting
    // it would drive a stopped loop (a tool call against a closed store, a
    // transcript entry after the row was written).
    if (state.closed) return;
    state.received += 1;
    try {
      if (frame.setupComplete) {
        if (!state.setupDone) {
          state.setupDone = true;
          clearReadyTimer();
          resolveReady(true);
          releasePreReady();
        }
        emit('setupComplete', frame.setupComplete);
      }

      const sc = frame.serverContent;
      if (sc) {
        // ORDER MATTERS: 'interrupted' must reach the loop BEFORE any audio in
        // the same frame, or the flush would throw away the NEW turn's speech.
        if (sc.interrupted) emit('interrupted', true);
        if (sc.inputTranscription?.text) emit('inputTranscription', sc.inputTranscription.text);
        if (sc.outputTranscription?.text) emit('outputTranscription', sc.outputTranscription.text);
        const parts = Array.isArray(sc.modelTurn?.parts) ? sc.modelTurn.parts : [];
        for (const part of parts) {
          const inline = part?.inlineData;
          if (!inline?.data) continue;
          const mime = String(inline.mimeType || '');
          if (mime && !mime.startsWith('audio')) continue;
          const pcm = bufferToInt16(Buffer.from(inline.data, 'base64'));
          if (pcm.length) {
            state.audioFramesIn += 1;
            emit('audio', pcm);
          }
        }
        if (sc.turnComplete) emit('turnComplete', true);
        if (sc.generationComplete) emit('generationComplete', true);
      }

      if (Array.isArray(frame.toolCall?.functionCalls) && frame.toolCall.functionCalls.length) {
        emit(
          'toolCall',
          frame.toolCall.functionCalls.map((fc) => ({
            id: fc?.id ?? null,
            name: fc?.name ?? '',
            args: fc?.args && typeof fc.args === 'object' ? fc.args : {},
          }))
        );
      }
      if (frame.toolCallCancellation) {
        const ids = Array.isArray(frame.toolCallCancellation.ids)
          ? frame.toolCallCancellation.ids
          : [];
        emit('toolCallCancellation', ids);
      }
      // goAway = "this session dies in N seconds". For a phone call there is no
      // graceful resumption worth the complexity: the loop degrades instead.
      if (frame.goAway) emit('goAway', frame.goAway);
      if (frame.sessionResumptionUpdate) emit('sessionResumption', frame.sessionResumptionUpdate);
      if (frame.usageMetadata) emit('usage', frame.usageMetadata);
    } catch (err) {
      emit('error', err);
    }
  }

  if (ws) {
    ws.onopen = () => {
      state.open = true;
      try {
        sendSetup();
      } catch (err) {
        failReady(err);
      }
    };
    ws.onmessage = (ev) => {
      // Serialize: a Blob needs an await, and reordering frames would let audio
      // overtake the toolCall that produced it.
      chain = chain
        .then(() => toObject(ev?.data ?? ev))
        .then((obj) => handleServerFrame(obj))
        .catch((err) => emit('error', err));
    };
    ws.onerror = (ev) => {
      const err = ev instanceof Error ? ev : new Error(ev?.message || 'live socket error');
      emit('error', err);
      failReady(err);
    };
    ws.onclose = (ev) => {
      state.open = false;
      state.closed = true;
      failReady(new Error(`live socket closed (${ev?.code ?? 'n/a'})`));
      emit('close', { code: ev?.code ?? null, reason: ev?.reason ?? null });
    };

    readyTimer = setTimeout(() => {
      failReady(new Error(`live setup timed out after ${readyMs}ms`));
    }, readyMs);
    if (typeof readyTimer.unref === 'function') readyTimer.unref();
  }

  function flushAudio() {
    if (!audioQueued) return;
    const merged = new Int16Array(audioQueued);
    let at = 0;
    for (const c of audioQueue) {
      merged.set(c, at);
      at += c.length;
    }
    audioQueue = [];
    audioQueued = 0;
    rawSend({
      realtimeInput: { audio: { data: int16ToBuffer(merged).toString('base64'), mimeType: INPUT_MIME } },
    });
  }

  return {
    /** Resolves on setupComplete; rejects on close/error/timeout. */
    ready,

    /** True once the server acknowledged setup. */
    get isReady() {
      return state.setupDone && !state.closed;
    },

    /** Stream caller audio (PCM16 mono @16 kHz). Batched to ~100 ms messages. */
    sendAudioChunk(int16) {
      if (state.closed || !int16 || !int16.length) return;
      if (!state.setupDone) {
        // Hold it — the caller's first words are worth more than the ~2 s of
        // memory. Oldest first out once the cap is hit.
        preReady.push(int16);
        preReadyCount += int16.length;
        while (preReadyCount > PRE_READY_MAX_SAMPLES && preReady.length > 1) {
          preReadyCount -= preReady.shift().length;
        }
        return;
      }
      audioQueue.push(int16);
      audioQueued += int16.length;
      while (audioQueued >= AUDIO_CHUNK_SAMPLES) flushAudio();
    },

    /** Force out whatever audio is buffered (end of a turn, shutdown). */
    flushAudio,

    /**
     * Make the model say/do something exact. This is the ONLY way our code puts
     * words in its mouth — used for the greeting and, critically, for the
     * emergency script, which OUR detector decides on and the model may not
     * override.
     */
    sendText(text) {
      if (!text) return false;
      return rawSend({
        clientContent: { turns: [{ role: 'user', parts: [{ text: String(text) }] }], turnComplete: true },
      });
    },

    /**
     * Answer function calls.
     * @param {Array<{id:string,name:string,response?:object,result?:object}>} responses
     */
    sendToolResponse(responses) {
      const list = (Array.isArray(responses) ? responses : [responses]).filter(Boolean).map((r) => ({
        id: r.id ?? null,
        name: r.name ?? '',
        response: r.response ?? { result: r.result ?? {} },
      }));
      if (!list.length) return false;
      return rawSend({ toolResponse: { functionResponses: list } });
    },

    /** Exposed for unit tests — the whole protocol surface, no socket needed. */
    handleServerFrame,

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

    stats() {
      return { ...state, preReadySamples: preReadyCount, at: clock() };
    },

    /** Idempotent, never throws. */
    close() {
      if (state.closed) {
        clearReadyTimer();
        return;
      }
      state.closed = true;
      state.open = false;
      clearReadyTimer();
      audioQueue = [];
      audioQueued = 0;
      preReady = [];
      preReadyCount = 0;
      failReady(new Error('live session closed locally'));
      try {
        ws?.close?.();
      } catch {
        /* best-effort */
      }
    },
  };
}

export default createLiveClient;
