// THE LAST LINK — the chat brain, on the phone.
//
// Every remote provider in the chain can be down, rate-limited or unpaid at the
// same time; free tiers make that likelier, not less likely. What must never
// happen on a medical phone line is SILENCE. So the final link is the thing
// this product has always had: the deterministic conversation engine
// (src/engine/), which needs no key, no network and no quota, and which has
// been answering patients since V1.
//
// IT IS A REAL ANSWER, NOT AN APOLOGY. handleMessage() runs the same intent
// routing, the same FAQ matching and the same booking state machine the
// WhatsApp thread runs, so a caller who says "نحب نحجز موعد" gets the booking
// flow's next question rather than "sorry, try later".
//
// FOUR PROPERTIES, AND THREE OF THEM WERE CORRECTED IN REVIEW:
//
//  1. ZERO NETWORK, GUARANTEED — not merely likely. `conversationMode` is
//     forced to 'classic' FOR THIS CALL ONLY (a config override handed to
//     createEngine, never a global mutation), and the provider is the
//     deterministic MockProvider. Before this, a tenant configured in llm mode
//     reached the LLM path, and even in classic mode `safeGenerate()` would
//     have called GeminiProvider for FAQ phrasing — i.e. the last link in a
//     chain that exists BECAUSE the network failed would have made a network
//     call, and the doctrine's "always available" would have been a wish.
//  2. EVENT-LAYER PARITY. The engine writes; it does not publish. On the
//     WhatsApp path src/api/ingest.js turns its result into
//     `appointment.created`, `handoff.requested` and the facilitator lead
//     (upsert + `lead.hot`). A call that skipped that block would write an
//     appointment no owner was ever told about, and would burn the engine's
//     alert-once flag on a lead that never reached the pipeline. That block is
//     replicated here, deliberately and visibly, with `channel:'call'`.
//  3. NO TOOLS, EVER. This link never yields a toolCall. The chat engine writes
//     through its OWN confirm step (engine/booking.js) — a read-back plus an
//     explicit yes — so there is no path here that books on one sentence. Which
//     gate is in force is decided ONCE per call (the sticky rule in ./index.js),
//     never per turn.
//  4. IT NEVER THROWS. An engine failure yields the localized fallback line
//     instead of propagating: at this point in the chain there is nobody left
//     to rotate to, and "say something honest" beats "say nothing".
import { createEngine } from '../../../engine/index.js';
import { MockProvider } from '../../../llm/mockProvider.js';
import { t } from '../../../engine/responses.js';
import { takeSentences } from '../../brain/chunker.js';
import { isSandboxWaId } from '../../../stats/index.js';

/**
 * @param {object} p
 * @param {object} p.clinic
 * @param {object} p.store
 * @param {object} [p.bus]           event-layer parity needs it (see header)
 * @param {object} [p.convo]         the inbox conversation record
 * @param {object} [p.config]
 * @param {string} [p.lang]
 * @param {string} [p.patientWaId]
 * @param {Function} [p.now]
 * @param {Function} [p.logger]
 * @param {Function} [p.engineFactory] default createEngine — tests inject
 * @param {Function} [p.onResult]      (engineResult) — the orchestrator records
 *   what the chat flow wrote and clears the voice-side staged booking.
 */
export function createClassicLlm({
  clinic,
  store,
  bus,
  convo,
  config = {},
  lang = 'ar',
  patientWaId,
  now,
  logger,
  engineFactory,
  onResult,
} = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  const clock = typeof now === 'function' ? now : () => new Date();
  const make = typeof engineFactory === 'function' ? engineFactory : createEngine;
  const tenantId = clinic?.id ?? null;
  const conversationId = convo?.id ?? null;
  let engine = null;

  function ensureEngine() {
    if (engine) return engine;
    engine = make({
      store,
      // The MockProvider is deterministic and offline. It is used for free-form
      // PHRASING only (fallbacks, FAQ rewording); booking is deterministic
      // regardless. This is what "always available" has to mean in a link whose
      // whole job is to work when the network does not.
      provider: new MockProvider(),
      // FOR THIS CALL ONLY. Never `config.conversationMode = …`: that object is
      // shared with the rest of the process.
      config: { ...config, conversationMode: 'classic' },
    });
    return engine;
  }

  /**
   * What src/api/ingest.js publishes after a turn, replicated for the call
   * transport. Deliberately a copy of a known block rather than an abstraction
   * over it: the two transports genuinely differ (a call has no inbound message
   * row, no nudge conversion, no analyzeInbound pass), and pretending otherwise
   * is how one of them silently stops firing.
   */
  async function publishParity(out, text) {
    if (!bus || !tenantId) return;
    const snippet = String(text || '').slice(0, 160);

    if (out?.appointment) {
      try {
        bus.publish?.('appointment.created', {
          tenantId,
          conversationId,
          // The chat engine does not know it is on a phone. The owner alert and
          // the analytics both branch on this field.
          appointment: { ...out.appointment, channel: 'call' },
        });
      } catch (err) {
        log('[voice-cascade] classic appointment publish failed:', err?.message || err);
      }
    }

    if (out?.handoff) {
      // Same shape ingest publishes: flag for a human. `keepActive` decides
      // whether the bot also pauses — a classic handoff pointed the patient off
      // WhatsApp, so it pauses; the llm one does not.
      const keepActive = out.handoff.keepActive === true;
      const patch = keepActive ? { status: 'needs_human' } : { status: 'needs_human', aiPaused: true };
      try {
        if (conversationId) {
          await store.conversations.update(tenantId, conversationId, patch);
          bus.publish?.('conversation.updated', { tenantId, conversationId, patch });
        }
        bus.publish?.('handoff.requested', {
          tenantId,
          conversationId,
          handoff: { ...out.handoff, channel: 'call' },
          lastMessage: '[voice call]',
          patientWaId,
        });
      } catch (err) {
        log('[voice-cascade] classic handoff publish failed:', err?.message || err);
      }
    }

    // FACILITATOR (D2). By the time we see this, the engine has ALREADY burned
    // its once-only alert flag — it lives in the conversation state it just
    // saved — so failing to persist and publish here does not merely lose a
    // ping, it loses it permanently. Hence: upsert first, publish second, and
    // say loudly when the upsert failed rather than letting the alert imply a
    // row that does not exist.
    const fl = out?.facilitatorLead;
    if (fl && !isSandboxWaId(patientWaId)) {
      let persisted = true;
      try {
        await store.leads?.upsertOpen?.(tenantId, {
          conversationId,
          patientWaId,
          procedure: fl.procedure || fl.procedureRaw || null,
          originCountry: fl.originCountry || null,
          details: {
            reason: 'facilitator_qualified',
            procedureLabel: fl.procedureLabel || null,
            originCity: fl.originCity || fl.originRaw || null,
            travelWindow: fl.travelWindow || null,
            budgetAsked: fl.budgetAsked || false,
            snippet,
            channel: 'call',
          },
        });
      } catch (err) {
        persisted = false;
        log('[voice-cascade] classic facilitator lead upsert FAILED:', err?.message || err);
      }
      if (fl.alert) {
        try {
          bus.publish?.('lead.hot', {
            tenantId,
            conversationId,
            lead: {
              reason: 'facilitator_qualified',
              procedure: fl.procedureLabel || fl.procedure || fl.procedureRaw || null,
              country: fl.originCountry || null,
              patientWaId,
              conversationId,
              snippet,
              persisted,
            },
          });
        } catch (err) {
          log('[voice-cascade] classic lead.hot publish failed:', err?.message || err);
        }
      }
    }
  }

  return {
    provider: 'classic',

    /**
     * @param {object} p
     * @param {Array<object>} p.messages neutral history; the last user turn is
     *   what the engine answers (it keeps its own conversation state).
     * @yields {{type:'text',delta}|{type:'done',usage}}
     */
    async *stream({ messages = [] } = {}) {
      const last = [...messages].reverse().find((m) => m?.role === 'user' && m.text);
      const text = String(last?.text || '').trim();
      let reply = '';
      if (text) {
        try {
          const out = await ensureEngine().handleMessage(
            {
              channel: 'voice-cascade',
              from: patientWaId,
              text,
              phoneNumberId: clinic?.phoneNumberId,
              tenantId: clinic?.id,
            },
            { now: clock() }
          );
          reply = String(out?.reply || '').trim();
          await publishParity(out, text);
          if (typeof onResult === 'function') {
            try {
              onResult(out);
            } catch (err) {
              log('[voice-cascade] classic onResult threw:', err?.message || err);
            }
          }
        } catch (err) {
          log('[voice-cascade] classic engine turn failed:', err?.message || err);
        }
      }
      if (!reply) reply = t(lang, 'faqFallback');

      // The engine writes for a CHAT bubble: emoji, bullets and newlines. A
      // mouth reads all three out loud, so they are stripped here rather than
      // shipped to a TTS vendor. The sentence splitter then cuts what is left
      // with the same rules every other link's output goes through.
      const spoken = toSpoken(reply);
      const { pieces, rest } = takeSentences(`${spoken} `);
      for (const piece of pieces) yield { type: 'text', delta: piece };
      if (rest.trim()) yield { type: 'text', delta: rest };
      yield { type: 'done', usage: { tokensIn: 0, tokensOut: 0 } };
    },
  };
}

/**
 * Chat copy → speakable copy. Deliberately conservative: it removes what a TTS
 * engine would read out as noise and changes nothing else. Numbers, dates and
 * prices are already speech-shaped at the source (engine/responses.js templates
 * + formatWhenSpoken), and re-parsing them here would be a second, drifting
 * implementation of a rule a patient acts on.
 */
export function toSpoken(text) {
  return String(text || '')
    // KEYCAP SEQUENCES FIRST ("1️⃣" = digit + VS16 + combining keycap). They are
    // list markers in chat copy, and the pictographic pass below would strip
    // only their decoration, leaving a bare "1" that a mouth reads as a step
    // number the caller never asked for.
    .replace(/[0-9#*]️?⃣/g, ' ')
    // Emoji and pictographs: a receptionist does not say "waving hand".
    .replace(/[\p{Extended_Pictographic}️]/gu, ' ')
    .replace(/^[\s•\-*]+/gm, '') // bullet markers at the head of a line
    .replace(/[*_`#]+/g, ' ') // markdown a vendor reads literally
    .replace(/\n+/g, '. ') // a hard break IS a sentence end on a phone
    .replace(/\s*\.\s*\./g, '.') // …without doubling one that was already there
    .replace(/\s+/g, ' ')
    .trim();
}

export default createClassicLlm;
