// Stateful booking flow. Collects, in order:
//   specialty -> date/time -> patient name -> origin city/country -> contact
// then a confirmation step that creates the appointment in the store.
//
// State lives on the conversation record (convo.state) so it survives across
// WhatsApp turns:
//   convo.state = { flow:'booking', step:<STEP>, data:{...collected...} }
import { t } from './responses.js';
import {
  extractSpecialty,
  extractName,
  extractOrigin,
  extractContact,
  detectYesNo,
} from './slots.js';
import { parseDateTimeRequest, resolveSlot, formatWhen } from './datetime.js';
// Leaf module — voiceSlots.js imports nothing from here, so there is no cycle.
import { blocksFinalize, markEchoed } from './voiceSlots.js';
// Leaf module too (D1): tenant type + doctor persona + default specialty.
import { defaultSpecialtyId, hasDoctorPersona, doctorName, isCabinet } from './tenantProfile.js';

const STEPS = ['specialty', 'datetime', 'name', 'origin', 'contact', 'confirm'];

// ── helpers ─────────────────────────────────────────────────────────────────
function specialtyLabel(clinic, id, lang) {
  const sp = (clinic.specialties || []).find((s) => s.id === id);
  return sp ? sp.labels?.[lang] || sp.labels?.fr || sp.labels?.en || id : id;
}

function specialtyList(clinic, lang) {
  return (clinic.specialties || [])
    .map((s) => s.labels?.[lang] || s.labels?.fr || s.labels?.en || s.id)
    .join(' · ');
}

function originDisplay(data) {
  if (data.originCity) {
    return data.originCountry ? `${data.originCity}, ${data.originCountry}` : data.originCity;
  }
  return data.originRaw || '-';
}

function nextStep(data) {
  if (!data.specialty) return 'specialty';
  if (!data.slotIso) return 'datetime';
  if (!data.name) return 'name';
  if (!data.originCity && !data.originRaw) return 'origin';
  if (!data.contact) return 'contact';
  return 'confirm';
}

function buildSummary(ctx) {
  const { clinic, lang, convo } = ctx;
  const d = convo.state.data;
  // The recap IS the voice read-back (V1 humility guardrail): it restates every
  // captured fact from re-derived values, so it is a strict superset of any
  // per-slot confirmation. Promoting here — the ONE place the recap is
  // rendered — covers both the llm executor and the classic flow, so a voice
  // booking costs zero extra turns while still never locking an unheard value.
  markEchoed(d);
  const summary = t(lang, 'confirmSummary', {
    // Cabinet persona (D1): the recap names the doctor. Absent → byte-identical
    // pre-D1 output, so clinic tenants cannot regress.
    doctor: hasDoctorPersona(clinic) ? doctorName(clinic, lang) : null,
    specialty: specialtyLabel(clinic, d.specialty, lang),
    when: formatWhen(new Date(d.slotIso), lang),
    name: d.name,
    origin: originDisplay(d),
    contact: d.contact,
  });
  // Adjustment transparency: a silently shifted time must be re-stated at the
  // recap, not just once mid-flow (spec P2-HUMANIZE §3).
  if (d.slotAdjusted) {
    return `${t(lang, 'adjustedInRecap', { when: formatWhen(new Date(d.slotIso), lang) })}\n\n${summary}`;
  }
  return summary;
}

function promptFor(step, ctx) {
  const { clinic, lang } = ctx;
  switch (step) {
    case 'specialty':
      return t(lang, 'askSpecialty', { list: specialtyList(clinic, lang) });
    case 'datetime':
      return t(lang, 'askDatetime');
    case 'name':
      return t(lang, 'askName');
    case 'origin':
      return t(lang, 'askOrigin');
    case 'contact':
      return t(lang, 'askContact');
    case 'confirm':
      return buildSummary(ctx);
    default:
      return '';
  }
}

function advanceBooking(ctx, opts = {}) {
  const { convo } = ctx;
  const step = nextStep(convo.state.data);
  convo.state.step = step;
  const replies = [];
  if (opts.intro) replies.push(t(ctx.lang, 'bookingIntro'));
  if (opts.note) replies.push(opts.note);
  replies.push(promptFor(step, ctx));
  return { intent: 'book_appointment', replies };
}

// Async since P1-G: listAppointments is a SQL query on the Postgres adapter
// (and a plain array on JSON — awaiting it is a no-op).
async function genRef(clinic, store, now) {
  const prefix = clinic.id.split('-').map((w) => w[0]).join('').toUpperCase().slice(0, 3);
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const appts = await store.listAppointments({ clinicId: clinic.id });
  const seq = String(appts.length + 1).padStart(3, '0');
  return `${prefix}-${yy}${mm}${dd}-${seq}`;
}

// ── entry points ────────────────────────────────────────────────────────────
export function startBooking(ctx) {
  const { convo, text, clinic } = ctx;
  // Keep already-collected slots when a stale flow restarts (P2-HUMANIZE F9:
  // state decay drops the "expected answer" lock but never the data).
  const prior = convo.state?.flow === 'booking' ? convo.state.data || {} : {};
  convo.state = { flow: 'booking', step: null, data: { ...prior } };
  // Pre-fill the specialty if the opening message already named one
  // ("I want to book cardiology" -> skip the specialty question).
  const sp = extractSpecialty(text, clinic);
  if (sp) convo.state.data.specialty = sp.id;
  // D1: a single-specialty practice (or a cabinet) NEVER asks "which specialty?"
  // — there is only one answer, and asking it is what makes a doctor's bot feel
  // like a switchboard. (On a voice turn the engine's provenance diff may mark
  // this config-derived value 'heard'; that is benign — the recap read-back
  // echoes it like any other slot, at zero extra turns.)
  if (!convo.state.data.specialty) {
    const def = defaultSpecialtyId(clinic);
    if (def) convo.state.data.specialty = def;
  }
  return advanceBooking(ctx, { intro: true });
}

export function continueBooking(ctx) {
  const { convo, text, clinic, lang, now } = ctx;
  const step = convo.state.step;
  const data = convo.state.data;

  if (step === 'specialty') {
    const sp = extractSpecialty(text, clinic);
    if (!sp) {
      return {
        intent: 'book_appointment',
        replies: [t(lang, 'specialtyUnknown', { list: specialtyList(clinic, lang) })],
      };
    }
    data.specialty = sp.id;
    return advanceBooking(ctx);
  }

  if (step === 'datetime') {
    const req = parseDateTimeRequest(text, now);
    const slot = resolveSlot(clinic, req, now);
    if (!slot) return { intent: 'book_appointment', replies: [t(lang, 'datetimeUnknown')] };
    data.slotIso = slot.iso;
    data.slotAdjusted = slot.adjusted;
    data.datetimeRaw = text;
    const note = slot.adjusted
      ? t(lang, 'datetimeAdjusted', { when: formatWhen(slot.date, lang) })
      : null;
    return advanceBooking(ctx, { note });
  }

  if (step === 'name') {
    const name = extractName(text, lang);
    if (!name) return { intent: 'book_appointment', replies: [t(lang, 'askName')] };
    data.name = name;
    return advanceBooking(ctx);
  }

  if (step === 'origin') {
    const o = extractOrigin(text);
    data.originCity = o.city;
    data.originCountry = o.country;
    data.originRaw = o.raw;
    return advanceBooking(ctx);
  }

  if (step === 'contact') {
    const contact = extractContact(text);
    if (!contact) return { intent: 'book_appointment', replies: [t(lang, 'contactUnknown')] };
    data.contact = contact;
    return advanceBooking(ctx);
  }

  if (step === 'confirm') {
    const yn = detectYesNo(text);
    // Voice humility gate (V1). This is the CLASSIC twin of the same check in
    // the humanize executor — and it is not redundant: engine/index.js drops to
    // classic route() on ANY llm failure (a timeout or a 429, which is exactly
    // what happens right after an STT call spends the quota), so without this
    // line a voice-derived slot could be finalized here with no read-back.
    if (yn === 'yes' && !blocksFinalize(data)) return finalizeBooking(ctx);
    if (yn === 'no') return cancelBooking(ctx);
    return { intent: 'book_appointment', replies: [t(lang, 'confirmRetry'), buildSummary(ctx)] };
  }

  // Unknown step — restart cleanly.
  return startBooking(ctx);
}

export async function finalizeBooking(ctx) {
  const { convo, clinic, lang, store, inbound, now } = ctx;
  const d = convo.state.data;
  const ref = await genRef(clinic, store, now);
  const spLabel = specialtyLabel(clinic, d.specialty, lang);
  const when = formatWhen(new Date(d.slotIso), lang);

  const appt = {
    id: `apt_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
    ref,
    clinicId: clinic.id,
    clinicName: clinic.name,
    patientWaId: inbound.from,
    specialty: d.specialty,
    specialtyLabel: spLabel,
    datetimeISO: d.slotIso,
    datetimeAdjusted: !!d.slotAdjusted,
    patientName: d.name,
    originCity: d.originCity || null,
    // The Libya default is a MEDICAL-TOURISM assumption (most clinic patients
    // cross the border). A cabinet is a local practice — its walk-ins default
    // to the practice's own country, never to a tourism corridor (D1 review).
    originCountry: d.originCountry || (isCabinet(clinic) ? clinic.country || null : 'Libya'),
    originRaw: d.originRaw || null,
    contact: d.contact,
    lang,
    channel: inbound.channel || 'whatsapp',
    status: 'confirmed',
    createdAt: now.toISOString(),
  };
  await store.createAppointment(appt);
  convo.state = null; // flow complete

  // Cabinet persona (D1): the confirmation names the doctor and closes like a
  // local practice; clinics keep the international-patients closing.
  const reply = hasDoctorPersona(clinic)
    ? t(lang, 'bookedCabinet', {
        ref,
        clinic: clinic.name,
        doctor: doctorName(clinic, lang),
        when,
        name: d.name,
        contact: d.contact,
        handoff: clinic.handoff?.phone || '',
      })
    : t(lang, 'booked', {
        ref,
        clinic: clinic.name,
        specialty: spLabel,
        when,
        name: d.name,
        origin: originDisplay(d),
        contact: d.contact,
        handoff: clinic.handoff?.phone || '',
      });
  return { intent: 'book_appointment', replies: [reply], appointment: appt };
}

export function cancelBooking(ctx) {
  ctx.convo.state = null;
  return { intent: 'cancel', replies: [t(ctx.lang, 'cancelled')] };
}

// genRef is exported since V2: the voice tier books through its own two-phase
// tool gate (src/voice-call/brain/tools.js) but MUST mint the same human
// reference the chat flow does — the clinic reads one appointments list, not two.
export { STEPS, specialtyLabel, specialtyList, buildSummary, nextStep, genRef };
