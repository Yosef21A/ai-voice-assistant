// Conversation policies for the LLM-led flow (P2-HUMANIZE §2): never-repeat,
// two-strike confusion, intent mapping for analytics/detectors, and the
// per-language fallback text bank. Pure helpers — no I/O.
import { detectIntent } from '../intent.js';

/** Collapse whitespace + trim so cosmetic differences don't defeat the check. */
export function normalizeForCompare(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** Last N assistant texts from the embedded transcript, newest first. */
export function lastAssistantTexts(convo, n = 2) {
  const out = [];
  const msgs = convo?.messages || [];
  for (let i = msgs.length - 1; i >= 0 && out.length < n; i--) {
    if (msgs[i]?.role === 'assistant') out.push(normalizeForCompare(msgs[i].text));
  }
  return out;
}

/** True when every candidate bubble already appeared as a recent bot message. */
export function isRepeat(convo, replies) {
  const prev = new Set(lastAssistantTexts(convo, 2));
  if (!prev.size) return false;
  const cand = (replies || []).map(normalizeForCompare).filter(Boolean);
  return cand.length > 0 && cand.every((r) => prev.has(r));
}

// Different-angle clarifications with a human offer — used when the LLM (or a
// template) would otherwise repeat itself (§2.8: never send the same
// clarification twice).
const VARIATIONS = {
  ar: [
    'خليني نعاونك بطريقة أخرى 🙌 قلّي بالضبط شنوة تحب: موعد، سعر، سؤال طبي عام، ولا حاجة أخرى؟',
    'باش ما نضيعوش وقتك: تحب نطلبلك واحد من الفريق يجاوبك هنا في المحادثة؟ ولا نكملو مع بعضنا — قلّي شنوة في بالك.',
  ],
  fr: [
    "Reprenons autrement 🙌 Dites-moi simplement ce qu'il vous faut : un rendez-vous, un tarif, une question — je m'en occupe.",
    "Pour ne pas tourner en rond : je peux demander à un membre de l'équipe de vous répondre ici même. Sinon, dites-moi ce que vous avez en tête.",
  ],
  en: [
    "Let's try this differently 🙌 Just tell me what you need — an appointment, a price, a question — and I'll take it from there.",
    "So we don't go in circles: I can ask a team member to reply to you right here. Or tell me in your own words what you're after.",
  ],
};

/** Pick a variation, cycling through the bank via the conversation's counter. */
export function pickVariation(lang, h) {
  const bank = VARIATIONS[lang] || VARIATIONS.fr;
  const i = (h.variant = ((h.variant ?? -1) + 1) % bank.length);
  return bank[i];
}

/**
 * Map an executed plan onto the classic intent vocabulary so P2-A stats
 * (funnel/unknownRate/topQuestions) and the hot-lead detector keep working.
 */
export function mapIntent({ plan, ctx, slotsTouched, bookingActive }) {
  const actions = new Set(plan.actions);
  if (actions.has('cancel_flow')) return 'cancel';
  if (actions.has('handoff_request')) return 'human_handoff';
  const gi = detectIntent(ctx.text);
  // pricing/travel keep their labels: hot-lead trigger 1+2 key on them.
  if (gi.intent === 'pricing_quote') return 'pricing_quote';
  if (gi.intent === 'travel_help') return 'travel_help';
  if (
    actions.has('confirm_booking') ||
    actions.has('propose_summary') ||
    actions.has('specialty_gap') ||
    slotsTouched ||
    bookingActive
  ) {
    return 'book_appointment';
  }
  if (actions.has('answer_faq')) return 'faq';
  if (actions.has('kb_gap')) return 'unknown';
  return gi.intent; // greeting / faq / unknown / …
}
