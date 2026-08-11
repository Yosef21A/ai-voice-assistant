// Call lifecycle state machine (V1) — PURE. No I/O, no timers, no imports.
//
// Why a separate module: the answer window Meta gives us is ~30-60s and the
// failure modes (nobody answers, the caller hangs up while ringing, media never
// connects, the call runs forever) are exactly the kind of thing that rots into
// unreviewable spaghetti when it lives inside the socket code. So the machine
// decides and RETURNS an action descriptor; the service (src/voice-call/index.js)
// is the only thing allowed to execute it. That makes every transition
// exhaustively unit-testable without a network.
//
//   ringing ──decideAnswer({open:false})──▶ rejected            (terminal)
//      │
//      └─decideAnswer({open:true})──▶ answering ──onAnswerPrepared──▶ connecting
//                                          │                              │
//                                          └────onMediaConnected──────────┤
//                                                                         ▼
//                                                                      active
//                                                                         │
//   any non-terminal ──onTerminateWebhook / onTimeout / onMaxDuration / localHangup
//                                                                         ▼
//                                            completed | missed | rejected | failed
//
// Terminal states are ABSORBING: every method is idempotent there and returns
// { action: null }, because Meta redelivers webhooks and our own watchdog can
// race the terminate webhook. Doing the cleanup twice must be free.

/** States from which no further transition is possible. */
export const TERMINAL_STATES = Object.freeze(['completed', 'missed', 'rejected', 'failed']);

const NO_ACTION = Object.freeze({ action: null });

/** Accept a Date, an epoch-ms number, or nothing → epoch ms. */
function ms(v, fallback = Date.now()) {
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * @param {object} p
 * @param {string} p.callId         Meta's `wacid.…`
 * @param {string} [p.tenantId]     resolved clinic id
 * @param {string} [p.from]         caller waId
 * @param {string} [p.phoneNumberId]
 * @param {Date|number} [p.now]     when the CONNECT webhook was received
 */
export function createCallSession({ callId, tenantId, from, phoneNumberId, now } = {}) {
  const startedAt = ms(now);

  const s = {
    callId: callId != null ? String(callId) : null,
    tenantId: tenantId ?? null,
    from: from ?? null,
    phoneNumberId: phoneNumberId ?? null,
    state: 'ringing',
    startedAt,
    // Milestones — the raw material for .summary().
    answeredAt: null, // pre_accept prepared
    mediaConnectedAt: null, // first moment audio actually flowed
    endedAt: null,
    outcome: null,
    reason: null,
    // Meta's own duration from the terminate webhook wins over our arithmetic:
    // it is the number the clinic will be billed on.
    reportedDurationSec: null,
  };

  const isTerminal = () => TERMINAL_STATES.includes(s.state);

  const finish = (state, at, reason = null) => {
    s.state = state;
    s.outcome = state;
    s.endedAt = ms(at);
    if (reason) s.reason = reason;
  };

  return {
    // ── read-only surface (getters so callers can never corrupt the machine) ──
    get callId() {
      return s.callId;
    },
    get tenantId() {
      return s.tenantId;
    },
    get from() {
      return s.from;
    },
    get phoneNumberId() {
      return s.phoneNumberId;
    },
    get state() {
      return s.state;
    },
    get startedAt() {
      return s.startedAt;
    },
    get mediaConnectedAt() {
      return s.mediaConnectedAt;
    },
    get endedAt() {
      return s.endedAt;
    },
    get outcome() {
      return s.outcome;
    },
    isTerminal,
    /** True once media connected — i.e. the patient actually heard us. */
    get wasActive() {
      return s.mediaConnectedAt != null;
    },

    // ── transitions ──────────────────────────────────────────────────────────

    /**
     * The clinic is open (or not). Closed ⇒ we reject immediately rather than
     * letting the caller ring out — a fast, explicit "closed" plus a WhatsApp
     * message beats 45 seconds of hope.
     *
     * `at` keeps this module 100% clock-free: every timestamp the machine
     * records comes from the caller, so tests are pure arithmetic. (It defaults
     * to Date.now() only so an omitted argument degrades sanely.)
     */
    decideAnswer({ open, at } = {}) {
      if (s.state !== 'ringing') return NO_ACTION;
      if (open) {
        s.state = 'answering';
        return { action: 'pre_accept' };
      }
      finish('rejected', at, 'closed');
      return { action: 'reject', reason: 'closed' };
    },

    /**
     * The SDP answer is ready. pre_accept goes out EARLY (while the phone is
     * still ringing) so the WebRTC handshake overlaps the ring — that is the
     * whole reason Meta exposes pre_accept as a separate action.
     */
    onAnswerPrepared(sdpAnswer, at) {
      if (s.state !== 'answering') return NO_ACTION;
      s.state = 'connecting';
      s.answeredAt = ms(at);
      return { action: 'send_pre_accept', sdp: sdpAnswer };
    },

    /** Media is flowing → confirm with `accept`. */
    onMediaConnected(at) {
      if (s.state !== 'answering' && s.state !== 'connecting') return NO_ACTION;
      s.state = 'active';
      s.mediaConnectedAt = ms(at);
      return { action: 'accept' };
    },

    /**
     * Meta's terminate webhook — arrives whichever side hung up, AND when the
     * call was never answered. `status` is 'Completed' | 'Failed'.
     */
    onTerminateWebhook({ status, durationSec, now: at } = {}) {
      if (isTerminal()) return NO_ACTION;
      const wasActive = s.mediaConnectedAt != null;
      if (durationSec != null && Number.isFinite(Number(durationSec))) {
        s.reportedDurationSec = Number(durationSec);
      }
      const failed = String(status || '') === 'Failed';
      const outcome = failed ? 'failed' : wasActive ? 'completed' : 'missed';
      finish(outcome, at, failed ? 'failed' : wasActive ? 'remote_hangup' : 'no_answer');
      return { action: 'cleanup' };
    },

    /** Watchdog: media never connected inside the answer window. */
    onTimeout(at) {
      if (isTerminal() || s.state === 'active') return NO_ACTION;
      finish('missed', at, 'connect_timeout');
      return { action: 'terminate', outcome: 'missed' };
    },

    /** Cap runaway calls (cost + a stuck session pinning a UDP socket). */
    onMaxDuration(at) {
      if (s.state !== 'active') return NO_ACTION;
      finish('completed', at, 'max_duration');
      return { action: 'terminate', outcome: 'completed', reason: 'max_duration' };
    },

    /** We hang up (shutdown, staff action). */
    localHangup(at) {
      if (isTerminal()) return NO_ACTION;
      const wasActive = s.mediaConnectedAt != null;
      finish(wasActive ? 'completed' : 'missed', at, 'local_hangup');
      return { action: 'terminate', outcome: wasActive ? 'completed' : 'missed' };
    },

    /**
     * The one-line record the transcript, the bus event and the audit log all
     * share. durationSec: Meta's number when we have it, else measured from
     * media-connect to end (a call that never connected lasted 0 seconds — NOT
     * the ring time, which would inflate every "talk time" report we ever run).
     * connectMs: connect-webhook → media-connected, the honest answer latency.
     */
    summary() {
      const durationSec =
        s.reportedDurationSec != null
          ? Math.max(0, Math.round(s.reportedDurationSec))
          : s.mediaConnectedAt != null && s.endedAt != null
            ? Math.max(0, Math.round((s.endedAt - s.mediaConnectedAt) / 1000))
            : 0;
      return {
        callId: s.callId,
        outcome: s.outcome,
        durationSec,
        connectMs: s.mediaConnectedAt != null ? s.mediaConnectedAt - s.startedAt : null,
        reason: s.reason,
      };
    },
  };
}

export default createCallSession;
