// THE MONTHLY CHARACTER BUDGET — the other half of "free tier" (V7 review).
//
// ElevenLabs' free tier is 10 000 characters A MONTH, measured live from
// `/v1/user/subscription` during P0: `tier:"free"`, `character_limit:10000`.
// At ~150 characters per spoken reply that is about SIXTY-FIVE replies — under
// ten real calls — for the whole month.
//
// THE FAILURE THIS PREVENTS. ElevenLabs is a FALLBACK candidate in the chain
// (doctrine order: fish → elevenlabs). A Fish outage on the 3rd of the month
// would silently drain the entire monthly allowance in an afternoon, and the
// founder would discover it when a demo call to a prospective client answered
// in the native voice — or not at all. So the fallback stops choosing
// ElevenLabs once the month's spend passes a soft cap.
//
// TWO DELIBERATE ASYMMETRIES:
//  1. It is a SOFT cap, below the real limit, because our count is an estimate
//     (the vendor bills normalized text, we count what we sent) and because the
//     last characters of an allowance should belong to a human's decision, not
//     to an automatic fallback.
//  2. A TENANT WHO EXPLICITLY CHOSE ElevenLabs is never blocked. They asked for
//     it, they may be on a paid plan, and silently downgrading a voice a clinic
//     is paying for would be a worse bug than the one this prevents. The cap
//     governs the FALLBACK only.
//
// Process-global, same single-process caveat as the greeting cache and the two
// breakers: it becomes per-worker if the JSON-store single-instance rule ever
// lifts. Noted rather than silently assumed away. It resets with the calendar
// month (UTC), which is how the vendors themselves bill.

/** provider → { month: 'YYYY-MM', chars } */
const spend = new Map();

/** UTC year-month. The vendors reset on the calendar month; so do we. */
export function monthKey(at = Date.now()) {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function entryFor(provider, at) {
  const key = String(provider || 'unknown');
  const month = monthKey(at);
  let e = spend.get(key);
  if (!e || e.month !== month) {
    e = { month, chars: 0 };
    spend.set(key, e);
  }
  return e;
}

/**
 * Count characters actually sent to a vendor.
 * @returns {number} the running total for this provider this month
 */
export function noteTtsChars(provider, chars, at = Date.now()) {
  const n = Number(chars) || 0;
  if (n <= 0) return entryFor(provider, at).chars;
  const e = entryFor(provider, at);
  e.chars += n;
  return e.chars;
}

/** What this provider has cost us so far this month. */
export function ttsCharsThisMonth(provider, at = Date.now()) {
  return entryFor(provider, at).chars;
}

/** Tests and ops: forget the ledger. */
export function resetTtsBudget() {
  spend.clear();
}

/** Ops visibility only. */
export function ttsBudgetStats(at = Date.now()) {
  return [...spend.entries()].map(([provider, e]) => ({ provider, month: e.month, chars: e.chars }));
}

export default noteTtsChars;
