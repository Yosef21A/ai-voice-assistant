// THE CASCADE — one call, end to end, with every hop overlapped.
//
//   caller RTP ─▶ codec.decodeIn ─▶ STT chain ─┬─ interim ─▶ SPECULATIVE start
//                                              └─ final ───▶ emergency preflight
//                                                              │ (miss)
//                                                              ▼
//                                    LLM chain ── text deltas ─▶ chunker
//                                        │                        │
//                                     toolCall               TTS chain
//                                        ▼                        ▼
//                                  tools.exec (the gate)   paced 20 ms queue
//                                                                 ▼
//                                                          media.sendRtp
//
// WHY THIS EXISTS. Gemini Live measured 1.97 s from the caller stopping to the
// first audio byte (P0, 2026-08-01) — and no amount of tuning beats a slow
// brain. The measured cascade budget is LLM 623 ms + TTS 572 ms ≈ 1.2 s, before
// the tricks below. It answers the founder's field verdict ("takes years") with
// numbers rather than opinions, and every turn logs its own waterfall so the
// next verdict is arguable with data.
//
// NINE THINGS THIS FILE IS RESPONSIBLE FOR:
//
//  1. THE SAME LAW AS THE INCUMBENT. The emergency detector runs on every final
//     BEFORE the LLM sees it; the booking gate is brain/tools.js, unchanged,
//     with its two-phase stage→recap→confirm and its "the caller must have
//     spoken since the stage" evidence check. Swapping the brain does not get
//     to soften a medical guardrail — that is the whole reason tools.js and the
//     detector are IMPORTED here rather than reimplemented.
//  2. PACING, byte for byte the incumbent's wall-clock catch-up pacer. Windows
//     timers fire late under load; one-frame-per-tick starved a real call until
//     ten seconds of speech took thirty to leave the machine.
//  3. SPECULATION. Two consecutive interims that agree on a long enough prefix
//     start the LLM before the caller has finished. If the final differs
//     materially the speculative turn is aborted and restarted — exactly ONE
//     answer reaches the caller either way, which is the property that makes
//     speculation safe rather than clever.
//  4. THE FILLER. If the brain has not produced a token in 700 ms, a cached
//     per-tenant clip says «ثانية برك…». Perceived latency is the metric: a
//     filled 1.5 s feels instant, a silent 900 ms feels broken.
//  5. BARGE-IN THAT REACHES THE SOCKET. Dropping queued frames is not enough
//     when a sentence is still being synthesized and a model is still writing:
//     one AbortController per turn kills the LLM stream AND the TTS request,
//     and a generation number makes every in-flight continuation a no-op even
//     if the abort loses the race. Budget: 150 ms, asserted in the suite.
//  6. THE TAPE. The greeting is composed (not generated — a model round trip at
//     pickup is the dead air this tier exists to delete), synthesized once per
//     tenant/lang/codec/voice and replayed from brain/greetingCache.js on every
//     later call. The filler clip rides the same cache under a `filler:` voice
//     key, which is the generalization the V7 brief asked for.
//  7. NOT TRUSTING THE EARS (V7-P2.1, after the first live call). A final in a
//     script nobody on this line speaks is a transcription hallucination, not a
//     caller: it never becomes a turn, and a reply in such a script never
//     reaches a mouth (./script.js, both directions). Barge-in no longer
//     depends on the transcript at all — sustained caller ENERGY while we are
//     speaking runs the same kill-chain, because on the call that produced this
//     rule the transcripts were too late and too wrong to fire it even once.
//  8. THE DEGRADE. No ears, no mouth, or a brain chain that cannot answer ⇒
//     outcome 'brain_lost' / 'tts_lost'. This loop does NOT hang up: it
//     reports, and src/voice-call/index.js terminates the call and sends the
//     WhatsApp follow-up so the chat engine picks the patient up. Same contract
//     as brain/loop.js, because the service must not know which brain it has.
//  9. ONE MOUTH (V7-P2.1, after the founder heard TWO replies to one sentence).
//     The instrumented call named both writers: a SPECULATIVE turn's audio
//     reached the wire (`[rtp-out] src=spec utt=4 frames=24`) and then the
//     final's turn answered the same utterance again. So:
//       • speculation is PREPARE-ONLY. The model streams and the mouth may
//         pre-warm, but every frame is HELD; zero frames enqueue while a turn
//         is speculative. On promotion the held audio flushes atomically under
//         the CURRENT speakGen — and a guess that missed is simply dropped,
//         unheard, which is cheaper than the apology it used to cost.
//       • ONE WRITER OWNS THE WIRE. Every enqueue — greeting, filler, turn,
//         emergency, replayed tape — goes through pushFrames() holding the
//         generation it was created under. Anything else is stale by
//         definition: dropped, logged and counted (stats.staleFramesDropped).
//       • AN UTTERANCE LEDGER. uttId → { answered, generations, revokedBy }.
//         One reply per utterance, ever; a second turn-start for an answered
//         utterance is refused (stats.ledgerRefused). The drift restart is the
//         ONE legitimate second generation: it revokes the answer under a
//         killSpeech gen bump, and two generations per utterance is the cap.
//       • ONE TURN-END. The vendor's `speech_final`, the flush signal and our
//         own EOT timer all mean the same thing; landing inside
//         voiceCascadeTurnEndDebounceMs of each other they collapse into one
//         (stats.turnEndsDebounced). The second one used to become the
//         "sorry, it is noisy" line spoken straight over a perfectly good
//         answer.
//
// CONTRACT: the surface is byte-compatible with createBrainLoop —
// warmUp/start/onRtp/stop/settled/transcript/outcome/stats — so P2 can swap
// them on a flag with no change to src/voice-call/index.js.
//
// Nothing here throws into the RTP path or into a socket handler.
import { createCodecBridge, negotiatedCodecName, BRAIN_IN_RATE, BRAIN_OUT_RATE } from '../brain/codec.js';
import { createTtsChain } from '../brain/tts/index.js';
import { createSttChain } from './stt/index.js';
import { createLlmChain } from './llm/index.js';
import { takeSentences, SPEAKABLE_RE } from '../brain/chunker.js';
import { buildToolDeclarations, createToolExecutor, formatWhenSpoken } from '../brain/tools.js';
import { getGreeting, putGreeting, MAX_GREETING_FRAMES } from '../brain/greetingCache.js';
import { sanitizeSpokenName } from '../brain/loop.js';
import {
  buildVoiceTurnPrompt,
  buildGreetingText,
  buildFillerText,
  buildUnclearText,
  buildTwoStrikeText,
} from './prompt.js';
import { isAlienScript, describeScript } from './script.js';
import { detectEmergency } from '../../notifications/detector.js';
import { buildEmergencyReply, buildSpokenEmergencyReply } from '../../notifications/pipeline.js';
import { isFacilitator } from '../../engine/tenantProfile.js';
import { normalize } from '../../engine/slots.js';
import { nowString } from '../../engine/humanize/context.js';
import { sendAs } from '../../api/outbound.js';

const FRAME_MS = 20;
/** Rolling window of ONE uninterrupted caller utterance the detector sees. */
const EMERGENCY_WINDOW_CHARS = 200;
/** Hard cap on the stored transcript (tail kept — the end of a call matters most). */
const TRANSCRIPT_MAX_CHARS = 8000;
const DEFAULT_EMERGENCY_GRACE_MS = 12000;
const DEFAULT_HANGUP_GRACE_MS = 8000;
const HANGUP_QUIET_MS = 300;
/** RFC 4733 event codes → the key the caller pressed. */
const DTMF_DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#', 'A', 'B', 'C', 'D'];
/** Turns of history handed to the model. A phone call has no scrollback. */
const MAX_HISTORY_TURNS = 12;
/** Tool rounds inside ONE caller turn. stage→confirm is two; four is generous. */
const MAX_TOOL_ROUNDS = 4;
/** Per-turn latency samples kept for the summary. */
const MAX_LATENCY_SAMPLES = 300;
/** Waterfalls kept on the outcome. A 10-minute call is ~60 turns. */
const MAX_WATERFALLS = 120;
/** Appointment statuses that count as "they still have this booked". */
const ACTIVE_APPT_STATUS = new Set(['pending', 'confirmed']);
/** Below this many speakable characters a final is noise, not an utterance. */
const MIN_MEANINGFUL_CHARS = 2;
/** Cap on the strings the Levenshtein comparison will look at. */
const DIFF_MAX_CHARS = 200;
/**
 * ENERGY BARGE-IN (V7-P2.1). RMS of a decoded 16 kHz frame above this, held for
 * `voiceCascadeBargeRmsMs`, is a human talking over us. PCM16 silence on a
 * mobile leg sits in the low hundreds; conversational speech is thousands.
 * Deliberately conservative: a false barge-in costs the caller a cut-off
 * sentence, so the sustain window (240 ms — longer than any click, cough or
 * packet-loss artefact) does most of the work.
 */
const DEFAULT_BARGE_RMS = 1200;
const DEFAULT_BARGE_RMS_MS = 240;
/**
 * ONE TURN-END PER UTTERANCE (V7-P2.1). Deepgram sends `speech_final` and then
 * `UtteranceEnd` on a later frame; our own EOT timer is a third opinion about
 * the same silence. Two of them landing inside this window are one endpoint
 * firing twice, and the second one used to speak.
 */
const DEFAULT_TURN_END_DEBOUNCE_MS = 250;
/**
 * Generations of reply allowed per utterance. TWO: the answer, and the ONE
 * legitimate restart when the finished sentence contradicts what we answered.
 * A third would be the agent arguing with itself out loud.
 */
const MAX_GENERATIONS_PER_UTT = 2;
/** Ledger rows kept for stats(). A 10-minute call is ~60 utterances. */
const MAX_LEDGER_ROWS = 120;
/**
 * Ceiling on the PCM a speculative turn may hold before it is confirmed —
 * ~20 s at 24 kHz. A guess is a fragment of a sentence; anything past this is a
 * model that will not stop writing, and holding it would be a leak on a call
 * that may last an hour.
 */
const MAX_HELD_SAMPLES = 480000;

const rand32 = () => Math.floor(Math.random() * 0xffffffff) >>> 0;
const rand16 = () => Math.floor(Math.random() * 0xffff) & 0xffff;

function toDate(v) {
  return v instanceof Date ? v : new Date(Number(v) || Date.now());
}

function msOf(value) {
  if (value instanceof Date) return value.getTime();
  if (value == null) return 0;
  const n = Date.parse(String(value));
  return Number.isFinite(n) ? n : 0;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

/**
 * Levenshtein distance, two rows, bounded input.
 * Exported because "did the final differ MATERIALLY from what we guessed" is
 * the single decision speculation lives or dies on, and it deserves its own
 * test rather than being buried in a closure.
 */
export function levenshtein(a = '', b = '') {
  const s = String(a).slice(0, DIFF_MAX_CHARS);
  const t = String(b).slice(0, DIFF_MAX_CHARS);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = new Array(t.length + 1);
  let cur = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) prev[j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[t.length];
}

/** 0 = identical, 1 = nothing in common. Normalized by the longer string. */
export function diffRatio(a = '', b = '') {
  const s = normalize(String(a)).replace(/\s+/g, ' ').trim();
  const t = normalize(String(b)).replace(/\s+/g, ' ').trim();
  const longest = Math.max(s.length, t.length);
  if (!longest) return 0;
  return levenshtein(s, t) / longest;
}

/**
 * DID THE FINAL CONTRADICT THE GUESS?
 *
 * The obvious implementation — normalized Levenshtein over the two whole
 * strings, against a 0.25 gate — is wrong here, and wrong in the direction that
 * silently deletes the feature: a speculative guess is BY CONSTRUCTION a
 * prefix of the finished sentence, so "نحب نحجز موعد" against "نحب نحجز موعد
 * عند طبيب" scores 0.43 and every single speculation would be thrown away.
 *
 * So the 0.25 gate is applied where it means something — the region the two
 * strings SHARE — plus a coverage floor:
 *
 *   1. PREFIX DRIFT. Compare the guess with the final's opening of the same
 *      length. This catches the failure that actually matters: the STT
 *      REWRITING what it thought it heard ("نحب نحجز" → "نحب نمشي").
 *   2. COVERAGE. If the guess covers less than half of what the caller
 *      eventually said, we were about to answer a fragment — restart, even
 *      though the opening matched. "نحب نحجز موعد" followed by "…لا سامحني،
 *      نحب نعرف الأسعار" is exactly that shape.
 *
 * @returns {boolean} true ⇒ abort the speculative turn and start again
 */
export function materialDrift(guess = '', final = '') {
  const g = normalize(String(guess)).replace(/\s+/g, ' ').trim();
  const f = normalize(String(final)).replace(/\s+/g, ' ').trim();
  if (!g || !f) return false;
  const head = f.slice(0, g.length);
  const prefixDrift = levenshtein(g, head) / Math.max(g.length, head.length);
  if (prefixDrift > 0.25) return true;
  return g.length / f.length < 0.5;
}

/**
 * THE ABORT REASON, and why it has a type (V7-P2.1).
 *
 * On the founder's instrumented call an energy barge-in KILLED THE SERVER:
 *
 *   Error: barge_in
 *     at killSpeech (orchestrator.js:670) ← noteEnergy ← onRtp ← werift
 *   → uncaughtException (fromPromise)
 *
 * The stack is where the reason was CONSTRUCTED, not where it was thrown: the
 * controller's abort reason travelled into the TTS wire, a promise there was
 * left floating (`reader.cancel()` returns one, and it rejects with the stream's
 * stored error), and Node turns an unhandled rejection into a fatal exception.
 * A caller interrupting the agent must never be able to end the process, so:
 * every abort reason is tagged, every await in the speak chain treats a tagged
 * reason as "we cancelled this" rather than as a provider failure, and the wire
 * (brain/tts/wire.js) never leaves a cancellation promise unobserved.
 *
 * @param {string} reason
 * @returns {Error}
 */
export function speechAbortReason(reason) {
  const err = new Error(reason || 'barge-in');
  err.isSpeechAbort = true;
  err.speechAbortReason = reason || 'barge-in';
  return err;
}

/** True for a cancellation this loop caused. Never a provider failure. */
export function isSpeechAbort(err) {
  return !!(err && err.isSpeechAbort === true);
}

/**
 * Abort a controller without ever throwing INTO the caller. Every call site is
 * on a path — RTP, a WebSocket handler, the pacer — where a throw is a dead
 * call at best and a dead process at worst.
 */
function abortQuietly(controller, reason) {
  try {
    controller?.abort(speechAbortReason(reason));
  } catch {
    /* an already-settled controller is fine */
  }
}

/**
 * Root-mean-square level of one decoded frame. Exported because "was the caller
 * actually speaking" is now a decision this loop makes fifty times a second and
 * it deserves its own test rather than a hand-wave about energy.
 *
 * @param {Int16Array} int16
 * @returns {number} 0 … 32767
 */
export function frameRms(int16) {
  if (!int16 || !int16.length) return 0;
  let sum = 0;
  for (let i = 0; i < int16.length; i += 1) sum += int16[i] * int16[i];
  return Math.sqrt(sum / int16.length);
}

/** The stable-prefix test two consecutive interims must pass to be speculated on. */
export function sharedPrefixLength(a = '', b = '') {
  const s = normalize(String(a)).replace(/\s+/g, ' ').trim();
  const t = normalize(String(b)).replace(/\s+/g, ' ').trim();
  const n = Math.min(s.length, t.length);
  let i = 0;
  while (i < n && s[i] === t[i]) i += 1;
  return i;
}

/**
 * @param {object} p  — the SAME shape createBrainLoop takes, plus test seams.
 * @param {Function} [p.sttFactory]  default createSttChain
 * @param {Function} [p.llmFactory]  default createLlmChain
 * @param {Function} [p.ttsFactory]  default createTtsChain
 */
export function createCascadeLoop({
  clinic,
  convo,
  media,
  store,
  bus,
  sender,
  config = {},
  lang = 'ar',
  patientWaId: waIdOverride,
  sdpOffer,
  sttFactory,
  llmFactory,
  ttsFactory,
  ttsChain: injectedTtsChain,
  wsFactory,
  liveFactory,
  fetchImpl,
  engineFactory,
  now,
  logger,
  onEnd,
} = {}) {
  const clock = typeof now === 'function' ? now : () => new Date();
  const log = typeof logger === 'function' ? logger : (...a) => console.error(...a);
  const L = ['ar', 'fr', 'en'].includes(lang) ? lang : 'ar';
  const makeStt = typeof sttFactory === 'function' ? sttFactory : createSttChain;
  const makeLlm = typeof llmFactory === 'function' ? llmFactory : createLlmChain;
  const makeTts = typeof ttsFactory === 'function' ? ttsFactory : createTtsChain;

  const tenantId = clinic?.id ?? null;
  const conversationId = convo?.id ?? null;
  // JSON stores `waId`, Postgres stores `patientWaId` — read both, and prefer
  // the caller id the webhook actually gave us (see brain/tools.js).
  const patientWaId = waIdOverride ?? convo?.patientWaId ?? convo?.waId ?? null;
  const facilitator = isFacilitator(clinic);
  const greetingCacheOn = config.voiceGreetingCache !== false;
  const emergencyGraceMs = Number(config.voiceBrainEmergencyGraceMs) || DEFAULT_EMERGENCY_GRACE_MS;
  const eotMs = Number(config.voiceCascadeEotMs) || 300;
  const specMinPrefix = Number(config.voiceCascadeSpecMinPrefix) || 12;
  const fillerTtftMs = Number(config.voiceCascadeFillerTtftMs) || 700;
  /**
   * ENERGY BARGE-IN (V7-P2.1). On the founder's first live call the caller
   * talked over the agent repeatedly and barge-in fired ZERO times in 101
   * seconds — because the kill-chain hung entirely off the transcript, and the
   * transcript was late, empty or hallucinated. So the interruption test no
   * longer depends on the ears being right: sustained speech ENERGY while our
   * own audio is on the wire is enough. Flagged, because a wrongly tuned
   * threshold on a noisy line would cut the agent off mid-sentence, and that
   * must be switchable from an env var at 2 a.m. rather than a deploy.
   */
  const energyBargeOn = config.voiceCascadeEnergyBarge !== false;
  const bargeRms = Number(config.voiceCascadeBargeRms) || DEFAULT_BARGE_RMS;
  const bargeRmsMs = Number(config.voiceCascadeBargeRmsMs) || DEFAULT_BARGE_RMS_MS;
  /** Two end-of-turn signals inside this window are ONE turn-end (V7-P2.1). */
  const turnEndDebounceMs = Number.isFinite(Number(config.voiceCascadeTurnEndDebounceMs))
    ? Math.max(0, Number(config.voiceCascadeTurnEndDebounceMs))
    : DEFAULT_TURN_END_DEBOUNCE_MS;
  /** The leg we are actually on — the mouth synthesizes for THIS wire. */
  const wireCodec = negotiatedCodecName({ sdpAnswer: media?.sdpAnswer, sdpOffer });

  // ── the three legs ────────────────────────────────────────────────────────
  function buildTts() {
    if (injectedTtsChain) return injectedTtsChain;
    try {
      // requireMouth: the cascade has NO native voice — Gemini's own audio
      // belongs to the incumbent loop. So, and only here, a chain that resolves
      // to `gemini` walks the doctrine fallback order instead of stopping.
      //
      // wireCodec: Fish synthesizes AT the wire's rate. 8 kHz onto a 48 kHz
      // Opus leg is what the founder heard as "the voice quality is low".
      return makeTts({ config, clinic, logger: log, fetchImpl, requireMouth: true, wireCodec });
    } catch (err) {
      log('[voice-cascade] TTS chain construction failed:', err?.message || err);
      return { mode: 'native', provider: 'gemini', voice: null, synthesize: null };
    }
  }
  const ttsChain = buildTts();
  const ttsRate = Number(ttsChain?.sampleRate) > 0 ? Number(ttsChain.sampleRate) : BRAIN_OUT_RATE;
  /**
   * THE CASCADE HAS NO NATIVE VOICE. Gemini's own audio belongs to the
   * incumbent loop; here the mouth is an HTTP TTS provider or there is no
   * mouth at all. So a chain that came back native is a call this brain cannot
   * take — start() rejects and the service degrades exactly as it does for a
   * dead Gemini socket. That is a loud failure on purpose: a silent one would
   * be an answered phone with nobody on it.
   */
  const hasMouth = ttsChain?.mode === 'tts' && typeof ttsChain.synthesize === 'function';
  const voiceKey = typeof ttsChain?.cacheKey === 'function' ? ttsChain.cacheKey() : '';

  const tools = buildToolDeclarations({ clinic });

  const callState = {
    staged: null,
    booked: null,
    appointment: null,
    handoff: false,
    emergency: false,
    lead: null,
    toolBatchId: 0,
    lastCallerSpeechAt: 0,
    speechSinceStage: '',
    endRequested: false,
  };

  const transcript = [];
  const pending = new Set();
  /** Neutral history: { role:'user'|'assistant'|'tool', text?, toolCalls?, … } */
  const history = [];
  const waterfalls = [];
  const usage = { sttMs: 0, llmTokensIn: 0, llmTokensOut: 0, ttsChars: 0, ttsRequests: 0 };

  let codec = null;
  let executor = null;
  let stt = null;
  let llm = null;
  let started = false;
  let stopped = false;
  let outcomeReason = null;
  let toolCalls = 0;
  let sttStartedAt = 0;
  let sttProvider = null;
  let llmProvider = null;
  /** The scripted engine has taken this call over for good (see llm/index.js). */
  let classicOwned = false;

  // ── outbound wire ─────────────────────────────────────────────────────────
  let outQueue = [];
  let paceTimer = null;
  let seq = rand16();
  let rtpTs = rand32();
  const ssrc = rand32();
  let markNext = true;
  let tapePending = 0;

  // ── speech queue ──────────────────────────────────────────────────────────
  let speakChain = Promise.resolve();
  let speakGen = 0;
  let speakPending = 0;
  let synthAbort = null;
  let sentencesSpoken = 0;
  let ttsFailed = false;
  /** Frames of the utterance currently being synthesized, when it is taped. */
  let activeTape = null;
  /**
   * True while the FILLER is on the wire. The latency marks skip it: the whole
   * point of the number is how long the caller waited for the ANSWER.
   */
  let emittingFiller = false;

  // ── turn state ────────────────────────────────────────────────────────────
  let turn = null;
  let turnGen = 0;
  let eotTimer = null;
  let fillerTimer = null;
  let emergencyTimer = null;
  let hangupTimer = null;
  let hangupQuietSince = 0;
  let hangupBy = null;
  let emergencyWindow = '';
  let callerHasFloor = false;
  let dtmfActive = null;
  let unclearStrikes = 0;
  /**
   * The last turn that ran to completion, and the utterance it answered. A
   * speculative turn can FINISH before the caller stops talking — a fast brain
   * plus a slow speaker — and without this the end-of-turn path would answer
   * the same sentence a second time. That is the "exactly one answer" property,
   * and it is not optional: two answers is worse than none.
   */
  let lastAnswered = null;
  /**
   * The utterance being assembled: interims seen, finals accumulated.
   * `id` is what ties a running turn to the sentence that started it — without
   * it, a caller who speaks again while we are still THINKING (no audio queued,
   * so no barge-in fired) would have their new question silently attached to
   * the old turn and never answered.
   */
  let uttId = 0;
  let utterance = { id: 0, startedAt: 0, prevInterim: '', lastInterim: '', finalText: '', finalAt: 0 };
  /**
   * THE UTTERANCE LEDGER (V7-P2.1). uttId → what this call has already done
   * about that sentence. It is the memory the double-reply bug proved this loop
   * did not have: `lastAnswered` remembered only the LAST utterance, so any
   * path that reached startTurn from somewhere else could answer a sentence a
   * second time and nothing in the process disagreed.
   *
   *   answered    — a reply for this utterance reached the WIRE (not merely a
   *                 turn that ran: a held, unpromoted guess has said nothing).
   *   generations — turns allowed to speak for it. Capped at two.
   *   revokedBy   — the answer was un-said (killSpeech + gen bump) because the
   *                 finished sentence contradicted it. 'drift' is the only
   *                 legitimate reason there has ever been.
   *   turnEndAt   — when we last acted on an end-of-turn signal for it.
   */
  const ledger = new Map();
  /** A finished SPECULATIVE turn holding its audio, waiting to be confirmed. */
  let pendingSpec = null;
  /** When we last acted on ANY end-of-turn signal (the debounce clock). */
  let lastTurnEndAt = 0;
  /** Has the STT delivered anything at all since that turn-end? */
  let signalSinceTurnEnd = false;

  function ledgerFor(id) {
    let e = ledger.get(id);
    if (!e) {
      e = { utt: id, answered: false, generations: 0, revokedBy: null, turnEndAt: 0, refused: 0 };
      // Bounded: a long call must not grow a map forever. The OLDEST row goes,
      // and an utterance old enough to fall off cannot still be answered.
      if (ledger.size >= MAX_LEDGER_ROWS) ledger.delete(ledger.keys().next().value);
      ledger.set(id, e);
    }
    return e;
  }

  /** A reply for this utterance is on the wire. There is never a second one. */
  function noteAnswered(id) {
    if (!id) return;
    const e = ledgerFor(id);
    if (!e.answered) {
      e.answered = true;
      e.answeredAt = Date.now();
    }
  }

  /**
   * UN-SAY IT. The finished sentence contradicted the one we answered, so the
   * utterance's answered slot is revoked and ONE more generation is allowed.
   * The caller ALWAYS follows this with killSpeech() — the audio of the answer
   * being revoked must die under the same gen bump, or the "correction" plays
   * after the thing it corrects.
   */
  function revokeAnswer(id, why) {
    if (!id) return;
    const e = ledgerFor(id);
    e.answered = false;
    e.revokedBy = why || 'drift';
  }

  /**
   * ONE TURN-END PER UTTERANCE, PER WINDOW.
   *
   * Three signals mean "the caller stopped": the vendor's `speech_final`, its
   * later empty `UtteranceEnd` flush frame, and our own EOT timer. On the
   * founder's call the second one arrived a few milliseconds after the first,
   * found the utterance already consumed, and spoke the unclear line straight
   * over the answer — a second reply to one sentence, from a path that never
   * touches an LLM.
   *
   * @returns {boolean} false ⇒ this signal is a duplicate; do nothing
   */
  function claimTurnEnd(id) {
    const at = Date.now();
    const e = id ? ledgerFor(id) : null;
    // With an utterance open the ledger is the clock; with none open (it was
    // just consumed) the call-level one is — but ONLY when nothing new has been
    // heard since, because a caller who spoke again is a new turn-end, not an
    // echo of the last one.
    const dup = e
      ? e.turnEndAt && at - e.turnEndAt < turnEndDebounceMs
      : lastTurnEndAt && at - lastTurnEndAt < turnEndDebounceMs && !signalSinceTurnEnd;
    if (dup) {
      turnEndsDebounced += 1;
      log(
        `[voice-cascade] turn-end debounced (utt ${id || 'none'}, ` +
          `${at - (e ? e.turnEndAt : lastTurnEndAt)}ms after the last one) — one utterance, one turn-end`
      );
      return false;
    }
    if (e) e.turnEndAt = at;
    lastTurnEndAt = at;
    signalSinceTurnEnd = false;
    return true;
  }

  function beginUtterance() {
    if (utterance.startedAt) return;
    utterance.startedAt = Date.now();
    utterance.id = uttId += 1;
  }

  function resetUtterance() {
    utterance = { id: 0, startedAt: 0, prevInterim: '', lastInterim: '', finalText: '', finalAt: 0 };
  }

  // ── instrumentation ───────────────────────────────────────────────────────
  const turnLatencies = [];
  let callerStopAt = 0;
  let awaitingReply = false;
  let markTurnFrame = false;
  let greetingSource = null;
  let greetStartAt = 0;
  let greetingMs = null;
  let markGreetingFrame = false;
  let bargeIns = 0;
  let bargeFramesDropped = 0;
  let lastFlushMs = null;
  let fillersPlayed = 0;
  let speculations = 0;
  let speculativeRestarts = 0;
  /** Finals the ears invented in a script nobody on this line speaks. */
  let hallucinatedFinals = 0;
  /** Replies the MODEL wrote in a language nobody spoke — discarded unheard. */
  let langRejected = 0;
  /** Finals with nothing sayable in them ('.', '…'): never a turn. */
  let emptyFinals = 0;
  /** Barge-ins triggered by ENERGY rather than by a transcript. */
  let energyBargeIns = 0;
  /** Consecutive milliseconds of caller energy over the threshold. */
  let bargeHotMs = 0;
  // ── V7-P2.1 — the double-reply counters ───────────────────────────────────
  /** Frames whose owner did not hold the current speakGen. Never sent. */
  let staleFramesDropped = 0;
  /** Held speculative PCM chunks thrown away because the wire moved on. */
  let staleHeldDropped = 0;
  /** Frames of a CONFIRMED guess flushed onto the wire on promotion. */
  let specFramesFlushed = 0;
  /** Speculative PCM chunks discarded unheard (a guess that missed costs 0 ms). */
  let specChunksDiscarded = 0;
  /** Turn-starts the ledger refused: that utterance already has its reply. */
  let ledgerRefused = 0;
  /** End-of-turn signals collapsed into the one that came first. */
  let turnEndsDebounced = 0;
  /** Energy barge-ins that fired with nothing of ours actually on the wire. */
  let energyBargeSilent = 0;
  /**
   * The last thing WE said out loud. liveEars compares finals against it: a
   * Gemini Live session listening to a phone leg sometimes transcribes our own
   * TTS bleeding back, and answering our own voice is the loop that turns one
   * agent into two.
   */
  let lastAgentUtterance = '';
  /**
   * Turns whose waterfall row exists but whose FIRST AUDIO has not reached the
   * wire yet. Emptied by markFirstAudio() or, failing that, by stop().
   */
  const openWaterfalls = new Set();
  /** The turn that owns the next real reply frame (for first_audio_ms). */
  let audioOwner = null;

  // ── caller context (personalization) ──────────────────────────────────────
  let contextPromise = null;
  let callerContext = null;
  let connecting = null;

  function track(p) {
    const q = Promise.resolve(p).catch((err) => log('[voice-cascade] background task failed:', err?.message || err));
    pending.add(q);
    q.finally(() => pending.delete(q));
    return q;
  }

  async function settled() {
    for (let i = 0; i < 20 && pending.size; i += 1) await Promise.all([...pending]);
  }

  // ── transcript ────────────────────────────────────────────────────────────
  function appendTranscript(who, text) {
    const s = String(text || '');
    if (!s) return;
    const last = transcript[transcript.length - 1];
    if (last && last.who === who) last.text += ` ${s}`;
    else transcript.push({ who, text: s, at: toDate(clock()).toISOString() });

    let total = 0;
    for (const e of transcript) total += e.text.length;
    while (total > TRANSCRIPT_MAX_CHARS && transcript.length) {
      const head = transcript[0];
      const over = total - TRANSCRIPT_MAX_CHARS;
      if (head.text.length > over) {
        head.text = head.text.slice(over);
        total -= over;
      } else {
        total -= head.text.length;
        transcript.shift();
      }
    }
  }

  // ── outbound RTP (the incumbent's pacer, unchanged) ────────────────────────
  function buildRtpPacket(payload) {
    const header = Buffer.allocUnsafe(12);
    header[0] = 0x80;
    header[1] = (markNext ? 0x80 : 0x00) | (codec.payloadType & 0x7f);
    header.writeUInt16BE(seq, 2);
    header.writeUInt32BE(rtpTs >>> 0, 4);
    header.writeUInt32BE(ssrc >>> 0, 8);
    seq = (seq + 1) & 0xffff;
    markNext = false;
    return Buffer.concat([header, Buffer.isBuffer(payload) ? payload : Buffer.from(payload)]);
  }

  // Wall-clock-anchored pacing. The naive design (ONE frame per setInterval
  // tick) starved a real call: Windows timers fire late under load, so "20 ms"
  // ticks averaged 30-50 ms and ten seconds of speech took ~30 s to leave the
  // machine. Every tick sends however many frames are DUE by real elapsed time,
  // capped so a long event-loop stall cannot megaburst.
  const MAX_CATCHUP_FRAMES = 25;
  let paceAnchor = null;
  let frameSlots = 0;
  // ── P2.1 INSTRUMENTATION: every RTP-out frame is source-tagged ────────────
  // The founder heard TWO sequential replies to one utterance. Before any fix,
  // the wire must say WHO spoke: queue entries carry {src, uttId}, the pacer
  // logs one line per contiguous source segment, and stats() counts frames by
  // source. srcs: greeting | filler | spec | turn | emergency.
  const outBySrc = { greeting: 0, filler: 0, spec: 0, turn: 0, emergency: 0, unknown: 0 };
  let outSeg = null; // { src, uttId, frames } — the segment being played now

  function logSegment() {
    if (!outSeg) return;
    log(`[rtp-out] src=${outSeg.src} utt=${outSeg.uttId ?? '-'} frames=${outSeg.frames} (${outSeg.frames * FRAME_MS}ms)`);
    outSeg = null;
  }

  function noteOutFrame(entry, nowMs) {
    const src = entry.src || 'unknown';
    outBySrc[src] = (outBySrc[src] || 0) + 1;
    if (!outSeg || outSeg.src !== src || outSeg.uttId !== entry.uttId) {
      logSegment();
      outSeg = { src, uttId: entry.uttId, frames: 0, startedAt: nowMs };
    }
    outSeg.frames += 1;
  }

  function tick() {
    if (stopped || !codec) return;
    const nowMs = Date.now();
    if (paceAnchor == null) paceAnchor = nowMs - FRAME_MS;
    const due = Math.floor((nowMs - paceAnchor) / FRAME_MS) - frameSlots;
    let budget = Math.min(due, MAX_CATCHUP_FRAMES);
    while (budget-- > 0) {
      frameSlots += 1;
      rtpTs = (rtpTs + codec.timestampIncrement) >>> 0;
      if (!outQueue.length) {
        markNext = true;
        logSegment(); // the wire went quiet — close the segment for the log
        continue;
      }
      const entry = outQueue.shift();
      const payload = entry.p;
      noteOutFrame(entry, nowMs);
      if (tapePending > 0) tapePending -= 1;
      hangupQuietSince = 0;
      if (markGreetingFrame) {
        markGreetingFrame = false;
        greetingMs = nowMs - greetStartAt;
      }
      if (markTurnFrame) {
        markTurnFrame = false;
        awaitingReply = false;
        if (callerStopAt && turnLatencies.length < MAX_LATENCY_SAMPLES) {
          turnLatencies.push(nowMs - callerStopAt);
        }
        // THE TURN THAT OWNS THIS AUDIO, not "whatever turn is running now".
        // That was the P1 bug behind `first_audio: None` on every waterfall of
        // the founder's live call: by the time a frame reached the wire, the
        // module-level `turn` had already been set to null by runTurn(), so the
        // mark landed on nothing. The owner is captured when the audio is
        // queued and travels with it.
        markFirstAudio(audioOwner, nowMs);
        audioOwner = null;
      }
      try {
        media?.sendRtp?.(buildRtpPacket(payload));
      } catch (err) {
        log('[voice-cascade] sendRtp failed:', err?.message || err);
      }
    }
    maybeHangUp(nowMs);
  }

  function ensurePacing() {
    if (paceTimer || stopped) return;
    paceAnchor = null;
    frameSlots = 0;
    paceTimer = setInterval(tick, FRAME_MS);
    paceTimer.unref?.();
  }

  /**
   * THE ONE DOOR TO THE WIRE (V7-P2.1).
   *
   * Every frame this call ever sends — greeting, filler, turn, promoted guess,
   * emergency, replayed tape — is pushed here, and it must present the
   * generation it was made under. A generation that is no longer current means
   * something has happened since (a barge-in, a restart, an emergency, the
   * hang-up), so those frames belong to a sentence the caller must not hear:
   * they are dropped, logged and counted rather than quietly appended behind
   * whatever is speaking now. That is what "one writer owns the wire" means in
   * code, and it is the invariant the double-reply bug violated.
   *
   * `gen === null` is the ONE exemption, and it is the emergency: the ambulance
   * number outranks the generation counter, exactly as speakSentence() already
   * exempts it from cancellation.
   *
   * @param {Array<Buffer>} frames encoded 20 ms payloads
   * @param {object} p { src, uttId, gen, owner, tapeable }
   * @returns {number} frames actually queued
   */
  function pushFrames(frames, { src = 'unknown', uttId: frameUtt = null, gen = null, owner = null, tapeable = true } = {}) {
    if (!frames || !frames.length) return 0;
    if (gen != null && gen !== speakGen) {
      staleFramesDropped += frames.length;
      log(`[rtp-out] dropped ${frames.length} frames: stale gen (src=${src} utt=${frameUtt ?? '-'})`);
      return 0;
    }
    const queueWasEmpty = outQueue.length === 0;
    // ONLY when the queue was empty: if we were still speaking, the first frame
    // out is the tail of the PREVIOUS sentence, and timing to it would report a
    // latency the caller never experienced.
    //
    // AND NEVER FOR A FILLER. «ثانية برك…» is what we say INSTEAD of the
    // answer; timing the reply to it would report a latency that flatters us by
    // exactly the amount the brain was late — turning the metric that exists to
    // expose slowness into one that hides it.
    if (awaitingReply && !markTurnFrame && queueWasEmpty && src !== 'filler' && src !== 'greeting') {
      markTurnFrame = true;
      audioOwner = owner;
    }
    for (const payload of frames) {
      outQueue.push({ p: payload, src, uttId: frameUtt });
      if (!tapeable) continue;
      if (activeTape && activeTape.frames.length < MAX_GREETING_FRAMES) activeTape.frames.push(payload);
      else if (activeTape) activeTape.overflow = true;
    }
    // A REPLY THIS UTTERANCE CAN NEVER GET TWICE. The ledger's `answered` is
    // set HERE — where audio really becomes audible — and not when a turn
    // finishes: a held guess that was never promoted has said nothing at all.
    if (frameUtt && (src === 'turn' || src === 'emergency')) noteAnswered(frameUtt);
    ensurePacing();
    return frames.length;
  }

  /**
   * Synthesized PCM on its way out. A SPECULATIVE turn's audio never reaches
   * pushFrames: it is held raw (un-encoded, so a guess that misses costs the
   * codec nothing) until a final confirms the guess.
   */
  function emitPcm(pcm, rate = ttsRate, owner = null, src = null, gen = null) {
    const frameSrc =
      src || (emittingFiller ? 'filler' : owner?.speculative ? 'spec' : owner ? 'turn' : 'unknown');
    if (owner && owner.speculative) {
      holdPcm(owner, pcm, rate, gen);
      return;
    }
    try {
      const frames = codec.encodeOut(pcm, rate);
      pushFrames(frames, { src: frameSrc, uttId: owner?.uttId ?? null, gen, owner });
    } catch (err) {
      log('[voice-cascade] outbound encode failed:', err?.message || err);
    }
  }

  /** PREPARE-ONLY. Pre-warmed audio for a guess nobody has confirmed yet. */
  function holdPcm(t, pcm, rate, gen) {
    if (!pcm || !pcm.length) return;
    if (t.heldSamples >= MAX_HELD_SAMPLES) {
      if (!t.heldOverflow) {
        t.heldOverflow = true;
        log(`[voice-cascade] speculative audio exceeded ${MAX_HELD_SAMPLES} samples — holding no more of it`);
      }
      return;
    }
    t.heldSamples += pcm.length;
    t.held.push({ pcm, rate, gen });
  }

  /**
   * THE GUESS WAS RIGHT. Everything held is encoded and queued now, in order,
   * under the CURRENT generation — one atomic handover, so no other writer can
   * interleave a frame into the middle of a sentence.
   */
  function flushHeld(t) {
    const held = t.held;
    t.held = [];
    t.heldSamples = 0;
    for (const chunk of held) {
      // Held under a generation that has since been superseded: a barge-in or an
      // emergency happened while we were guessing, and this audio answers a
      // moment that is over.
      if (chunk.gen != null && chunk.gen !== speakGen) {
        staleHeldDropped += 1;
        continue;
      }
      try {
        const frames = codec.encodeOut(chunk.pcm, chunk.rate);
        specFramesFlushed += pushFrames(frames, {
          src: 'turn',
          uttId: t.uttId,
          gen: speakGen,
          owner: t,
        });
      } catch (err) {
        log('[voice-cascade] outbound encode failed:', err?.message || err);
      }
    }
  }

  /** The guess missed. It never reached a mouth, so there is nothing to unsay. */
  function dropHeld(t) {
    if (!t) return;
    specChunksDiscarded += t.held.length;
    t.held = [];
    t.heldSamples = 0;
    t.heldTranscript = [];
  }

  /**
   * SHUT UP, NOW. Every layer at once: the queued frames, the codec's partial
   * frame, the utterances still on the speech queue (via the generation number)
   * and the HTTP request being streamed right this instant (via the abort).
   * @returns {number} milliseconds the whole kill chain took
   */
  function killSpeech(reason) {
    const t0 = Date.now();
    const dropped = outQueue.length;
    if (dropped) {
      const bySrc = {};
      for (const e of outQueue) bySrc[e.src || 'unknown'] = (bySrc[e.src || 'unknown'] || 0) + 1;
      log(`[rtp-out] killed ${dropped} queued frames (${reason}): ${JSON.stringify(bySrc)}`);
    }
    logSegment();
    outQueue = [];
    tapePending = 0;
    markNext = true;
    markTurnFrame = false;
    codec?.resetOut();
    speakGen += 1;
    activeTape = null;
    const ac = synthAbort;
    synthAbort = null;
    // THE LINE THAT KILLED THE SERVER. Aborting a controller is synchronous and
    // cannot throw here — but the REASON travels into the synthesis chain, and
    // anything there that leaves a rejected promise unobserved becomes an
    // unhandled rejection, which Node turns into a fatal exception out of the
    // RTP path. Tagged so every layer below can tell "we cancelled this" from
    // "the provider died"; see speechAbortReason above and brain/tts/wire.js.
    abortQuietly(ac, reason);
    const ms = Date.now() - t0;
    if (reason === 'barge_in') {
      bargeIns += 1;
      bargeFramesDropped += dropped;
      lastFlushMs = ms;
      log(
        `[voice-cascade] barge-in #${bargeIns}: killed ${dropped} queued frames ` +
          `(${dropped * FRAME_MS}ms of speech) in ${ms}ms`
      );
    }
    return ms;
  }

  // ── the mouth ─────────────────────────────────────────────────────────────
  function enqueueSpeak(fn) {
    const gen = speakGen;
    speakPending += 1;
    speakChain = speakChain
      .then(async () => {
        if (stopped || gen !== speakGen) return;
        await fn(gen);
      })
      // The chain must never stay rejected: everything queued behind a failed
      // utterance would be skipped.
      .catch((err) => log('[voice-cascade] speech queue error:', err?.message || err))
      .finally(() => {
        speakPending = Math.max(0, speakPending - 1);
      });
    track(speakChain);
    return speakChain;
  }

  /**
   * Synthesize ONE utterance onto the wire.
   * @param {string} text
   * @param {number} gen
   * @param {object} [opts] { emergency, tape } — `tape` records the frames for
   *   the cache (the greeting and the filler); `emergency` marks the one
   *   utterance nothing may cancel.
   */
  async function speakSentence(text, gen, { emergency = false, tape = null, filler = false, owner = null } = {}) {
    if (!hasMouth) return;
    const said = ttsChain.normalizeSpoken ? ttsChain.normalizeSpoken(text, L) : String(text || '').trim();
    // Punctuation-only text is not an utterance, and turning it into an HTTP
    // request means a provider error on a piece of nothing could end a call
    // that was going perfectly well.
    if (!said || !SPEAKABLE_RE.test(said)) return;
    const cancelled = () => stopped || (!emergency && gen !== speakGen);
    if (cancelled()) return;

    const ac = new AbortController();
    if (!emergency) synthAbort = ac;
    if (tape) activeTape = { frames: [], overflow: false, key: tape.key, text: tape.text };
    // What the ears may hear coming back out of the caller's speaker — a
    // SPECULATIVE sentence has not been said, so it is not echo material.
    if (!owner?.speculative) lastAgentUtterance = said;
    const startedAt = Date.now();
    let firstChunkAt = 0;
    if (filler) emittingFiller = true;
    try {
      for await (const chunk of ttsChain.synthesize(said, { lang: L, signal: ac.signal })) {
        if (cancelled()) return;
        if (!chunk || !chunk.length) continue;
        if (!firstChunkAt) {
          firstChunkAt = Date.now();
          // THE MOUTH'S OWN LATENCY, attributed to the turn that ORDERED this
          // sentence rather than to whatever `turn` happens to be now — the
          // speech queue is asynchronous, so by the time a provider answers,
          // runTurn() has usually finished and cleared it. That is why every
          // waterfall in the founder's live call read `tts_ttfb: None`.
          //
          // A filler's synthesis time is not the REPLY's time-to-first-byte.
          if (!filler && owner && owner.ttsTtfbMs == null) owner.ttsTtfbMs = firstChunkAt - startedAt;
        }
        emitPcm(
          chunk,
          ttsRate,
          owner,
          emergency ? 'emergency' : filler ? 'filler' : owner ? 'turn' : 'greeting',
          // THE GENERATION THIS AUDIO BELONGS TO. The emergency writer alone
          // presents none: it outranks the counter, exactly as `cancelled()`
          // above exempts it from being cancelled at all.
          emergency ? null : gen
        );
      }
      sentencesSpoken += 1;
      commitTape();
    } catch (err) {
      // OUR OWN abort is not a provider failure. Ending the call because the
      // caller interrupted us would be the most expensive bug in this file.
      if (cancelled()) return;
      onTtsFailure(err);
    } finally {
      if (filler) emittingFiller = false;
      if (synthAbort === ac) synthAbort = null;
      activeTape = null;
    }
  }

  function onTtsFailure(err) {
    if (ttsFailed) return;
    ttsFailed = true;
    ttsChain.markDegraded?.();
    speakGen += 1;
    log(
      `[voice-cascade] TTS provider ${ttsChain.provider} failed mid-call (${err?.message || err}) — ` +
        `degrading to the WhatsApp follow-up`
    );
    if (!stopped) stop('tts_lost');
  }

  /** True while something is still being synthesized or waiting to be. */
  function speechInFlight() {
    return speakPending > 0;
  }

  // ── the tape (greeting + filler share one cache) ──────────────────────────
  /**
   * Say something that is the SAME every call, from cache when we have it.
   *
   * The greeting and the filler are the two utterances a tenant repeats
   * hundreds of times, and both are on the critical path: the greeting IS the
   * first impression, and the filler exists specifically because something else
   * is slow. Synthesizing either from scratch every call would spend the
   * latency this whole tier was built to remove.
   *
   * The cache is brain/greetingCache.js unchanged — keyed tenant:lang:codec and
   * discriminated by voice. The FILLER rides the same store under a `filler:`
   * voice prefix, which is the generalization rather than a second cache with
   * the same three bugs. The CODEC in that key is load-bearing: Opus payloads
   * replayed on a G.711 leg are pure noise.
   */
  function speakTaped(text, kind) {
    if (!text) return false;
    const filler = kind === 'filler';
    const key = filler ? `filler:${voiceKey || 'default'}` : voiceKey;
    if (greetingCacheOn) {
      const tape = getGreeting({
        tenantId,
        lang: L,
        codec: codec?.codec,
        voice: key,
        signature: text,
        at: Date.now(),
      });
      if (tape) {
        // Already encoded, so it skips the codec — but NOT the one door: a
        // replayed tape acquires the current generation like every other
        // writer, and `tapeable:false` keeps a replay from being re-recorded.
        lastAgentUtterance = text;
        const queued = pushFrames(tape.frames, {
          src: filler ? 'filler' : 'greeting',
          gen: speakGen,
          tapeable: false,
        });
        tapePending += queued;
        return true; // played from cache, inside one pacing tick
      }
    }
    enqueueSpeak((gen) =>
      speakSentence(text, gen, { filler, tape: greetingCacheOn ? { key, text } : null })
    );
    return false;
  }

  /** The utterance finished cleanly ⇒ it is safe to replay on the next call. */
  function commitTape() {
    const tape = activeTape;
    activeTape = null;
    if (!tape || tape.overflow || !tape.frames.length) return;
    putGreeting({
      tenantId,
      lang: L,
      codec: codec?.codec,
      voice: tape.key,
      frames: tape.frames,
      text: tape.text,
      signature: tape.text,
      sampleCount: 0,
      at: Date.now(),
    });
  }

  // ── the hang-up (V5-T2 semantics, unchanged) ──────────────────────────────
  function maybeHangUp(nowMs) {
    if (stopped || !callState.endRequested) return;
    // An EMERGENCY owns the ending. Its grace timer is the authority.
    if (callState.emergency) return;
    if (outQueue.length || tapePending > 0 || speechInFlight()) {
      hangupQuietSince = 0;
      return;
    }
    if (!hangupQuietSince) {
      hangupQuietSince = nowMs;
      return;
    }
    if (nowMs - hangupQuietSince < HANGUP_QUIET_MS) return;
    hangupBy = 'agent';
    log('[voice-cascade] end_call: the goodbye finished playing — hanging up');
    stop('completed');
  }

  function armHangup() {
    if (hangupTimer || stopped) return;
    hangupQuietSince = 0;
    const graceMs = Number(config.voiceCallHangupGraceMs) || DEFAULT_HANGUP_GRACE_MS;
    hangupTimer = setTimeout(() => {
      if (stopped || !callState.endRequested) return;
      hangupBy = 'grace';
      log(`[voice-cascade] end_call: the goodbye never finished within ${graceMs}ms — hanging up anyway`);
      stop('completed');
    }, graceMs);
    hangupTimer.unref?.();
    // The pacer is what NOTICES the wire going quiet.
    ensurePacing();
  }

  function cancelHangup(why) {
    if (!callState.endRequested && !hangupTimer) return;
    callState.endRequested = false;
    hangupQuietSince = 0;
    hangupBy = null;
    if (hangupTimer) {
      clearTimeout(hangupTimer);
      hangupTimer = null;
    }
    log(`[voice-cascade] end_call cancelled (${why}) — the caller is still speaking`);
  }

  // ── the emergency preflight (the model never gets a vote) ─────────────────
  /**
   * @returns {boolean} true when this text was an emergency and has been handled
   */
  function emergencyPreflight(text) {
    if (callState.emergency) return true;
    // THE WINDOW IS ONE UTTERANCE, NOT ONE CALL. It exists to rejoin fragments
    // streamed mid-sentence. Letting it span turns produced a proven false
    // positive: "my knee hurts" then "chest imaging" ⇒ chest_pain.
    callerHasFloor = true;
    emergencyWindow = `${emergencyWindow}${text}`.slice(-EMERGENCY_WINDOW_CHARS);
    const hit = detectEmergency(emergencyWindow, L);
    if (!hit.hit) return false;
    callState.emergency = true;
    track(fireEmergency(hit));
    return true;
  }

  function onAgentTurn() {
    if (!callerHasFloor) return;
    callerHasFloor = false;
    emergencyWindow = '';
  }

  /** Is any of OUR audio queued, taped or still being synthesized right now? */
  function agentSpeaking() {
    return outQueue.length > 0 || tapePending > 0 || speechInFlight();
  }

  /** Is any of it AUDIBLE — actually on the wire, as opposed to being made? */
  function agentAudible() {
    return outQueue.length > 0 || tapePending > 0;
  }

  /**
   * ENERGY BARGE-IN — the interruption test that does not trust the ears.
   *
   * On the founder's first live cascade call the caller talked over the agent
   * again and again and `bargeIns` was ZERO for 101 seconds: every path to the
   * kill-chain went through a transcript, and the transcripts were late, empty
   * or hallucinated. Meanwhile the ONE thing we always have, on every frame, at
   * zero cost, is how loud the caller is.
   *
   * Two deliberate restrictions:
   *   • energy is only accumulated WHILE WE ARE SPEAKING. Otherwise a caller
   *     who was mid-sentence when the agent started would trip the barge-in on
   *     the agent's very first frame — cutting off the answer they asked for.
   *   • the sustain window is 240 ms. A click, a cough, a burst of line noise
   *     or one loud packet does not survive it; a human syllable does.
   *
   * @param {Int16Array} pcm decoded caller audio @16 kHz
   */
  function noteEnergy(pcm) {
    if (!energyBargeOn || stopped || callState.emergency) return;
    if (!agentSpeaking()) {
      bargeHotMs = 0;
      return;
    }
    if (frameRms(pcm) < bargeRms) {
      bargeHotMs = 0;
      return;
    }
    bargeHotMs += (pcm.length / BRAIN_IN_RATE) * 1000;
    if (bargeHotMs < bargeRmsMs) return;
    bargeHotMs = 0;
    // THE GATE, CHECKED WHERE IT FIRES (V7-P2.1). On the instrumented call two
    // of four energy barge-ins killed ZERO queued frames — they fired into
    // silence, because the sustain window can outlive the sentence it was
    // measured against. Killing silence is not an interruption, it is noise in
    // the one counter that says whether callers can interrupt this agent.
    if (!agentSpeaking()) {
      energyBargeSilent += 1;
      return;
    }
    const queued = outQueue.length + tapePending;
    if (!queued) energyBargeSilent += 1;
    energyBargeIns += 1;
    log(
      `[voice-cascade] energy barge-in: ${Math.round(bargeRmsMs)}ms of speech over us ` +
        `(rms ≥ ${bargeRms}) with no usable transcript — stopping anyway ` +
        `(${queued} frames queued, ${speakPending} utterances in flight)`
    );
    abortTurn('barge_in');
    killSpeech('barge_in');
  }

  async function fireEmergency(hit) {
    // Localize from the table that MATCHED, not the ambient guess. Arabizi is
    // Arabic typed in Latin ⇒ Arabic reply.
    const matched = hit.lang === 'arabizi' ? 'ar' : hit.lang;
    const replyLang = ['ar', 'fr', 'en'].includes(matched) ? matched : L;
    const spoken = buildSpokenEmergencyReply(clinic, replyLang); // no emoji, digits read out
    const written = buildEmergencyReply(clinic, replyLang);

    // 1) The caller's EAR first. Kill whatever we were saying — including the
    //    LLM turn that was writing it — so the override is not queued behind a
    //    sentence about opening hours. From here barge-in is ignored and the
    //    caller's uplink is muted: being interrupted out of reading an ambulance
    //    number is a worse outcome than being rude.
    abortTurn('emergency');
    killSpeech('emergency');
    enqueueSpeak((gen) => speakSentence(spoken, gen, { emergency: true }));
    // The ONE thing the clinic must be able to prove it said.
    appendTranscript('agent', spoken);

    // 2) Staff.
    try {
      bus?.publish?.('emergency.detected', {
        tenantId,
        conversationId,
        keyword: hit.keyword,
        category: hit.category,
        lang: hit.lang || L,
        waId: patientWaId,
        patientWaId,
        channel: 'call',
      });
    } catch (err) {
      log('[voice-cascade] emergency publish failed:', err?.message || err);
    }

    // 3) The bot steps back on EVERY channel, not just this call.
    try {
      if (conversationId) {
        const patch = { status: 'needs_human', aiPaused: true };
        await store.conversations.update(tenantId, conversationId, patch);
        bus?.publish?.('conversation.updated', { tenantId, conversationId, patch });
      }
    } catch (err) {
      log('[voice-cascade] emergency pause failed:', err?.message || err);
    }

    // 4) IN WRITING. Nobody in distress retains a phone number heard once.
    try {
      if (conversationId && patientWaId) {
        await sendAs('bot', conversationId, () => sender.sendText(clinic, patientWaId, written));
      }
    } catch (err) {
      log('[voice-cascade] emergency WhatsApp text failed:', err?.message || err);
    }

    // 5) End the call — on a timer, so it happens whether or not anything else did.
    if (!stopped && !emergencyTimer) {
      emergencyTimer = setTimeout(() => stop('emergency'), emergencyGraceMs);
      emergencyTimer.unref?.();
    }
  }

  // ── STT → turns ───────────────────────────────────────────────────────────
  function noteCallerSpeech(text, { final }) {
    callState.lastCallerSpeechAt = toDate(clock()).getTime();
    if (final && callState.staged) callState.speechSinceStage += String(text || '');
    callerStopAt = Date.now();
    awaitingReply = true;
    // "بالسلامة" — "wait, one more thing!". They spoke after the goodbye, so
    // there is no goodbye.
    if (!callState.emergency && callState.endRequested) cancelHangup('the caller spoke again');
  }

  function onInterim(ev) {
    if (stopped || callState.emergency) return;
    const text = String(ev?.text || '');
    if (!text.trim()) return;
    // The ears delivered something: the next end-of-turn signal is about NEW
    // speech, not a second opinion on the last silence (see claimTurnEnd).
    signalSinceTurnEnd = true;
    noteCallerSpeech(text, { final: false });
    beginUtterance();

    // BARGE-IN. The caller is talking while we are: stop, at every layer, and
    // keep the context — what we already said stays in history so the next turn
    // knows the caller heard half a sentence.
    if (outQueue.length || tapePending > 0 || speechInFlight()) {
      abortTurn('barge_in');
      killSpeech('barge_in');
    }

    // The detector runs on interims too. Waiting for the final would cost a
    // frightened caller several hundred milliseconds for no benefit — and the
    // final path runs it again, so a missed interim changes nothing.
    if (emergencyPreflight(text)) return;

    // THE CALLER IS STILL TALKING. An interim after a final means the utterance
    // is not over, so any end-of-turn timer armed by that final is wrong — it
    // would cut them off mid-sentence and answer half a question. Found in
    // review; the vendor's own `speech_final` is the only signal allowed to end
    // a turn while words are still arriving.
    clearEot();

    utterance.prevInterim = utterance.lastInterim;
    utterance.lastInterim = text;
    maybeSpeculate();
  }

  /**
   * SPECULATION. Start the brain before the caller stops, on the evidence that
   * two consecutive interims agree about the beginning of the sentence. It buys
   * the whole LLM TTFT back when the guess holds, and costs one aborted request
   * when it does not.
   *
   * AT MOST ONE PER UTTERANCE, BETWEEN FINALS. Interims arrive several times a
   * second; without this gate a caller who paused mid-sentence would start,
   * abort and restart a request per interim — burning free-tier quota to answer
   * one question, and thrashing the very breaker that protects the call. The
   * gate re-opens when a FINAL arrives, because that is new evidence.
   */
  function maybeSpeculate() {
    if (turn || stopped || callState.emergency) return;
    if (utterance.speculated) return;
    if (!utterance.prevInterim || !utterance.lastInterim) return;
    const shared = sharedPrefixLength(utterance.prevInterim, utterance.lastInterim);
    if (shared < specMinPrefix) return;
    // A hallucinated INTERIM is the same lie as a hallucinated final, and
    // speculation is the one path that would hand it straight to a model
    // without passing the final gate. It still barged in (energy and interims
    // are how we know the caller is talking) — it just does not get a turn.
    if (isAlienScript(utterance.lastInterim)) {
      utterance.speculated = true; // do not retry this utterance every interim
      return;
    }
    // A GUESS THAT IS ALREADY MADE. One held, un-confirmed reply per utterance
    // is enough; a second would be a second thing to flush. (An utterance that
    // has already been ANSWERED is refused by the ledger inside startTurn,
    // where every path to a turn has to pass.)
    if (pendingSpec && pendingSpec.uttId === utterance.id) return;
    utterance.speculated = true;
    speculations += 1;
    startTurn(utterance.lastInterim, { speculative: true, uttId: utterance.id });
  }

  /**
   * THE EARS ARE NOT ORACLES (V7-P2.1). Two ways a "final" is not speech, and
   * both of them answered a caller on the founder's first live call:
   *
   *  1. IT IS PUNCTUATION. A '.'-only final became a full LLM turn — a model
   *     round trip, a spoken reply and a token bill, for a caller who had said
   *     nothing at all. The two-strike rule already covers this; it just was
   *     not reached, because the text was non-empty.
   *  2. IT IS ANOTHER ALPHABET. The transcriber hallucinated Mongolian Cyrillic
   *     («ийм шийд хэд за это») out of noisy derja, the model answered in
   *     Mongolian, and a Tunisian patient heard a language they do not speak
   *     from their own clinic. No prompt can repair a transcript that never
   *     contained the caller's words.
   *
   * Both are treated as what they are — an unclear turn — which reuses the V6.2
   * two-strike ladder (warm ask-again, then change the medium) instead of
   * inventing a third behaviour for the same human situation.
   *
   * @returns {boolean} true ⇒ handled here; this final is not speech
   */
  function refuseFinal(text, endOfTurn) {
    if (countSpeakable(text) < MIN_MEANINGFUL_CHARS) {
      emptyFinals += 1;
      // Punctuation is not an utterance — but an END-OF-TURN full of nothing
      // still closes whatever real words we were already holding.
      if (endOfTurn) endOfTurnSignal();
      return true;
    }
    if (isAlienScript(text)) {
      hallucinatedFinals += 1;
      log(
        `[voice-cascade] the ears hallucinated a foreign script (${describeScript(text)}) — ` +
          `refusing it as an unclear turn; no model sees this`
      );
      noteUnclear();
      return true;
    }
    return false;
  }

  function onFinal(ev) {
    if (stopped) return;
    const text = String(ev?.text || '');
    const endOfTurn = !!ev?.endOfTurn;
    if (text.trim()) signalSinceTurnEnd = true;
    if (!text.trim()) {
      // AN EMPTY END-OF-TURN FINAL IS A FLUSH SIGNAL, NOT A SILENT CALLER.
      // Deepgram sends `UtteranceEnd` (and an empty speech_final) on its own
      // frame after the words have already arrived on earlier ones. Treating
      // that as "I could not hear you" answered a perfectly good sentence with
      // "sorry, it is noisy" — found in review. So: if we are holding finals,
      // this CLOSES them; only a turn with nothing in it at all is unclear.
      //
      // V7-P2.1: and when the finals were ALREADY closed a moment ago — by
      // `speech_final` or by our own timer — this frame is the same endpoint
      // speaking twice. It used to answer the caller a second time, out of a
      // path that never touches an LLM. claimTurnEnd() collapses it.
      if (!endOfTurn) return;
      endOfTurnSignal();
      return;
    }
    // Before ANYTHING else: is this speech at all, and is it in a script a
    // caller on this line could have produced?
    if (refuseFinal(text, endOfTurn)) return;
    noteCallerSpeech(text, { final: true });
    beginUtterance(); // a final with no interim before it (Speechmatics, liveEars)
    appendTranscript('patient', text);

    // THE PREFLIGHT. Every final goes through OUR deterministic detector BEFORE
    // one byte of it reaches an LLM. This is the line the whole medical
    // guardrail rests on, and it is why the detector is imported rather than
    // re-implemented for voice.
    if (emergencyPreflight(text)) return;

    utterance.finalText = utterance.finalText ? `${utterance.finalText} ${text}` : text;
    utterance.finalAt = Date.now();
    utterance.speculated = false; // a final is new evidence: one more guess allowed
    if (!utterance.sttFinalMs && utterance.startedAt) {
      utterance.sttFinalMs = utterance.finalAt - utterance.startedAt;
    }

    // EVERY final is checked against the turn that is running, whether that turn
    // is still a guess or was PROMOTED by an earlier final.
    //
    // The bug this fixes, reproduced in review: "نحب نحجز موعد" promotes the
    // speculation, then the caller adds "…لا سامحني، نحب نعرف الأسعار". The
    // promoted turn was never re-checked, so the agent answered the booking
    // request and ignored the correction entirely. A caller correcting
    // themselves is not an edge case on a phone line — it is most of them.
    const live = turn && turn.uttId === utterance.id && !turn.locked ? turn : null;
    // A guess that FINISHED before the caller did is still a guess: it is
    // holding its audio, it has said nothing, and this final decides its fate.
    const held = !live && pendingSpec && pendingSpec.uttId === utterance.id ? pendingSpec : null;
    const candidate = live || held;
    if (candidate) {
      if (materialDrift(candidate.text, utterance.finalText)) {
        speculativeRestarts += 1;
        log(
          `[voice-cascade] turn discarded (drift ${diffRatio(candidate.text, utterance.finalText).toFixed(2)}) ` +
            `— restarting on the full final`
        );
        // THE REVOKE, THEN THE KILL, IN THAT ORDER (V7-P2.1). If any of this
        // utterance's answer already reached the wire it is un-said under a
        // generation bump; if it never did (a held guess) there is nothing to
        // unsay, and the caller never learns we guessed wrong.
        revokeAnswer(utterance.id, 'drift');
        if (live) abortTurn('speculation_missed');
        else discardSpec('drift');
        killSpeech('speculation_missed');
      } else if (candidate.speculative) {
        // It still answers this sentence: PROMOTE it — the held audio goes to
        // the wire now, atomically, under the current generation.
        promoteTurn(candidate, { text: utterance.finalText });
      } else {
        // Already promoted by an earlier final: keep its text in step with what
        // the caller has actually now said.
        candidate.text = utterance.finalText;
      }
    }
    // A COMPLETED answer for this utterance: we cannot unsay it, but the
    // HISTORY must record what the caller really said, never our guess at it.
    // `answeredText` (what the turn was given) is kept separately, because that
    // is what the drift decision at end-of-turn has to compare against.
    if (lastAnswered && lastAnswered.uttId === utterance.id && lastAnswered.entry) {
      lastAnswered.entry.text = utterance.finalText;
    }

    clearEot();
    // `speech_final` is the vendor's own endpointer saying the caller STOPPED.
    // Trusting it is how the 300 ms timer stops being paid on most turns.
    if (endOfTurn) endOfTurnSignal();
    else {
      eotTimer = setTimeout(endOfTurnSignal, eotMs);
      eotTimer.unref?.();
    }
  }

  /**
   * AN END-OF-TURN SIGNAL ARRIVED — from the vendor's `speech_final`, from its
   * empty flush frame, or from our own timer. All three mean one thing, so all
   * three come through one door, and the door only opens once per utterance
   * per debounce window.
   */
  function endOfTurnSignal() {
    clearEot();
    if (stopped || callState.emergency) return;
    if (!claimTurnEnd(utterance.id)) return;
    if (utterance.finalText.trim()) endOfTurnNow();
    else noteUnclear();
  }

  function clearEot() {
    if (eotTimer) {
      clearTimeout(eotTimer);
      eotTimer = null;
    }
  }

  function endOfTurnNow() {
    clearEot();
    if (stopped || callState.emergency) return;
    const text = utterance.finalText.trim();
    const vadMs = utterance.startedAt ? Date.now() - utterance.startedAt : null;
    const sttFinalMs = utterance.sttFinalMs ?? null;
    const id = utterance.id;
    resetUtterance();
    if (!text) return;
    if (countSpeakable(text) < MIN_MEANINGFUL_CHARS) {
      noteUnclear();
      return;
    }
    unclearStrikes = 0;
    let reuseEntry = null;
    // A GUESS THAT FINISHED BEFORE THE CALLER DID, holding its whole reply. The
    // finished sentence is the verdict: say it, or throw it away unheard. This
    // is the case that produced the founder's double reply — the guess used to
    // play as it was generated, and then this path answered the same sentence
    // again.
    if (pendingSpec && pendingSpec.uttId === id) {
      const guess = pendingSpec;
      if (!materialDrift(guess.text, text)) {
        promoteTurn(guess, { text, vadMs, sttFinalMs, eotAt: Date.now() });
        return;
      }
      speculativeRestarts += 1;
      log('[voice-cascade] the completed guess drifted from the final — dropping it unheard and answering for real');
      discardSpec('drift');
    }
    // A turn that ALREADY ANSWERED this utterance out loud. If the finished
    // sentence says the same thing, that answer stands — answering twice is the
    // failure speculation is most likely to cause. If it drifted, the answer is
    // revoked (killSpeech, under the generation bump) and the real question
    // gets the ONE restart the ledger allows.
    if (lastAnswered && lastAnswered.uttId === id) {
      if (!materialDrift(lastAnswered.answeredText, text)) return;
      speculativeRestarts += 1;
      log('[voice-cascade] a completed speculative answer drifted from the final — answering the real sentence');
      revokeAnswer(id, 'drift');
      killSpeech('drift_restart');
      // The history entry for this utterance already exists and already carries
      // the caller's real words (rewritten in onFinal). The corrected turn
      // updates it rather than pushing the same sentence a second time.
      reuseEntry = lastAnswered.entry || null;
    }
    // A guess still RUNNING when the caller stopped: the final is its verdict
    // too, and it never needed the caller to pause for us to check.
    if (turn && turn.speculative && turn.uttId === id) {
      if (!materialDrift(turn.text, text)) {
        promoteTurn(turn, { text, vadMs, sttFinalMs, eotAt: Date.now() });
        turn.locked = true;
        armFiller(turn);
        return;
      }
      abortTurn('speculation_missed');
      killSpeech('speculation_missed');
    }
    if (turn && !turn.speculative && turn.uttId === id) {
      // The turn was promoted and survived every drift check: it is already
      // answering this exact sentence. Give it the timings it could not know
      // when it started, and LOCK it — later finals belong to the next
      // utterance, not to this one.
      turn.vadMs = vadMs;
      turn.sttFinalMs = sttFinalMs;
      turn.eotAt = Date.now();
      turn.locked = true;
      armFiller(turn);
      return;
    }
    startTurn(text, { speculative: false, vadMs, sttFinalMs, uttId: id, reuseEntry });
  }

  function countSpeakable(text) {
    let n = 0;
    for (const ch of String(text || '')) if (SPEAKABLE_RE.test(ch)) n += 1;
    return n;
  }

  /**
   * V6.2 §4 — THE TWO-STRIKE NOISE RULE. A human receptionist asks once, warmly,
   * and then changes the medium rather than asking a third time. Nothing here
   * touches the booking gate: an unclear turn simply never becomes one.
   */
  function noteUnclear() {
    if (stopped || callState.emergency) return;
    unclearStrikes += 1;
    const line = unclearStrikes >= 2 ? buildTwoStrikeText(L) : buildUnclearText(L);
    if (unclearStrikes >= 2) unclearStrikes = 0;
    onAgentTurn();
    appendTranscript('agent', line);
    enqueueSpeak((gen) => speakSentence(line, gen));
  }

  // ── the turn ──────────────────────────────────────────────────────────────
  function abortTurn(why) {
    if (!turn) return;
    const dying = turn;
    turn = null;
    clearFiller();
    // NOTHING THIS TURN PREPARED WAS EVER HEARD if it was still a guess: the
    // audio is held, not queued, and the transcript rows are held with it.
    dropHeld(dying);
    if (pendingSpec === dying) pendingSpec = null;
    // KEEP THE CONTEXT. Whatever the model already said is what the caller
    // heard; dropping it would make the next turn repeat itself. A SPECULATIVE
    // turn's prompt was a guess at a half-finished sentence, so its user text
    // is deliberately not recorded — only real speech becomes history, and a
    // guess that never reached a mouth leaves no assistant line either: a
    // sentence nobody heard in the context window is how the next turn learns
    // not to say it.
    if (!dying.speculative && dying.text) history.push({ role: 'user', text: dying.text });
    if (!dying.speculative && dying.said.trim()) history.push({ role: 'assistant', text: dying.said.trim() });
    // TOKENS ARE SPENT WHETHER OR NOT WE USED THE ANSWER. An aborted turn still
    // billed a prompt, and under-reporting the cost of speculation and barge-in
    // would make the meter flatter than the invoice — which is the one direction
    // a cost number must never be wrong in.
    meterTurn(dying);
    abortQuietly(dying.abort, why || 'aborted');
  }

  /**
   * THE GUESS WAS RIGHT — hand it the wire.
   *
   * One place, so there is exactly one way a speculative turn can start
   * speaking: it stops being speculative, its held transcript rows become real,
   * its held audio is flushed under the CURRENT generation, and the ledger
   * records that this utterance now has its one reply. A turn that had already
   * finished writing is committed here too, because its commit was deferred
   * until somebody confirmed it was answering the right sentence.
   *
   * @param {object} t
   * @param {object} [p] { text, vadMs, sttFinalMs, eotAt }
   */
  function promoteTurn(t, { text = '', vadMs = null, sttFinalMs = null, eotAt = 0 } = {}) {
    if (!t || !t.speculative) return false;
    const e = t.uttId ? ledgerFor(t.uttId) : null;
    if (e && e.generations >= MAX_GENERATIONS_PER_UTT) {
      // Unreachable by design (a promotion IS the utterance's generation), and
      // loud rather than silent if the design is ever wrong.
      ledgerRefused += 1;
      log(`[voice-cascade] ledger refused to promote utt ${t.uttId}: ${e.generations} generations already`);
      discardSpec('ledger');
      return false;
    }
    t.speculative = false;
    if (text) t.text = text;
    if (vadMs != null) t.vadMs = vadMs;
    if (sttFinalMs != null) t.sttFinalMs = sttFinalMs;
    if (eotAt) t.eotAt = eotAt;
    if (pendingSpec === t) pendingSpec = null;
    if (e) e.generations += 1;
    for (const piece of t.heldTranscript) appendTranscript('agent', piece);
    t.heldTranscript = [];
    // What the ears may now hear coming back off the caller's speaker.
    if (t.said.trim()) lastAgentUtterance = t.said.trim();
    flushHeld(t);
    // It finished writing while it was still a guess: its history row, its
    // waterfall and its place in the ledger were all waiting on this.
    if (t.finished) commitTurn(t);
    return true;
  }

  /** The guess missed, and it never spoke. Drop it; the caller heard nothing. */
  function discardSpec(why) {
    const t = pendingSpec;
    if (!t) return;
    pendingSpec = null;
    dropHeld(t);
    meterTurn(t); // the tokens were spent whether or not we used the answer
    log(`[voice-cascade] a speculative reply was discarded unheard (${why}) — utt ${t.uttId}`);
  }

  /** Fold ONE turn's token usage into the call meter, exactly once. */
  function meterTurn(t) {
    if (!t || t.metered) return;
    t.metered = true;
    usage.llmTokensIn += t.usage.tokensIn;
    usage.llmTokensOut += t.usage.tokensOut;
  }

  /**
   * THE FILLER TIMER. Armed only for a turn that is answering a FINISHED
   * sentence: a speculation is by definition still waiting for the caller to
   * stop, so a filler there would be the agent saying "one second" while the
   * caller is mid-word — the exact interruption V6.2 forbids. When a promoted
   * turn reaches end-of-turn without a token yet, it is armed there instead.
   */
  function armFiller(t) {
    clearFiller();
    if (!t || t.speculative || t.ttftMs != null) return;
    fillerTimer = setTimeout(() => {
      if (stopped || turn !== t || t.ttftMs != null || t.speculative) return;
      // Only when the wire is genuinely quiet: talking over our own tail to say
      // "one second" is worse than the silence it was meant to cover.
      if (outQueue.length || speechInFlight()) return;
      fillersPlayed += 1;
      speakTaped(buildFillerText(L), 'filler');
    }, fillerTtftMs);
    fillerTimer.unref?.();
  }

  function clearFiller() {
    if (fillerTimer) {
      clearTimeout(fillerTimer);
      fillerTimer = null;
    }
  }

  function startTurn(
    text,
    { speculative = false, vadMs = null, sttFinalMs = null, uttId: id = 0, reuseEntry = null } = {}
  ) {
    if (stopped || callState.emergency || !hasMouth) return;
    const said = String(text || '').trim();
    if (!said) return;
    // ── THE LEDGER (V7-P2.1) ────────────────────────────────────────────────
    // Every path to a spoken reply comes through here — speculation, the
    // end-of-turn path, the keypad — so this is where "one reply per utterance"
    // is enforced rather than in each of them. A keypad phrase has no utterance
    // (id 0) and is governed by the keypad instead.
    if (id) {
      const e = ledgerFor(id);
      if (e.answered) {
        ledgerRefused += 1;
        e.refused += 1;
        log(
          `[voice-cascade] ledger REFUSED a second reply for utt ${id} ` +
            `(${speculative ? 'speculative' : 'end-of-turn'}): it has already been answered`
        );
        return;
      }
      // Speculation reserves nothing: a guess that is never confirmed never
      // speaks, so it cannot spend one of the utterance's two generations.
      if (!speculative) {
        if (e.generations >= MAX_GENERATIONS_PER_UTT) {
          ledgerRefused += 1;
          e.refused += 1;
          log(
            `[voice-cascade] ledger REFUSED generation ${e.generations + 1} for utt ${id} — ` +
              `the cap is ${MAX_GENERATIONS_PER_UTT} (answer + one drift restart)`
          );
          return;
        }
        e.generations += 1;
      }
    }
    // A held guess for a DIFFERENT sentence is dead the moment we start work on
    // this one: nobody is ever going to confirm it.
    if (pendingSpec && pendingSpec.uttId !== id) discardSpec('superseded');
    if (turn) abortTurn('superseded');
    const t = {
      gen: (turnGen += 1),
      uttId: id,
      text: said,
      speculative,
      /** For the waterfall: did speculation buy this turn its head start? */
      wasSpeculative: speculative,
      /** Set at end-of-turn: later finals belong to the NEXT utterance. */
      locked: false,
      /** An existing history row for this utterance, to update instead of duplicate. */
      reuseEntry,
      abort: new AbortController(),
      startedAt: Date.now(),
      eotAt: speculative ? 0 : Date.now(),
      ttftMs: null,
      ttsTtfbMs: null,
      firstAudioAt: 0,
      /** The waterfall row this turn owns, once it has one, and whether it is closed. */
      row: null,
      rowLogged: false,
      vadMs,
      sttFinalMs,
      said: '',
      buffer: '',
      usage: { tokensIn: 0, tokensOut: 0 },
      metered: false,
      /** PREPARE-ONLY (V7-P2.1): audio and transcript rows a guess may not publish. */
      held: [],
      heldSamples: 0,
      heldOverflow: false,
      heldTranscript: [],
      /** The model stopped writing (so a promotion must commit it immediately). */
      finished: false,
      committed: false,
    };
    turn = t;
    armFiller(t);
    track(runTurn(t));
  }

  async function runTurn(t) {
    const messages = [...history.slice(-MAX_HISTORY_TURNS), { role: 'user', text: t.text }];
    const system = buildVoiceTurnPrompt({
      clinic,
      lang: L,
      nowStr: nowString(toDate(clock())),
      kbText: t.text,
      patientWaId,
      callerContext,
    });
    let rounds = 0;

    try {
      for (;;) {
        rounds += 1;
        const calls = [];
        for await (const ev of llm.streamTurn({ system, messages, signal: t.abort.signal })) {
          if (stopped || turn !== t) return;
          if (ev.type === 'text' && ev.delta) {
            if (t.ttftMs == null) {
              t.ttftMs = Date.now() - t.startedAt;
              clearFiller();
            }
            onAgentTurn();
            t.said += ev.delta;
            t.buffer += ev.delta;
            const { pieces, rest } = takeSentences(t.buffer);
            t.buffer = rest;
            for (const piece of pieces) {
              // THE BACKSTOP (V7-P2.1). The prompt tells the model to answer in
              // one of three languages; this makes it true. Checked per SPOKEN
              // PIECE, which is the last moment before a vendor turns it into
              // audio — and the first piece is where a wandered model wanders.
              if (rejectAlienReply(t, piece)) return;
              // A GUESS DOES NOT GO ON THE RECORD. The transcript is what the
              // clinic can prove it said out loud; a speculative sentence has
              // not been said, and may never be. Held with its audio, published
              // together on promotion.
              if (t.speculative) t.heldTranscript.push(piece.trim());
              else appendTranscript('agent', piece.trim());
              enqueueSpeak((gen) => speakSentence(piece, gen, { owner: t }));
            }
            continue;
          }
          if (ev.type === 'toolCall' && ev.call) {
            calls.push(ev.call);
            continue;
          }
          if (ev.type === 'done') {
            llmProvider = ev.provider || llmProvider;
            t.usage.tokensIn += Number(ev.usage?.tokensIn) || 0;
            t.usage.tokensOut += Number(ev.usage?.tokensOut) || 0;
          }
        }
        if (stopped || turn !== t) return;

        if (!calls.length) break;

        // A GUESS MAY NOT WRITE. A speculative turn is running on half a
        // sentence; letting it stage a booking would mean the name, the day or
        // the number came from a fragment the caller had not finished saying.
        // So the moment a speculation reaches for a tool it is abandoned, and
        // the real turn — on the finished sentence — does the work.
        if (t.speculative) {
          log('[voice-cascade] speculative turn wanted a tool — abandoning it; a guess may not write');
          turn = null;
          clearFiller();
          // Whatever it had already prepared goes with it: held audio for a
          // sentence nobody will ever confirm is a reply waiting to escape.
          dropHeld(t);
          if (pendingSpec === t) pendingSpec = null;
          abortQuietly(t.abort, 'speculation reached a tool');
          return;
        }

        // ONE increment per BATCH. brain/tools.js refuses a confirm whose stage
        // carries this same id — that is the "you have not read the recap yet"
        // check, and it is the reason a stage+confirm in one model turn books
        // nothing (reproduced: CX-260803-001).
        callState.toolBatchId += 1;
        messages.push({ role: 'assistant', text: t.said, toolCalls: calls });
        for (const call of calls) {
          toolCalls += 1;
          const startedAt = Date.now();
          const result = await executor.exec({ name: call.name, args: call.args });
          const ms = Date.now() - startedAt;
          if (ms >= 600) {
            log(`[voice-cascade] tool ${call.name} took ${ms}ms — the caller heard that as silence unless the filler covered it`);
          }
          messages.push({ role: 'tool', callId: call.id, name: call.name, result });
        }
        if (callState.endRequested) armHangup();
        if (rounds >= MAX_TOOL_ROUNDS) {
          log(`[voice-cascade] tool rounds exhausted (${rounds}) — ending the turn`);
          break;
        }
      }

      // The tail: a fragment with no terminator is still something to say.
      if (turn === t && t.buffer.trim() && SPEAKABLE_RE.test(t.buffer)) {
        const tail = t.buffer;
        t.buffer = '';
        if (rejectAlienReply(t, tail)) return;
        if (t.speculative) t.heldTranscript.push(tail.trim());
        else appendTranscript('agent', tail.trim());
        enqueueSpeak((gen) => speakSentence(tail, gen, { owner: t }));
      }

      if (turn !== t) return;
      t.finished = true;
      turn = null;
      clearFiller();
      // A GUESS THAT FINISHED FIRST. It has said nothing — its audio and its
      // transcript are held — so it gets no history row, no waterfall and no
      // claim on the utterance yet. The final decides: promoteTurn() commits
      // it, discardSpec() throws it away and nobody ever knows.
      if (t.speculative) {
        pendingSpec = t;
        meterTurn(t);
        return;
      }
      commitTurn(t);
    } catch (err) {
      if (turn !== t) return; // aborted by a barge-in or a restart: not a failure
      turn = null;
      clearFiller();
      meterTurn(t);
      log('[voice-cascade] turn failed:', err?.message || err);
      // Every remote provider AND the classic engine failed. There is nothing
      // left to say and nothing left to try, so this is a lost brain — the
      // service hangs up and the patient is picked up on WhatsApp.
      if (!stopped) stop('brain_lost');
    }
  }

  /**
   * THE TURN IS ON THE RECORD. History, meter, waterfall and the ledger's
   * memory of what this utterance was answered with — done exactly once, and
   * deferred for a speculative turn until somebody confirms it (promoteTurn).
   */
  function commitTurn(t) {
    if (!t || t.committed) return;
    t.committed = true;
    // ONE history row per utterance. A corrected turn UPDATES the row its
    // predecessor left behind instead of asking the same question twice; the
    // row's text is the caller's real words either way (see onFinal).
    let entry = t.reuseEntry;
    if (entry) entry.text = t.text;
    else {
      entry = { role: 'user', text: t.text };
      history.push(entry);
    }
    if (t.said.trim()) history.push({ role: 'assistant', text: t.said.trim() });
    meterTurn(t);
    noteWaterfall(t);
    // Remember WHAT was answered, so the end-of-turn path cannot answer the
    // same utterance a second time (see `lastAnswered`). `answeredText` is the
    // text this turn was actually given — the drift decision compares against
    // it, while `entry.text` is kept truthful for the model.
    if (t.uttId) lastAnswered = { uttId: t.uttId, answeredText: t.text, entry };
    if (callState.endRequested) armHangup();
  }

  /**
   * A MODEL MAY NOT SPEAK A LANGUAGE NOBODY SPOKE. The prompt asks; this
   * enforces. On a rejection the whole turn is discarded — the caller hears the
   * deterministic "sorry, it is noisy" line instead, which is both true (the
   * ears very probably fed it garbage) and recoverable.
   *
   * The rejected sentence is deliberately NOT kept as history: a Mongolian
   * assistant line in the context window is how the next turn learns to do it
   * again. The caller's own words stay, so the repeat has somewhere to land.
   *
   * @returns {boolean} true ⇒ the turn is over, return immediately
   */
  function rejectAlienReply(t, piece) {
    if (!isAlienScript(piece)) return false;
    langRejected += 1;
    log(
      `[voice-cascade] the model replied in a foreign script (${describeScript(piece)}) — ` +
        `discarding the reply unheard and asking the caller to repeat`
    );
    if (turn === t) {
      turn = null;
      clearFiller();
    }
    dropHeld(t);
    if (pendingSpec === t) pendingSpec = null;
    if (!t.speculative && t.text) history.push({ role: 'user', text: t.text });
    meterTurn(t);
    abortQuietly(t.abort, 'reply language rejected');
    // Anything earlier in the SAME reply that already reached the queue goes
    // too: half a discarded answer is still a discarded answer.
    killSpeech('lang_rejected');
    noteUnclear();
    return true;
  }

  /**
   * THE WATERFALL — one line per turn, and the array on the outcome. This is
   * how "the agent feels slow" stops being an opinion: every hop is a number,
   * and the provider that answered is NAMED, so a quality complaint is
   * attributable to a model rather than to the product.
   *
   * THE ROW IS CREATED HERE AND FINISHED LATER (V7-P2.1). The mouth's two
   * numbers do not exist yet when the brain stops writing: TTS time-to-first-
   * byte is known when the vendor answers, and first-audio only when a frame
   * actually leaves for the wire — both after this point, on the speech queue
   * and the pacer respectively. P1 read them off the module-level `turn`, which
   * runTurn() had already cleared, so the founder's whole live call logged
   * `tts_ttfb=None first_audio=None`. The row object stays mutable in
   * `waterfalls` (outcome() copies it on read) and is logged exactly once, when
   * it is complete or when the call ends — whichever comes first.
   */
  function noteWaterfall(t) {
    const row = {
      vad_ms: t.vadMs ?? null,
      stt_final_ms: t.sttFinalMs ?? null,
      llm_ttft_ms: t.ttftMs ?? null,
      tts_ttfb_ms: t.ttsTtfbMs ?? null,
      first_audio_ms: t.firstAudioAt && t.eotAt ? t.firstAudioAt - t.eotAt : null,
      speculative: !!t.wasSpeculative,
      stt: sttProvider,
      llm: llmProvider,
      tts: ttsChain?.provider ?? null,
    };
    t.row = row;
    if (waterfalls.length < MAX_WATERFALLS) waterfalls.push(row);
    // A turn with audio already on the wire (a fast mouth, a slow tool round)
    // is complete right now; anything else waits for its first frame.
    if (row.first_audio_ms != null || !hasMouth) finalizeWaterfall(t);
    else openWaterfalls.add(t);
  }

  /** The first REAL reply frame of turn `t` just went to the socket. */
  function markFirstAudio(t, nowMs) {
    if (!t || t.firstAudioAt) return;
    t.firstAudioAt = nowMs;
    if (t.row) finalizeWaterfall(t);
  }

  /** Fill in whatever the mouth learned late, log the line, and close the row. */
  function finalizeWaterfall(t) {
    const row = t?.row;
    if (!row || t.rowLogged) return;
    t.rowLogged = true;
    openWaterfalls.delete(t);
    if (row.tts_ttfb_ms == null && t.ttsTtfbMs != null) row.tts_ttfb_ms = t.ttsTtfbMs;
    if (row.first_audio_ms == null && t.firstAudioAt && t.eotAt) {
      row.first_audio_ms = t.firstAudioAt - t.eotAt;
    }
    log(
      `[voice-cascade] waterfall vad=${row.vad_ms ?? 'n/a'}ms stt=${row.stt_final_ms ?? 'n/a'}ms ` +
        `llm_ttft=${row.llm_ttft_ms ?? 'n/a'}ms tts_ttfb=${row.tts_ttfb_ms ?? 'n/a'}ms ` +
        `first_audio=${row.first_audio_ms ?? 'n/a'}ms · ${row.stt || 'n/a'} → ${row.llm || 'n/a'} → ${row.tts || 'n/a'}`
    );
  }

  // ── DTMF (noisy lines, RFC 4733) ──────────────────────────────────────────
  function handleDtmf(payload) {
    if (!payload || payload.length < 4) return;
    const digit = DTMF_DIGITS[payload[0]];
    if (digit == null) return;
    const end = (payload[1] & 0x80) !== 0;
    if (end) {
      dtmfActive = null;
      return;
    }
    if (dtmfActive === digit) return; // the event repeats every 20 ms while held
    dtmfActive = digit;
    // A KEYPRESS BECOMES A SENTENCE THE CALLER COULD HAVE SAID, in their own
    // language — not bracketed English stage directions.
    //
    // Two reasons, and the second is the one that bit us: an LLM handed
    // "[KEYPAD] The caller pressed 1…" answers in English about half the time,
    // and the CLASSIC link (which may own this call) has no idea what a bracket
    // means — it would run intent detection over English meta-text and fall
    // through to "I didn't understand". A localized intent phrase works
    // identically in both brains, because it is exactly what pressing the key
    // meant. An agency has no calendar, so 1 opens qualification instead — and
    // the engine routes the same phrase there by tenant type.
    if (digit === '1') startTurn(keypadPhrase('book'));
    else if (digit === '2') {
      track(
        (async () => {
          await executor.exec({ name: 'request_handoff', args: { reason: 'dtmf_2' } });
          startTurn(keypadPhrase('human'));
        })()
      );
    }
  }

  /** What the caller would have SAID, had they said it instead of pressing it. */
  function keypadPhrase(kind) {
    const PHRASES = {
      book: {
        ar: facilitator ? 'نحب نعرف على العلاج في تونس' : 'نحب نحجز موعد',
        fr: facilitator ? "je voudrais des informations pour un traitement en Tunisie" : 'je voudrais prendre un rendez-vous',
        en: facilitator ? 'I would like information about treatment in Tunisia' : 'I would like to book an appointment',
      },
      human: {
        ar: 'نحب نحكي مع موظف',
        fr: 'je voudrais parler à un conseiller',
        en: 'I would like to speak to an agent',
      },
    };
    return PHRASES[kind][L] || PHRASES[kind].ar;
  }

  // ── personalization ───────────────────────────────────────────────────────
  async function loadCallerContext() {
    if (!tenantId || !patientWaId) return null;
    if (typeof store?.appointments?.list !== 'function') return null;
    let rows = [];
    try {
      rows = (await store.appointments.list(tenantId, { patientWaId })) || [];
    } catch (err) {
      log('[voice-cascade] caller context lookup failed:', err?.message || err);
      return null;
    }
    if (!Array.isArray(rows) || !rows.length) return null;

    const at = toDate(clock()).getTime();
    const when = (a) => msOf(a?.datetimeISO ?? a?.datetimeIso);
    const created = (a) => msOf(a?.createdAt ?? a?.created_at);

    const named = rows.filter((a) => sanitizeSpokenName(a?.patientName)).sort((a, b) => created(b) - created(a))[0];
    const name = named ? sanitizeSpokenName(named.patientName) : null;

    const upcomingRow = rows
      .filter((a) => ACTIVE_APPT_STATUS.has(String(a?.status || '')) && when(a) > at)
      .sort((a, b) => when(a) - when(b))[0];
    const upcoming = upcomingRow
      ? {
          what: String(upcomingRow.specialtyLabel || upcomingRow.specialty || '').slice(0, 60) || 'an appointment',
          when: formatWhenSpoken(new Date(when(upcomingRow)), L),
          ref: String(upcomingRow.ref || '').slice(0, 40),
        }
      : null;

    if (!name && !upcoming) return null;
    return { name, upcoming };
  }

  function loadContextOnce() {
    if (contextPromise) return contextPromise;
    contextPromise = loadCallerContext().then(
      (ctx) => {
        callerContext = ctx;
        return ctx;
      },
      () => {
        callerContext = null;
        return null;
      }
    );
    return contextPromise;
  }

  function isPersonalized() {
    return !!(callerContext && (callerContext.name || callerContext.upcoming));
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  function connectOnce() {
    if (connecting) return connecting;
    connecting = (async () => {
      if (stopped) return;
      codec = createCodecBridge({ sdpAnswer: media?.sdpAnswer, sdpOffer, logger: log });
      executor = createToolExecutor({
        clinic,
        convo,
        store,
        bus,
        callState,
        lang: L,
        patientWaId,
        now: clock,
        logger: log,
      });
      llm = makeLlm({
        config,
        clinic,
        store,
        bus,
        convo,
        tools,
        lang: L,
        patientWaId,
        fetchImpl,
        now: clock,
        logger: log,
        engineFactory,
        // The classic link writes through the CHAT booking flow, which has its
        // own confirm step. When it does, the call outcome has to say so or the
        // clinic sees a booking with no call.
        onClassicResult: (out) => {
          if (out?.appointment?.ref) {
            callState.booked = out.appointment.ref;
            callState.appointment = out.appointment;
          }
          if (out?.handoff) callState.handoff = true;
          if (out?.facilitatorLead?.procedure || out?.facilitatorLead?.procedureRaw) {
            callState.lead = {
              procedure: out.facilitatorLead.procedure || out.facilitatorLead.procedureRaw,
              originCity: out.facilitatorLead.originCity || out.facilitatorLead.originRaw || null,
              travelWindow: out.facilitatorLead.travelWindow || null,
            };
          }
          // THE TAKEOVER. From here the scripted engine owns this call (the
          // sticky rule in llm/index.js), and it collects every slot itself. A
          // voice-side STAGED booking left standing would be a second, stale
          // half-booking that a later confirm_booking could still write — with
          // details the caller gave to a different gate. It is dropped, and
          // NOTHING is said about it: the engine simply asks its own questions.
          if (!classicOwned) {
            classicOwned = true;
            if (callState.staged) {
              log('[voice-cascade] classic took the call over — dropping the voice-side staged booking');
            }
            callState.staged = null;
            callState.speechSinceStage = '';
          }
        },
      });
      stt = makeStt({
        config,
        lang: L,
        wsFactory,
        liveFactory,
        fetchImpl,
        logger: log,
        // ECHO SUPPRESSION FOR THE LEG THAT NEEDS IT (liveEars). A Gemini Live
        // session on a phone leg sometimes transcribes OUR OWN voice bleeding
        // back through the caller's speaker; answering that is how one agent
        // becomes two. Only the orchestrator knows what we are saying and
        // whether we are still saying it, so it lends both, as functions.
        agentSpeaking,
        agentSaid: () => lastAgentUtterance,
      });
      sttStartedAt = Date.now();
      stt.on('interim', onInterim);
      stt.on('final', onFinal);
      stt.on('lost', (err) => {
        log('[voice-cascade] no ears left:', err?.message || err);
        if (!stopped) stop('brain_lost');
      });
      const provider = await stt.ready;
      sttProvider = provider;
      if (!provider) throw new Error('no STT provider could be started');
    })();
    connecting.catch(() => {});
    return connecting;
  }

  // ── outcome ───────────────────────────────────────────────────────────────
  function latencySummary() {
    const sorted = [...turnLatencies].sort((a, b) => a - b);
    return {
      turns: sorted.length,
      medianMs: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      worstMs: sorted.length ? sorted[sorted.length - 1] : null,
      greetingMs,
      greetingSource,
    };
  }

  function voiceSummary() {
    const d = typeof ttsChain?.describe === 'function' ? ttsChain.describe() : null;
    return {
      mode: d?.mode ?? (hasMouth ? 'tts' : 'native'),
      provider: d?.provider ?? ttsChain?.provider ?? 'gemini',
      voice: d?.voice ?? ttsChain?.voice ?? null,
      degradedMidCall: !!(ttsFailed || d?.degraded),
      spoke: sentencesSpoken > 0,
    };
  }

  function meter() {
    const tts = typeof ttsChain?.meter === 'function' ? ttsChain.meter() : { chars: 0, requests: 0 };
    return {
      sttMs: sttStartedAt ? Math.max(0, (stoppedAt || Date.now()) - sttStartedAt) : 0,
      llmTokensIn: usage.llmTokensIn,
      llmTokensOut: usage.llmTokensOut,
      ttsChars: tts.chars || 0,
      ttsRequests: tts.requests || 0,
    };
  }

  let stoppedAt = 0;

  function buildOutcome() {
    return {
      reason: outcomeReason,
      booked: callState.booked || null,
      handoff: !!callState.handoff,
      emergency: !!callState.emergency,
      lead: callState.lead ? { ...callState.lead } : null,
      turns: transcript.length,
      toolCalls,
      codec: codec ? codec.codec : null,
      bargeIns,
      latency: latencySummary(),
      voice: voiceSummary(),
      // V7: the per-turn waterfall and the per-call meter. The first makes
      // "it feels slow" arguable; the second makes pass-through billing one
      // config change away instead of a migration.
      brain: 'cascade',
      // True ⇒ the scripted engine finished this call. It is on the outcome
      // because "why did this call sound different?" must be answerable from
      // the record, not from a log nobody kept.
      classicOwned,
      providers: { stt: sttProvider, llm: llmProvider, tts: ttsChain?.provider ?? null },
      waterfalls: waterfalls.map((w) => ({ ...w })),
      usage: meter(),
    };
  }

  return {
    /**
     * PARALLEL WARM-UP. Open the ears and read the caller's context NOW — the
     * service calls this while pre_accept/accept are still in flight. Never
     * throws and never rejects: the service degrades from start().
     */
    async warmUp() {
      if (stopped || started) return false;
      loadContextOnce();
      try {
        await connectOnce();
        return !stopped;
      } catch (err) {
        log('[voice-cascade] warm-up failed:', err?.message || err);
        return false;
      }
    },

    /**
     * Make the agent speak FIRST. Rejects when the cascade cannot run at all
     * (no mouth, no ears) — the service degrades on that, exactly as it does
     * for a dead Gemini socket.
     */
    async start() {
      if (started) return;
      started = true;
      greetStartAt = Date.now();
      markGreetingFrame = true;
      const conn = connectOnce();
      await loadContextOnce();

      if (!hasMouth) {
        // Said plainly because it is the most likely misconfiguration: the
        // cascade has no native voice to fall back to, by design.
        throw new Error(
          'the cascade brain needs a TTS provider (VOICE_TTS_PROVIDER / clinic.voice.provider) — it has no native voice'
        );
      }

      try {
        await conn;
      } catch (err) {
        // THE HANG-UP IS NOT A BRAIN FAILURE. stop('call_ended') tears the ears
        // down, which rejects whatever was in flight — an impatient caller must
        // not count against the service's breaker.
        if (stopped && (!outcomeReason || outcomeReason === 'call_ended')) return;
        throw err;
      }
      if (stopped) {
        if (outcomeReason && outcomeReason !== 'call_ended') {
          throw new Error(`cascade ended before it could speak (${outcomeReason})`);
        }
        return;
      }

      // ZERO DEAD AIR. The greeting is composed, not generated: it is the same
      // sentence every time, so the first call of a tenant/lang/codec/voice
      // pays for it once and every later call replays the tape inside one
      // pacing tick. A PERSONALIZED greeting is never taped and never served
      // from the tape — a name belongs to one caller.
      const personalized = isPersonalized();
      const greeting = buildGreetingText(clinic, L, personalized ? callerContext : null);
      appendTranscript('agent', greeting);
      if (personalized) {
        greetingSource = 'live';
        enqueueSpeak((gen) => speakSentence(greeting, gen));
      } else {
        greetingSource = speakTaped(greeting, 'greeting') ? 'cache' : 'live';
      }
      ensurePacing();
    },

    /** Wire this into media.onRtp. NEVER throws. */
    onRtp(packet) {
      if (stopped || !packet || !codec) return;
      try {
        const pt = packet.header?.payloadType ?? packet.payloadType ?? null;
        const payload = packet.payload;
        if (!payload || !payload.length) return;
        if (codec.dtmfPayloadType != null && pt === codec.dtmfPayloadType) {
          handleDtmf(payload);
          return;
        }
        // MUTE THE UPLINK once the emergency script is in flight. Nothing the
        // caller says now changes what happens next — staff are already paged
        // and the call ends on a timer — and a barge-in must not be able to cut
        // off an ambulance number.
        if (callState.emergency) return;
        const pcm = codec.decodeIn(payload);
        if (!pcm.length) return;
        // BEFORE the ears, and independent of them: the caller's own loudness
        // is the one interruption signal no transcriber can get wrong.
        noteEnergy(pcm);
        stt?.sendAudio(pcm);
      } catch (err) {
        log('[voice-cascade] inbound RTP handling failed:', err?.message || err);
      }
    },

    stop(reason) {
      return stop(reason);
    },

    transcript() {
      return transcript.map((e) => ({ who: e.who, text: e.text, at: e.at }));
    },

    outcome: buildOutcome,

    settled,

    stats() {
      return {
        outQueue: outQueue.length,
        outBySrc: { ...outBySrc },
        pacing: !!paceTimer,
        codec: codec ? codec.stats() : null,
        stt: typeof stt?.stats === 'function' ? stt.stats() : null,
        llm: typeof llm?.stats === 'function' ? llm.stats() : null,
        staged: !!callState.staged,
        toolBatchId: callState.toolBatchId,
        emergencyWindow,
        greetingSource,
        greetingMs,
        tapePending,
        personalized: isPersonalized(),
        bargeIns,
        bargeFramesDropped,
        lastFlushMs,
        fillersPlayed,
        speculations,
        speculativeRestarts,
        unclearStrikes,
        // V7-P2.1 — the field-fix counters. Every one of these was a silent
        // failure on the founder's first live call.
        hallucinatedFinals,
        langRejected,
        emptyFinals,
        energyBargeIns,
        energyBargeSilent,
        // V7-P2.1 — the double-reply invariants, as numbers a test can assert
        // and a field call can print. `outBySrc.spec` is 0 on every healthy
        // call BY CONSTRUCTION: a speculative frame that reaches the wire has
        // been promoted first, and is tagged 'turn'.
        staleFramesDropped,
        staleHeldDropped,
        specFramesFlushed,
        specChunksDiscarded,
        specHeld: pendingSpec ? pendingSpec.held.length : 0,
        ledgerRefused,
        turnEndsDebounced,
        ledger: [...ledger.values()].map((e) => ({
          utt: e.utt,
          answered: e.answered,
          generations: e.generations,
          revokedBy: e.revokedBy,
          refused: e.refused,
        })),
        wireCodec,
        ttsRate,
        classicOwned,
        turnActive: !!turn,
        turnSpeculative: !!turn?.speculative,
        speakPending,
        sentencesSpoken,
        latency: latencySummary(),
        voice: voiceSummary(),
        waterfalls: waterfalls.length,
        usage: meter(),
        endRequested: !!callState.endRequested,
        hangupArmed: !!hangupTimer,
        endedBy: hangupBy,
      };
    },
  };

  // Idempotent by contract: finish(), the emergency timer, a lost leg and the
  // service's shutdown all race each other, and doing this twice must be free.
  function stop(reason) {
    if (stopped) return buildOutcome();
    stopped = true;
    stoppedAt = Date.now();
    outcomeReason = outcomeReason || reason || 'stopped';
    for (const timer of [paceTimer]) if (timer) clearInterval(timer);
    paceTimer = null;
    // Rows whose audio never made it to the wire (a hang-up mid-sentence, a
    // tool-only turn) are still logged — a waterfall that is never printed is
    // a measurement nobody can argue with, in the wrong sense.
    for (const t of [...openWaterfalls]) finalizeWaterfall(t);
    for (const timer of [emergencyTimer, hangupTimer, eotTimer, fillerTimer]) if (timer) clearTimeout(timer);
    emergencyTimer = null;
    hangupTimer = null;
    eotTimer = null;
    fillerTimer = null;
    outQueue = [];
    activeTape = null;
    // A synthesis or an LLM stream outliving the call is a socket nobody will
    // read and audio nobody will hear.
    speakGen += 1;
    abortQuietly(turn?.abort, 'call ended');
    if (turn) dropHeld(turn);
    turn = null;
    if (pendingSpec) {
      abortQuietly(pendingSpec.abort, 'call ended');
      dropHeld(pendingSpec);
      pendingSpec = null;
    }
    abortQuietly(synthAbort, 'call ended');
    synthAbort = null;
    try {
      stt?.close();
    } catch {
      /* close() is contractually non-throwing; belt and braces */
    }
    try {
      codec?.close();
    } catch {
      /* same */
    }

    const oc = buildOutcome();
    if (started) {
      const l = oc.latency;
      const v = oc.voice;
      const u = oc.usage;
      log(
        `[voice-cascade] turn latency median=${l.medianMs ?? 'n/a'}ms p95=${l.p95Ms ?? 'n/a'}ms ` +
          `turns=${l.turns} barge-ins=${bargeIns} fillers=${fillersPlayed} ` +
          `greeting=${greetingMs ?? 'n/a'}ms (${greetingSource || 'none'}) ` +
          `chain=${sttProvider || 'n/a'} → ${llmProvider || 'n/a'} → ${v.provider} ` +
          `usage=${u.llmTokensIn}/${u.llmTokensOut} tok, ${u.ttsChars} chars ` +
          `ended=${outcomeReason}${hangupBy ? ` (agent hang-up: ${hangupBy})` : ''}`
      );
      // METERING, persisted best-effort: per-tenant STT minutes, LLM tokens and
      // TTS characters from day one, so pass-through billing at pilot signing
      // is a config change rather than an archaeology project.
      try {
        store?.events
          ?.append?.(tenantId, {
            type: 'call.usage',
            actor: 'system',
            conversationId,
            payload: { ...u, brain: 'cascade', providers: oc.providers },
          })
          ?.catch?.(() => {});
      } catch {
        /* the audit ring is best-effort — a call must never fail on it */
      }
    }
    if (typeof onEnd === 'function') {
      try {
        onEnd(oc);
      } catch (err) {
        log('[voice-cascade] onEnd handler threw:', err?.message || err);
      }
    }
    return oc;
  }
}

export default createCascadeLoop;
