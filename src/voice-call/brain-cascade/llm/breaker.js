// THE LLM CIRCUIT BREAKER — one incident, not one per caller.
//
// Deliberately the same shape as brain/tts/breaker.js, createBrainBreaker
// (voice-call/index.js) and createQuota (voice/transcriber.js): this codebase
// has ONE mental model for "a dependency is down, stop paying for it".
//
// THE FAILURE IT EXISTS FOR is specific to free tiers and it is not
// hypothetical: `gemini-3-flash-preview` allows FIVE requests per minute across
// EVERY tenant (P0-measured). Without a breaker, every turn of every call would
// spend its first ~600 ms discovering that again before rotating. With one, the
// first 429 benches the model for a cooldown and the chain starts at the next
// link — so a busy minute costs one wasted request, not one per turn.
//
// TWO DELIBERATE DIFFERENCES FROM THE TTS BREAKER:
//  1. The cooldown is SHORT (60 s default, against 5 minutes). A TTS outage is
//     a vendor being down; an LLM 429 is a rolling quota window that recovers
//     in ~20 s, and benching a healthy model for five minutes would push every
//     call onto an unbenchmarked fallback for no reason.
//  2. The half-open probe is NOT exclusive. The TTS verdict is a whole call
//     away, so one probe goes out and everyone waits; here the verdict arrives
//     in under a second, so letting the window through costs nothing.
//
// PROCESS-GLOBAL and PER-PROVIDER, same single-process caveat as the greeting
// cache and the TTS breaker: it becomes per-worker if the JSON-store
// single-instance rule ever lifts. Noted rather than silently assumed away.

/** Consecutive failures before a provider is benched. */
export const DEFAULT_LLM_BREAKER_THRESHOLD = 2;
/** How long it stays benched. Free-tier windows recover in ~20 s. */
export const DEFAULT_LLM_BREAKER_COOLDOWN_MS = 60000;

/** provider → { failures, openedAt } */
const breakers = new Map();

function entryFor(provider) {
  const key = String(provider || 'unknown');
  let e = breakers.get(key);
  if (!e) {
    e = { failures: 0, openedAt: 0 };
    breakers.set(key, e);
  }
  return e;
}

/**
 * A turn failed on this provider (429, 5xx, timeout, empty stream).
 * @returns {{failures:number, open:boolean, justOpened:boolean}}
 */
export function noteLlmFailure(
  provider,
  { threshold = DEFAULT_LLM_BREAKER_THRESHOLD, at = Date.now() } = {}
) {
  const e = entryFor(provider);
  const wasOpen = !!e.openedAt;
  e.failures += 1;
  if (e.failures >= threshold) e.openedAt = at;
  return { failures: e.failures, open: !!e.openedAt, justOpened: !!e.openedAt && !wasOpen };
}

/** A turn was answered by this provider. The incident is over. */
export function noteLlmOk(provider) {
  const e = entryFor(provider);
  e.failures = 0;
  e.openedAt = 0;
}

/**
 * True ⇒ skip this provider for this turn.
 *
 * MUTATES on the half-open transition: the first turn after the cooldown gets
 * `false` (it is the probe) and the counter is left ONE short of the threshold,
 * so a single noteLlmFailure re-opens the breaker on the spot. House pattern —
 * which is why this is a function call and not a getter.
 */
export function isLlmBreakerOpen(
  provider,
  {
    threshold = DEFAULT_LLM_BREAKER_THRESHOLD,
    cooldownMs = DEFAULT_LLM_BREAKER_COOLDOWN_MS,
    at = Date.now(),
  } = {}
) {
  const e = breakers.get(String(provider || 'unknown'));
  if (!e || !e.openedAt) return false;
  if (at - e.openedAt < cooldownMs) return true;
  e.openedAt = 0;
  e.failures = Math.max(0, threshold - 1);
  return false; // half-open: this turn is the probe
}

/** Tests and ops: forget every incident. */
export function resetLlmBreakers() {
  breakers.clear();
}

/** Ops visibility only — never used to make a decision. */
export function llmBreakerStats() {
  return [...breakers.entries()].map(([provider, e]) => ({
    provider,
    failures: e.failures,
    open: !!e.openedAt,
    openedAt: e.openedAt || null,
  }));
}

export default isLlmBreakerOpen;
