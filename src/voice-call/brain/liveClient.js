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
 * The only end-of-speech sensitivities BidiGenerateContentSetup accepts.
 * An unknown value is DROPPED rather than sent: a setup the server rejects
 * closes the socket (1007/1008), and that is a whole call degraded to a
 * WhatsApp apology because someone typed an enum wrong in an .env file.
 */
export const END_SENSITIVITIES = new Set([
  'END_SENSITIVITY_UNSPECIFIED',
  'END_SENSITIVITY_HIGH',
  'END_SENSITIVITY_LOW',
]);
export const START_SENSITIVITIES = new Set([
  'START_SENSITIVITY_UNSPECIFIED',
  'START_SENSITIVITY_HIGH',
  'START_SENSITIVITY_LOW',
]);

/**
 * ENDPOINTING (V5-T0.4). Callers pause mid-sentence — a patient reading a date
 * off a paper, an older caller in Derja, a noisy Libyan mobile leg. The
 * server's default end-of-speech detection clips them, and a clipped caller is
 * the second-loudest "this is a robot" tell after dead air at pickup.
 *
 * Field names are the documented camelCase JSON form of
 * BidiGenerateContentSetup.realtimeInputConfig.automaticActivityDetection
 * (disabled, startOfSpeechSensitivity, prefixPaddingMs, endOfSpeechSensitivity,
 * silenceDurationMs). Anything not recognized is left out entirely, so the
 * server keeps its own default rather than rejecting the setup.
 *
 * `endSensitivity: 'off'` returns `{}` — exactly the pre-V5 payload, i.e. the
 * server's defaults. That is the escape hatch if the API ever changes shape.
 *
 * Dropping silently would be its own trap — a typo in an .env file would look
 * exactly like working endpointing — so every rejected value is logged once,
 * naming the value AND what was expected.
 *
 * @param {object} [vad] { silenceMs, endSensitivity, startSensitivity, prefixPaddingMs }
 * @param {Function} [log] warn sink (the client's logger)
 * @returns {object} the automaticActivityDetection block ({} = server defaults)
 */
export function buildActivityDetection(vad = {}, log) {
  const out = {};
  const warn = typeof log === 'function' ? log : () => {};
  const reject = (field, value, expected) =>
    warn(
      `[voice-brain] ignoring VAD ${field}=${JSON.stringify(value)} — not a value the Live API accepts. ` +
        `Expected ${expected}. The server's default is being used instead.`
    );
  if (!vad || typeof vad !== 'object') return out;

  const end = String(vad.endSensitivity ?? '').trim();
  if (end.toLowerCase() === 'off') return out; // kill switch: pre-V5 behaviour
  if (END_SENSITIVITIES.has(end)) out.endOfSpeechSensitivity = end;
  else if (end) reject('endSensitivity', end, `one of ${[...END_SENSITIVITIES].join(', ')} (or "off")`);

  const start = String(vad.startSensitivity ?? '').trim();
  if (START_SENSITIVITIES.has(start)) out.startOfSpeechSensitivity = start;
  else if (start) reject('startSensitivity', start, `one of ${[...START_SENSITIVITIES].join(', ')}`);

  const silence = Number(vad.silenceMs);
  if (Number.isFinite(silence) && silence > 0) out.silenceDurationMs = Math.round(silence);
  else if (vad.silenceMs != null && vad.silenceMs !== '') {
    reject('silenceMs', vad.silenceMs, 'a positive number of milliseconds');
  }

  const padding = Number(vad.prefixPaddingMs);
  if (Number.isFinite(padding) && padding > 0) out.prefixPaddingMs = Math.round(padding);
  else if (vad.prefixPaddingMs != null && vad.prefixPaddingMs !== '') {
    reject('prefixPaddingMs', vad.prefixPaddingMs, 'a positive number of milliseconds');
  }
  return out;
}

/**
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} p.model                  e.g. 'gemini-live-2.5-flash-native-audio'
 * @param {string} [p.systemInstruction]
 * @param {Array}  [p.tools]                functionDeclarations (see ./tools.js)
 * @param {number} [p.temperature]
 * @param {string[]} [p.responseModalities] ['AUDIO'] (default) or ['TEXT'] — see below
 * @param {object} [p.vad]                  endpointing knobs (see buildActivityDetection)
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
  responseModalities,
  vad,
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
  /** The setup we sent, redacted, so a 1007/1008 close is diagnosable. */
  let lastSetup = null;

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

  /** Never throws, never explodes a log line. */
  function safeJson(value) {
    try {
      return JSON.stringify(value ?? null).slice(0, 2000);
    } catch {
      return '(unserializable)';
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

  /**
   * AUDIO (the native voice, V2) or TEXT (V5-T1: an external TTS provider owns
   * the mouth, see brain/tts/). This is part of `setup`, which is sent exactly
   * once — a session CANNOT change modality later, and that immutability is why
   * a mid-call TTS failure degrades the call instead of falling back to audio.
   */
  const modalities =
    Array.isArray(responseModalities) && responseModalities.length
      ? responseModalities.map((m) => String(m).toUpperCase())
      : ['AUDIO'];
  const textOnly = modalities.includes('TEXT') && !modalities.includes('AUDIO');

  function sendSetup() {
    const setup = {
      setup: {
        model: String(model || '').startsWith('models/') ? model : `models/${model}`,
        generationConfig: { responseModalities: modalities, temperature },
        // Server-side VAD. It is what makes barge-in work: the server tells us
        // `interrupted` the moment the caller speaks over the model. The block
        // is empty ⇒ server defaults; tuned ⇒ a caller who pauses is not cut off.
        realtimeInputConfig: { automaticActivityDetection: buildActivityDetection(vad, log) },
        // The INPUT transcription is required in BOTH modes and is never
        // optional: it is what our deterministic emergency detector reads, and
        // the model is never allowed to make that call.
        inputAudioTranscription: {},
        // The OUTPUT transcription only exists when there IS output audio. In
        // TEXT mode the model's words arrive as text parts instead (the 'text'
        // event below), and asking to transcribe audio that will never be
        // generated is an unknown-shape setup — which the server answers by
        // closing the socket, i.e. by degrading the whole call.
        ...(textOnly ? {} : { outputAudioTranscription: {} }),
      },
    };
    if (systemInstruction) setup.setup.systemInstruction = { parts: [{ text: systemInstruction }] };
    if (Array.isArray(tools) && tools.length) {
      setup.setup.tools = [{ functionDeclarations: tools }];
    }
    // Kept for the close-code post-mortem below. The key is NEVER in here (it
    // rides in the URL), and the two unbounded fields are summarized rather
    // than logged: a rejected setup must be diagnosable from one log line.
    lastSetup = {
      ...setup.setup,
      systemInstruction: systemInstruction ? `[${systemInstruction.length} chars]` : undefined,
      tools: Array.isArray(tools) && tools.length ? tools.map((d) => d?.name) : undefined,
    };
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
          // TEXT modality (V5-T1): the model's words arrive as plain text parts
          // and an external TTS provider says them. Emitted BEFORE the inline
          // data check so a mixed frame keeps its order, and emitted in every
          // mode — an AUDIO session simply never produces these parts, so this
          // costs the native path nothing.
          if (typeof part?.text === 'string' && part.text) emit('text', part.text);
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
      const wasSetUp = state.setupDone;
      state.closed = true;
      // A close BEFORE setupComplete means the endpoint refused what we sent —
      // 1007 (invalid frame payload) and 1008 (policy violation) are how a bad
      // model id or an unknown setup field come back, and the symptom is a whole
      // call degraded to a WhatsApp apology. This log is the only evidence that
      // ever exists, so it carries the code, the reason AND the setup we sent
      // (minus the credential, which lives in the URL and is never logged).
      if (!wasSetUp) {
        log(
          `[voice-brain] LIVE SETUP REJECTED — the session closed before setupComplete. ` +
            `code=${ev?.code ?? 'n/a'} reason=${ev?.reason || 'n/a'} setup=${safeJson(lastSetup)}`
        );
      }
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
     *
     * `{ turnComplete: false }` sends the same text as CONTEXT ONLY: the turn is
     * left open, so the model records it and says nothing until the caller
     * speaks. That distinction is load-bearing for V5-T0 — "you already greeted
     * them, stay quiet" and "keep your turns shorter" must not themselves
     * trigger a spoken reply on top of the caller.
     *
     * @param {string} text
     * @param {object} [opts] { turnComplete = true }
     */
    sendText(text, opts) {
      if (!text) return false;
      const complete = opts?.turnComplete !== false;
      return rawSend({
        clientContent: { turns: [{ role: 'user', parts: [{ text: String(text) }] }], turnComplete: complete },
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
