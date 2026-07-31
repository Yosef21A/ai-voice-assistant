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

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {object} deps.bus
 * @param {object} deps.sender        the ONE WhatsApp sender (mock under test)
 * @param {object} [deps.config]      voiceCallConnectTimeoutMs / voiceCallMaxSec
 * @param {object} [deps.alerts]      system alerts (owner-visible failures)
 * @param {object} deps.graphCalls    ./graphCalls.js client
 * @param {Function} [deps.mediaFactory] default createMediaSession (inject fakes)
 * @param {Function} [deps.brainFactory] default createBrainLoop (inject fakes)
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
  now,
} = {}) {
  const clock = typeof now === 'function' ? now : () => new Date();
  const makeMedia = typeof mediaFactory === 'function' ? mediaFactory : createMediaSession;
  const makeBrain = typeof brainFactory === 'function' ? brainFactory : createBrainLoop;
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
    const brain = entry.loop ? entry.loop.outcome() : null;
    const transcript = entry.loop ? entry.loop.transcript() : null;
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
      closeMedia(media); // terminated while pre_accept was in flight
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
   * Build and start the Gemini Live loop for a connected call. A brain that
   * cannot come up inside `voiceBrainConnectMs` is not something we wait out —
   * the caller is listening to silence, which is worse than a polite goodbye.
   */
  async function startBrain(entry) {
    if (entry.finished || entry.loop) return;
    // Breaker open ⇒ the endpoint is known-down. Do not spend six seconds of
    // this caller's life proving it again; go straight to the WhatsApp handover.
    if (brainBreaker.isOpen()) {
      console.warn(`[voice-call] brain breaker OPEN — degrading call ${entry.callId} immediately`);
      return await degradeBrain(entry, { skipAlert: true });
    }
    let loop;
    try {
      loop = makeBrain({
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
        // The loop never hangs up by itself: it reports, and THIS module owns
        // the Graph terminate + the transcript + the degrade text.
        onEnd: (outcome) => track(onBrainEnd(entry, outcome)),
      });
    } catch (err) {
      console.error('[voice-call] brain construction failed:', err?.message || err);
      brainBreaker.note();
      return await degradeBrain(entry);
    }
    entry.loop = loop;
    if (entry.finished) {
      stopLoop(entry, 'call_ended'); // terminated while we were constructing
      return;
    }

    try {
      await withTimeout(loop.start(), brainConnectMs, 'brain connect timeout');
    } catch (err) {
      console.error('[voice-call] brain failed to start:', err?.message || err);
      brainBreaker.note();
      return await degradeBrain(entry);
    }
    brainBreaker.noteOk(); // the endpoint answered — close a half-open breaker
    if (entry.finished) stopLoop(entry, 'call_ended');
  }

  /** The loop reported it is over. Decide how the CALL ends. */
  async function onBrainEnd(entry, outcome) {
    if (entry.finished || entry.brainClosing) return;
    if (outcome?.reason === 'call_ended') return; // WE stopped it from finish()
    entry.brainClosing = true;
    // An EMERGENCY outranks everything, including a socket that died right
    // after it. The script was spoken, the owner paged and the number already
    // sent in writing — a "sorry, write to us here" on top of that would be
    // noise at best, and at worst reads as the clinic brushing them off.
    if (outcome?.emergency) return await hangUp(entry, 'emergency');
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
