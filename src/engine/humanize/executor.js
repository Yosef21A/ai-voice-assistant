// The EXECUTOR (P2-HUMANIZE §1) — the ONLY writer in the LLM-led flow. The LLM
// plans (reply text + slots patch + actions); this module re-derives every fact
// deterministically: datetimes are re-parsed from the patient's words, the
// specialty is validated against the tenant registry, availability comes from
// working hours, the recap/booked messages are template-rendered (never LLM
// numbers), guardrails post-filter the prose, and refusal/handoff are honored
// unconditionally. It never throws on plan content — malformed pieces degrade.
import {
  extractSpecialty,
  extractName,
  extractOrigin,
  extractContact,
  detectYesNo,
} from '../slots.js';
import { parseDateTimeRequest, resolveSlot, formatWhen } from '../datetime.js';
import { finalizeBooking, buildSummary, nextStep } from '../booking.js';
import { t } from '../responses.js';
import { splitBubbles } from '../text.js';
import { filterReply } from './guardrails.js';
import { mapIntent, isRepeat, pickVariation } from './policies.js';

const LANG_MAP = { ar: 'ar', fr: 'fr', en: 'en', 'ar-Latn': 'ar' };
const WARM_LINE_MAX = 200;

function ensureState(convo) {
  if (!convo.state || typeof convo.state !== 'object') {
    convo.state = { flow: null, step: null, data: {} };
  }
  if (!convo.state.data || typeof convo.state.data !== 'object') convo.state.data = {};
  if (!convo.state.h || typeof convo.state.h !== 'object') convo.state.h = {};
  return convo.state;
}

/** Apply the LLM's slots_patch with deterministic re-extraction of each value. */
function applySlots(ctx, patch = {}, data) {
  const res = { any: false, adjusted: false, slotDate: null, unmatchedSpecialty: null };

  if (patch.specialty) {
    const byId = (ctx.clinic.specialties || []).find((s) => s.id === patch.specialty);
    // Match the LLM's specialty value only — do NOT rescan the whole message,
    // which could bind an unrelated specialty word and mask a genuine gap.
    const sp = byId || extractSpecialty(patch.specialty, ctx.clinic);
    if (sp) {
      if (data.specialty !== sp.id) res.any = true;
      data.specialty = sp.id;
    } else {
      res.unmatchedSpecialty = patch.specialty;
    }
  }

  if (patch.datetimeText) {
    // Never trust an LLM datetime: parse the patient's words ourselves.
    const req = parseDateTimeRequest(patch.datetimeText, ctx.now);
    if (req.date || req.hour != null) {
      const slot = resolveSlot(ctx.clinic, req, ctx.now);
      if (slot) {
        if (data.slotIso !== slot.iso) res.any = true;
        data.slotIso = slot.iso;
        data.slotAdjusted = slot.adjusted;
        data.datetimeRaw = patch.datetimeText;
        res.adjusted = slot.adjusted;
        res.slotDate = slot.date;
      }
    }
    // Unparseable → ignored; the LLM's reply asks again in its own words.
  }

  if (patch.name) {
    const name = extractName(patch.name);
    if (name) {
      if (data.name !== name) res.any = true;
      data.name = name.slice(0, 80);
    }
  }

  if (patch.origin) {
    const o = extractOrigin(patch.origin);
    if (o.raw) {
      if (data.originRaw !== o.raw) res.any = true;
      data.originCity = o.city;
      data.originCountry = o.country;
      data.originRaw = o.raw;
    }
  }

  if (patch.contact) {
    const contact = extractContact(patch.contact);
    if (contact) {
      if (data.contact !== contact) res.any = true;
      data.contact = contact;
    }
  }

  return res;
}

/** Final safety net on the composed bubbles: non-empty + never-repeat marker. */
function finish(ctx, result) {
  const replies = (result.replies || []).map((r) => String(r ?? '').trim()).filter(Boolean);
  if (!replies.length) {
    const h = ensureState(ctx.convo).h;
    replies.push(pickVariation(ctx.lang, h));
  }
  result.replies = replies.slice(0, 2); // ≤2 bubbles, always
  if (!result.appointment && isRepeat(ctx.convo, result.replies)) {
    result.__repeat = true; // caller may regenerate once, else vary
  }
  return result;
}

/** Swap a repeated reply for a different-angle variation (two-strike rule). */
export function applyVariation(ctx, result) {
  const h = ensureState(ctx.convo).h;
  result.replies = [pickVariation(ctx.lang, h)];
  delete result.__repeat;
  return result;
}

/**
 * Execute a coerced plan. Mutates convo.state / the store deterministically and
 * returns the classic route() result shape (+ gap/adminNotify/kbQuestion for
 * the ingest layer).
 */
export function executePlan(ctx, plan) {
  const { convo, clinic } = ctx;
  const state = ensureState(convo);
  const data = state.data;
  const h = state.h;

  // Language mirroring: the LLM's read of the LAST message wins (F2/Arabizi:
  // ar-Latn replies in Arabic script → 'ar' templates).
  const lang = LANG_MAP[plan.detected_lang] || ctx.lang;
  ctx.lang = lang;
  convo.lang = lang;

  const yn = detectYesNo(ctx.text);
  const actions = new Set(plan.actions);

  const patch = applySlots(ctx, plan.slots_patch, data);
  if (patch.any && state.flow !== 'booking') state.flow = 'booking';
  if (state.flow === 'booking') state.step = nextStep(data);

  const filtered = filterReply(plan.reply_text, { clinic, lang });
  const reply = filtered.text;

  const result = {
    intent: mapIntent({ plan, ctx, slotsTouched: patch.any, bookingActive: state.flow === 'booking' }),
    replies: [],
    lang,
  };
  if (actions.has('kb_gap')) {
    result.knew = false;
    result.kbQuestion = plan.kb_question || null;
  }
  if (filtered.violations.length) result.guardrailViolations = filtered.violations;

  // ── refusal is sacred (§2.4): honored before anything else ────────────────
  const refusal =
    actions.has('cancel_flow') || (h.awaitingConfirm && yn === 'no' && !patch.any);
  if (refusal) {
    convo.state = { flow: null, step: null, data: {}, h: { ...h, awaitingConfirm: false } };
    result.intent = 'cancel';
    result.replies = [reply || t(lang, 'cancelled')];
    return finish(ctx, result);
  }

  // ── handoff keeps the chat (§2.6): flag needs_human + owner alert, but the
  // bot stays ACTIVE so it can keep helping until a human actually takes over
  // (keepActive tells ingest not to pause — pausing here would contradict the
  // "I can help you meanwhile" the prompt promises). Takeover pauses the bot
  // when staff sends the first message.
  if (actions.has('handoff_request')) {
    h.awaitingConfirm = false;
    result.intent = 'human_handoff';
    result.handoff = { clinicId: clinic.id, ...(clinic.handoff || {}), keepActive: true };
    result.replies = [
      reply ||
        t(lang, 'handoff', { name: clinic.handoff?.name || '', phone: clinic.handoff?.phone || '' }),
    ];
    return finish(ctx, result);
  }

  // ── specialty gap → lead + keep the conversation alive (§2.5) ─────────────
  if (actions.has('specialty_gap') || patch.unmatchedSpecialty) {
    result.gap = {
      type: 'specialty',
      requested:
        plan.requested_specialty || patch.unmatchedSpecialty || String(ctx.text).slice(0, 80),
      name: data.name || null,
      contact: data.contact || null,
    };
  }

  if (actions.has('notify_admin')) {
    result.adminNotify = { reason: plan.action_reason || 'assistant flagged this conversation' };
  }

  // ── booking: deterministic confirm / recap ────────────────────────────────
  const complete = state.flow === 'booking' && nextStep(data) === 'confirm';
  if (complete) {
    const wantsConfirm = actions.has('confirm_booking');
    // Finalize ONLY after a recap was shown (awaitingConfirm) and the patient
    // agreed. A recap is non-negotiable: it's where an auto-adjusted slot is
    // disclosed (§3) and where the patient sees the parsed facts. A first-turn
    // confirm_booking (no recap yet) falls through to propose the recap.
    const agreed = yn === 'yes' || (wantsConfirm && yn !== 'no');
    if (h.awaitingConfirm && agreed) {
      const fin = finalizeBooking(ctx); // the ONE appointment write + booked recap
      const appt = fin.appointment;
      convo.state = {
        flow: null,
        step: null,
        data: {},
        h: {
          ...h,
          awaitingConfirm: false,
          lastBooking: {
            ref: appt.ref,
            specialty: appt.specialtyLabel,
            when: formatWhen(new Date(appt.datetimeISO), lang),
          },
        },
      };
      result.intent = 'book_appointment';
      result.appointment = appt;
      result.replies =
        reply && reply.length <= WARM_LINE_MAX ? [reply, ...fin.replies] : fin.replies;
      return finish(ctx, result);
    }
    if (wantsConfirm || actions.has('propose_summary')) {
      // A confirm without consent downgrades to a proposal — the recap is
      // template-rendered so every number is the executor's, never the LLM's.
      h.awaitingConfirm = true;
      state.step = 'confirm';
      const summary = buildSummary(ctx);
      result.replies = reply && reply.length <= WARM_LINE_MAX ? [reply, summary] : [summary];
      return finish(ctx, result);
    }
  }

  // ── default: the LLM's guardrailed prose (+ adjustment disclosure §3) ─────
  if (patch.adjusted && patch.slotDate) {
    const when = formatWhen(patch.slotDate, lang);
    if (!reply.includes(when)) {
      result.replies = [t(lang, 'datetimeAdjusted', { when }), reply];
      return finish(ctx, result);
    }
  }
  result.replies = splitBubbles(reply, 2);
  return finish(ctx, result);
}
