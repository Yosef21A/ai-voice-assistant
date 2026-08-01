// The deterministic law of a voice call: what the model is ALLOWED to do.
//
// A large model on a phone line will, given the chance, cheerfully tell a
// patient "you're booked for Thursday at ten" without anything existing in any
// database. So it is given no such chance. The only writes it can cause go
// through a gate with THREE independent conditions, and an adversarial review
// proved every one of them is load-bearing:
//
//   stage_booking(...)   validates every field with the SAME deterministic
//                        extractors the chat engine uses (specialty, date/time
//                        against real opening hours, name, contact), stores the
//                        result on per-call state, WRITES NOTHING, and returns a
//                        localized recap the agent must read aloud.
//   confirm_booking()    refuses unless ALL of:
//                          (1) something is staged;
//                          (2) the stage happened in an EARLIER tool batch — a
//                              model that emits stage+confirm together never
//                              gave the caller a chance to hear anything;
//                          (3) the caller has SPOKEN since the stage — the only
//                              machine-checkable evidence that the recap was
//                              actually read out and answered.
//                        …and if that speech reads as a refusal, the stage is
//                        dropped and the tool says so.
//
// Conditions (2) and (3) exist because of a reproduced failure: a single tool
// batch carrying stage_booking + confirm_booking wrote appointment
// CX-260803-001 with ZERO caller speech anywhere in the transcript. "The prompt
// says read the recap first" is not a control. This is.
//
// The tool list is also a guardrail. There is deliberately NO pricing tool and
// no "quote" tool: prices are "from" figures in the prompt plus a human quote,
// full stop. A FACILITATOR tenant (D2) gets no booking tools at all — an agency
// has no calendar — and instead gets capture_lead, because a qualified caller
// the team never hears about is worth exactly as much as a call that never came.
import { extractSpecialty, extractName, extractContact, detectYesNo, normalize } from '../../engine/slots.js';
import { parseDateTimeRequest, resolveSlot, toLocalISO } from '../../engine/datetime.js';
import { windowFor, WD_KEYS, SLOT_MIN } from '../../store/availability.js';
import { specialtyLabel, genRef } from '../../engine/booking.js';
import {
  isCabinet,
  isFacilitator,
  defaultSpecialtyId,
  doctorName,
  hasDoctorPersona,
} from '../../engine/tenantProfile.js';
import { t } from '../../engine/responses.js';

const LEAD_MS = 60 * 60 * 1000; // same 1h minimum lead time as the chat flow
const SCAN_DAYS = 21;
const NOON = 12 * 60;

// ── spoken date/time (V2) ───────────────────────────────────────────────────
// formatWhen() renders "الخميس 06/08/2026 10:00", which is right for a chat
// bubble and wrong for a mouth: a slash-separated numeric date read aloud is the
// fastest way to make a caller say "sorry, what?". These render the same instant
// the way a receptionist says it. formatWhen stays untouched for every chat
// path, so the two channels differ in phrasing and in nothing else.
const WEEKDAYS = {
  ar: ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'],
  fr: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};
// Tunisian/Maghrebi month names are the French-derived set (جانفي, أوت …), NOT
// the Levantine كانون/شباط series — using the wrong one reads as foreign.
const MONTHS = {
  ar: ['جانفي', 'فيفري', 'مارس', 'أفريل', 'ماي', 'جوان', 'جويلية', 'أوت', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};

function spokenHour(date, lang) {
  const h = date.getHours();
  const m = date.getMinutes();
  if (lang === 'fr') return `${h}h${String(m).padStart(2, '0')}`;
  if (lang === 'en') {
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  }
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const suffix = h < 12 ? 'صباحاً' : 'بعد الظهر';
  return m ? `${h12} و${m} دقيقة ${suffix}` : `${h12} ${suffix}`;
}

/** "الخميس 6 أوت على الساعة 10 صباحاً" / "jeudi 6 août à 10h00". */
export function formatWhenSpoken(date, lang = 'ar') {
  const L = WEEKDAYS[lang] ? lang : 'ar';
  const day = `${WEEKDAYS[L][date.getDay()]} ${date.getDate()} ${MONTHS[L][date.getMonth()]}`;
  if (L === 'fr') return `${day} à ${spokenHour(date, 'fr')}`;
  if (L === 'en') return `${day} at ${spokenHour(date, 'en')}`;
  return `${day} على الساعة ${spokenHour(date, 'ar')}`;
}

// ── half-day intent (V2) ────────────────────────────────────────────────────
// parseDateTimeRequest only applies a meridiem once an HOUR has been parsed, so
// a bare "الخميس العشية" / "jeudi après-midi" came back as { hour: null } and
// resolved to the first slot of the day — 08:30. The caller asked for the
// afternoon, was quietly given the morning, and `adjusted` was false so nothing
// was even disclosed. These two tables recover the intent the parser drops.
const PM_RE =
  /(العشيه|العشية|عشيه|عشية|بعد الظهر|بعد الظهير|مساء|المساء|بالليل|3chia|3achia|3shia|3chiya|apres-?midi|aprem|\bsoir\b|\bsoiree\b|afternoon|evening|\bpm\b)/;
const AM_RE = /(الصباح|صباحا|صباح|sbah|sba7|sabah|\bmatin\b|\bmatinee\b|morning|\bam\b)/;

/**
 * Which half of the day did the caller ask for? Null when they said nothing
 * about it (or named an explicit hour, which is stronger evidence anyway).
 * @returns {'am'|'pm'|null}
 */
export function detectHalfDay(text) {
  const s = normalize(text); // lowercases + strips Latin accents, Arabic intact
  if (!s) return null;
  if (PM_RE.test(s)) return 'pm';
  if (AM_RE.test(s)) return 'am';
  return null;
}

/** The bookable [first, last] slot minutes of a day, narrowed to a half. */
function slotBounds(clinic, day, half) {
  const win = windowFor(clinic, day);
  if (!win) return null;
  let lo = win[0];
  let hi = win[1] - SLOT_MIN;
  if (half === 'pm') lo = Math.max(lo, NOON);
  if (half === 'am') hi = Math.min(hi, NOON - SLOT_MIN);
  return lo > hi ? null : [lo, hi];
}

const sameDay = (date, req) =>
  !!req && date.getFullYear() === req.y && date.getMonth() === req.mo && date.getDate() === req.d;

/**
 * The next `count` genuinely-open 30-minute slots, scanning forward from `now`
 * (plus the standard 1h lead time). Same working-hours source as the chat
 * engine, so a voice caller can never be offered a time the inbox would reject.
 * @param {object} [opts] { half: 'am'|'pm' } — restrict to a half-day
 */
export function nextOpenSlots(clinic, req, now, count = 3, opts = {}) {
  const half = opts.half || null;
  const earliest = new Date(now.getTime() + LEAD_MS);
  const base = req?.date
    ? new Date(req.date.y, req.date.mo, req.date.d)
    : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const wantMins = req?.hour != null ? req.hour * 60 + (req.minute || 0) : null;
  const out = [];

  for (let i = 0; i < SCAN_DAYS && out.length < count; i += 1) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    const bounds = slotBounds(clinic, day, half);
    if (!bounds) continue;
    const [lo, hi] = bounds;
    // On the requested DAY, start at the requested hour; on later days start at
    // the window's edge — "Thursday afternoon" must not offer Friday 8:30 first.
    const from =
      i === 0 && wantMins != null ? Math.max(lo, Math.ceil(wantMins / SLOT_MIN) * SLOT_MIN) : lo;
    for (let m = from; m <= hi && out.length < count; m += SLOT_MIN) {
      const cand = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(m / 60), m % 60);
      if (cand.getTime() < earliest.getTime()) continue;
      out.push(cand);
    }
  }
  return out;
}

/**
 * Resolve a caller's spoken day/time into a concrete bookable slot, honouring a
 * bare meridiem. Returns the shape resolveSlot does, and `adjusted` is TRUE
 * whenever we could not give them the half-day (or the day) they asked for — so
 * callAdjusted gets spoken instead of a silent substitution.
 */
export function resolveVoiceSlot(clinic, dayText, now) {
  const req = parseDateTimeRequest(String(dayText || ''), now);
  const half = req.hour == null ? detectHalfDay(dayText) : null;
  if (half) {
    const [first] = nextOpenSlots(clinic, req, now, 1, { half });
    if (first) {
      return {
        iso: toLocalISO(first),
        date: first,
        adjusted: !!req.date && !sameDay(first, req.date),
        half,
      };
    }
    // Their half-day is unbookable inside the scan window. Fall back to the
    // ordinary resolution, but SAY SO — that disclosure is exactly what the
    // silent-morning bug was skipping.
    const fb = resolveSlot(clinic, req, now);
    return fb ? { ...fb, adjusted: true, half } : null;
  }
  return resolveSlot(clinic, req, now);
}

/**
 * Gemini function declarations for this tenant.
 * @param {object} p
 * @param {object} p.clinic
 * @returns {Array<object>} functionDeclarations (Gemini schema subset)
 */
export function buildToolDeclarations({ clinic } = {}) {
  const handoff = {
    name: 'request_handoff',
    description:
      'Hand the caller to a human. Call this when they ask for a person, when they are upset, or when you have failed twice to help. After calling it, tell the caller a team member will follow up on WhatsApp in this same conversation.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reason: { type: 'STRING', description: 'Short reason, for the staff notification.' },
      },
    },
  };

  /**
   * THE HANG-UP (V5-T2). Found on a real call: the conversation finished, both
   * sides said goodbye — and the agent just sat there, holding the line open
   * until the caller gave up and hung up themselves. Every human receptionist
   * ends a call; an assistant that cannot is unmistakably a machine, and it
   * bills for the silence.
   *
   * Available to EVERY tenant type: a facilitator finishing a qualification and
   * a cabinet finishing a booking both need to put the phone down.
   */
  const endCall = {
    name: 'end_call',
    description:
      'Call this after you have said goodbye and the conversation is finished. It hangs up the phone. Never call it in the middle of a task, and never call it right after you have asked the caller a question — they have not answered yet.',
    parameters: { type: 'OBJECT', properties: {} },
  };

  // D2: an agency books nothing — but a qualified caller MUST reach the team.
  if (isFacilitator(clinic)) {
    return [
      {
        name: 'capture_lead',
        description:
          "Save the caller's request so the team can come back with a tailored clinic offer today. Call this as soon as you know the treatment they want, where they are travelling from, and roughly when. Call it BEFORE you promise them an offer — the promise is only true once this is saved.",
        parameters: {
          type: 'OBJECT',
          properties: {
            procedure: { type: 'STRING', description: 'The treatment they want, in their own words.' },
            originCity: { type: 'STRING', description: 'The city/country they are travelling from.' },
            travelWindow: { type: 'STRING', description: 'When they can travel, in their own words.' },
            notes: { type: 'STRING', description: 'Anything else the team should know. Keep it short.' },
          },
          required: ['procedure'],
        },
      },
      handoff,
      endCall,
    ];
  }

  return [
    {
      name: 'get_available_slots',
      description:
        'List the next few appointment times that are genuinely open, according to the real opening hours. Use this when the caller asks what is available. Offer at most three out loud.',
      parameters: {
        type: 'OBJECT',
        properties: {
          specialty: { type: 'STRING', description: "The specialty in the caller's own words (optional)." },
          dayText: {
            type: 'STRING',
            description:
              "The day or time the caller asked for, in THEIR OWN WORDS, including 'morning'/'afternoon' if they said it (e.g. 'الخميس العشية', 'lundi matin'). Never compute a date yourself.",
          },
        },
      },
    },
    {
      name: 'stage_booking',
      description:
        'Validate a booking and get a recap to READ ALOUD. This writes NOTHING. Call it once you have the specialty, a day/time, a name and a contact number. Then read the returned recap word for word and ask the caller a yes/no question. Do NOT call confirm_booking in the same turn — it will be refused.',
      parameters: {
        type: 'OBJECT',
        properties: {
          specialty: { type: 'STRING', description: "The specialty in the caller's own words." },
          datetimeText: {
            type: 'STRING',
            description:
              "The day and time in the caller's OWN WORDS, including 'morning'/'afternoon' if they said it. Never convert to a date, never invent one — the system resolves it against real opening hours and tells you if it had to move.",
          },
          name: { type: 'STRING', description: "The patient's full name as spoken." },
          contact: {
            type: 'STRING',
            description: 'A phone number to reach them. Leave empty to use the number they are calling from.',
          },
        },
        required: ['datetimeText', 'name'],
      },
    },
    {
      name: 'confirm_booking',
      description:
        'Write the appointment. ONLY call this in a LATER turn: after stage_booking succeeded, after you read the recap out loud, and after the caller answered yes. It refuses if any of that did not happen. Never tell the caller they are booked before this returns a reference.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    handoff,
    endCall,
  ];
}

/** A tenant-shaped "we're open X–Y" line, used when nothing is bookable. */
function hoursLine(clinic) {
  const wh = clinic?.workingHours || {};
  const parts = [];
  for (const k of WD_KEYS) {
    if (Array.isArray(wh[k]) && wh[k].length >= 2) parts.push(`${k} ${wh[k][0]}-${wh[k][1]}`);
  }
  return parts.join(', ');
}

/**
 * The executor the loop calls for every function call.
 *
 * @param {object} p
 * @param {object} p.clinic
 * @param {object} p.convo         the conversation record (id + patientWaId)
 * @param {object} p.store
 * @param {object} p.bus
 * @param {object} p.callState     per-call mutable state. The LOOP maintains
 *   `toolBatchId` (incremented once per toolCall frame), `lastCallerSpeechAt`
 *   and `speechSinceStage`; this module reads them to enforce the gate.
 * @param {string} p.lang
 * @param {string} [p.patientWaId]
 * @param {Function} [p.now]       injected clock
 * @param {Function} [p.logger]
 * @returns {{exec:Function}}
 */
export function createToolExecutor({
  clinic,
  convo,
  store,
  bus,
  callState,
  lang = 'ar',
  patientWaId: waIdOverride,
  now,
  logger,
} = {}) {
  const clock = typeof now === 'function' ? now : () => new Date();
  const log = typeof logger === 'function' ? logger : () => {};
  const tenantId = clinic?.id ?? null;
  const conversationId = convo?.id ?? null;
  // The two store adapters disagree on the field name: the JSON conversation
  // record carries `waId`, the Postgres one carries `patientWaId` (and `waId`
  // as a legacy alias). Reading only one of them silently produced a null
  // patient id — and a null contact on the appointment — on the JSON store.
  // The caller's own id from the webhook wins when it is supplied.
  const patientWaId = waIdOverride ?? convo?.patientWaId ?? convo?.waId ?? null;
  const state = callState || {};
  const facilitator = isFacilitator(clinic);

  function label(id) {
    return specialtyLabel(clinic, id, lang);
  }

  /**
   * Resolve the specialty deterministically. A cabinet's (or any single-
   * specialty tenant's) is FIXED by configuration — but a caller who names a
   * DIFFERENT discipline this practice actually lists is asking for something
   * else, and silently substituting would book them with the wrong doctor.
   */
  function resolveSpecialty(spoken) {
    const forced = defaultSpecialtyId(clinic);
    const asked = extractSpecialty(String(spoken || ''), clinic);
    if (forced) {
      if (asked && asked.id !== forced) return { conflict: asked.id, forced };
      return { id: forced, wasForced: true };
    }
    if (asked) return { id: asked.id, wasForced: false };
    return null;
  }

  async function getAvailableSlots(args) {
    const dayText = String(args?.dayText || '');
    const at = clock();
    const req = parseDateTimeRequest(dayText, at);
    const half = req.hour == null ? detectHalfDay(dayText) : null;
    let slots = nextOpenSlots(clinic, req, at, 3, { half });
    // Never dead-end: if their half-day has nothing anywhere in the scan window,
    // offer what does exist — but say plainly that it is a different time.
    const missedHalf = !!half && !slots.length;
    if (missedHalf) slots = nextOpenSlots(clinic, req, at, 3);
    if (!slots.length) return { ok: false, error: 'no_open_slots', hours: hoursLine(clinic) };
    // Same transparency rule the recap follows: a substitution the caller did
    // not ask for has to be SAID, not slipped in among three cheerful options.
    const movedDay = !!req.date && !sameDay(slots[0], req.date);
    const note = missedHalf
      ? `Nothing is open in the ${half === 'pm' ? 'afternoon' : 'morning'} they asked for — say that first, then offer these.`
      : movedDay
        ? 'The day they asked for has nothing free — say that first, then offer these.'
        : 'Offer these out loud, at most three, and let the caller choose.';
    return { ok: true, slots: slots.map((d) => ({ when: formatWhenSpoken(d, lang) })), note };
  }

  async function stageBooking(args) {
    const sp = resolveSpecialty(args?.specialty);
    if (sp?.conflict) {
      // Honest refusal beats a silent substitution: this practice does list the
      // discipline they named, but it is not what this line books.
      return {
        ok: false,
        error: 'specialty_not_offered',
        requested: label(sp.conflict),
        offered: label(sp.forced),
        note: 'Say honestly that this practice does not take that on this line, and offer to keep their number for the team.',
      };
    }
    if (!sp) {
      return {
        ok: false,
        error: 'unknown_specialty',
        options: (clinic.specialties || []).map((s) => label(s.id)),
      };
    }

    const at = clock();
    const slot = resolveVoiceSlot(clinic, args?.datetimeText, at);
    if (!slot) return { ok: false, error: 'no_slot_available', hours: hoursLine(clinic) };

    const name = extractName(String(args?.name || ''), lang);
    if (!name || name.trim().length < 2) return { ok: false, error: 'missing_name' };

    // The number they are calling from is the honest default — but only as a
    // FALLBACK, never silently over a number they actually dictated.
    const contact = extractContact(String(args?.contact || '')) || patientWaId || null;
    if (!contact) return { ok: false, error: 'missing_contact' };

    const when = formatWhenSpoken(slot.date, lang);
    const recap = t(lang, 'callRecap', {
      doctor: hasDoctorPersona(clinic) ? doctorName(clinic, lang) : null,
      specialty: label(sp.id),
      when,
      name: name.trim(),
      contact: String(contact),
    });
    // Transparency guardrail: a time we silently moved must be disclosed in the
    // SAME breath as the recap, not buried in a later sentence.
    const spoken = slot.adjusted ? `${t(lang, 'callAdjusted', { when })} ${recap}` : recap;

    state.staged = {
      specialty: sp.id,
      specialtyLabel: label(sp.id),
      specialtyForced: !!sp.wasForced,
      slotIso: slot.iso,
      slotDate: slot.date,
      adjusted: !!slot.adjusted,
      name: name.trim(),
      contact: String(contact),
      recapSpoken: spoken,
      stagedAt: at.getTime(),
      // The batch this staging happened in. confirm_booking must arrive in a
      // LATER one — see the header note and the reproduced CX-260803-001 bug.
      batchId: state.toolBatchId ?? 0,
    };
    // Everything the caller says from here is their answer to the recap.
    state.speechSinceStage = '';

    return {
      ok: true,
      recap: spoken,
      adjusted: !!slot.adjusted,
      note: 'Nothing has been saved. Read the recap out loud exactly as written, ask yes or no, and WAIT for the answer. Only call confirm_booking in a LATER turn, after they say yes.',
    };
  }

  async function confirmBooking() {
    const staged = state.staged;
    // THE GATE, part 1: a model that "just confirms" without staging books nothing.
    if (!staged) {
      return {
        ok: false,
        error: 'nothing_staged',
        note: 'No booking has been staged and read back. Call stage_booking first, read the recap aloud, and get a yes.',
      };
    }
    // Part 2: same tool batch as the stage ⇒ the caller has not heard one word
    // of the recap, because we have not even sent the audio yet.
    if (!(staged.batchId < (state.toolBatchId ?? 0))) {
      return {
        ok: false,
        error: 'read_recap_first',
        recap: staged.recapSpoken,
        note: 'You have not read the recap to the caller yet. Read it out loud, ask yes or no, wait for their answer, and only then call confirm_booking.',
      };
    }
    // Part 3: the caller must have SPOKEN since the stage — the only
    // machine-checkable evidence that a read-back actually happened.
    //
    // Gated on the ACCUMULATED speech, not on `lastCallerSpeechAt > stagedAt`.
    // A timestamp comparison is only as good as the clock's resolution, and the
    // loop's clock is injectable (frozen in tests, coarse on some hosts): two
    // events in the same millisecond would fail a strict `>` and refuse a
    // legitimate booking forever. The transcript itself is the evidence.
    if (!String(state.speechSinceStage || '').trim()) {
      return {
        ok: false,
        error: 'read_recap_first',
        recap: staged.recapSpoken,
        note: 'The caller has not answered yet. Read the recap out loud, ask yes or no, and wait for them.',
      };
    }
    // …and if what they said was a refusal, do not book it — drop the stage.
    if (detectYesNo(String(state.speechSinceStage || '')) === 'no') {
      state.staged = null;
      state.speechSinceStage = '';
      return {
        ok: false,
        error: 'caller_declined',
        note: 'The caller said no. Ask what they want to change and call stage_booking again with the corrected details.',
      };
    }

    const at = clock();
    const ref = await genRef(clinic, store, at);
    const appt = {
      id: `apt_${at.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
      ref,
      clinicId: clinic.id,
      clinicName: clinic.name,
      patientWaId,
      specialty: staged.specialty,
      specialtyLabel: staged.specialtyLabel,
      datetimeISO: staged.slotIso,
      datetimeAdjusted: !!staged.adjusted,
      patientName: staged.name,
      originCity: null,
      // Same rule as the chat flow: a cabinet is a local practice, a clinic sits
      // on the medical-tourism corridor. A phone call never asks for origin.
      originCountry: isCabinet(clinic) ? clinic.country || null : 'Libya',
      originRaw: null,
      contact: staged.contact,
      lang,
      channel: 'call',
      createdBy: 'bot',
      status: 'confirmed',
      createdAt: at.toISOString(),
    };

    await store.createAppointment(appt);
    state.staged = null;
    state.speechSinceStage = '';
    state.booked = ref;
    state.appointment = appt;
    try {
      bus?.publish?.('appointment.created', { tenantId, conversationId, appointment: appt });
    } catch (err) {
      log('[voice-brain] appointment.created publish failed:', err?.message || err);
    }

    return {
      ok: true,
      ref,
      when: formatWhenSpoken(new Date(staged.slotDate || staged.slotIso), lang),
      note: 'Now say the reference back to the caller slowly, once, and confirm the day and time in one short sentence.',
    };
  }

  async function requestHandoff(args) {
    state.handoff = true;
    state.handoffReason = args?.reason ? String(args.reason).slice(0, 200) : null;
    // Same shape ingest publishes for an llm handoff: flag for a human WITHOUT
    // pausing the bot — the caller was told the team replies HERE, and takeover
    // pauses the bot when staff actually sends the first message.
    const patch = { status: 'needs_human' };
    try {
      if (conversationId) {
        await store.conversations.update(tenantId, conversationId, patch);
        bus?.publish?.('conversation.updated', { tenantId, conversationId, patch });
      }
    } catch (err) {
      log('[voice-brain] handoff status update failed:', err?.message || err);
    }
    bus?.publish?.('handoff.requested', {
      tenantId,
      conversationId,
      handoff: { keepActive: true, reason: state.handoffReason, channel: 'call' },
      lastMessage: '[voice call]',
      patientWaId,
    });
    return {
      ok: true,
      note: 'Tell the caller a team member will follow up on WhatsApp in this same conversation, then say a warm goodbye.',
    };
  }

  /**
   * D2 (facilitator): the product moment. An agency call that qualifies a caller
   * and then hangs up without a row in the leads pipeline has produced nothing,
   * and the same-day-offer promise becomes a lie the team never even hears.
   */
  async function captureLead(args) {
    const procedure = String(args?.procedure || '').trim();
    if (!procedure) return { ok: false, error: 'missing_procedure' };
    const originCity = String(args?.originCity || '').trim() || null;
    const travelWindow = String(args?.travelWindow || '').trim() || null;
    const notes = String(args?.notes || '').trim().slice(0, 300) || null;
    const snippet = '[voice call]';

    try {
      await store.leads?.upsertOpen?.(tenantId, {
        conversationId,
        patientWaId,
        procedure,
        originCountry: null,
        details: { reason: 'facilitator_qualified_voice', originCity, travelWindow, notes, snippet },
      });
    } catch (err) {
      // The owner alert below still fires: a broken leads table must not also
      // cost the agency the ping.
      log('[voice-brain] lead upsert failed:', err?.message || err);
    }
    try {
      bus?.publish?.('lead.hot', {
        tenantId,
        conversationId,
        lead: {
          reason: 'facilitator_qualified',
          procedure,
          country: null,
          patientWaId,
          conversationId,
          snippet,
        },
      });
    } catch (err) {
      log('[voice-brain] lead.hot publish failed:', err?.message || err);
    }
    state.lead = { procedure, originCity, travelWindow };
    return {
      ok: true,
      note: 'Saved. NOW you may make the promise: the team finds the right clinic and comes back with an offer today. Then stop asking questions.',
    };
  }

  /**
   * The model has said goodbye and wants the line closed. This writes NOTHING
   * and decides NOTHING: it raises a flag, and brain/loop.js hangs up only once
   * the farewell has actually reached the wire. Keeping it inert is the point —
   * a tool that terminated the call directly would cut the model off mid-word,
   * which is precisely the failure it exists to fix.
   */
  async function endCall() {
    state.endRequested = true;
    return { ok: true, note: 'The call will end as soon as your goodbye has finished playing. Say nothing further.' };
  }

  const TOOLS = {
    get_available_slots: getAvailableSlots,
    stage_booking: stageBooking,
    confirm_booking: confirmBooking,
    request_handoff: requestHandoff,
    capture_lead: captureLead,
    end_call: endCall,
  };
  // Capability, not prose. A model can hallucinate a tool name it was never
  // given, so the executor re-checks what this tenant type may do at all.
  // end_call is on BOTH lists: every tenant type has to be able to put the
  // phone down.
  const ALLOWED = facilitator
    ? new Set(['capture_lead', 'request_handoff', 'end_call'])
    : new Set(['get_available_slots', 'stage_booking', 'confirm_booking', 'request_handoff', 'end_call']);

  return {
    /**
     * Execute one function call. NEVER throws — a tool error must come back as
     * data the model can talk its way out of, not as a dropped call.
     * @param {{name:string, args:object}} call
     */
    async exec({ name, args } = {}) {
      const fn = TOOLS[name];
      if (!fn) return { ok: false, error: 'unknown_tool' };
      if (!ALLOWED.has(name)) {
        return { ok: false, error: facilitator ? 'booking_not_supported' : 'not_supported' };
      }
      try {
        return await fn(args || {});
      } catch (err) {
        log(`[voice-brain] tool ${name} failed:`, err?.message || err);
        return { ok: false, error: 'internal_error' };
      }
    },
  };
}

export default createToolExecutor;
