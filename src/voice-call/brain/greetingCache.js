// The greeting on tape — the cheapest half second in the product (V5-T0.1).
//
// THE PROBLEM IT SOLVES. On a real call the caller hears: media connects →
// (Gemini Live handshake) → (setup) → (first generation) → "أهلا بيك…". Even
// with the session warmed in parallel with pre_accept, the model still has to
// GENERATE the greeting, and that generation is the last multi-second gap
// between "hello?" and a voice. Dead air at pickup is the #1 tell that a caller
// is talking to a machine — it is the thing that makes people hang up.
//
// So the FIRST call of a tenant/language pays for the greeting once, and every
// later call replays those exact frames the instant media connects, while the
// model is told (as context, not as a turn) that the greeting has already been
// spoken in its own voice.
//
// WHAT IS STORED, AND WHY IT IS SAFE TO STORE IT:
//   • Wire-format RTP payloads of ONE turn — the standard greeting. It names
//     the clinic and says "automated assistant"; it contains no patient data,
//     ever. A PERSONALIZED greeting (returning patient's name, their upcoming
//     appointment) is never teed in and never served from here — see loop.js.
//   • The greeting TEXT, so the model can be told exactly what the caller heard
//     rather than guessing and repeating half of it.
//
// THREE THINGS THAT ARE LOAD-BEARING IN THE KEY:
//   1. tenantId — obviously; one clinic must never speak in another's voice.
//   2. lang — the greeting is the language the call opens in.
//   3. CODEC — Opus payloads replayed on a G.711 (PCMA) leg are pure noise, and
//      Meta has shipped both. This is a deviation from the slice brief (which
//      said `${tenantId}:${lang}`) and it is deliberate: a cache hit across
//      codecs is a fax-machine call that is nearly impossible to diagnose from
//      a log.
// Plus a `signature` (the exact greeting instruction the tape was recorded
// from): rename a clinic and the old tape stops being served on the spot,
// instead of greeting patients with a dead name for up to a day.
//
// Process-local by design. It is a warm-up accelerator, not a data store: a
// deploy empties it and the next call refills it for the price of one greeting.

/** Distinct tenant/lang/codec greetings kept at once. */
export const MAX_ENTRIES = 32;
/** Older than this and we re-record: tenant config drifts, voices change. */
export const STALE_MS = 24 * 60 * 60 * 1000;
/** 15 s at 20 ms per frame. A greeting longer than that is a bug, not a tape. */
export const MAX_GREETING_FRAMES = 750;

/** key → { frames, text, signature, sampleCount, cachedAt } */
const cache = new Map();

/** `tenant:lang:codec` — see the header for why the codec is in here. */
export function greetingKey(tenantId, lang, codec) {
  return `${tenantId ?? ''}:${lang ?? ''}:${codec ?? ''}`;
}

/**
 * Read the tape for one tenant/lang/codec. Returns null on a miss, on a stale
 * entry (which is dropped, so the next call re-records it), or when the
 * greeting the tenant would speak today no longer matches the one on tape.
 *
 * @param {object} p
 * @param {string} p.tenantId
 * @param {string} p.lang
 * @param {string} p.codec        'opus' | 'pcma'
 * @param {string} [p.signature]  the greeting instruction this call would send
 * @param {number} [p.at]         now, in ms (injectable for tests)
 * @returns {{frames:Buffer[], text:string, sampleCount:number, cachedAt:number}|null}
 */
export function getGreeting({ tenantId, lang, codec, signature, at = Date.now() } = {}) {
  const key = greetingKey(tenantId, lang, codec);
  const entry = cache.get(key);
  if (!entry) return null;
  if (at - entry.cachedAt > STALE_MS) {
    cache.delete(key);
    return null;
  }
  if (signature != null && entry.signature !== signature) {
    // The tenant's greeting changed under us (a rename, a language switch).
    // Drop it rather than serve yesterday's clinic name.
    cache.delete(key);
    return null;
  }
  // LRU-ish: re-insert so the eviction below takes the coldest entry.
  cache.delete(key);
  cache.set(key, entry);
  return { frames: entry.frames, text: entry.text, sampleCount: entry.sampleCount, cachedAt: entry.cachedAt };
}

/**
 * Record one greeting. Frames are COPIED: they come off a codec that may reuse
 * its output buffer, and a tape that mutates under the next caller is the kind
 * of bug nobody finds.
 *
 * Refuses (silently, it is best-effort) an empty tape, a tape over the 15 s cap
 * and a greeting with no transcript — without the text there is nothing to tell
 * the model it already said.
 *
 * @returns {boolean} true when it was stored
 */
export function putGreeting({
  tenantId,
  lang,
  codec,
  frames,
  text,
  signature = null,
  sampleCount = 0,
  at = Date.now(),
} = {}) {
  if (!tenantId || !lang || !codec) return false;
  const list = Array.isArray(frames) ? frames.filter((f) => f && f.length) : [];
  const said = String(text || '').trim();
  if (!list.length || list.length > MAX_GREETING_FRAMES || said.length < 5) return false;

  const key = greetingKey(tenantId, lang, codec);
  cache.delete(key);
  cache.set(key, {
    frames: list.map((f) => Buffer.from(f)),
    text: said,
    signature,
    sampleCount: Number(sampleCount) || 0,
    cachedAt: at,
  });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return true;
}

/** Tests and ops: drop everything. */
export function clearGreetingCache() {
  cache.clear();
}

/** Ops visibility only — never used to make a decision. */
export function greetingCacheStats() {
  return {
    size: cache.size,
    keys: [...cache.keys()],
    entries: [...cache.entries()].map(([key, e]) => ({
      key,
      frames: e.frames.length,
      durationMs: e.frames.length * 20,
      chars: e.text.length,
      cachedAt: e.cachedAt,
    })),
  };
}

export default getGreeting;
