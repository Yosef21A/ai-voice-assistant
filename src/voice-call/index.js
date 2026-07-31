// Voice-call service (V1) — the transport-agnostic brain-less call handler.
//
// WHAT THIS SLICE DOES: a patient calls the clinic's WhatsApp number; we decide
// open/closed, answer or decline, hold a real WebRTC audio path (echo only),
// and leave a durable trace on the SAME conversation thread the patient already
// chats on. WHAT IT DELIBERATELY DOES NOT DO: transcribe, think, or speak.
// There is no STT/LLM/TTS here, so no medical guardrail can be violated by a
// V1 call — the bot literally cannot say anything.
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
import { isAfterHours, weekdayInTz } from '../stats/index.js';
import { sendAs } from '../api/outbound.js';
import { resolveLanguage } from '../engine/language.js';
import { t } from '../engine/responses.js';

const LANGS = ['ar', 'fr', 'en'];
const DAY_KEYS = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
const DEFAULT_CONNECT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_SEC = 600;
// Recently-ended callIds are remembered just long enough to swallow a late
// redelivery. Meta retries a webhook for minutes, not hours.
const RECENT_TTL_MS = 10 * 60 * 1000;
const RECENT_CAP = 200;

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
  now,
} = {}) {
  const clock = typeof now === 'function' ? now : () => new Date();
  const makeMedia = typeof mediaFactory === 'function' ? mediaFactory : createMediaSession;
  const connectTimeoutMs = Number(config.voiceCallConnectTimeoutMs) || DEFAULT_CONNECT_TIMEOUT_MS;
  const maxSec = Number(config.voiceCallMaxSec) || DEFAULT_MAX_SEC;

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
    closeMedia(entry.media);
    sessions.delete(entry.callId);
    rememberEnded(entry.callId, clock().getTime());

    const { session, tenantId, conversationId, lang } = entry;
    const summary = session.summary();
    // "Did the patient actually hear us?" is the question that decides both the
    // transcript line and the bus event — NOT the outcome string. A call that
    // connected and then failed mid-way is a call that happened; telling the
    // clinic it was "missed" would be a lie, and would break the catalog rule
    // that call.ended always follows call.started.
    const held = session.wasActive;
    const missReason =
      reason || (summary.reason === 'closed' ? 'closed' : summary.outcome === 'failed' ? 'failed' : 'no_answer');
    const text = held
      ? t(lang, 'callSummary', { duration: formatDuration(summary.durationSec) })
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
              outcome: summary.outcome,
              durationSec: summary.durationSec,
              connectMs: summary.connectMs,
              from: entry.from,
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

    const call = { ...summary, from: entry.from, reason: held ? summary.reason : missReason };
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

    let media;
    try {
      media = await makeMedia({
        sdpOffer: ev.sdpOffer,
        // V1 = ECHO. Verbatim: werift's sender rewrites ssrc / payloadType /
        // sequence / timestamp on write, so relaying the packet is correct.
        onRtp: (packet) => entry.media?.sendRtp(packet),
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

    /** Resolve once every out-of-band task (accept, watchdogs) has drained. */
    settled,

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
      for (const entry of entries) {
        entry.finished = true;
        clearTimers(entry);
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
