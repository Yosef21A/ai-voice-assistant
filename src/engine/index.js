// Conversation engine. Transport-agnostic: it consumes a normalized inbound
// message and returns replies + any created appointment. All state is persisted
// through the injected store; free-form phrasing goes through the injected LLM
// provider (mock by default). Booking is fully deterministic.
import { detectLanguage, resolveLanguage } from './language.js';
import { detectIntent } from './intent.js';
import { startBooking, continueBooking, cancelBooking, specialtyLabel } from './booking.js';
import { extractSpecialty } from './slots.js';
import { matchFaq, faqAnswer } from './faq.js';
import { t } from './responses.js';
import { normalizeDigits } from './text.js';
import { handleLlmTurn } from './humanize/index.js';
import { snapshotCritical, markVoiceProvisional } from './voiceSlots.js';
import { hasDoctorPersona, doctorName, isFacilitator } from './tenantProfile.js';
import {
  startQualify,
  continueQualify,
  handleFacilitatorPricing,
  facilitatorLeadFrom,
} from './facilitator.js';

// F9 state decay: a booking flow idle longer than this keeps its slots but
// drops the "expected answer" lock — the next message is evaluated fresh.
const STALE_FLOW_MS = 2 * 60 * 60 * 1000;

/**
 * @param {object} deps
 * @param {object} deps.store     store instance (src/store)
 * @param {object} deps.provider  LLM provider (src/llm)
 * @param {object} deps.config
 */
export function createEngine({ store, provider, config }) {
  /**
   * @param {object} inbound  normalized message: { channel, from, text, phoneNumberId, tenantId }
   * @param {object} [opts]   { now } — inject a reference time for reproducibility
   */
  async function handleMessage(inbound, opts = {}) {
    const now = opts.now ? new Date(opts.now) : new Date();

    const clinic =
      store.getClinicByPhoneNumberId(inbound.phoneNumberId) ||
      store.getClinicById(inbound.tenantId) ||
      store.getDefaultClinic();

    store.upsertPatient(clinic.id, inbound.from, { lastSeen: now.toISOString() });
    const convo =
      store.getConversation(clinic.id, inbound.from) ||
      store.newConversation(clinic.id, inbound.from);

    const detected = detectLanguage(inbound.text);
    const lang = resolveLanguage(detected, convo.lang, clinic);
    convo.lang = lang;
    convo.messages.push({ role: 'user', text: inbound.text, ts: now.toISOString() });

    const ctx = {
      inbound,
      // Digit normalization is defensive here (ingest paths normalize too):
      // every parser downstream must see ASCII digits (live failure F4).
      text: normalizeDigits(String(inbound.text || '')).trim(),
      clinic,
      convo,
      lang,
      store,
      provider,
      config,
      now,
      // V1: how this turn's TEXT reached us. 'voice' means it is a machine
      // transcript of a voice note, not something the patient typed — the
      // humility guardrail (voiceSlots.js) keys off this. The engine stays
      // transport-agnostic; it just consumes two more fields on the normalized
      // inbound shape.
      source: inbound.source === 'voice' ? 'voice' : 'text',
      voice: inbound.voice || null,
      // F9: mark a stale booking flow so route() releases the step lock.
      staleFlow:
        convo.state?.flow === 'booking' &&
        convo.updatedAt &&
        now.getTime() - new Date(convo.updatedAt).getTime() > STALE_FLOW_MS,
    };

    // ── mode dispatch (P2-HUMANIZE) ──────────────────────────────────────────
    // llm: the provider plans the turn, the deterministic executor writes.
    // Any LLM failure (timeout, quota, malformed output) falls back to the
    // classic state machine — THE BOT NEVER GOES SILENT.
    const tenantMode = clinic.conversationMode || config.conversationMode;
    const useLlm = tenantMode === 'llm' && typeof provider.generateStructured === 'function';
    let result = null;
    if (useLlm) {
      try {
        result = await handleLlmTurn(ctx);
      } catch (err) {
        result = null; // classic fallback below
        try {
          store.events
            ?.append?.(clinic.id, {
              type: 'llm.fallback',
              actor: 'engine',
              conversationId: convo.id,
              payload: { error: String(err?.message || err).slice(0, 200) },
            })
            ?.catch?.(() => {});
        } catch {
          /* audit is best-effort */
        }
      }
    }
    const beforeCritical = snapshotCritical(convo.state?.data);
    if (!result) result = await route(ctx);

    // Writer-agnostic BACKSTOP for the voice humility guardrail. The executor
    // marks its own writes, but the CLASSIC state machine (continueBooking /
    // startBooking) writes slots directly and is reached on any LLM failure —
    // and any writer added later would be too. Diffing here means nobody has to
    // remember to call markVoiceProvisional at a new assignment site.
    if (convo.state?.data) markVoiceProvisional(ctx, convo.state.data, beforeCritical);

    const replies = result.replies || [];
    for (const r of replies) convo.messages.push({ role: 'assistant', text: r, ts: now.toISOString() });
    // The llm executor may re-detect the language (Arabizi → 'ar').
    const finalLang = result.lang || lang;
    convo.lang = finalLang;
    convo.updatedAt = now.toISOString();
    store.saveConversation(convo);
    if (result.appointment) {
      const a = result.appointment;
      // Patient memory (P2-HUMANIZE §2.10): only defined fields — the JSON
      // adapter Object.assigns the patch, so nulls would clobber stored facts.
      const patch = { name: a.patientName, lastAppointmentRef: a.ref };
      if (a.originCity) patch.originCity = a.originCity;
      if (a.originCountry) patch.originCountry = a.originCountry;
      if (a.contact) patch.contact = a.contact;
      if (finalLang) patch.lang = finalLang;
      store.upsertPatient(clinic.id, inbound.from, patch);
    }

    // Facilitator (D2): every turn exposes the current qualification snapshot —
    // the ingest layer persists it as the ONE open lead per conversation and
    // pings the owner exactly once when it becomes rich. Computed AFTER the
    // turn so it sees this turn's captures, BEFORE save so the alert-once flag
    // persists.
    const facilitatorLead = isFacilitator(clinic)
      ? facilitatorLeadFrom(clinic, convo, finalLang)
      : null;
    if (facilitatorLead) store.saveConversation(convo);

    return {
      clinicId: clinic.id,
      clinicName: clinic.name,
      lang: finalLang,
      intent: result.intent,
      reply: replies.join('\n\n'),
      replies,
      appointment: result.appointment || null,
      handoff: result.handoff || null,
      facilitatorLead,
      state: convo.state || null,
      // P2-B: false only when the bot had NO real answer (unknown intent, or a
      // FAQ ask that matched nothing) — feeds the "bot didn't know" queue.
      knew: result.knew !== false,
      // P2-HUMANIZE pass-throughs for the ingest layer (lead capture / owner
      // alerts). Absent in classic mode.
      gap: result.gap || null,
      adminNotify: result.adminNotify || null,
      kbQuestion: result.kbQuestion || null,
      guardrailViolations: result.guardrailViolations || null,
    };
  }

  return { handleMessage };
}

// ── routing ─────────────────────────────────────────────────────────────────
async function route(ctx) {
  const { convo, text } = ctx;
  const gi = detectIntent(text);

  // Facilitator tenants (D2): the appointment flow is UNREACHABLE — an agency
  // has no local calendar. Booking/pricing intents become qualification.
  if (isFacilitator(ctx.clinic)) return routeFacilitator(ctx, gi);

  // An active booking flow captures the turn, except for explicit interrupts.
  if (convo.state?.flow === 'booking') {
    // cancel / handoff are interrupts in BOTH fresh and stale flows — a stale
    // flow must still be cancellable, or the patient hears "nothing to cancel"
    // while a zombie flow re-captures the next message (F9 regression).
    if (gi.intent === 'cancel') return cancelBooking(ctx);
    if (gi.intent === 'human_handoff') return handleHandoff(ctx);
    // A live (non-stale) flow captures the turn on its current step.
    if (!ctx.staleFlow) return continueBooking(ctx);
    // Stale flow (idle >2h, F9): the "expected answer" lock is released. A
    // restated booking intent resumes (slots carried over by startBooking);
    // anything else is evaluated fresh through the switch below.
    if (gi.intent === 'book_appointment') return startBooking(ctx);
  }

  switch (gi.intent) {
    case 'human_handoff':
      return handleHandoff(ctx);
    case 'cancel':
      // A lingering (stale) flow is cleared; with no flow, nothing to cancel.
      return convo.state?.flow === 'booking'
        ? cancelBooking(ctx)
        : { intent: 'cancel', replies: [t(ctx.lang, 'nothingToCancel')] };
    case 'pricing_quote':
      return handlePricing(ctx);
    case 'book_appointment':
      return startBooking(ctx);
    case 'travel_help':
      return handleTravel(ctx);
    case 'faq':
      return handleFaq(ctx);
    case 'greeting':
      return handleGreeting(ctx);
    default:
      return handleFallback(ctx);
  }
}

// Facilitator routing (D2): same interrupts and knowledge paths as a clinic,
// but every "I want treatment / how much" road leads to qualification.
async function routeFacilitator(ctx, gi) {
  const { convo, lang } = ctx;

  if (gi.intent === 'human_handoff') return handleHandoff(ctx);
  if (gi.intent === 'cancel') {
    if (convo.state?.flow === 'qualify') {
      convo.state = null;
      return { intent: 'cancel', replies: [t(lang, 'cancelled')] };
    }
    return { intent: 'cancel', replies: [t(lang, 'nothingToCancel')] };
  }
  if (gi.intent === 'pricing_quote') return handleFacilitatorPricing(ctx);

  // A live qualification captures the turn (whatever step it recorded — an
  // LLM-written state carries no step and continueQualify self-heals).
  if (convo.state?.flow === 'qualify') return continueQualify(ctx);

  switch (gi.intent) {
    case 'book_appointment':
      return startQualify(ctx);
    case 'travel_help':
      return handleTravel(ctx);
    case 'faq':
      return handleFaq(ctx);
    case 'greeting':
      return {
        intent: 'greeting',
        replies: [t(lang, 'greetingFacilitator', { agency: ctx.clinic.name })],
      };
    default: {
      // An unknown message that names a procedure IS a qualification opener
      // ("نحب نعمل زرع أسنان في تونس") — never a dead "I didn't understand".
      const sp = extractSpecialty(ctx.text, ctx.clinic);
      if (sp) return startQualify(ctx);
      return handleFallback(ctx);
    }
  }
}

// ── intent handlers ─────────────────────────────────────────────────────────
function handleGreeting(ctx) {
  const { clinic, lang } = ctx;
  // Cabinet persona (D1): the bot introduces itself as the doctor's assistant.
  if (hasDoctorPersona(clinic)) {
    return {
      intent: 'greeting',
      replies: [t(lang, 'greetingCabinet', { cabinet: clinic.name, doctor: doctorName(clinic, lang) })],
    };
  }
  return {
    intent: 'greeting',
    replies: [t(lang, 'greeting', { clinic: clinic.name })],
  };
}

function handleHandoff(ctx) {
  const { clinic, lang } = ctx;
  // Leaving any active flow intact is intentional: a human takes over from here.
  const reply = hasDoctorPersona(clinic)
    ? t(lang, 'handoffCabinet', { doctor: doctorName(clinic, lang), phone: clinic.handoff?.phone || '' })
    : t(lang, 'handoff', { name: clinic.handoff?.name || '', phone: clinic.handoff?.phone || '' });
  return {
    intent: 'human_handoff',
    replies: [reply],
    handoff: { clinicId: clinic.id, ...clinic.handoff },
  };
}

function handlePricing(ctx) {
  const { clinic, lang, text } = ctx;
  const sp = extractSpecialty(text, clinic);
  if (sp && clinic.pricing?.[sp.id]) {
    const p = clinic.pricing[sp.id];
    return {
      intent: 'pricing_quote',
      replies: [
        t(lang, 'pricingOne', {
          clinic: clinic.name,
          specialty: specialtyLabel(clinic, sp.id, lang),
          consult: p.consultation_eur,
          low: p.estimate_eur[0],
          high: p.estimate_eur[1],
        }),
      ],
    };
  }
  const lines = (clinic.specialties || [])
    .filter((s) => clinic.pricing?.[s.id])
    .map((s) => {
      const p = clinic.pricing[s.id];
      const label = specialtyLabel(clinic, s.id, lang);
      return `• ${label}: ~${p.consultation_eur}€ / ${p.estimate_eur[0]}€–${p.estimate_eur[1]}€`;
    })
    .join('\n');
  return {
    intent: 'pricing_quote',
    replies: [t(lang, 'pricingList', { clinic: clinic.name, lines })],
    // A pricing ask answered with an EMPTY list is a didn't-know turn: the
    // clinic skipped the pricing step, and the owner should hear about it.
    knew: lines.length > 0,
  };
}

function handleTravel(ctx) {
  const { clinic, lang } = ctx;
  const tr = clinic.travel || {};
  return {
    intent: 'travel_help',
    replies: [
      t(lang, 'travel', {
        clinic: clinic.name,
        airports: tr.airports || '-',
        transfer: tr.transfer || '-',
        accommodation: tr.accommodation || '-',
        companion: tr.companion || '-',
        visa: tr.visa || '-',
      }),
    ],
    // All-placeholder travel info (module unconfigured) is a didn't-know turn.
    knew: Object.keys(tr).length > 0,
  };
}

async function handleFaq(ctx) {
  const { clinic, lang, text } = ctx;
  const entry = matchFaq(text, clinic);
  if (entry) {
    // Route the KB answer through the provider so voice stays consistent
    // (the mock provider passes it straight through).
    const out = await safeGenerate(ctx, {
      task: 'faq_answer',
      context: { answer: faqAnswer(entry, lang) },
    });
    return { intent: 'faq', replies: [out.text || faqAnswer(entry, lang)] };
  }
  return { intent: 'faq', replies: [t(lang, 'faqFallback')], knew: false };
}

async function handleFallback(ctx) {
  const { clinic, lang, text } = ctx;
  // The KB gets first refusal (P2-B): owner-trained answers live in clinic.faq
  // (merged by src/store/kbLive.js), so a question the bot once missed — which
  // rarely carries an intent keyword — is answered here instead of falling to
  // the generic provider reply. This IS the training loop closing.
  const entry = matchFaq(text, clinic);
  if (entry) {
    const out = await safeGenerate(ctx, {
      task: 'faq_answer',
      context: { answer: faqAnswer(entry, lang) },
    });
    return { intent: 'faq', replies: [out.text || faqAnswer(entry, lang)] };
  }
  const out = await safeGenerate(ctx, { task: 'fallback' });
  return { intent: 'unknown', replies: [out.text], knew: false };
}

// Never let a provider error break the conversation.
async function safeGenerate(ctx, req) {
  try {
    const out = await ctx.provider.generate({
      lang: ctx.lang,
      userText: ctx.text,
      clinic: ctx.clinic,
      ...req,
    });
    if (out && out.text) return out;
  } catch {
    /* fall through */
  }
  return { text: t(ctx.lang, 'faqFallback'), provider: 'static-fallback' };
}
