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
  return t(lang, 'confirmSummary', {
    specialty: specialtyLabel(clinic, d.specialty, lang),
    when: formatWhen(new Date(d.slotIso), lang),
    name: d.name,
    origin: originDisplay(d),
    contact: d.contact,
  });
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

function genRef(clinic, store, now) {
  const prefix = clinic.id.split('-').map((w) => w[0]).join('').toUpperCase().slice(0, 3);
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const seq = String(store.listAppointments({ clinicId: clinic.id }).length + 1).padStart(3, '0');
  return `${prefix}-${yy}${mm}${dd}-${seq}`;
}

// ── entry points ────────────────────────────────────────────────────────────
export function startBooking(ctx) {
  const { convo, text, clinic } = ctx;
  convo.state = { flow: 'booking', step: null, data: {} };
  // Pre-fill the specialty if the opening message already named one
  // ("I want to book cardiology" -> skip the specialty question).
  const sp = extractSpecialty(text, clinic);
  if (sp) convo.state.data.specialty = sp.id;
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
    if (yn === 'yes') return finalizeBooking(ctx);
    if (yn === 'no') return cancelBooking(ctx);
    return { intent: 'book_appointment', replies: [t(lang, 'confirmRetry'), buildSummary(ctx)] };
  }

  // Unknown step — restart cleanly.
  return startBooking(ctx);
}

export function finalizeBooking(ctx) {
  const { convo, clinic, lang, store, inbound, now } = ctx;
  const d = convo.state.data;
  const ref = genRef(clinic, store, now);
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
    originCountry: d.originCountry || 'Libya',
    originRaw: d.originRaw || null,
    contact: d.contact,
    lang,
    channel: inbound.channel || 'whatsapp',
    status: 'confirmed',
    createdAt: now.toISOString(),
  };
  store.createAppointment(appt);
  convo.state = null; // flow complete

  const reply = t(lang, 'booked', {
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

export { STEPS, specialtyLabel, specialtyList, buildSummary };
