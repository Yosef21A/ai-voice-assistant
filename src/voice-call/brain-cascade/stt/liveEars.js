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
//   • It transcribes WHATEVER IT HEARS — including our own TTS coming back
//     through the caller's speaker. See isEchoOfAgent below: a final that is
//     the opening of what we are saying right now is echo, not a caller.
import { createLiveClient } from '../../brain/liveClient.js';

/** Silence is asked for, never relied on. See the header. */
export const EARS_INSTRUCTION =
  'You are a silent transcription service. Do not speak, do not answer, do not acknowledge. Produce no output of any kind. Another system is talking to this caller.';

/** No fragment for this long ⇒ the utterance is over, even if the server never says so. */
export const EARS_IDLE_MS = 700;

/** Below this, a final is too short for an echo comparison to mean anything. */
const MIN_ECHO_CHARS = 4;

/**
 * Compare-only normalization: letters and digits, lowercased, no spaces.
 * Deliberately crude — an echo of our own sentence comes back through a
 * speaker, a microphone and a codec, so punctuation and spacing are the first
 * things to differ and the last things worth comparing.
 */
export function normalizeEcho(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * DID WE JUST TRANSCRIBE OURSELVES? True when `text` is the opening of what the
 * agent is saying right now. Prefix-only, on purpose: an echo starts where our
 * sentence starts, while a caller who happens to repeat a phrase we used
 * mid-sentence is a caller and must be answered.
 */
export function isEchoOfAgent(text, agentText) {
  const heard = normalizeEcho(text);
  const said = normalizeEcho(agentText);
  if (heard.length < MIN_ECHO_CHARS || !said) return false;
  return said.startsWith(heard);
}

/**
 * @param {object} p
 * @param {object} p.config          needs geminiApiKey + geminiLiveModel + VAD knobs
 * @param {string} [p.lang]
 * @param {Function} [p.liveFactory] default createLiveClient — tests inject
 * @param {Function} [p.logger]
 * @param {number} [p.idleMs]
 * @param {Function} [p.agentSpeaking] () => boolean — is OUR audio on the wire?
 * @param {Function} [p.agentSaid]     () => string  — the last thing we said
 */
export function createLiveEarsStt({
  config = {},
  lang = 'ar',
  liveFactory,
  logger,
  idleMs = EARS_IDLE_MS,
  agentSpeaking,
  agentSaid,
} = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  const makeLive = typeof liveFactory === 'function' ? liveFactory : createLiveClient;
  const speaking = typeof agentSpeaking === 'function' ? agentSpeaking : () => false;
  const saidByUs = typeof agentSaid === 'function' ? agentSaid : () => '';
  const handlers = new Map();
  const counts = { interims: 0, finals: 0, swallowed: 0, echoDropped: 0, dupSuppressed: 0 };
  let buffer = '';
  let idleTimer = null;
  let closed = false;
  /**
   * Is there an utterance in progress that has NOT been emitted as a final yet?
   *
   * THE DUPLICATE THIS KILLS. Two independent things end an utterance here: the
   * 700 ms idle timer and the server's own `turnComplete`/`generationComplete`.
   * On a slow line both fire, and a second `flushFinal` for the same speech
   * used to be prevented only by the buffer happening to be empty — which stops
   * being true the moment ONE more fragment arrives between them. One utterance
   * is one final; anything else answers the caller twice.
   */
  let utteranceOpen = false;

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
    if (!utteranceOpen) {
      // Already flushed by the other end-of-turn signal. Counted rather than
      // ignored: "the idle timer and turnComplete are racing" is a real
      // property of this transport and it should be visible in stats().
      counts.dupSuppressed += 1;
      return;
    }
    utteranceOpen = false;
    // OUR OWN VOICE, COMING BACK. Gemini transcribes whatever it hears, and on
    // a speakerphone that includes the agent. A final that is the opening of
    // what we are saying right now is echo, not a caller, and answering it
    // would have the agent hold a conversation with itself.
    if (speaking() && isEchoOfAgent(text, saidByUs())) {
      counts.echoDropped += 1;
      log(`[voice-cascade] liveEars dropped an echo of our own utterance (${text.slice(0, 40)})`);
      return;
    }
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
    utteranceOpen = true;
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
    // P2.1 ears-only assertion, in the log where a field test can read it:
    // everything the model tried to say through this session was swallowed.
    log(`[liveEars] ears-only: swallowed ${counts.swallowed} model outputs, forwarded 0`);
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
    stats: () => ({ provider: 'liveEars', ...counts, buffered: buffer.length, utteranceOpen }),
  };
}

export default createLiveEarsStt;
