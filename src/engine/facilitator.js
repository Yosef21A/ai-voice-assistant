// Facilitator mode (D2) — medical-tourism agencies. An agency has NO local
// calendar: the appointment flow is unreachable by design, and the
// conversation's goal is QUALIFICATION — procedure, origin, travel window,
// budget signal, an invitation to send the medical report/X-ray, and a
// contact. The reward the patient hears is the agency's promise: "نلقاولك
// أحسن عيادة ونرجعولك بعرض اليوم إن شاء الله" — a human returns with a
// tailored offer today.
//
// The classic flow below is the deterministic twin of the facilitator prompt
// rules (humanize/prompt.js): both write the SAME state fields the booking
// flow uses where they overlap (specialty, origin*, contact), plus
// travelWindow / procedureRaw / budgetAsked, so an LLM failure mid-dialogue
// degrades seamlessly and the lead snapshot (engine/index.js) reads one shape.
//
// State: convo.state = { flow: 'qualify', step, data } with steps
//   procedure → origin → window → contact → done
import { t } from './responses.js';
import { extractSpecialty, extractOrigin, extractContact } from './slots.js';
import { specialtyLabel } from './booking.js';
import { matchFaq, faqAnswer } from './faq.js';

const STEPS = ['procedure', 'origin', 'window', 'contact', 'done'];

function nextQualifyStep(data, h = {}) {
  if (!data.specialty && !data.procedureRaw) return 'procedure';
  if (!data.originCity && !data.originRaw) return 'origin';
  if (!data.travelWindow) return 'window';
  if (!data.contact && !h.contactSkipped) return 'contact';
  return 'done';
}

function promptForQualify(step, ctx) {
  const { clinic, lang } = ctx;
  switch (step) {
    case 'procedure':
      return t(lang, 'qualifyAskProcedure');
    case 'origin':
      return t(lang, 'qualifyAskOrigin');
    case 'window':
      return t(lang, 'qualifyAskWindow');
    case 'contact':
      return t(lang, 'qualifyAskContact');
    case 'done':
    default:
      return t(lang, 'qualifyDone', { agency: clinic.name });
  }
}

/** Opportunistic capture: fill whatever THIS message states, whatever the step. */
function captureFacts(ctx, data) {
  const { text, clinic } = ctx;
  if (!data.specialty) {
    const sp = extractSpecialty(text, clinic);
    if (sp) data.specialty = sp.id;
  }
  if (!data.originCity && !data.originRaw) {
    const o = extractOrigin(text);
    // "نحب نعمل زرع أسنان في تونس" names the DESTINATION, not the origin — a
    // mention of the agency's own country is never origin evidence. A named
    // city is; and when both co-occur ("من طرابلس … في تونس") the city wins
    // while the destination country is discarded.
    const country = o.country === clinic.country ? null : o.country;
    if (o.city || country) {
      data.originCity = o.city;
      data.originCountry = country;
      data.originRaw = o.raw;
    }
  }
  if (!data.contact) {
    const c = extractContact(text);
    if (c) data.contact = c;
  }
}

function advanceQualify(ctx, opts = {}) {
  const { convo } = ctx;
  const state = convo.state;
  const step = nextQualifyStep(state.data, state.h || {});
  state.step = step;
  const replies = [];
  if (opts.intro) replies.push(t(ctx.lang, 'qualifyIntro', { agency: ctx.clinic.name }));
  if (opts.note) replies.push(opts.note);
  replies.push(promptForQualify(step, ctx));
  return { intent: 'qualify', replies };
}

export function startQualify(ctx, opts = {}) {
  const { convo } = ctx;
  const prior = convo.state?.flow === 'qualify' ? convo.state.data || {} : {};
  const h = convo.state?.flow === 'qualify' ? convo.state.h || {} : {};
  convo.state = { flow: 'qualify', step: null, data: { ...prior }, h: { ...h } };
  captureFacts(ctx, convo.state.data);
  return advanceQualify(ctx, { intro: opts.intro !== false });
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.reask]  the turn's text was a DIGRESSION (e.g. a price
 *   ask) already answered by the caller — extract hard facts from it, but never
 *   consume it as the pending step's answer; just re-ask the pending question.
 */
export function continueQualify(ctx, opts = {}) {
  const { convo, text, clinic, lang } = ctx;
  const state = convo.state;
  const data = state.data;
  const h = (state.h = state.h || {});
  const step = state.step;

  // Every turn captures whatever it can, whatever the expected answer.
  captureFacts(ctx, data);

  if (opts.reask) {
    const pending = nextQualifyStep(data, h);
    if (pending === 'done' && step !== 'done') {
      state.step = 'done';
      return { intent: 'qualify', replies: [t(lang, 'qualifyDone', { agency: clinic.name })] };
    }
    state.step = pending;
    return { intent: 'qualify', replies: [promptForQualify(pending, ctx)] };
  }

  if (step === 'procedure' && !data.specialty && !data.procedureRaw) {
    // Free text is ALWAYS an acceptable procedure — an agency never gate-keeps
    // ("عملية قلب مفتوح" must qualify even if no registry entry matches).
    data.procedureRaw = String(text).slice(0, 120);
  }
  if (step === 'origin' && !data.originCity && !data.originRaw) {
    // The ANSWER to the origin question is origin by definition — accept it
    // raw even when no known city/country matches (same as the booking flow).
    const o = extractOrigin(text);
    data.originCity = o.city;
    data.originCountry = o.country;
    data.originRaw = o.raw || String(text).slice(0, 120);
  }
  if (step === 'window' && !data.travelWindow) {
    data.travelWindow = String(text).slice(0, 120);
  }
  if (step === 'contact' && !data.contact) {
    if (!h.contactRetried) {
      h.contactRetried = true;
      return { intent: 'qualify', replies: [t(lang, 'contactUnknown')] };
    }
    // Second miss: their WhatsApp number IS a contact — never lose the lead
    // over a formality.
    h.contactSkipped = true;
  }

  const done = nextQualifyStep(data, h) === 'done';
  if (done && step !== 'done') {
    state.step = 'done';
    return { intent: 'qualify', replies: [t(lang, 'qualifyDone', { agency: clinic.name })] };
  }
  if (step === 'done') {
    // Post-qualification chatter: answer from the KB when possible, else a
    // warm "the team is on it" — never restart the interview.
    const entry = matchFaq(text, clinic);
    if (entry) return { intent: 'faq', replies: [faqAnswer(entry, lang)] };
    return { intent: 'qualify', replies: [t(lang, 'qualifyFollowup')] };
  }
  return advanceQualify(ctx);
}

/**
 * The facilitator's answer to a price ask: a budget SIGNAL is captured, but no
 * figure is ever quoted — offers come from the partner clinics via the team
 * ("from" prices + human quote is the law, CLAUDE.md).
 */
export function handleFacilitatorPricing(ctx) {
  const { convo } = ctx;
  if (convo.state?.flow === 'qualify') {
    convo.state.data.budgetAsked = true;
    const note = t(ctx.lang, 'qualifyBudgetNote');
    // reask: the price question is a DIGRESSION — "قداش السعر؟" must never be
    // recorded as the travel window (D2 review finding).
    const cont = continueQualify(ctx, { reask: true });
    return { ...cont, replies: [note, ...cont.replies.slice(0, 1)] };
  }
  const start = startQualify(ctx, { intro: false });
  convo.state.data.budgetAsked = true;
  return { ...start, replies: [t(ctx.lang, 'qualifyBudgetNote'), ...start.replies.slice(-1)] };
}

/**
 * Build the lead snapshot the ingest layer persists. Null when the
 * conversation holds nothing lead-worthy yet.
 */
export function facilitatorLeadFrom(clinic, convo, lang) {
  const state = convo.state;
  if (!state || state.flow !== 'qualify') return null;
  const d = state.data || {};
  const procedure = d.specialty || null;
  const anything =
    procedure || d.procedureRaw || d.originCity || d.originRaw || d.contact || d.travelWindow;
  if (!anything) return null;
  const rich =
    !!(procedure || d.procedureRaw) &&
    !!(d.originCity || d.originRaw) &&
    (state.step === 'done' || !!d.contact);
  // Alert-once lives on the CONVERSATION record, not on state.h — a cancel
  // nulls the state, and a re-qualification in the same conversation merges
  // into the same open lead, so it must not re-ping the owner (D2 review).
  const alert = rich && !convo.facilitatorAlerted;
  if (alert) convo.facilitatorAlerted = true;
  return {
    procedure,
    procedureLabel: procedure ? specialtyLabel(clinic, procedure, lang) : d.procedureRaw || null,
    procedureRaw: d.procedureRaw || null,
    originCity: d.originCity || null,
    originCountry: d.originCountry || null,
    originRaw: d.originRaw || null,
    travelWindow: d.travelWindow || d.datetimeRaw || null,
    contact: d.contact || null,
    budgetAsked: !!d.budgetAsked,
    rich,
    alert,
  };
}

export { STEPS as QUALIFY_STEPS, nextQualifyStep };
