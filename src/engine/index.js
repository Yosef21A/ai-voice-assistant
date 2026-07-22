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
    if (!result) result = await route(ctx);

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

    return {
      clinicId: clinic.id,
      clinicName: clinic.name,
      lang: finalLang,
      intent: result.intent,
      reply: replies.join('\n\n'),
      replies,
      appointment: result.appointment || null,
      handoff: result.handoff || null,
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

  // An active booking flow captures the turn, except for explicit interrupts.
  // A STALE flow (idle >2h, F9) no longer captures: the message routes fresh
  // by intent; collected slots survive via startBooking's data carry-over.
  if (convo.state?.flow === 'booking' && !ctx.staleFlow) {
    if (gi.intent === 'cancel') return cancelBooking(ctx);
    if (gi.intent === 'human_handoff') return handleHandoff(ctx);
    return continueBooking(ctx);
  }
  if (convo.state?.flow === 'booking' && ctx.staleFlow && gi.intent === 'unknown') {
    // Fresh evaluation of an unknown message against a stale flow: fall through
    // to the FAQ/fallback handlers instead of force-feeding the old step.
    return handleFallback(ctx);
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
