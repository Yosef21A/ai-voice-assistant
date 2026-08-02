// THE DERJA FEW-SHOT PACK — "the highest-leverage naturalness fix" (V7
// amendment §2), rebuilt for V8-D4 (founder: "I want him to be more fluent").
// Prompt rules tell a model what NOT to do; examples tell it how a Tunisian
// receptionist actually sounds. Every provider in the cascade gets the same
// pack, so a rotation to Cerebras or Groq mid-call does not change the person
// the caller is talking to.
//
// THREE LAWS THIS FILE OBEYS, and they are not style preferences:
//
//  1. **NO REAL NUMBERS, EVER.** An exemplar that says "الكشفية 50 دينار"
//     teaches the model that 50 dinars is a fact about this clinic. It is not —
//     the price lives in the tenant's own facts block, and inventing one is the
//     single worst thing this agent can do on a phone call (P0 grading sheet:
//     "any reply that names a consultation fee made it up — Correct? = 0").
//     So every figure here is a bracketed PLACEHOLDER and the block header says
//     so in the model's own instructions.
//  2. **ONE QUESTION PER TURN, TWO SHORT SENTENCES.** Every agent line below is
//     something a person could say in one breath. The turn-discipline rule in
//     the prompt is what the model is told; this is what it is shown.
//  3. **THE GUARDRAILS ARE DEMONSTRATED, not just declared.** There is an
//     exemplar for a symptom (no diagnosis), for a price (from-figure + "the
//     doctor decides after the examination"), and — new at V8-D4 — for a
//     caller who corrects themselves mid-call.
//
// REGISTER. Tunisian (`tn`) is the default because the pilot clinics are in
// Sousse. Libyan (`ly`) is a SEPARATE list, appended when the tenant's dialect
// config says so or when the caller's number is Libyan — the two registers
// share vocabulary but not everything ("شنوة" vs "شن هو", "برشة" vs "وايد"),
// and mixing them is the exact thing a native ear catches instantly. At V8-D4
// the Libyan list became SELF-SUFFICIENT (its own rhythm, read-back, guardrail
// and correction exemplars) instead of borrowing two Tunisian guardrail lines —
// see the note on `pickFewshots` below for why the borrow was retired.
//
// SOURCES (V8-D4 mining pass). `data/runtime/messages.json` carries the
// founder's own live test calls (`type:'call'`, `body.call.transcript`) plus
// real WhatsApp chat threads. Two things came out of reading all of them
// end to end, cleaned of PII (the founder's own name and number, replaced with
// the file's existing bracket-placeholder convention — nothing else in this
// file was ever anything but a placeholder):
//   • the phrase actually deployed for "it's noisy, say that again" —
//     `سامحني، فما حس برشة — تنجم تعاود آخر حاجة؟` (this file's own noise
//     exemplar, word for word, and also `buildUnclearText` in ./prompt.js) —
//     appeared TWICE, VERBATIM, back to back, in one real call (seq 153,
//     2026-08-01). That is the anti-repetition bug this tier exists to kill,
//     caught in the founder's own transcript, not invented for a test.
//   • a real chat reply's smooth-pivot phrasing — "ولا يهمك سي [الاسم]، جراحة
//     تجميل الصدر تدخل تحت جراحة التجميل عندنا ✅. باش نشوفلك أقرب موعد متوفر
//     فوراً، شنوة نهار ووقتاش تحب بالضبط؟" (seq 81) — is the register the two
//     new correction exemplars below are built from: acknowledge the change
//     warmly ("ولا يهمك" / "ماكاش مشكلة"), never re-state the wrong slot, go
//     straight to the new option and end on one question.
// A third finding shaped the PROMPT, not this file: the same live call also
// spoke a filler ("ثانية برك") stitched onto the tail of an already-decided
// handoff sentence — disfluency on what was functionally a closing turn. That
// is exactly the emergency/confirmation exception V8-D4 adds in ./prompt.js
// (HUMAN_POLISH_POLICY): fillers are for while you are still deciding, never
// once the call has landed on an outcome.
// The rest of the tone is mined from src/engine/responses.js (the chat agent's
// own Tunisian voice, in production since V1) and docs/P0-DERJA-SHEET.md — the
// replies the founder graded, with the invented prices stripped out.

/**
 * How many exchanges reach a prompt. More is not better: they cost TTFT and
 * they cost tokens on EVERY turn.
 *
 * V7-P2.1 cut this from 12 to 6 after the first live call metered ~3.8 k input
 * tokens per turn. Six is not a round number picked for tidiness: it is the
 * smallest set that still SHOWS every behaviour the block exists to teach —
 * the rhythm of a booking, the read-back recap, the "from" price, the refusal
 * to diagnose, and (V8-D4) a graceful correction. Two behaviours that used to
 * hold a seat — the noise ask-again and the goodbye — were retired from the
 * selection, not deleted: NOISE_POLICY in ./prompt.js already quotes the
 * ask-again line verbatim, and voiceStyleBlock already lists the sign-off
 * options, so a dedicated exemplar for either was teaching the model something
 * it had already been told twice.
 */
export const MAX_FEWSHOTS = 6;

/**
 * The six Tunisian exchanges that survive the diet, by index into FEWSHOTS_TN:
 * the greeting rhythm, the read-back recap, the two guardrails a caller will
 * actually test (price, diagnosis), and — new at V8-D4 — a time correction and
 * a specialty correction, each pivoting with a DIFFERENT acknowledgement
 * phrase on purpose: the exemplars model the anti-repetition rule, not just
 * the correction-handling one.
 */
const TN_CORE = Object.freeze([0, 1, 2, 3, 4, 5]);

const pick = (list, indexes) => indexes.map((i) => list[i]).filter(Boolean);

/**
 * Tunisian register. `caller` → `agent`, in the order a real call goes.
 * Bracketed placeholders are never spoken as-is: the header instruction below
 * tells the model to substitute the real value from the facts block.
 */
export const FEWSHOTS_TN = Object.freeze([
  {
    caller: 'عسلامة، نحب نحجز موعد.',
    agent: 'عسلامة وأهلا بيك. أي نهار يريّحك؟',
    note: 'the rhythm exemplar: acknowledge the greeting, then end on the one question — no filler needed, nothing to look up yet',
  },
  {
    caller: 'محمد الهادي.',
    agent: 'مرسي. الموعد [التاريخ والساعة] باسم محمد الهادي — صحيح؟',
    note: 'D4 read-back rule: ONLY the exact data (name + slot) is repeated, word for word, before anything is written',
  },
  {
    caller: 'قداش تسوى الكشفية؟',
    agent:
      'الكشفية تبدا من [السعر المذكور في معلومات العيادة]، والطبيب هو اللي يحدد بالضبط بعد الفحص. تحب نحجزلك موعد؟',
    note: 'a "from" figure, then the honest limit — never an exact or personalized price',
  },
  {
    caller: 'عندي وجيعة في ظهري من أسبوع، شنوة عندي؟',
    agent:
      'سامحني، ما ننجمش نشخّص — هذا شغل الطبيب بعد ما يعاينك. تحب نلقالك أقرب موعد؟',
    note: 'never names a condition, never reassures, never dismisses — it offers the appointment',
  },
  {
    caller: 'لا سامحني، ما نجمش الثلاثاء، تنجملي الأربعاء الصباح؟',
    agent: 'ولا يهمك، نبدلها. عندي [الوقت المتاح] — يعجبك؟',
    note: 'V8-D4 correction #1 (mined pivot phrase "ولا يهمك"): no scolding, no re-stating the wrong slot, straight to stage_booking again and a fresh recap',
  },
  {
    caller: 'لا سامحني، ماهوش عظام، نحب طب الأسنان.',
    agent: 'ماكاش مشكلة. عندي [الوقت المتاح] لطب الأسنان — يناسبك؟',
    note: 'V8-D4 correction #2: same graceful pivot, a DIFFERENT acknowledgement phrase than correction #1 on purpose — anti-repetition, demonstrated not just declared',
  },
]);

/**
 * Libyan register. Most callers on this corridor are Libyan, and a Tunisian
 * "برشة" where a Libyan says "وايد" is exactly the tell this pack exists to
 * remove. Self-sufficient at V8-D4: its own rhythm, read-back, guardrail
 * (price/travel + the emergency-adjacent case) and both correction exemplars,
 * in Libyan phrasing throughout — six exemplars, one register, no seams.
 */
export const FEWSHOTS_LY = Object.freeze([
  {
    caller: 'السلام عليكم، نبي نحجز موعد.',
    agent: 'وعليكم السلام، أهلا بيك. شن نهار يناسبك؟',
  },
  {
    caller: 'اسمي محمد الطرابلسي.',
    agent: 'تمام. الموعد [التاريخ والساعة] باسم محمد الطرابلسي — صح كذا؟',
    note: 'D4 read-back rule in Libyan register: "صح كذا؟" not the Tunisian "صحيح؟"',
  },
  {
    caller: 'أنا من طرابلس ونبي نجي لتونس، قداش تكلف؟',
    agent: 'الأسعار تبدا من [السعر المذكور في معلومات العيادة]، والطبيب يحدد بعد الفحص. نحجزولك موعد؟',
  },
  {
    caller: 'ولدي عندو سخانة من الليلة، نستنى الموعد ولا نجي توا؟',
    agent: 'كان مستعجلة امشي لأقرب استعجالي ولا اتصل بالطوارئ. نثبتلك موعد قريب؟',
    note: 'emergency-adjacent, not an emergency: never diagnose, never dismiss, point at urgences AND offer the slot',
  },
  {
    caller: 'لا سامحني، مو الثلاثاء، نبي الأربعاء الصبح.',
    agent: 'ما عليها، نبدلها. عندي [الوقت المتاح] — يوافقك؟',
    note: 'V8-D4 correction #1, Libyan register ("ما عليها" not the Tunisian "ولا يهمك")',
  },
  {
    caller: 'لا سامحني، مو عظام، نبي طب الأسنان.',
    agent: 'تمام، نصلحها. عندي [الوقت المتاح] لطب الأسنان — يناسبك؟',
    note: 'V8-D4 correction #2, a different pivot phrase than correction #1 above',
  },
]);

/** French callers exist too — same discipline, three lines is enough. */
export const FEWSHOTS_FR = Object.freeze([
  { caller: 'Bonjour, je voudrais un rendez-vous.', agent: 'Bonjour et bienvenue. Quel jour vous arrange ?' },
  {
    caller: "C'est combien la consultation ?",
    agent:
      "À partir de [le tarif indiqué dans les informations], et le médecin fixe le montant exact après l'examen. Je vous prends un rendez-vous ?",
  },
  { caller: 'Merci, au revoir.', agent: 'Bonne journée, au revoir.' },
]);

export const FEWSHOTS_EN = Object.freeze([
  { caller: 'Hi, I need an appointment.', agent: "Hello, welcome. What day works for you?" },
  {
    caller: 'How much is a consultation?',
    agent:
      'From [the price listed in the clinic facts], and the doctor sets the exact amount after the examination. Shall I book you in?',
  },
  { caller: 'Thanks, bye.', agent: 'Have a good day, goodbye.' },
]);

/** True when this tenant (or this caller) should hear the Libyan register. */
export function isLibyanRegister({ clinic, patientWaId } = {}) {
  const dialect = String(clinic?.dialect || clinic?.config?.dialect || '').toLowerCase();
  if (/liby|ليبي|ar-ly/.test(dialect)) return true;
  const country = String(clinic?.country || '').toLowerCase();
  // A Libyan CLINIC serves Libyan callers; a Tunisian clinic on the corridor
  // does not switch register for everyone just because one caller dialled in.
  if (/libya|ليبيا/.test(country)) return true;
  // +218 is Libya. The caller's own number is the strongest signal there is.
  return /^\+?218/.test(String(patientWaId || ''));
}

/**
 * Pick the exemplar list for one call.
 *
 * V8-D4 CHANGE: the Libyan branch used to be `[...FEWSHOTS_LY, ...pick(
 * FEWSHOTS_TN, TN_GUARDRAILS)]` — four Libyan lines plus two borrowed Tunisian
 * guardrail lines, capped at six. Now that FEWSHOTS_LY carries six exemplars
 * of its own (including its own price and emergency-adjacent guardrails in
 * Libyan phrasing), the borrow is not just unneeded, it would have been
 * silently DROPPED by the six-item cap anyway — `[...6 Libyan, ...2 Tunisian]
 * .slice(0, 6)` never reaches the Tunisian tail. Retiring the borrow keeps the
 * behaviour honest: a Libyan caller now hears Libyan phrasing end to end,
 * never a Tunisian guardrail line mixed in.
 *
 * @param {object} p
 * @param {string} [p.lang] 'ar' | 'fr' | 'en'
 * @param {object} [p.clinic]
 * @param {string} [p.patientWaId]
 * @returns {Array<{caller:string, agent:string, note?:string}>}
 */
export function pickFewshots({ lang = 'ar', clinic, patientWaId } = {}) {
  if (lang === 'fr') return [...FEWSHOTS_FR];
  if (lang === 'en') return [...FEWSHOTS_EN];
  const libyan = isLibyanRegister({ clinic, patientWaId });
  // THE ROTATION IS PER REGISTER, NOT PER TURN. A Libyan caller hears the
  // Libyan six; a Tunisian caller hears the Tunisian core. Rotating the pack
  // turn by turn would change the agent's voice mid-call, which is precisely
  // the tell this pack exists to remove.
  const list = libyan ? [...FEWSHOTS_LY] : pick(FEWSHOTS_TN, TN_CORE);
  return list.slice(0, MAX_FEWSHOTS);
}

/**
 * Render the pack as a prompt block. The header is not decoration: without the
 * placeholder warning a model will happily read "[السعر المذكور…]" out loud, or
 * worse, replace it with a number it made up.
 *
 * THE `note` FIELDS ARE FOR HUMANS, NOT FOR THE MODEL (V7-P2.1). They explain
 * to a reader of this file WHY each exemplar is shaped the way it is; shipping
 * them re-stated the prompt's own rules a second time, in English, on every
 * single turn. The exemplar already demonstrates the behaviour — that is the
 * entire premise of a few-shot pack.
 *
 * @param {object} p  same shape as pickFewshots
 * @returns {string} '' when there is nothing to show
 */
export function buildFewshotBlock({ lang = 'ar', clinic, patientWaId } = {}) {
  const list = pickFewshots({ lang, clinic, patientWaId });
  if (!list.length) return '';
  const lines = list.map((ex) => `CALLER: ${ex.caller}\nYOU: ${ex.agent}`);
  return `HOW YOU SOUND — copy the RHYTHM, never the content. [brackets] are PLACEHOLDERS: never say one out loud, never invent what goes in it — every price, time, date and reference comes from the facts above or from a tool result.

${lines.join('\n\n')}`;
}

export default buildFewshotBlock;
