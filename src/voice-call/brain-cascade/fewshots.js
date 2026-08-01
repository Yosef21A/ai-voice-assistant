// THE DERJA FEW-SHOT PACK — "the highest-leverage naturalness fix" (V7
// amendment §2). Prompt rules tell a model what NOT to do; examples tell it how
// a Tunisian receptionist actually sounds. Every provider in the cascade gets
// the same pack, so a rotation to Cerebras or Groq mid-call does not change the
// person the caller is talking to.
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
//     doctor decides after the examination"), for noise (ask once, warmly), for
//     the two-strike degrade to chat, and for the goodbye that ends the call.
//
// REGISTER. Tunisian (`tn`) is the default because the pilot clinics are in
// Sousse. Libyan (`ly`) is a SEPARATE list, appended when the tenant's dialect
// config says so or when the caller's number is Libyan — the two registers
// share vocabulary but not everything ("شنوة" vs "شن هو", "برشة" vs "وايد"),
// and mixing them is the exact thing a native ear catches instantly.
//
// SOURCES. The tone is mined from src/engine/responses.js (the chat agent's own
// Tunisian voice, in production since V1) and from docs/P0-DERJA-SHEET.md — the
// replies the founder graded, with the invented prices stripped out.

/**
 * How many exchanges reach a prompt. More is not better: they cost TTFT and
 * they cost tokens on EVERY turn.
 *
 * V7-P2.1 cut this from 12 to 6 after the first live call metered ~3.8 k input
 * tokens per turn. Six is not a round number picked for tidiness: it is the
 * smallest set that still SHOWS every behaviour the block exists to teach —
 * the rhythm of a booking, the read-back recap, the "from" price, the refusal
 * to diagnose, the warm ask-again in noise, and the one-line goodbye.
 */
export const MAX_FEWSHOTS = 6;

/**
 * The six Tunisian exchanges that survive the diet, by index into FEWSHOTS_TN.
 * One rhythm exemplar, one recap, and the four that DEMONSTRATE a guardrail —
 * because a rule the model has only been told is a rule it negotiates with.
 */
const TN_CORE = Object.freeze([0, 4, 6, 7, 8, 11]);

/**
 * What a LIBYAN call keeps from the Tunisian pack once its own register is in:
 * the price guardrail and the no-diagnosis guardrail. The register rotates; the
 * guardrails never do.
 */
const TN_GUARDRAILS = Object.freeze([6, 7]);

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
  },
  {
    caller: 'نهار الخميس إذا ممكن، في الصباح.',
    agent: 'باهي، ثانية برك نشوفلك وقت نهار الخميس الصباح.',
    note: 'the filler is spoken BEFORE the tool call, never after — a silent lookup sounds like a dropped line',
  },
  {
    caller: 'وقتاش تحبني نجي؟',
    agent: 'عندي [الوقت المتاح] — يمشيك؟',
  },
  {
    caller: 'إي يمشيني.',
    agent: 'تمام. شنوة اسمك الكامل من فضلك؟',
  },
  {
    caller: 'محمد الهادي.',
    agent: 'مرسي. الموعد [التاريخ والساعة] باسم محمد الهادي — صحيح؟',
    note: 'the recap is read back word for word and answered with a plain yes/no before anything is written',
  },
  {
    caller: 'إي صحيح.',
    agent: 'مثبّت. رقم الموعد [المرجع]، ونستناوك [التاريخ والساعة].',
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
    caller: '… (حس برشة في الخلفية) … نحب … الأربعاء …',
    agent: 'سامحني، فما حس برشة — تنجم تعاود آخر حاجة؟',
    note: 'V6.2: address only the primary caller and ask once, warmly',
  },
  {
    caller: '… (ما زال ما يتسمعش) …',
    agent: 'ما تقلقش. نبعثلك رسالة هوني في الواتساب ونكملو كتابة؟',
    note: 'the two-strike rule: after twice unclear, offer the chat thread instead of a third "sorry?"',
  },
  {
    caller: 'نحب نحكي مع واحد من الفريق.',
    agent: 'أكيد. واحد من الفريق باش يجاوبك هوني في الواتساب. تحب حاجة أخرى؟',
  },
  {
    caller: 'لا شكرا، يعيشك.',
    agent: 'يعطيك الصحة، بالسلامة.',
    note: 'a person ends the call: one short farewell, then end_call — no recap, no "anything else today?"',
  },
]);

/**
 * Libyan register. Most callers on this corridor are Libyan, and a Tunisian
 * "برشة" where a Libyan says "وايد" is exactly the tell this pack exists to
 * remove. Kept short: register, not a second personality.
 */
export const FEWSHOTS_LY = Object.freeze([
  {
    caller: 'السلام عليكم، نبي نحجز موعد.',
    agent: 'وعليكم السلام، أهلا بيك. شن نهار يناسبك؟',
  },
  {
    caller: 'شن الأوقات المتوفرة نهار الأحد؟',
    agent: 'لحظة نتثبت من الأوقات نهار الأحد.',
  },
  {
    caller: 'أنا من طرابلس ونبي نجي لتونس، قداش تكلف؟',
    agent:
      'مرحبتين بيك. الأسعار تبدا من [السعر المذكور في معلومات العيادة]، والطبيب يحدد بالضبط بعد ما يشوف حالتك. نحجزولك موعد؟',
  },
  {
    caller: 'ولدي عندو سخانة من الليلة، نستنى الموعد ولا نجي توا؟',
    agent:
      'كان الحالة مستعجلة امشي توا لأقرب استعجالي ولا اتصل بالطوارئ. ولا تحب نثبتلك موعد قريب؟',
    note: 'emergency-adjacent, not an emergency: never diagnose, never dismiss, point at urgences AND offer the slot',
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
  // Libyan four plus the two Tunisian exchanges that carry a guardrail; a
  // Tunisian caller hears the Tunisian core. Rotating the pack turn by turn
  // would change the agent's voice mid-call, which is precisely the tell this
  // pack exists to remove.
  const list = libyan ? [...FEWSHOTS_LY, ...pick(FEWSHOTS_TN, TN_GUARDRAILS)] : pick(FEWSHOTS_TN, TN_CORE);
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
