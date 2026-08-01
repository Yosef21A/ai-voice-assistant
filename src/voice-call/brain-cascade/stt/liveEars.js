// liveEars — Gemini Live used ONLY as ears. The adapter that works TODAY.
//
// The whole V7 cascade is blocked on one thing: a streaming STT key. Deepgram
// and Speechmatics both need a founder signup that has not happened. But the
// product already has a working streaming transcriber with a key in .env — the
// Gemini Live session that has been running the incumbent brain since V2 emits
// `inputAudioTranscription` for the CALLER's speech, continuously, in Arabic.
//
// So this adapter opens exactly that session and uses NOTHING else from it:
//   • caller PCM goes in (16 kHz, the same rate the incumbent sends),
//   • `inputTranscription` fragments come out as the transcript stream,
//   • the model's own 'audio' and 'text' output is SWALLOWED — the cascade's
//     mouth is Fish/ElevenLabs and its brain is Flash-Lite; this session has no
//     say in either.
//
// WHY NOT JUST ASK IT TO BE QUIET. Because you cannot: a Live session with
// `responseModalities:['AUDIO']` and a system instruction saying "transcribe
// silently, never speak" is a request the server is free to ignore, and one
// ignored request is a second voice on a live medical call. The guarantee has
// to be structural, and it is: this adapter never registers an audio consumer
// and never forwards a byte of model output to anything. The instruction below
// is a cost optimization (a model that says nothing generates fewer tokens),
// NOT the control.
//
// THE HONEST COSTS, so nobody discovers them on a bill or a call:
//   • It burns Gemini Live quota to do a job an STT vendor does for less.
//   • Its endpointing is the server's VAD, tuned by the same VOICE_VAD_* knobs
//     as the incumbent — so it inherits the incumbent's endpointing, which is
//     patient by design (~1 s) and therefore SLOWER than Deepgram's 300 ms.
//     That is why it is third in the chain and not first.
//   • It has no `speech_final`. End of turn is signalled by the server deciding
//     the caller finished (it starts generating), or by an idle timer here.
import { createLiveClient } from '../../brain/liveClient.js';

/** Silence is asked for, never relied on. See the header. */
export const EARS_INSTRUCTION =
  'You are a silent transcription service. Do not speak, do not answer, do not acknowledge. Produce no output of any kind. Another system is talking to this caller.';

/** No fragment for this long ⇒ the utterance is over, even if the server never says so. */
export const EARS_IDLE_MS = 700;

/**
 * @param {object} p
 * @param {object} p.config          needs geminiApiKey + geminiLiveModel + VAD knobs
 * @param {string} [p.lang]
 * @param {Function} [p.liveFactory] default createLiveClient — tests inject
 * @param {Function} [p.logger]
 * @param {number} [p.idleMs]
 */
export function createLiveEarsStt({ config = {}, lang = 'ar', liveFactory, logger, idleMs = EARS_IDLE_MS } = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  const makeLive = typeof liveFactory === 'function' ? liveFactory : createLiveClient;
  const handlers = new Map();
  const counts = { interims: 0, finals: 0, swallowed: 0 };
  let buffer = '';
  let idleTimer = null;
  let closed = false;

  function emit(event, payload) {
    for (const cb of [...(handlers.get(event) || [])]) {
      try {
        cb(payload);
      } catch (err) {
        log('[voice-cascade] liveEars handler threw:', err?.message || err);
      }
    }
  }

  function clearIdle() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  /** One utterance is over: emit it as a final, exactly once. */
  function flushFinal(endOfTurn) {
    clearIdle();
    const text = buffer.trim();
    buffer = '';
    if (!text) return;
    counts.finals += 1;
    emit('final', { text, endOfTurn: !!endOfTurn });
  }

  function armIdle() {
    clearIdle();
    idleTimer = setTimeout(() => flushFinal(true), idleMs);
    idleTimer.unref?.();
  }

  const live = makeLive({
    apiKey: config.geminiApiKey,
    model: config.geminiLiveModel,
    systemInstruction: EARS_INSTRUCTION,
    // No tools, ever: this session must not be able to cause a write. The
    // booking gate belongs to the cascade's own executor.
    tools: [],
    vad: {
      silenceMs: config.voiceVadSilenceMs,
      endSensitivity: config.voiceVadEndSensitivity,
      prefixPaddingMs: config.voiceVadPrefixPaddingMs,
    },
    logger: log,
  });

  live.on('inputTranscription', (text) => {
    if (closed) return;
    const s = String(text || '');
    if (!s) return;
    buffer += s;
    counts.interims += 1;
    emit('interim', { text: buffer });
    armIdle();
  });
  // The server started answering ⇒ its VAD decided the caller stopped. That is
  // the closest thing this transport has to `speech_final`, and it is free.
  live.on('turnComplete', () => {
    if (!closed) flushFinal(true);
  });
  live.on('generationComplete', () => {
    if (!closed) flushFinal(true);
  });
  // SWALLOWED. Counted so "it is speaking over us" is a number in stats()
  // rather than an argument, but never forwarded anywhere.
  live.on('audio', () => {
    counts.swallowed += 1;
  });
  live.on('text', () => {
    counts.swallowed += 1;
  });
  live.on('error', (err) => emit('error', err instanceof Error ? err : new Error(String(err))));
  live.on('close', (info) => {
    clearIdle();
    emit('close', { ...(info || {}), wasReady: true });
  });

  return {
    provider: 'liveEars',
    ready: live.ready,
    /** @param {Int16Array} int16 PCM16 mono @16 kHz */
    sendAudio(int16) {
      if (closed || !int16 || !int16.length) return;
      live.sendAudioChunk(int16);
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
      clearIdle();
      try {
        live.close();
      } catch {
        /* close() is contractually non-throwing */
      }
    },
    stats: () => ({ provider: 'liveEars', ...counts, buffered: buffer.length }),
  };
}

export default createLiveEarsStt;
