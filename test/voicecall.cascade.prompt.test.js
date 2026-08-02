// V8-D4 — HUMAN POLISH (prompt-level) + the V7-amendment fluency mandate.
//
// This suite asserts the prompt/fewshot LAYER only: brain-cascade/prompt.js
// and brain-cascade/fewshots.js. It does not touch the orchestrator (owned by
// a concurrent slice) — no socket, no LLM, no store writes; pure string
// assertions on the compiled prompt and the exported fewshot pool, using real
// tenant fixtures via makeTestApp()/store.getClinicById the same way the rest
// of the voice-call suite does.
//
// Founder law under test (docs/VOICE-AGENT-SPEC.md §V8 D4):
//   1. turn shape — acknowledge → answer → ONE question, every turn ends on it
//   2. anti-repetition — never the same phrasing twice in a call
//   3. restrained disfluency — 1-2 per turn max, NEVER on emergency/confirm turns
//   4. spoken forms — digits/dates as words (already law in the imported
//      compact voiceStyleBlock; asserted here via the ASSEMBLED prompt so a
//      future edit that drops the import is caught here too)
//   5. read-backs ONLY for exact data (name/phone/date), never a general claim
// Plus the V7-amendment §2 few-shot mandate: ≤6 exemplars per register, no
// invented prices, the placeholder convention intact, and (V8-D4) two
// exemplars per register demonstrating a graceful mid-call correction.
//
// Budget asserts TWO numbers on purpose (review round, 2026-08-02): the diet
// target for the COMMON case (a plain booking turn, <6000) AND an HONEST
// ceiling for the worst realistic turn (hours + pricing + a KB match at
// once, <7200 — measured 6888). Asserting only the small case would make the
// "<6000" claim true in the test suite and false on a real call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers/client.js';
import {
  buildVoiceTurnPrompt,
  HUMAN_POLISH_POLICY,
  needsHours,
  needsPricing,
} from '../src/voice-call/brain-cascade/prompt.js';
import {
  buildFewshotBlock,
  pickFewshots,
  isLibyanRegister,
  FEWSHOTS_TN,
  FEWSHOTS_LY,
  MAX_FEWSHOTS,
} from '../src/voice-call/brain-cascade/fewshots.js';

const CLINIC = 'el-amen-sousse'; // multi-specialty Tunisian clinic
const CABINET = 'cabinet-bensalem-sousse'; // fixed-specialty doctor persona
const LIBYAN_WA = '218911234567'; // caller-number signal, not a tenant field
const NOW = 'الجمعة 2026-08-02 10:00';

function getClinic(tenantId) {
  const app = makeTestApp();
  return app.store.getClinicById(tenantId);
}

/** A booking-flow turn that needs neither hours nor pricing — the honest
 * reading of "a plain booking turn": mid-flow (asking for the caller's name),
 * not a turn ABOUT the clinic's hours or money. Verified against the same
 * needsHours/needsPricing predicates the prompt itself uses. */
const PLAIN_BOOKING_TURN = 'شنو اسمك الكامل من فضلك';

test('sanity: the plain-booking fixture does not trip the hours/pricing gates', () => {
  assert.equal(needsHours(PLAIN_BOOKING_TURN), false);
  assert.equal(needsPricing(PLAIN_BOOKING_TURN), false);
});

// ── D4 rule 1: turn shape ────────────────────────────────────────────────────

test('D4 #1 — prompt states the turn SHAPE (acknowledge, answer, end on ONE question)', () => {
  const clinic = getClinic(CLINIC);
  const prompt = buildVoiceTurnPrompt({ clinic, lang: 'ar', nowStr: NOW, kbText: PLAIN_BOOKING_TURN });
  assert.match(prompt, /Acknowledge, answer, END on exactly ONE question/i);
  assert.match(prompt, /never a flat statement/i);
});

// ── D4 rule 2: anti-repetition ───────────────────────────────────────────────

test('D4 #2 — prompt forbids reusing the same sentence/backchannel/filler twice in one call', () => {
  const clinic = getClinic(CLINIC);
  const prompt = buildVoiceTurnPrompt({ clinic, lang: 'ar', nowStr: NOW, kbText: PLAIN_BOOKING_TURN });
  assert.match(prompt, /NEVER reuse a sentence, backchannel or filler twice in one call/i);
});

// ── D4 rule 3: restrained disfluency + the emergency/confirmation exception ──

test('D4 #3 — disfluency is capped (1-2/turn) and explicitly OFF for emergency/confirmation turns', () => {
  const clinic = getClinic(CLINIC);
  const prompt = buildVoiceTurnPrompt({ clinic, lang: 'ar', nowStr: NOW, kbText: PLAIN_BOOKING_TURN });
  assert.match(prompt, /Disfluency/i);
  assert.match(prompt, /1-2 per turn max/i);
  assert.match(prompt, /NEVER in the emergency script or a confirmation turn/i);
  // the actual disfluency vocabulary from the spec is present verbatim
  for (const marker of ['نشوف', 'ثانية برك', 'أممم']) {
    assert.ok(prompt.includes(marker), `expected disfluency marker "${marker}" in prompt`);
  }
});

// ── D4 rule 4: spoken-form numbers ───────────────────────────────────────────

test('D4 #4 — spoken-form rule reaches the assembled prompt (imported from voiceStyleBlock)', () => {
  const clinic = getClinic(CLINIC);
  const prompt = buildVoiceTurnPrompt({ clinic, lang: 'ar', nowStr: NOW, kbText: PLAIN_BOOKING_TURN });
  assert.match(prompt, /numbers, dates and times the way a person says them out loud/i);
});

// ── D4 rule 5: read-backs ONLY for exact data ────────────────────────────────

test('D4 #5 — read-backs are scoped to exact data, never a general statement', () => {
  const clinic = getClinic(CLINIC);
  const prompt = buildVoiceTurnPrompt({ clinic, lang: 'ar', nowStr: NOW, kbText: PLAIN_BOOKING_TURN });
  assert.match(prompt, /Read back ONLY exact data \(name, date, phone\)/i);
  assert.match(prompt, /never a general statement/i);
});

// ── D4 pace hint ──────────────────────────────────────────────────────────────

test('D4 — the confirm-after-yes rule is imperative (self-test found the model looping back after «نعم»)', () => {
  // The elderly-pace hint (V5-T2, prompt-only, no rate control) was traded out
  // of the budget for this: the 2026-08-02 rehearsal booked nothing because
  // flash-lite got a perfect recap + «نعم صحيح» and then re-asked the day
  // instead of calling confirm_booking. The rule that fixes it must be present.
  const clinic = getClinic(CLINIC);
  const p = buildVoiceTurnPrompt({ clinic, lang: 'ar' });
  assert.match(p, /confirm_booking/);
  assert.match(p, /VERY NEXT action is confirm_booking/);
});

// ── D4 is never conditional: present on every persona (clinic, cabinet, facilitator) ──

test('D4 — HUMAN_POLISH_POLICY rides every persona, not just the default clinic', () => {
  const clinic = getClinic(CLINIC);
  const cabinet = getClinic(CABINET);
  const facilitator = getClinic('medtour-tripoli-sousse');
  for (const c of [clinic, cabinet, facilitator]) {
    const prompt = buildVoiceTurnPrompt({ clinic: c, lang: 'ar', nowStr: NOW, kbText: PLAIN_BOOKING_TURN });
    assert.ok(prompt.includes(HUMAN_POLISH_POLICY), `HUMAN_POLISH_POLICY missing for tenant ${c.id}`);
  }
});

// ── fewshots: ≤6 per register ─────────────────────────────────────────────────

test('fewshots — at most MAX_FEWSHOTS (6) exemplars reach the prompt, Tunisian register', () => {
  const clinic = getClinic(CLINIC);
  const list = pickFewshots({ lang: 'ar', clinic, patientWaId: '' });
  assert.equal(MAX_FEWSHOTS, 6);
  assert.ok(list.length <= 6, `TN register carried ${list.length} exemplars`);
  assert.equal(isLibyanRegister({ clinic, patientWaId: '' }), false);
});

test('fewshots — at most MAX_FEWSHOTS (6) exemplars reach the prompt, Libyan register', () => {
  const clinic = getClinic(CLINIC); // Tunisian clinic, Libyan CALLER
  const list = pickFewshots({ lang: 'ar', clinic, patientWaId: LIBYAN_WA });
  assert.ok(list.length <= 6, `LY register carried ${list.length} exemplars`);
  assert.equal(isLibyanRegister({ clinic, patientWaId: LIBYAN_WA }), true);
});

test('fewshots — the raw pools themselves are capped at 6 (nothing to accidentally over-select)', () => {
  assert.equal(FEWSHOTS_TN.length, 6);
  assert.equal(FEWSHOTS_LY.length, 6);
});

// ── fewshots: no invented prices ─────────────────────────────────────────────

// A "real" price looks like a bare number glued to a currency word/symbol —
// dinar, euro, DT, €, $ — OUTSIDE a [placeholder]. The placeholder text itself
// legitimately contains the word "السعر" but never a digit.
const CURRENCY_WORDS = /(دينار|دولار|يورو|€|\$|DT\b|TND\b|EUR\b)/;

function assertNoInventedPrices(exemplars, label) {
  for (const ex of exemplars) {
    const text = `${ex.caller} ${ex.agent}`;
    // strip bracketed placeholders before scanning — those are allowed to
    // reference "price" in prose, just never a digit.
    const stripped = text.replace(/\[[^\]]*\]/g, '');
    const hasDigitNearCurrency = /\d/.test(stripped) && CURRENCY_WORDS.test(stripped);
    assert.equal(
      hasDigitNearCurrency,
      false,
      `${label}: exemplar appears to invent a real price outside a placeholder: "${text}"`
    );
  }
}

test('fewshots — no exemplar (TN or LY) states a real number+currency price', () => {
  assertNoInventedPrices(FEWSHOTS_TN, 'FEWSHOTS_TN');
  assertNoInventedPrices(FEWSHOTS_LY, 'FEWSHOTS_LY');
});

// ── fewshots: the placeholder convention is intact ───────────────────────────

test('fewshots — the price/date/time exemplars use bracketed placeholders, never a literal figure', () => {
  const priceEx = FEWSHOTS_TN.find((e) => /قداش تسوى/.test(e.caller));
  assert.ok(priceEx, 'expected the price-guardrail exemplar to survive the rebuild');
  assert.match(priceEx.agent, /\[.*\]/, 'price exemplar must carry a bracketed placeholder');

  const recapEx = FEWSHOTS_TN.find((e) => /\[التاريخ والساعة\]/.test(e.agent));
  assert.ok(recapEx, 'expected the recap/read-back exemplar with a bracketed date placeholder');
});

test('fewshots — the block header still teaches the placeholder convention (V7-P2.1 anti-invention law)', () => {
  const clinic = getClinic(CLINIC);
  const block = buildFewshotBlock({ lang: 'ar', clinic, patientWaId: '' });
  assert.match(block, /\[brackets\] are PLACEHOLDERS/);
  assert.match(block, /never invent what goes in it/);
});

// ── fewshots: both correction exemplars are present, in both registers ──────

test('fewshots — TN register carries two graceful-correction exemplars ("لا سامحني…")', () => {
  const corrections = FEWSHOTS_TN.filter((e) => e.caller.trim().startsWith('لا سامحني'));
  assert.equal(corrections.length, 2, 'expected exactly two correction exemplars in FEWSHOTS_TN');
  // the two pivots must use DIFFERENT acknowledgement phrasing — the anti-
  // repetition rule (D4 #2) applies to the exemplars too, not just the model.
  const openings = corrections.map((e) => e.agent.split('،')[0].split('.')[0].trim());
  assert.notEqual(openings[0], openings[1], 'both corrections pivot with the same phrase — anti-repetition violated');
});

test('fewshots — LY register carries two graceful-correction exemplars, in Libyan phrasing', () => {
  const corrections = FEWSHOTS_LY.filter((e) => e.caller.trim().startsWith('لا سامحني'));
  assert.equal(corrections.length, 2, 'expected exactly two correction exemplars in FEWSHOTS_LY');
  const openings = corrections.map((e) => e.agent.split('،')[0].split('.')[0].trim());
  assert.notEqual(openings[0], openings[1], 'both LY corrections pivot with the same phrase — anti-repetition violated');
});

test('fewshots — the selected pack for a Tunisian call includes both correction exemplars', () => {
  const clinic = getClinic(CLINIC);
  const list = pickFewshots({ lang: 'ar', clinic, patientWaId: '' });
  const corrections = list.filter((e) => e.caller.trim().startsWith('لا سامحني'));
  assert.equal(corrections.length, 2);
});

test('fewshots — the selected pack for a Libyan call includes both correction exemplars', () => {
  const clinic = getClinic(CLINIC);
  const list = pickFewshots({ lang: 'ar', clinic, patientWaId: LIBYAN_WA });
  const corrections = list.filter((e) => e.caller.trim().startsWith('لا سامحني'));
  assert.equal(corrections.length, 2);
});

// ── the P2.1 budget: a plain booking turn stays under 6000 chars ────────────

test('P2.1 budget — a plain booking turn stays under 6000 chars (Tunisian register, multi-specialty clinic)', () => {
  const clinic = getClinic(CLINIC);
  const prompt = buildVoiceTurnPrompt({ clinic, lang: 'ar', nowStr: NOW, kbText: PLAIN_BOOKING_TURN, patientWaId: '' });
  assert.ok(prompt.length < 6000, `prompt was ${prompt.length} chars, budget is <6000`);
});

test('P2.1 budget — a plain booking turn stays under 6000 chars (Libyan register, same clinic)', () => {
  const clinic = getClinic(CLINIC);
  const prompt = buildVoiceTurnPrompt({
    clinic,
    lang: 'ar',
    nowStr: NOW,
    kbText: PLAIN_BOOKING_TURN,
    patientWaId: LIBYAN_WA,
  });
  assert.ok(prompt.length < 6000, `prompt was ${prompt.length} chars, budget is <6000`);
});

test('P2.1 budget — a plain booking turn stays under 6000 chars (cabinet/doctor persona, fixed specialty)', () => {
  const clinic = getClinic(CABINET);
  const prompt = buildVoiceTurnPrompt({ clinic, lang: 'ar', nowStr: NOW, kbText: PLAIN_BOOKING_TURN, patientWaId: '' });
  assert.ok(prompt.length < 6000, `prompt was ${prompt.length} chars, budget is <6000`);
});

test('P2.1 budget — French and English plain-booking turns are comfortably under budget too', () => {
  const clinic = getClinic(CLINIC);
  const fr = buildVoiceTurnPrompt({ clinic, lang: 'fr', nowStr: NOW, kbText: 'nom complet' });
  const en = buildVoiceTurnPrompt({ clinic, lang: 'en', nowStr: NOW, kbText: 'full name' });
  assert.ok(fr.length < 6000, `fr prompt was ${fr.length} chars`);
  assert.ok(en.length < 6000, `en prompt was ${en.length} chars`);
});

// ── the HONEST worst case (V8-D4 review) ─────────────────────────────────────
//
// "<6000" above is the diet's target for the COMMON case (a plain booking
// turn). It is not a ceiling on every turn: a caller who asks about hours AND
// price AND something the tenant's FAQ actually answers pulls the hours
// block, the pricing block (guardrail wording — imported, never trimmed) and
// a KB digest all at once. That combination is real (a caller genuinely can
// ask "what are your hours and how much, and do you take cards" in one
// breath) so it is measured and bounded here rather than only asserting the
// scenario that happens to be small. el-amen-sousse is the worst fixture in
// data/clinics.json (five specialties, a five-entry FAQ) and is used on
// purpose, not the smallest tenant.
const WORST_CASE_TURN = 'قداش سعر الكشفية بالدينار نهار الجمعة والدفع بالبطاقة'; // price + hours + an FAQ (payment) match at once

test('sanity: the worst-case fixture actually trips BOTH the hours and pricing gates', () => {
  assert.equal(needsHours(WORST_CASE_TURN), true);
  assert.equal(needsPricing(WORST_CASE_TURN), true);
});

test('HONEST CEILING — the worst realistic turn (hours + pricing + KB match) is bounded, not silently exceeded', () => {
  const clinic = getClinic(CLINIC); // el-amen-sousse: the largest fixture (5 specialties, 5-entry FAQ)
  const prompt = buildVoiceTurnPrompt({ clinic, lang: 'ar', nowStr: NOW, kbText: WORST_CASE_TURN, patientWaId: '' });
  // Measured 2026-08-02: 6888 chars. The ceiling below is that measurement plus
  // headroom for tenant-data drift (a longer clinic name, one more FAQ line),
  // NOT a target to design toward — see prompt.js's "THE HONEST CEILING" note.
  assert.ok(prompt.length < 7200, `worst-case prompt was ${prompt.length} chars, honest ceiling is <7200`);
  // And it must be MEASURABLY larger than the plain-booking case — if it ever
  // collapses to the same size, the conditional gating broke silently.
  const plain = buildVoiceTurnPrompt({ clinic, lang: 'ar', nowStr: NOW, kbText: PLAIN_BOOKING_TURN });
  assert.ok(prompt.length > plain.length, 'worst-case turn should be larger than the plain-booking turn');
});

// ── never conditional: NOISE_POLICY, safety, language lock still ride every turn ──

test('the never-conditional blocks (noise policy, medical safety, language lock) survive alongside D4', () => {
  const clinic = getClinic(CLINIC);
  const prompt = buildVoiceTurnPrompt({ clinic, lang: 'ar', nowStr: NOW, kbText: PLAIN_BOOKING_TURN });
  assert.match(prompt, /NOISE AND MULTIPLE VOICES/);
  assert.match(prompt, /MEDICAL SAFETY — ABSOLUTE/);
  assert.match(prompt, /LANGUAGE LOCK — ABSOLUTE/);
});
