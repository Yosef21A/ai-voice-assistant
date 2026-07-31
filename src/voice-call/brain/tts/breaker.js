// THE TTS CIRCUIT BREAKER — the fix for the outage that costs every caller.
//
// THE FAILURE IT EXISTS FOR, stated as it was proven: the credentials are
// valid, so the chain arms happily; the VENDOR is down, so the first synthesis
// of every call throws. Because `responseModalities` is fixed at Live `setup`,
// a call that opened in TEXT mode has no audio to fall back to (see
// ./index.js), so it hangs up with the written follow-up. Repeat for every
// caller, for the whole outage — while the native Gemini voice sat there,
// healthy, free, and one composition decision away.
//
// The modality decision is made ONCE PER CALL, before the socket opens. That is
// exactly where a breaker belongs: after N consecutive calls lost their voice to
// the same provider, the next call simply composes NATIVE. The clinic keeps
// answering the phone in the Gemini voice — slightly less human, entirely
// working — until one probe call proves the vendor is back.
//
// Deliberately the same shape as createBrainBreaker (src/voice-call/index.js)
// and createQuota (src/voice/transcriber.js): one mental model in this codebase
// for "the paid dependency is down, stop paying for it".
//
// PROCESS-GLOBAL and PER-PROVIDER. Global because the point is to carry a fact
// learned on call N into call N+1, and the chain is rebuilt per call. Per
// provider because a tenant on Azure must not be punished for an ElevenLabs
// outage. Same single-process caveat as the greeting cache and the STT quota
// breaker: it becomes per-worker if the JSON-store single-instance rule ever
// lifts, which is noted rather than silently assumed away.

/** Consecutive lost-voice calls before a provider is benched. */
export const DEFAULT_TTS_BREAKER_THRESHOLD = 2;
/** How long it stays benched before ONE probe call is allowed through. */
export const DEFAULT_TTS_BREAKER_COOLDOWN_MS = 300000;

/** provider → { failures, openedAt, probingAt } */
const breakers = new Map();

function entryFor(provider) {
  const key = String(provider || 'unknown');
  let e = breakers.get(key);
  if (!e) {
    e = { failures: 0, openedAt: 0, probingAt: 0 };
    breakers.set(key, e);
  }
  return e;
}

/**
 * A call lost its voice to this provider ('tts_lost').
 * @returns {{failures:number, open:boolean, justOpened:boolean}} — `justOpened`
 *   is true exactly once per incident, so the alert fires once and not per call.
 */
export function noteTtsFailure(provider, { threshold = DEFAULT_TTS_BREAKER_THRESHOLD, at = Date.now() } = {}) {
  const e = entryFor(provider);
  const wasOpen = !!e.openedAt;
  e.probingAt = 0; // the probe reported: failed
  e.failures += 1;
  if (e.failures >= threshold) e.openedAt = at;
  return { failures: e.failures, open: !!e.openedAt, justOpened: !!e.openedAt && !wasOpen };
}

/** A call spoke through this provider and survived. The incident is over. */
export function noteTtsOk(provider) {
  const e = entryFor(provider);
  e.failures = 0;
  e.openedAt = 0;
  e.probingAt = 0;
}

/**
 * True ⇒ compose the NATIVE voice for this call and do not open a TEXT session.
 *
 * MUTATES on the half-open transition: the first call after the cooldown gets
 * `false` (it is the probe) and the counter is left ONE short of the threshold,
 * so a single `noteTtsFailure` re-opens the breaker on the spot. That is the
 * house pattern, and it is why this is a function call and not a getter.
 *
 * ONE DELIBERATE DEVIATION from createBrainBreaker: the probe is EXCLUSIVE.
 * There, the verdict arrives microseconds later (the socket either opens or it
 * does not), so letting the whole half-open window through costs nothing. Here
 * the verdict is a WHOLE CALL away — a probe that started at 09:00 reports when
 * the patient hangs up — and every call that starts in the meantime would take
 * the paid voice and lose it the same way. So one probe goes out and everybody
 * else waits for its answer. The token expires after another cooldown so a
 * probe that never reports (a crash, a call that never ended) cannot bench a
 * healthy provider forever.
 */
export function isTtsBreakerOpen(
  provider,
  { threshold = DEFAULT_TTS_BREAKER_THRESHOLD, cooldownMs = DEFAULT_TTS_BREAKER_COOLDOWN_MS, at = Date.now() } = {}
) {
  const e = breakers.get(String(provider || 'unknown'));
  if (!e) return false;
  if (e.openedAt) {
    if (at - e.openedAt < cooldownMs) return true;
    e.openedAt = 0;
    e.failures = Math.max(0, threshold - 1);
    e.probingAt = at;
    return false; // half-open: THIS call is the probe
  }
  if (e.probingAt) {
    if (at - e.probingAt < cooldownMs) return true; // waiting on the probe
    e.probingAt = 0; // the probe never reported; send another one
    return false;
  }
  return false;
}

/** Tests and ops: forget every incident. */
export function resetTtsBreakers() {
  breakers.clear();
}

/** Ops visibility only — never used to make a decision. */
export function ttsBreakerStats() {
  return [...breakers.entries()].map(([provider, e]) => ({
    provider,
    failures: e.failures,
    open: !!e.openedAt,
    openedAt: e.openedAt || null,
    probing: !!e.probingAt,
  }));
}

export default isTtsBreakerOpen;
