// Voice-call service — the transport-agnostic call handler.
//
// WHAT THIS MODULE DOES: a patient calls the clinic's WhatsApp number; we decide
// open/closed, answer or decline, hold a real WebRTC audio path, and leave a
// durable trace on the SAME conversation thread the patient already chats on.
//
// TWO MODES, chosen by `config.voiceCallMode`:
//   'echo'  (V1) — the audio path is held open and echoed back. There is no
//                  STT/LLM/TTS, so no medical guardrail can be violated: the bot
//                  literally cannot say anything. This is still the default
//                  without a Gemini key, and every V1 test asserts it.
//   'brain' (V2) — src/voice-call/brain/ runs a Gemini Live loop on the same
//                  audio path: per-tenant persona, KB grounding, a two-phase
//                  deterministic booking gate, and OUR emergency detector on the
//                  caller's transcript. If the brain cannot start (or dies
//                  mid-call), we do NOT leave dead air: the call is terminated
//                  and a WhatsApp follow-up goes out, so the existing chat
//                  engine picks the patient up from their next message.
// This module owns mode selection, the loop's lifecycle and the degrade path;
// everything the agent actually says lives under ./brain/.
//
// V7-P2 — WHICH BRAIN, inside 'brain' mode. `resolveVoiceBrainMode()` picks
// between the incumbent Live loop (./brain/loop.js) and the fast cascade
// (./brain-cascade/orchestrator.js, STT → text LLM → TTS, overlapped) from
// `clinic.voiceBrain` → `config.voiceBrain` → 'live'. The two factories are
// contract-identical (warmUp/start/onRtp/stop/settled/transcript/outcome/stats),
// so everything below this line is the same code for both. A cascade that has
// no mouth or no ears in THIS process is composed as LIVE instead — once, with
// one warning — because the cascade has no native voice to fall back to and a
// silently mute phone line is the one outcome this tier refuses.
//
// Design notes worth keeping:
//   • The call state machine (./session.js) is pure and returns action
//     descriptors; THIS module is the only executor. Sockets, timers, Graph
//     calls and store writes all live here, nowhere else.
//   • The connect webhook claims its callId SYNCHRONOUSLY (before any await),
//     so Meta's redeliveries can never open two media sessions for one call.
//     A short TTL ring of recently-ENDED callIds closes the other half of that
//     hole: a redelivery arriving after we hung up must not raise a ghost call.
//   • Calls do NOT publish `message.in`. That event drives the notification,
//     CRM and analytics pipelines, all of which were built for patient MESSAGES;
//     a call is a different animal and gets its own `call.*` events.
//   • Exactly ONE terminal event per call, chosen by whether audio ever flowed
//     (`session.wasActive`): `call.ended` for a call the patient actually held
//     (outcome 'completed' OR 'failed' — a mid-call failure is still a call),
//     `call.missed` when it never connected. `call.ended` always follows a
//     `call.started`; `call.missed` never does.
//   • EVERY await that sits between "we have a live session" and "we act on it"
//     is followed by an `entry.finished` re-check. Meta's terminate webhook and
//     our own watchdog routinely land mid-flight, and the two bugs that class
//     produces are a phantom `call.started` after `call.ended` and an orphaned
//     RTCPeerConnection holding UDP sockets open forever.
//   • Nothing here may throw into the webhook handler. Per-event try/catch,
//     console.error, move on — the same contract POST /webhook already has.
import { createCallSession } from './session.js';
import { createMediaSession } from './media.js';
import { createBrainLoop } from './brain/loop.js';
import { createCascadeLoop } from './brain-cascade/orchestrator.js';
import { createTtsChain } from './brain/tts/index.js';
import { negotiatedCodecName } from './brain/codec.js';
import {
  noteTtsFailure,
  noteTtsOk,
  DEFAULT_TTS_BREAKER_THRESHOLD,
  DEFAULT_TTS_BREAKER_COOLDOWN_MS,
} from './brain/tts/breaker.js';
import { isAfterHours, weekdayInTz } from '../stats/index.js';
import { sendAs } from '../api/outbound.js';
import { resolveLanguage } from '../engine/language.js';
import { t } from '../engine/responses.js';

const LANGS = ['ar', 'fr', 'en'];
const DAY_KEYS = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
const DEFAULT_CONNECT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_SEC = 600;
const DEFAULT_BRAIN_CONNECT_MS = 6000;
const DEFAULT_BREAKER_THRESHOLD = 3;
const DEFAULT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000;
// How long finish() will wait for a tool call that was still running when the
// caller hung up. A `confirm_booking` in flight across the terminate webhook
// wrote appointment EAS-260805-001 AFTER the transcript row had already
// recorded booked:null — the clinic saw a call with no booking and a booking
// with no call. Bounded, because a wedged tool must not hold a call open.
const OUTCOME_DRAIN_MS = 2000;

/**
 * Consecutive-failure breaker for the voice brain. Deliberately the same shape
 * as createQuota() in src/voice/transcriber.js — one mental model for "the
 * paid dependency is down, stop paying the latency for it".
 */
export function createBrainBreaker({ threshold = 3, cooldownMs = 300000, now = () => Date.now() } = {}) {
  let failures = 0;
  let openedAt = 0;
  return {
    note() {
      failures += 1;
      if (failures >= threshold) openedAt = now();
    },
    noteOk() {
      failures = 0;
      openedAt = 0;
    },
    /** True ⇒ skip the brain entirely and degrade immediately. */
    isOpen() {
      if (!openedAt) return false;
      if (now() - openedAt >= cooldownMs) {
        // Half-open: let ONE probe through. If it fails, `note()` re-opens on
        // the spot because failures is left one short of the threshold.
        openedAt = 0;
        failures = Math.max(0, threshold - 1);
        return false;
      }
      return true;
    },
    state() {
      return { failures, open: !!openedAt };
    },
  };
}
// Recently-ended callIds are remembered just long enough to swallow a late
// redelivery. Meta retries a webhook for minutes, not hours.
const RECENT_TTL_MS = 10 * 60 * 1000;
const RECENT_CAP = 200;

/**
 * Race a promise against a deadline. The timer is unref'd so a slow brain can
 * never hold the process open, and the loser is swallowed — whoever called us
 * has already moved on to the degrade path.
 */
export function withTimeout(promise, ms, message = 'timeout') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    if (typeof timer.unref === 'function') timer.unref();
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/** "0:47" / "12:05" — the duration format used in the transcript line. */
export function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * A short, honest "we're open X–Y" line for the closed-call reply.
 * Prefers TODAY's window (the patient is calling today); falls back to the most
 * common weekly window so a clinic closed on Sunday still gets a useful answer.
 * Returns '' when the tenant configured no hours at all.
 *
 * "Today" is resolved in the CLINIC's timezone — same rule the open/closed
 * decision uses. A VPS running UTC must not tell a Tunisian patient yesterday's
 * hours at 00:30 local.
 */
export function hoursHint(clinic, date = new Date(), tz) {
  const wh = clinic?.workingHours;
  if (!wh || typeof wh !== 'object') return '';
  const zone = tz || clinic?.timezone;
  const fmt = (w) => (Array.isArray(w) && w.length >= 2 ? `${w[0]}–${w[1]}` : null);
  const dayKey = zone ? weekdayInTz(date, zone) : DAY_KEYS[date.getDay()];
  const today = fmt(wh[dayKey]);
  if (today) return today;
  const counts = new Map();
  for (const k of DAY_KEYS) {
    const s = fmt(wh[k]);
    if (s) counts.set(s, (counts.get(s) || 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [s, n] of counts) {
    if (n > bestN) {
      best = s;
      bestN = n;
    }
  }
  return best;
}

/**
 * Language for a call: the conversation's own language when we know it, else
 * the tenant's first configured language. Delegated to the engine's
 * resolveLanguage so calls and messages can never drift apart (a call has no
 * text to detect from, hence `detected = null`). The allow-list guards both
 * ends: a stored junk value must not reach the response templates.
 */
export function pickLang(convo, clinic) {
  const previous = LANGS.includes(convo?.lang) ? convo.lang : null;
  const lang = resolveLanguage(null, previous, clinic);
  return LANGS.includes(lang) ? lang : 'fr';
}

/** The two brains a call can be answered by. Anything else means 'live'. */
export const VOICE_BRAINS = Object.freeze(['live', 'cascade']);

/**
 * Waterfalls kept on the STORED call record. The loop keeps up to 120 (a
 * ten-minute call is ~60 turns); this row fans out to the inbox, the Calls tab
 * and every open SSE stream, so only the tail — the part of a call a complaint
 * is actually about — is persisted.
 */
export const MAX_RECORDED_WATERFALLS = 30;

/** Cascade-only seams the composition layer may inject (tests, harnesses). */
const CASCADE_DEP_KEYS = Object.freeze([
  'sttFactory',
  'llmFactory',
  'ttsFactory',
  'ttsChain',
  'wsFactory',
  'liveFactory',
  'fetchImpl',
  'engineFactory',
]);

/**
 * Can this process pay for a given mouth AT ALL? Credential presence only —
 * whether the vendor is UP is the breaker's job, and whether the voice id is
 * valid is the chain's (./brain/tts/index.js). This is the composition-level
 * pre-flight, and it is deliberately cheap.
 */
function ttsCredentialPresent(name, config = {}) {
  if (name === 'fish') return !!config.fishAudioApi;
  if (name === 'elevenlabs') return !!config.elevenlabsApiKey;
  if (name === 'azure') return !!(config.azureSpeechKey && config.azureSpeechRegion);
  return false;
}

/**
 * WHICH BRAIN ANSWERS THIS CALL (V7-P2).
 *
 * Precedence, and only the exact literals 'live' / 'cascade' count at every rung
 * — the same rule `voiceCallMode` and graphCalls' transport use, because an
 * unrecognized value must never silently enable the experimental path:
 *   1. `clinic.voiceBrain` — the per-tenant override (validated in api/tenant.js
 *      exactly like `clinic.voice`).
 *   2. `config.voiceBrain` (VOICE_BRAIN) — the global default.
 *   3. 'live' — the incumbent Gemini Live loop.
 *
 * THEN THE COMPOSITION-LEVEL FALLBACK, which is the whole reason this function
 * exists rather than a one-line ternary. The cascade has NO native voice and NO
 * native ears: its mouth is an HTTP TTS provider and its ears are a streaming
 * STT leg. Composing it without either produces a call that connects, greets
 * nobody and degrades — dead air, which is the one outcome this tier refuses.
 * So a cascade that cannot be fed falls back to LIVE, loudly, once per call.
 *
 * The mouth check accepts a Fish or ElevenLabs credential (the doctrine
 * fallback order) OR a tenant/global provider named EXPLICITLY whose own
 * credential is present — that last clause is what lets an Azure tenant run the
 * cascade even though Azure is parked out of the automatic order.
 *
 * @param {object} p
 * @param {object} [p.config]
 * @param {object} [p.clinic]
 * @returns {{mode:'live'|'cascade', requested:string, source:string, reason:string|null}}
 */
export function resolveVoiceBrainMode({ config = {}, clinic } = {}) {
  // EXACT literals only — no trimming, no case folding. Byte for byte the rule
  // `config.voiceCallMode === 'brain'` uses two hundred lines up: 'CASCADE',
  // 'Cascade' and 'cascade ' all mean live, because every way of being wrong
  // about this flag must land on the brain that already answers phones.
  const pick = (v) => (VOICE_BRAINS.includes(v) ? v : null);
  const tenant = pick(clinic?.voiceBrain ?? clinic?.config?.voiceBrain);
  const requested = tenant || pick(config.voiceBrain) || 'live';
  const source = tenant ? 'tenant' : pick(config.voiceBrain) ? 'config' : 'default';
  if (requested !== 'cascade') return { mode: 'live', requested, source, reason: null };

  const voice = (clinic?.voice ?? clinic?.config?.voice) || {};
  const named = String(
    config.voiceBenchmarkMode
      ? config.voiceBenchmarkTtsProvider || ''
      : voice.provider || config.voiceTtsProvider || ''
  )
    .trim()
    .toLowerCase();
  const mouth = config.voiceBenchmarkMode
    ? !!named && named !== 'gemini' && ttsCredentialPresent(named, config)
    : ttsCredentialPresent('fish', config) ||
      ttsCredentialPresent('elevenlabs', config) ||
      (!!named && named !== 'gemini' && ttsCredentialPresent(named, config));
  // liveEars — a Gemini Live session used ONLY as ears — is the free STT leg the
  // cascade falls through to, so a Gemini key counts as ears on its own.
  const pinnedStt = String(config.voiceBenchmarkSttProvider || '').trim();
  const ears = config.voiceBenchmarkMode
    ? pinnedStt === 'deepgram'
      ? !!config.deepgramApiKey
      : pinnedStt === 'speechmatics'
        ? !!config.speechmaticsApiKey
        : pinnedStt === 'liveEars'
          ? !!config.geminiApiKey
          : false
    : !!(config.deepgramApiKey || config.speechmaticsApiKey || config.geminiApiKey);

  const missing = [];
  if (!mouth) {
    missing.push(
      config.voiceBenchmarkMode
        ? `benchmark TTS ${named || '(unset)'} has no usable credential`
        : 'no TTS credential — set FISH_AUDIO_API or ELEVENLABS_API_KEY'
    );
  }
  if (!ears) {
    missing.push(
      config.voiceBenchmarkMode
        ? `benchmark STT ${pinnedStt || '(unset)'} has no usable credential`
        : 'no STT credential — set DEEPGRAM_API_KEY, SPEECHMATICS_API_KEY or GEMINI_API_KEY'
    );
  }
  if (missing.length) {
    // A benchmark that silently becomes the incumbent is mislabeled evidence.
    // Keep the requested brain so startup fails/degrades the call visibly;
    // ordinary calls retain the product's availability-first Live fallback.
    return {
      mode: config.voiceBenchmarkMode ? 'cascade' : 'live',
      requested,
      source,
      reason: missing.join('; '),
    };
  }
  return { mode: 'cascade', requested, source, reason: null };
}

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {object} deps.bus
 * @param {object} deps.sender        the ONE WhatsApp sender (mock under test)
 * @param {object} [deps.config]      voiceCallConnectTimeoutMs / voiceCallMaxSec
 * @param {object} [deps.alerts]      system alerts (owner-visible failures)
 * @param {object} deps.graphCalls    ./graphCalls.js client
 * @param {Function} [deps.mediaFactory] default createMediaSession (inject fakes)
 * @param {Function} [deps.brainFactory] OVERRIDES mode selection entirely (fakes)
 * @param {object} [deps.cascadeFactories] cascade-only seams (stt/llm/tts/…)
 * @param {Function} [deps.logger]    both loops log through this (default console.error)
 * @param {Function} [deps.now]       inject the clock (tests drive closed hours)
 * @returns {{handleEvents:Function, active:Function, settled:Function, stop:Function}}
 */
export function createVoiceCallService({
  store,
  bus,
  sender,
  config = {},
  alerts,
  graphCalls,
  mediaFactory,
  brainFactory,
  cascadeFactories = {},
  logger,
  now,
} = {}) {
  const clock = typeof now === 'function' ? now : () => new Date();
  const log = typeof logger === 'function' ? logger : (...a) => console.error(...a);
  const makeMedia = typeof mediaFactory === 'function' ? mediaFactory : createMediaSession;
  // An injected factory WINS over mode selection — that is the seam every voice
  // suite is built on. The mode is still resolved (and still reported on the
  // call record), because "which brain did this call think it was" must not
  // become unanswerable just because a test swapped the implementation.
  const injectedBrain = typeof brainFactory === 'function' ? brainFactory : null;
  const connectTimeoutMs = Number(config.voiceCallConnectTimeoutMs) || DEFAULT_CONNECT_TIMEOUT_MS;
  const maxSec = Number(config.voiceCallMaxSec) || DEFAULT_MAX_SEC;
  const brainConnectMs = Number(config.voiceBrainConnectMs) || DEFAULT_BRAIN_CONNECT_MS;
  // Only the literal 'brain' opts in. Anything else — a typo, 'BRAIN', '' —
  // stays on the mute echo path, the same rule graphCalls uses for transports:
  // an unrecognized value must never silently enable the expensive/risky mode.
  const brainMode = config.voiceCallMode === 'brain';

  // Circuit breaker on the BRAIN, mirroring the STT quota breaker
  // (src/voice/transcriber.js). When Gemini Live is down, every caller would
  // otherwise pay `voiceBrainConnectMs` of dead silence before the degrade —
  // during exactly the incident when the clinic can least afford it. After
  // `threshold` consecutive start failures we skip the wait entirely and go
  // straight to "we'll message you on WhatsApp"; after the cooldown, ONE probe
  // call is let through to find out whether the endpoint came back.
  const brainBreaker = createBrainBreaker({
    threshold: Number(config.voiceBrainBreakerThreshold) || DEFAULT_BREAKER_THRESHOLD,
    cooldownMs: Number(config.voiceBrainBreakerCooldownMs) || DEFAULT_BREAKER_COOLDOWN_MS,
    now: () => clock().getTime(),
  });

  // The TTS breaker (V5-T1) is PROCESS-GLOBAL rather than per-service, because
  // the fact it carries — "this vendor is down" — has to survive into the next
  // call, and the chain is rebuilt per call inside the loop. This service owns
  // the two transitions; brain/tts/index.js is the only consumer.
  const ttsBreakerThreshold = Number(config.voiceTtsBreakerThreshold) || DEFAULT_TTS_BREAKER_THRESHOLD;
  const ttsBreakerCooldownMs = Number(config.voiceTtsBreakerCooldownMs) || DEFAULT_TTS_BREAKER_COOLDOWN_MS;

  /** callId → { session, clinic, tenantId, conversationId, lang, media, timers } */
  const sessions = new Map();
  /** callId → endedAt(ms) — the anti-ghost ring (insertion-ordered). */
  const recentlyEnded = new Map();
  // In-flight async work started OUTSIDE handleEvents (the onConnected callback,
  // the watchdogs). settled() drains it — same contract as notifier.settled().
  const pending = new Set();
  let stopped = false;

  function track(p) {
    const q = Promise.resolve(p).catch((err) => {
      console.error('[voice-call] background task failed:', err?.message || err);
    });
    pending.add(q);
    q.finally(() => pending.delete(q));
    return q;
  }

  async function settled() {
    // Loop: a drained task may itself have queued another (connect → accept).
    for (let i = 0; i < 20 && pending.size; i += 1) {
      await Promise.all([...pending]);
    }
  }

  // ── anti-ghost ring ────────────────────────────────────────────────────────
  function rememberEnded(callId, at) {
    if (!callId) return;
    recentlyEnded.delete(callId); // re-insert so the eviction order stays LRU-ish
    recentlyEnded.set(callId, at);
    for (const [id, ts] of recentlyEnded) {
      if (at - ts > RECENT_TTL_MS) recentlyEnded.delete(id);
    }
    while (recentlyEnded.size > RECENT_CAP) {
      recentlyEnded.delete(recentlyEnded.keys().next().value);
    }
  }

  function isRecentlyEnded(callId, nowMs) {
    const at = recentlyEnded.get(callId);
    if (at == null) return false;
    if (nowMs - at > RECENT_TTL_MS) {
      recentlyEnded.delete(callId);
      return false;
    }
    return true;
  }

  function clearTimers(entry) {
    for (const timer of entry.timers) clearTimeout(timer);
    entry.timers.length = 0;
  }

  function later(entry, ms, fn) {
    const timer = setTimeout(fn, ms);
    if (typeof timer.unref === 'function') timer.unref(); // never hold the process open
    entry.timers.push(timer);
    return timer;
  }

  /** Close a media session without ever throwing. Idempotent by contract. */
  function closeMedia(media) {
    try {
      media?.close();
    } catch {
      /* close() is contractually non-throwing; belt and braces */
    }
  }

  async function audit(tenantId, type, conversationId, payload) {
    try {
      await store.events.append(tenantId, { type, actor: 'system', conversationId, payload });
    } catch {
      /* the audit ring is best-effort — a call must never fail on it */
    }
  }

  /**
   * V7-P2 — what the CLINIC's record says about the brain that answered.
   *
   * Two things are folded in here and nowhere else:
   *   • `mode` ('cascade'|'live'). The founder's quality complaints have to be
   *     attributable per call. Without this, "the agent sounded slow on Tuesday"
   *     cannot be tied to a pipeline, and an A/B is just two opinions.
   *   • the waterfall TAIL. The loop keeps up to 120 turns; this payload fans
   *     out to every open SSE stream, so only the last MAX_RECORDED_WATERFALLS
   *     are persisted. The usage meter rides through untouched — it is four
   *     numbers, and it is what makes pass-through billing a config change.
   *
   * A COPY, never the loop's own object: outcome() is the loop's to own, and a
   * fake loop in a test may well return a shared reference.
   */
  function shapeBrainOutcome(raw, entry) {
    if (!raw) return null;
    const out = { ...raw, mode: entry.brainKind || 'live' };
    if (Array.isArray(out.waterfalls) && out.waterfalls.length > MAX_RECORDED_WATERFALLS) {
      out.waterfalls = out.waterfalls.slice(-MAX_RECORDED_WATERFALLS);
    }
    return out;
  }

  // ── the single place a call leaves the world ───────────────────────────────
  // Writes the transcript line, publishes exactly one terminal bus event, drops
  // the socket and the timers. Idempotent: the watchdog and Meta's terminate
  // webhook routinely race each other.
  async function finish(entry, { reason } = {}) {
    if (entry.finished) return;
    entry.finished = true;
    clearTimers(entry);
    // Order matters, and it is not just "stop before reading". A tool call can
    // still be RUNNING when the caller hangs up: stopping the loop does not
    // await it, so reading outcome() straight away recorded booked:null for a
    // booking that landed in the database a moment later. Stop, DRAIN, then read.
    stopLoop(entry, 'call_ended');
    await drainLoop(entry);
    closeMedia(entry.media);
    sessions.delete(entry.callId);
    rememberEnded(entry.callId, clock().getTime());

    const { session, tenantId, conversationId, lang } = entry;
    const summary = session.summary();
    const brain = shapeBrainOutcome(entry.loop ? entry.loop.outcome() : null, entry);
    const transcript = entry.loop ? entry.loop.transcript() : null;
    // THE OTHER HALF OF THE TTS BREAKER. A call that actually SPOKE through the
    // provider is the only proof the vendor is healthy — a call that ended
    // before the agent said a word proves nothing and must not close a breaker
    // that a half-open probe just opened. The failure side is noted in
    // onBrainEnd, on the spot; this is the success side, on the way out.
    if (brain?.voice?.mode === 'tts' && brain.voice.spoke && brain.reason !== 'tts_lost') {
      noteTtsOk(brain.voice.provider);
    }
    // "Did the patient actually hear us?" is the question that decides both the
    // transcript line and the bus event — NOT the outcome string. A call that
    // connected and then failed mid-way is a call that happened; telling the
    // clinic it was "missed" would be a lie, and would break the catalog rule
    // that call.ended always follows call.started.
    const held = session.wasActive;
    const missReason =
      reason || (summary.reason === 'closed' ? 'closed' : summary.outcome === 'failed' ? 'failed' : 'no_answer');
    const duration = formatDuration(summary.durationSec);
    // The inbox row is the only thing most staff will ever read about a call,
    // so the line has to lead with what actually happened. Priority is by
    // urgency, not by chronology: an emergency outranks a booking outranks a
    // handoff request.
    const text = held
      ? brain?.emergency
        ? t(lang, 'callEmergencySummary', { duration })
        : brain?.booked
          ? t(lang, 'callBookedSummary', { duration, ref: brain.booked })
          : brain?.handoff
            ? t(lang, 'callHandoffSummary', { duration })
            : t(lang, 'callSummary', { duration })
      : t(lang, 'callMissed', { reason: missReason });

    if (conversationId) {
      try {
        const rec = await store.conversations.appendMessage(tenantId, conversationId, {
          direction: 'inbound',
          type: 'call',
          // NOTE (deferred to the V3 calls-tab slice): the SPA inbox currently
          // renders this row as a patient bubble — it keys off `direction` and
          // ignores `body.by === 'system'`. The data below is already correct.
          body: {
            text,
            by: 'system',
            call: {
              callId: summary.callId,
              // `outcome` stays the SESSION outcome ('completed'|'failed'|…) —
              // the inbox and the analytics slice already branch on it. What the
              // brain did rides alongside as `brain`, never on top of it.
              outcome: summary.outcome,
              durationSec: summary.durationSec,
              connectMs: summary.connectMs,
              from: entry.from,
              ...(transcript && transcript.length ? { transcript } : {}),
              ...(brain ? { brain } : {}),
            },
          },
          ts: new Date(session.endedAt || clock().getTime()).toISOString(),
        });
        // appendMessage already stamps convo.lastMessageAt in BOTH adapters —
        // this publish is purely so the open inbox re-sorts live.
        bus?.publish?.('conversation.updated', {
          tenantId,
          conversationId,
          patch: { lastMessageAt: rec.ts },
        });
      } catch (err) {
        console.error('[voice-call] transcript write failed:', err?.message || err);
      }
    }

    // The brain outcome rides the terminal event too — the notification, CRM and
    // analytics consumers subscribe HERE, and "this call booked EAS-260805-001"
    // is exactly what an owner alert needs to say. The transcript deliberately
    // does NOT: it can be kilobytes and this payload fans out to every open SSE
    // stream; the conversation row is where the words belong.
    const call = {
      ...summary,
      from: entry.from,
      reason: held ? summary.reason : missReason,
      ...(brain ? { brain } : {}),
    };
    bus?.publish?.(held ? 'call.ended' : 'call.missed', { tenantId, conversationId, call });
    await audit(tenantId, held ? 'call.ended' : 'call.missed', conversationId, call);
  }

  // ── CONNECT ────────────────────────────────────────────────────────────────
  async function onConnect(ev) {
    if (stopped) return;
    if (!ev.callId) return;
    if (sessions.has(ev.callId)) {
      // Meta redelivers webhooks; a live session for this callId means we are
      // already ringing/talking. Second delivery is a no-op, by construction.
      return;
    }
    const nowDate = clock();
    if (isRecentlyEnded(ev.callId, nowDate.getTime())) {
      // The other half of the dedupe: a redelivery landing AFTER we hung up
      // would otherwise open a fresh socket, fail its pre_accept against a dead
      // call, alert the owner and write a second terminal event.
      console.warn(`[voice-call] dropping connect for already-ended call ${ev.callId}`);
      return;
    }
    const clinic = store.getClinicByPhoneNumberId(ev.phoneNumberId);
    if (!clinic) {
      console.error(`[voice-call] no tenant for phone_number_id=${ev.phoneNumberId} (call ${ev.callId})`);
      return;
    }
    const tenantId = clinic.id;

    const session = createCallSession({
      callId: ev.callId,
      tenantId,
      from: ev.from,
      phoneNumberId: ev.phoneNumberId,
      now: ev.timestamp || nowDate.getTime(),
    });
    const entry = {
      callId: ev.callId,
      session,
      clinic,
      tenantId,
      from: ev.from,
      conversationId: null,
      lang: pickLang(null, clinic),
      media: null,
      timers: [],
      finished: false,
    };
    // Claim the id BEFORE the first await — this is what makes the dedupe above
    // race-free against two webhook deliveries landing at once.
    sessions.set(ev.callId, entry);

    try {
      let convo = await store.conversations.get(tenantId, ev.from);
      if (!convo) {
        convo = await store.conversations.create(tenantId, { patientWaId: ev.from, status: 'open' });
      }
      if (entry.finished) return; // hung up while we were resolving the thread
      entry.conversationId = convo.id;
      entry.convo = convo; // the brain books against this exact thread
      entry.lang = pickLang(convo, clinic);

      // Timezone-aware, overnight-window-aware (src/stats). A tenant with NO
      // configured hours counts as OPEN — "unknown ⇒ don't overstate", and the
      // right product default for a ringing phone is to pick it up.
      const open = !isAfterHours(nowDate, clinic.workingHours, clinic.timezone);
      const decision = session.decideAnswer({ open, at: nowDate.getTime() });

      if (decision.action === 'reject') return await rejectClosed(entry, nowDate);
      if (decision.action !== 'pre_accept') return; // already terminal; nothing to do
      await answer(entry, ev);
    } catch (err) {
      console.error('[voice-call] connect handling failed:', err?.message || err);
      await failCall(entry, 'failed');
    }
  }

  // Closed: decline the call, then say it in writing on the same thread.
  async function rejectClosed(entry, nowDate) {
    const { clinic, tenantId, conversationId, lang } = entry;
    await graphCalls.callAction({ tenant: clinic, callId: entry.callId, action: 'reject' });
    if (conversationId) {
      const text = t(lang, 'callClosed', {
        clinic: clinic.name,
        hours: hoursHint(clinic, nowDate),
      });
      try {
        await sendAs('bot', conversationId, () => sender.sendText(clinic, entry.from, text));
      } catch (err) {
        console.error('[voice-call] closed-hours reply failed:', err?.message || err);
      }
    }
    await audit(tenantId, 'call.rejected', conversationId, {
      callId: entry.callId,
      from: entry.from,
      outcome: 'rejected_closed',
    });
    await finish(entry, { reason: 'closed' });
  }

  // Open: build the media session, pre_accept EARLY (handshake overlaps the
  // ring), then accept the moment audio actually flows.
  async function answer(entry, ev) {
    const { clinic, session } = entry;
    if (!ev.sdpOffer) {
      console.error(`[voice-call] connect without an SDP offer (call ${entry.callId})`);
      return await failCall(entry, 'failed');
    }

    entry.sdpOffer = ev.sdpOffer;
    let media;
    try {
      media = await makeMedia({
        sdpOffer: ev.sdpOffer,
        // ONE inbound seam, two consumers. Echo (V1) relays the packet verbatim
        // — werift's sender rewrites ssrc / payloadType / sequence / timestamp
        // on write, so that is correct. Brain (V2) hands it to the loop, which
        // may not exist yet: the loop is only built once media CONNECTS, and
        // audio can arrive in that window. Reading `entry.loop` late (rather
        // than capturing it now) is what makes the seam work for both.
        onRtp: (packet) => {
          if (brainMode) entry.loop?.onRtp(packet);
          else entry.media?.sendRtp(packet);
        },
        clockNow: () => clock().getTime(),
      });
    } catch (err) {
      console.error('[voice-call] media session failed:', err?.message || err);
      return await failCall(entry, 'failed');
    }
    entry.media = media;
    // The call can be terminated (or the process stopped) WHILE the peer
    // connection is being built. finish() ran with entry.media still null, so
    // this brand-new werift peer — and its UDP sockets — would leak forever.
    if (entry.finished) {
      closeMedia(media);
      return;
    }

    // ── PARALLEL WARM-UP (V5-T0.1a) ────────────────────────────────────────
    // The Gemini Live handshake used to start AFTER media connected, so every
    // caller paid the WebSocket + setup + first-generation time as silence
    // after pickup. It starts HERE instead, overlapping pre_accept, accept and
    // the ICE/DTLS handshake — none of which need the brain. Caller audio only
    // flows once media connects, and liveClient buffers anything that arrives
    // before setupComplete, so nothing is lost and no frame is sent early.
    // Synchronous up to the point entry.loop is assigned: there is no await
    // between the finished-check above and the assignment, which is what keeps
    // a terminate from slipping in and orphaning a socket.
    warmBrain(entry);

    const prepared = session.onAnswerPrepared(media.sdpAnswer, clock().getTime());
    if (prepared.action !== 'send_pre_accept') return await failCall(entry, 'failed');

    const pre = await graphCalls.callAction({
      tenant: clinic,
      callId: entry.callId,
      action: 'pre_accept',
      sdp: prepared.sdp,
      sdpType: 'answer',
    });
    if (entry.finished) {
      // Terminated while pre_accept was in flight. The warmed brain is now OUR
      // orphan to close — finish() ran before entry.loop existed.
      stopLoop(entry, 'call_ended');
      closeMedia(media);
      return;
    }
    if (!pre.ok) {
      console.error('[voice-call] pre_accept rejected:', pre.error?.message);
      return await failCall(entry, 'failed');
    }

    media.onConnected(() => track(onMediaConnected(entry)));

    // Watchdog: Meta drops the call at ~30-60s anyway, but a session whose media
    // never connects would otherwise hold a UDP socket forever.
    later(entry, connectTimeoutMs, () => track(onConnectTimeout(entry)));
  }

  async function onMediaConnected(entry) {
    if (entry.finished) return;
    const r = entry.session.onMediaConnected(clock().getTime());
    if (r.action !== 'accept') return;

    const res = await graphCalls.callAction({
      tenant: entry.clinic,
      callId: entry.callId,
      action: 'accept',
      sdp: entry.media?.sdpAnswer,
      sdpType: 'answer',
    });
    // A terminate processed while `accept` was in flight already published the
    // terminal event. Publishing call.started now would invert the catalog
    // order and leave a max-duration timer on a dead call.
    if (entry.finished) return;
    if (!res.ok) {
      console.error('[voice-call] accept rejected:', res.error?.message);
      return await failCall(entry, 'failed');
    }

    clearTimers(entry); // the connect watchdog is done
    later(entry, maxSec * 1000, () => track(onMaxDuration(entry)));

    bus?.publish?.('call.started', {
      tenantId: entry.tenantId,
      conversationId: entry.conversationId,
      call: { callId: entry.callId, from: entry.from },
    });
    await audit(entry.tenantId, 'call.started', entry.conversationId, {
      callId: entry.callId,
      from: entry.from,
      connectMs: entry.session.summary().connectMs,
    });

    // The agent starts talking only once the caller can actually hear it.
    if (brainMode) await startBrain(entry);
  }

  // ── the brain (V2) ─────────────────────────────────────────────────────────

  /** Close a brain loop without ever throwing. Idempotent by contract. */
  function stopLoop(entry, reason) {
    if (!entry.loop) return null;
    try {
      return entry.loop.stop(reason);
    } catch (err) {
      console.error('[voice-call] brain stop failed:', err?.message || err);
      return null;
    }
  }

  /**
   * Wait (briefly) for the loop's in-flight work — a tool call that was running
   * when the caller hung up. Bounded and non-throwing: a wedged tool costs us
   * OUTCOME_DRAIN_MS and nothing else.
   */
  async function drainLoopSafe(loop) {
    if (typeof loop?.settled !== 'function') return;
    try {
      await withTimeout(loop.settled(), OUTCOME_DRAIN_MS, 'brain drain timeout');
    } catch (err) {
      console.error('[voice-call] brain drain incomplete:', err?.message || err);
    }
  }

  async function drainLoop(entry) {
    await drainLoopSafe(entry.loop);
  }

  /**
   * Decide — ONCE per call — which brain this call gets, and say so out loud if
   * the answer is not the one that was asked for. Cached on the entry because
   * warmBrain() and startBrain() both reach for it, and "cascade unavailable"
   * is a per-call fact, not a per-attempt one: two warnings for one call would
   * make an outage look twice as bad as it is.
   */
  function brainKindFor(entry) {
    if (entry.brainKind) return entry.brainKind;
    const r = resolveVoiceBrainMode({ config, clinic: entry.clinic });
    if (r.reason) {
      // LOUD, and never dead air: the caller still gets a working phone line,
      // and whoever set VOICE_BRAIN=cascade gets told exactly what is missing.
      console.warn(
        config.voiceBenchmarkMode
          ? `[voice-call] benchmark cascade invalid (${r.reason}) — fallback is disabled for this sample`
          : `[voice-call] cascade unavailable (${r.reason}) — live mode for this call`
      );
    }
    entry.brainKind = r.mode;
    return entry.brainKind;
  }

  /**
   * The cascade's extra seams. The mouth is built HERE, with requireMouth:true —
   * the cascade's brain is a text model, so resolving to the native Gemini voice
   * is a call it cannot take, and only this caller is allowed to walk the
   * doctrine fallback order (see brain/tts/index.js). An injected chain wins, so
   * a test never constructs a real vendor client.
   */
  function cascadeDeps(entry) {
    const extras = {};
    for (const k of CASCADE_DEP_KEYS) {
      if (cascadeFactories?.[k] != null) extras[k] = cascadeFactories[k];
    }
    if (extras.ttsChain == null && extras.ttsFactory == null) {
      try {
        // Forward the injected fetch seam: a harness that fakes fetch but not
        // the whole chain must never end up POSTing spoken text to the real
        // vendor (review finding — the seam's stated purpose is hermeticity).
        extras.ttsChain = createTtsChain({
          config,
          clinic: entry.clinic,
          logger: log,
          fetchImpl: extras.fetchImpl,
          requireMouth: true,
          // THE LEG DECIDES THE SYNTHESIS RATE (V7-P2.1). The mouth is built
          // here, before the orchestrator exists, so the negotiation is read
          // straight off the SDP we already have: Fish answers at 24 kHz on an
          // Opus leg (no band loss) and 8 kHz on G.711 (no resampling). The
          // founder's first live call was synthesized at telephone band onto a
          // 48 kHz wire — "the voice quality is low".
          wireCodec: negotiatedCodecName({
            sdpAnswer: entry.media?.sdpAnswer,
            sdpOffer: entry.sdpOffer,
          }),
        });
      } catch (err) {
        // Never fatal: the orchestrator builds its own chain (and its own
        // no-mouth degrade) when we hand it nothing.
        log('[voice-call] cascade TTS chain construction failed:', err?.message || err);
      }
    }
    return extras;
  }

  /**
   * Construct the loop, once. Returns null when construction itself blew up —
   * the breaker is deliberately NOT touched here so a failure is counted once,
   * by startBrain(), no matter which of the two callers hit it first.
   */
  function buildBrain(entry) {
    if (entry.loop) return entry.loop;
    if (entry.brainBuildFailed) return null;
    const kind = brainKindFor(entry);
    const makeBrain = injectedBrain || (kind === 'cascade' ? createCascadeLoop : createBrainLoop);
    try {
      entry.loop = makeBrain({
        clinic: entry.clinic,
        convo: entry.convo || { id: entry.conversationId, patientWaId: entry.from },
        // The webhook's `from` is the authoritative caller id — never a field
        // read off a conversation record whose name differs per store adapter.
        patientWaId: entry.from,
        media: entry.media,
        store,
        bus,
        sender,
        config,
        lang: entry.lang,
        sdpOffer: entry.sdpOffer,
        now: clock,
        logger: log,
        // The loop never hangs up by itself: it reports, and THIS module owns
        // the Graph terminate + the transcript + the degrade text.
        onEnd: (outcome) => track(onBrainEnd(entry, outcome)),
        ...(kind === 'cascade' ? cascadeDeps(entry) : {}),
      });
    } catch (err) {
      console.error('[voice-call] brain construction failed:', err?.message || err);
      entry.brainBuildFailed = true;
      return null;
    }
    return entry.loop;
  }

  /**
   * V5-T0.1a — open the Live socket while the Meta handshake is still running.
   * Fire-and-tracked: it never rejects, it never decides anything. startBrain()
   * still owns the timeout, the breaker and the degrade, so a warm-up that
   * fails costs the call nothing it was not already going to pay.
   */
  function warmBrain(entry) {
    if (!brainMode || entry.finished || entry.loop) return;
    // Breaker open ⇒ the endpoint is known-down; do not open a socket at all.
    if (brainBreaker.isOpen()) return;
    const loop = buildBrain(entry);
    if (!loop) return;
    if (entry.finished) {
      stopLoop(entry, 'call_ended'); // terminated while we were constructing
      return;
    }
    if (typeof loop.warmUp === 'function') track(loop.warmUp());
  }

  /**
   * Start the Gemini Live loop for a connected call — the caller can hear us
   * now, so this is where the agent speaks. A brain that cannot come up inside
   * `voiceBrainConnectMs` is not something we wait out: the caller is listening
   * to silence, which is worse than a polite goodbye. With the warm-up above,
   * that budget is usually already spent before we get here.
   */
  async function startBrain(entry) {
    if (entry.finished || entry.brainStarted) return;
    entry.brainStarted = true;
    // Breaker open ⇒ the endpoint is known-down. Do not spend six seconds of
    // this caller's life proving it again; go straight to the WhatsApp handover.
    if (brainBreaker.isOpen()) {
      console.warn(`[voice-call] brain breaker OPEN — degrading call ${entry.callId} immediately`);
      return await degradeBrain(entry, { skipAlert: true });
    }
    const loop = buildBrain(entry);
    if (!loop) {
      brainBreaker.note();
      return await degradeBrain(entry);
    }
    if (entry.finished) {
      stopLoop(entry, 'call_ended'); // terminated while we were constructing
      return;
    }

    try {
      await withTimeout(loop.start(), brainConnectMs, 'brain connect timeout');
    } catch (err) {
      console.error('[voice-call] brain failed to start:', err?.message || err);
      // SECOND BELT on the same bug the loop guards from its side: if the call
      // is already over, whatever start() threw is a symptom of the hang-up, not
      // evidence about Gemini. Counting it would let three impatient callers
      // open the breaker on a healthy endpoint and cost the next five minutes of
      // real calls their voice agent.
      if (!entry.finished) brainBreaker.note();
      return await degradeBrain(entry);
    }
    brainBreaker.noteOk(); // the endpoint answered — close a half-open breaker
    if (entry.finished) stopLoop(entry, 'call_ended');
  }

  /** The loop reported it is over. Decide how the CALL ends. */
  async function onBrainEnd(entry, outcome) {
    if (entry.finished || entry.brainClosing) return;
    if (outcome?.reason === 'call_ended') return; // WE stopped it from finish()
    // A socket that died during the PARALLEL WARM-UP is not a mid-call outage:
    // we have not accepted the call yet, and startBrain() is still to come.
    // Hanging up here would terminate a call the caller is still hearing ring.
    // loop.start() rejects on a loop that already died, so the degrade happens
    // there, once, on the normal path.
    if (!entry.brainStarted) return;
    entry.brainClosing = true;
    // An EMERGENCY outranks everything, including a socket that died right
    // after it. The script was spoken, the owner paged and the number already
    // sent in writing — a "sorry, write to us here" on top of that would be
    // noise at best, and at worst reads as the clinic brushing them off.
    if (outcome?.emergency) return await hangUp(entry, 'emergency');
    // 'tts_lost' (V5-T1) is a brain_lost with a different cause: the Live
    // session is alive and thinking, but the TTS provider that was giving it a
    // voice failed, and the session's modality cannot be changed mid-call (see
    // brain/tts/index.js). A caller cannot tell the two apart — both are an
    // agent that stopped talking — so they get the SAME degrade: hang up and
    // put it in writing, which hands the patient to the chat engine.
    if (outcome?.reason === 'tts_lost') {
      // NOTED HERE, not at finish(): the next caller may compose their chain
      // before this call has finished closing its books, and the entire point
      // of the breaker is that they do not repeat this call's mistake.
      const provider = outcome?.voice?.provider || 'unknown';
      const b = noteTtsFailure(provider, { threshold: ttsBreakerThreshold, at: clock().getTime() });
      if (b.justOpened) {
        console.warn(
          `[voice-call] TTS BREAKER OPEN — ${provider} lost ${b.failures} consecutive calls their voice. ` +
            `Falling back to the native Gemini voice for ${ttsBreakerCooldownMs}ms.`
        );
        alerts?.fire?.(
          entry.tenantId,
          'voice_tts_breaker_open',
          `${provider} TTS failed ${b.failures} calls in a row — voice calls fall back to the native voice`
        );
      }
      return await degradeBrain(entry);
    }
    if (outcome?.reason === 'brain_lost') return await degradeBrain(entry);
    await hangUp(entry, outcome?.reason || 'brain_ended');
  }

  /**
   * THE DEGRADE PATH — the difference between an outage and a lost patient.
   * We hang up rather than hold a mute line, and we say so IN WRITING on the
   * same thread, which hands the patient straight back to the chat engine.
   */
  async function degradeBrain(entry, { skipAlert = false } = {}) {
    if (entry.finished || entry.degraded) return;
    entry.degraded = true;
    stopLoop(entry, 'brain_lost');
    // An emergency already put the ambulance number in this thread in writing.
    // Following it with "sorry, write to us here" is noise at best.
    const hadEmergency = !!entry.loop?.outcome?.()?.emergency;
    if (hadEmergency) return await hangUp(entry, 'emergency');

    if (entry.conversationId) {
      try {
        await sendAs('bot', entry.conversationId, () =>
          sender.sendText(entry.clinic, entry.from, t(entry.lang, 'callBrainLost'))
        );
      } catch (err) {
        console.error('[voice-call] brain-lost follow-up failed:', err?.message || err);
      }
    }
    // While the breaker is open the outage is already known — one alert per
    // incident, not one per caller.
    if (!skipAlert) {
      alerts?.fire?.(entry.tenantId, 'voice_brain_lost', `call ${entry.callId} lost its voice agent`);
    }
    await hangUp(entry, 'brain_lost');
  }

  /** We end the call ourselves: Graph terminate, then close the books once. */
  async function hangUp(entry, reason) {
    if (entry.finished) return;
    entry.session.localHangup(clock().getTime());
    await graphCalls
      .callAction({ tenant: entry.clinic, callId: entry.callId, action: 'terminate' })
      .catch(() => {});
    await finish(entry, { reason });
  }

  async function onConnectTimeout(entry) {
    if (entry.finished) return;
    const r = entry.session.onTimeout(clock().getTime());
    if (r.action !== 'terminate') return;
    await graphCalls.callAction({ tenant: entry.clinic, callId: entry.callId, action: 'terminate' });
    await finish(entry, { reason: 'no_answer' });
  }

  async function onMaxDuration(entry) {
    if (entry.finished) return;
    const r = entry.session.onMaxDuration(clock().getTime());
    if (r.action !== 'terminate') return;
    await graphCalls.callAction({ tenant: entry.clinic, callId: entry.callId, action: 'terminate' });
    await finish(entry);
  }

  // Anything that broke before audio flowed: hang up, log it, close the books.
  async function failCall(entry, reason) {
    if (entry.finished) {
      // finish() may have run BEFORE the media session existed (terminate during
      // makeMedia). Whatever landed on the entry since then still needs closing.
      stopLoop(entry, 'call_ended');
      closeMedia(entry.media);
      return;
    }
    entry.session.onTerminateWebhook({ status: 'Failed', now: clock().getTime() });
    await graphCalls
      .callAction({ tenant: entry.clinic, callId: entry.callId, action: 'terminate' })
      .catch(() => {});
    alerts?.fire?.(entry.tenantId, 'voice_call_failed', `call ${entry.callId} could not be answered`);
    await finish(entry, { reason: reason || 'failed' });
  }

  // ── TERMINATE ──────────────────────────────────────────────────────────────
  async function onTerminate(ev) {
    const entry = sessions.get(ev.callId);
    if (!entry) {
      // Normal and expected: our watchdog already closed the books, or the call
      // belongs to another process/instance. Nothing to clean up.
      return;
    }
    // Tenant scoping is not optional, even here: callIds are opaque strings from
    // an untrusted body, and a mismatched phone_number_id must never let one
    // tenant's webhook hang up (and stamp a duration onto) another's live call.
    if (ev.phoneNumberId !== entry.session.phoneNumberId) {
      console.error(
        `[voice-call] DROPPED terminate for ${ev.callId}: phone_number_id=${ev.phoneNumberId} ` +
          `does not match the live session's ${entry.session.phoneNumberId}`
      );
      return;
    }
    entry.session.onTerminateWebhook({
      status: ev.status,
      durationSec: ev.durationSec,
      now: ev.endTime || clock().getTime(),
    });
    await finish(entry);
  }

  return {
    /**
     * The Graph client this service will actually use. Exposed read-only for
     * ops and for the hermeticity test that asserts a composed test app can
     * never end up on the `real` transport.
     */
    graphCalls,

    /**
     * Handle normalized call events (see ./normalize.js). NEVER throws.
     * @param {Array<object>|object} events
     */
    async handleEvents(events) {
      const list = Array.isArray(events) ? events : events ? [events] : [];
      for (const ev of list) {
        try {
          if (!ev || ev.channel !== 'whatsapp-call') continue;
          if (ev.kind === 'connect') await onConnect(ev);
          else if (ev.kind === 'terminate') await onTerminate(ev);
          else console.warn(`[voice-call] ignoring unsupported call event: ${ev.event || ev.kind}`);
        } catch (err) {
          console.error('[voice-call] event handling error:', err);
        }
      }
    },

    /** Live sessions — ops visibility + tests. */
    active() {
      return [...sessions.values()].map((e) => ({
        callId: e.callId,
        tenantId: e.tenantId,
        conversationId: e.conversationId,
        from: e.from,
        state: e.session.state,
        startedAt: e.session.startedAt,
        // Which brain this call is on — ops needs it live, not only afterwards.
        brain: e.brainKind || null,
      }));
    },

    /**
     * Resolve once every out-of-band task has drained — the service's own
     * (accept, watchdogs) AND every live brain's in-flight tool calls. Ops and
     * tests both need "is anything still writing?" to be one question.
     */
    async settled() {
      await settled();
      const loops = [...sessions.values()].map((e) => e.loop).filter(Boolean);
      await Promise.all(loops.map((l) => drainLoopSafe(l)));
      await settled();
    },

    /**
     * Graceful shutdown / test teardown: hang up everything, drop every socket
     * and timer. Deliberately does NOT write to the store — a process being
     * torn down (or a test whose temp dir is gone) must not fail here.
     * A media session still being BUILT is closed by answer()'s post-await
     * check, which sees `finished` and never leaves a peer connection behind.
     */
    async stop() {
      stopped = true;
      const entries = [...sessions.values()];
      sessions.clear();
      const at = clock().getTime();
      // Drain BEFORE tearing anything down: a tool call still writing an
      // appointment during a deploy must finish, not be abandoned half-written.
      await Promise.all(entries.map((e) => drainLoopSafe(e.loop)));
      for (const entry of entries) {
        entry.finished = true;
        clearTimers(entry);
        stopLoop(entry, 'call_ended');
        closeMedia(entry.media);
        rememberEnded(entry.callId, at);
        const r = entry.session.localHangup(at);
        if (r.action === 'terminate') {
          await graphCalls
            ?.callAction?.({ tenant: entry.clinic, callId: entry.callId, action: 'terminate' })
            ?.catch?.(() => {});
        }
      }
      await settled();
    },
  };
}

export default createVoiceCallService;
