// Dialect-STT humility guardrail (V1) — a misheard word must never book an
// appointment.
//
// Speech recognition on Tunisian/Libyan Derja WILL mishear: names, weekdays and
// treatment words are exactly the tokens it gets wrong, and they are exactly the
// tokens a booking is made of. The product rule is "confirm before locking a
// voice-derived slot". Per CLAUDE.md that rule has to live in CODE — a prompt
// instruction is advice, and the executor is the only writer we actually trust.
//
// ── How it works ────────────────────────────────────────────────────────────
// Three states per critical slot, stored on `convo.state.data.voiceProvisional`:
//
//     (absent)  — typed, or already confirmed. Nothing blocks.
//     'heard'   — captured from a voice turn. blocksFinalize() is TRUE.
//     'echoed'  — the bot has read the value back to the patient in ITS OWN
//                 template. A "نعم" now clears it and the booking may complete.
//
// The provenance lives on `state.data`, deliberately, NOT on `state.h`:
// the executor's refusal branch resets `data` to `{}` and cancelBooking() nulls
// `convo.state`, so a cancel correctly wipes the gate instead of leaving a
// stale lock behind.
//
// Detection is a DIFF, not a list of assignment sites: snapshot the critical
// fields before the turn writes anything, compare after. That way a writer
// added later (or the classic booking state machine, which is a completely
// separate code path reached whenever the LLM fails) is covered without
// anybody remembering to call us.
//
// The gate is ONE pure predicate, `blocksFinalize(data)`, wired into BOTH — and
// only both — appointment writes:
//     src/engine/humanize/executor.js  (the llm path)
//     src/engine/booking.js            (the classic path, reached on ANY llm
//                                       failure via engine/index.js)
// Grep `finalizeBooking(` — there are exactly two call sites, and each is
// guarded. Note the executor's own comment used to call itself "the ONE
// appointment write"; it never was.
//
// CONTACT IS SPECIAL: a phone number is never written from speech at all. Digits
// are the single worst thing to mis-transcribe and the one field where being
// wrong is silent (nobody notices until the clinic calls a stranger). A number
// heard in a voice note is parked on `data.contactHeard`, read back, and only
// becomes `data.contact` when the patient types it or confirms it explicitly.

/** Slots where a mishearing has real-world consequences. */
export const CRITICAL_VOICE_SLOTS = Object.freeze(['specialty', 'slotIso', 'name', 'contact']);

const isVoice = (ctx) => ctx?.source === 'voice';

/** Shallow copy of the critical fields, for the before/after diff. */
export function snapshotCritical(data) {
  const d = data && typeof data === 'object' ? data : {};
  const out = {};
  for (const f of CRITICAL_VOICE_SLOTS) out[f] = d[f] ?? null;
  return out;
}

/**
 * Fields that transitioned to a DEFINED, CHANGED value. Transitions TO null are
 * ignored on purpose: a state reset (`data = {}`, `convo.state = null`) must
 * never register as a write and re-arm the gate.
 */
export function diffCritical(before = {}, after = {}) {
  const changed = [];
  for (const f of CRITICAL_VOICE_SLOTS) {
    const now = after?.[f];
    if (now == null || now === '') continue;
    if (now !== (before?.[f] ?? null)) changed.push(f);
  }
  return changed;
}

/**
 * Mark every slot this VOICE turn captured as provisional. No-op on typed turns.
 * Never downgrades an existing 'echoed' back to 'heard', so calling it twice in
 * one turn (executor + the engine-level backstop) is harmless.
 *
 * A contact heard from speech is MOVED off `data.contact` — see the header.
 */
export function markVoiceProvisional(ctx, data, before) {
  if (!isVoice(ctx) || !data || typeof data !== 'object') return [];
  const changed = diffCritical(before, data);
  if (!changed.length) return [];
  const prov = data.voiceProvisional && typeof data.voiceProvisional === 'object'
    ? data.voiceProvisional
    : (data.voiceProvisional = {});
  for (const f of changed) {
    if (f === 'contact') {
      // Never commit a spoken phone number. Park it for read-back instead.
      data.contactHeard = data.contact;
      delete data.contact;
      if (prov.contact !== 'echoed') prov.contact = 'heard';
      continue;
    }
    if (prov[f] !== 'echoed') prov[f] = 'heard';
  }
  return changed;
}

/** Slots still awaiting a read-back or a confirmation. */
export function unconfirmedVoiceSlots(data) {
  const prov = data?.voiceProvisional;
  if (!prov || typeof prov !== 'object') return [];
  return Object.keys(prov).filter((f) => prov[f] === 'heard' || prov[f] === 'echoed');
}

/**
 * THE GATE. True while any voice-derived slot has not yet been read back to the
 * patient. Both appointment writes consult this and refuse to finalize.
 *
 * Only 'heard' blocks — once the value has been echoed, the recap the patient is
 * agreeing to contains it, so a "نعم" is genuine consent to that exact value.
 * (Blocking on 'echoed' too would deadlock: the confirmation could never be
 * discharged by the very turn that agrees to it.)
 */
export function blocksFinalize(data) {
  const prov = data?.voiceProvisional;
  if (!prov || typeof prov !== 'object') return false;
  return Object.values(prov).some((v) => v === 'heard');
}

/** Promote slots from 'heard' to 'echoed' — the bot has now stated them back. */
export function markEchoed(data, fields) {
  const prov = data?.voiceProvisional;
  if (!prov || typeof prov !== 'object') return;
  const list = Array.isArray(fields) && fields.length ? fields : Object.keys(prov);
  for (const f of list) if (prov[f] === 'heard') prov[f] = 'echoed';
}

/** Drop the provenance entirely (values are now trusted). */
export function clearVoiceProvenance(data) {
  if (data && typeof data === 'object') delete data.voiceProvisional;
}

/**
 * Apply the patient's answer to a pending read-back. Runs FIRST in the turn,
 * before this turn's own slots are applied, so a turn can never confirm itself.
 *
 * yes → provenance cleared; the same turn may go on to complete the booking.
 * no  → the misheard VALUES are deleted (not merely un-trusted — keeping a value
 *       the patient just rejected is how a wrong appointment gets made two turns
 *       later) and the flow re-asks.
 *
 * @returns {{resolved:'yes'|'no'|null, cleared:string[]}}
 */
export function resolveVoiceConfirm(ctx, state, data, yn) {
  const prov = data?.voiceProvisional;
  if (!prov || typeof prov !== 'object' || !Object.keys(prov).length) {
    return { resolved: null, cleared: [] };
  }
  const echoed = Object.keys(prov).filter((f) => prov[f] === 'echoed');
  if (!echoed.length) return { resolved: null, cleared: [] };

  if (yn === 'yes') {
    // A voice "نعم" is accepted only when the transcript was clean: a
    // mis-transcribed yes must not be able to unlock a mis-transcribed slot.
    if (isVoice(ctx) && ctx?.voice?.grade && ctx.voice.grade !== 'ok') {
      return { resolved: null, cleared: [] };
    }
    for (const f of echoed) delete prov[f];
    if (!Object.keys(prov).length) clearVoiceProvenance(data);
    return { resolved: 'yes', cleared: echoed };
  }

  if (yn === 'no') {
    for (const f of echoed) {
      if (f === 'slotIso') {
        delete data.slotIso;
        delete data.slotAdjusted;
        delete data.datetimeRaw;
      } else if (f === 'contact') {
        delete data.contactHeard;
      } else {
        delete data[f];
      }
      delete prov[f];
    }
    if (!Object.keys(prov).length) clearVoiceProvenance(data);
    if (state?.h) state.h.awaitingConfirm = false;
    return { resolved: 'no', cleared: echoed };
  }

  return { resolved: null, cleared: [] };
}

/**
 * A typed value overrides anything heard for that field — typed input is
 * authoritative and needs no read-back.
 */
export function clearTypedOverrides(ctx, data, changed = []) {
  if (isVoice(ctx) || !data?.voiceProvisional) return;
  for (const f of changed) delete data.voiceProvisional[f];
  if (!Object.keys(data.voiceProvisional).length) clearVoiceProvenance(data);
}
