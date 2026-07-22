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
      text: String(inbound.text || '').trim(),
      clinic,
      convo,
      lang,
      store,
      provider,
      config,
      now,
    };

    const result = await route(ctx);

    const replies = result.replies || [];
    for (const r of replies) convo.messages.push({ role: 'assistant', text: r, ts: now.toISOString() });
    convo.updatedAt = now.toISOString();
    store.saveConversation(convo);
    if (result.appointment) {
      store.upsertPatient(clinic.id, inbound.from, {
        name: result.appointment.patientName,
        lastAppointmentRef: result.appointment.ref,
      });
    }

    return {
      clinicId: clinic.id,
      clinicName: clinic.name,
      lang,
      intent: result.intent,
      reply: replies.join('\n\n'),
      replies,
      appointment: result.appointment || null,
      handoff: result.handoff || null,
      state: convo.state || null,
      // P2-B: false only when the bot had NO real answer (unknown intent, or a
      // FAQ ask that matched nothing) — feeds the "bot didn't know" queue.
      knew: result.knew !== false,
    };
  }

  return { handleMessage };
}

// ── routing ─────────────────────────────────────────────────────────────────
async function route(ctx) {
  const { convo, text } = ctx;
  const gi = detectIntent(text);

  // An active booking flow captures the turn, except for explicit interrupts.
  if (convo.state?.flow === 'booking') {
    if (gi.intent === 'cancel') return cancelBooking(ctx);
    if (gi.intent === 'human_handoff') return handleHandoff(ctx);
    return continueBooking(ctx);
  }

  switch (gi.intent) {
    case 'human_handoff':
      return handleHandoff(ctx);
    case 'cancel':
      return { intent: 'cancel', replies: [t(ctx.lang, 'nothingToCancel')] };
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

// ── intent handlers ─────────────────────────────────────────────────────────
function handleGreeting(ctx) {
  return {
    intent: 'greeting',
    replies: [t(ctx.lang, 'greeting', { clinic: ctx.clinic.name })],
  };
}

function handleHandoff(ctx) {
  const { clinic, lang } = ctx;
  // Leaving any active flow intact is intentional: a human takes over from here.
  return {
    intent: 'human_handoff',
    replies: [t(lang, 'handoff', { name: clinic.handoff?.name || '', phone: clinic.handoff?.phone || '' })],
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
