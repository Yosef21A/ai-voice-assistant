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

// ── THE SOFT VARIANT: 'cooling', not 'open' (V8-D2 §2) ──────────────────────
// A provider can be UP and still unusable on a phone line. The founder's
// measured reality was not an outage, it was JITTER: the same model answering
// in 600 ms and then in 2.4 s, on the same call, with nothing in the logs to
// distinguish them. A breaker is the wrong instrument for that — nothing
// failed, so nothing would ever open it, and if it did, a five-failure bench
// for a model that is merely slow today would push every call onto an
// unbenchmarked fallback.
//
// So: a rolling window of the last few TTFTs per provider. When the MEDIAN of a
// full window passes the clamp, the provider is 'cooling' — skipped for NEW
// turns, logged ONCE, and probed every Nth turn so it can come back the moment
// it is quick again. Median rather than mean because one 8 s stall (the stall
// timer's own ceiling) would otherwise clamp a healthy provider for a window.

/** TTFT samples kept per provider. Five turns ≈ the last ~40 s of a call. */
export const TTFT_WINDOW = 5;
/** Above this rolling median a provider is cold rather than broken. */
export const DEFAULT_TTFT_CLAMP_MS = 2000;
/** One turn in this many is a probe: a clamped provider must be able to return. */
export const TTFT_PROBE_EVERY = 5;

/** provider → { failures, openedAt, ttft:number[], cooling:boolean, skipped:number } */
const breakers = new Map();

function entryFor(provider) {
  const key = String(provider || 'unknown');
  let e = breakers.get(key);
  if (!e) {
    e = { failures: 0, openedAt: 0, ttft: [], cooling: false, skipped: 0 };
    breakers.set(key, e);
  }
  return e;
}

/** The median of a numeric array. Empty ⇒ null. */
function median(list) {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * One turn's measured time-to-first-token for this provider.
 * @param {string} provider
 * @param {number} ms
 * @returns {{median:number|null, samples:number}}
 */
export function noteLlmTtft(provider, ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return { median: null, samples: 0 };
  const e = entryFor(provider);
  e.ttft.push(n);
  while (e.ttft.length > TTFT_WINDOW) e.ttft.shift();
  return { median: median(e.ttft), samples: e.ttft.length };
}

/**
 * Is this provider too slow to be given a NEW turn?
 *
 * Requires a FULL window: clamping on one slow sample would bench a provider
 * for the first cold-start request of every process, which is the one request
 * the pre-warm exists to make irrelevant.
 *
 * MUTATES on the probe transition, exactly like isLlmBreakerOpen above — the
 * house pattern, which is why this is a function and not a getter.
 *
 * @returns {{cooling:boolean, median:number|null, probe:boolean, justCooled:boolean}}
 */
export function llmTtftClamp(provider, { clampMs = DEFAULT_TTFT_CLAMP_MS, probeEvery = TTFT_PROBE_EVERY } = {}) {
  // 0 / off / a non-positive value ⇒ the clamp is disabled (review minor 6).
  // Ops has to be able to turn it off at 2 a.m. when a mis-tuned threshold is
  // benching a healthy provider, and `|| DEFAULT` would swallow a deliberate 0.
  if (!(Number(clampMs) > 0)) return { cooling: false, median: null, probe: false, justCooled: false };
  const e = breakers.get(String(provider || 'unknown'));
  if (!e || e.ttft.length < TTFT_WINDOW) return { cooling: false, median: e ? median(e.ttft) : null, probe: false, justCooled: false };
  const med = median(e.ttft);
  if (med == null || med <= clampMs) {
    e.cooling = false;
    e.skipped = 0;
    return { cooling: false, median: med, probe: false, justCooled: false };
  }
  const justCooled = !e.cooling;
  e.cooling = true;
  // Every Nth turn goes through anyway. A clamped provider that is never tried
  // again is a permanent demotion decided by five samples.
  e.skipped += 1;
  if (probeEvery > 0 && e.skipped % probeEvery === 0) {
    return { cooling: false, median: med, probe: true, justCooled };
  }
  return { cooling: true, median: med, probe: false, justCooled };
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
 * Ops visibility on the clamp: what each provider's rolling median actually is.
 *
 * A provider that recovered clears itself WITHOUT a special case — every probe
 * turn pushes a fast sample that evicts an old slow one, so the median walks
 * back under the line within one window. There is deliberately no "unclamp"
 * call: a clamp that can be cleared by hand is a clamp that hides a slow model.
 */
export function llmTtftStats() {
  return [...breakers.entries()]
    .filter(([, e]) => e.ttft.length)
    .map(([provider, e]) => ({
      provider,
      samples: e.ttft.length,
      medianMs: median(e.ttft),
      cooling: !!e.cooling,
    }));
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
