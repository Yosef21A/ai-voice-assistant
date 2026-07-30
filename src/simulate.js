// End-to-end sales demo. Drives scripted Arabic and French conversations through
// the SAME engine the webhook uses, printing the dialogue and the resulting
// stored appointments. Runs fully offline with the mock provider.
//
//   npm run simulate
import path from 'node:path';
import { getConfig } from './config.js';
import { createStore } from './store/index.js';
import { createEngine } from './engine/index.js';
import { getProvider } from './llm/index.js';
import { isWithinWorkingHours } from './store/availability.js';
import { analyzeInbound } from './notifications/index.js';

const base = getConfig();
// The demo is byte-for-byte reproducible: always the classic deterministic
// flow, even when a real .env carries a Gemini key (llm mode is webhook-only
// until you opt in via the server).
const config = {
  ...base,
  runtimeDir: path.join(base.dataDir, 'runtime-sim'),
  conversationMode: 'classic',
};
const store = createStore({
  clinicsFile: config.clinicsFile,
  runtimeDir: config.runtimeDir,
  reset: true,
});
const provider = getProvider(config);
const engine = createEngine({ store, provider, config });

// Fixed reference time so the demo is byte-for-byte reproducible.
const NOW = new Date(2026, 7, 2, 9, 0, 0); // 02 Aug 2026, 09:00 local

const line = (s = '') => console.log(s);
const hr = () => line('─'.repeat(64));

async function runFlow({ title, phoneNumberId, from, script }) {
  hr();
  line(`  ${title}`);
  hr();
  const clinic = store.getClinicByPhoneNumberId(phoneNumberId);
  let booked = null;
  let leadShown = false; // the live service dedupes; here we just show it once
  for (const msg of script) {
    const out = await engine.handleMessage(
      {
        channel: 'simulate',
        from,
        text: msg,
        phoneNumberId,
        messageId: `sim_${Date.now()}`,
        timestamp: NOW.getTime(),
      },
      { now: NOW }
    );
    // Run the same safety + revenue detectors the live webhook runs (no bus here
    // — this is an offline demo), so the guardrail is visible end-to-end: an
    // emergency OVERRIDES the engine reply and the bot steps back.
    const analysis = analyzeInbound({
      tenant: clinic,
      text: msg,
      lang: out.lang,
      engineResult: out,
      waId: from,
    });
    const reply = analysis.overrideReply || out.reply;
    line(`\n👤  ${msg}`);
    line(`🤖  ${reply.replace(/\n/g, '\n    ')}`);
    if (analysis.emergency) {
      line('   🚨  emergency detected → bot stepped back, staff would be alerted');
    } else if (analysis.hot && !leadShown) {
      leadShown = true;
      line(`   🔥  hot lead detected → ${analysis.lead?.reason} (owner would be pinged once)`);
    }
    // Facilitator qualification (D2): persist the snapshot exactly as the
    // webhook ingest does — one open lead per conversation, updated per turn.
    if (out.facilitatorLead) {
      const fl = out.facilitatorLead;
      await store.leads.upsertOpen(clinic.id, {
        conversationId: `${clinic.id}:${from}`,
        patientWaId: from,
        procedure: fl.procedure || fl.procedureRaw || null,
        originCountry: fl.originCountry || null,
        details: {
          reason: 'facilitator_qualified',
          procedureLabel: fl.procedureLabel || null,
          originCity: fl.originCity || fl.originRaw || null,
          travelWindow: fl.travelWindow || null,
          budgetAsked: fl.budgetAsked || false,
          snippet: msg.slice(0, 160),
        },
      });
      if (fl.alert) line('   🤝  file qualified → agency owner would be pinged: prepare the offer TODAY');
    }
    if (!analysis.overrideReply && out.appointment) booked = out.appointment;
  }
  line('');
  return booked;
}

const arabicFlow = {
  title: '🇱🇾→🇹🇳  Arabic booking · Clinique El Amen (Sousse)',
  phoneNumberId: '1000000001',
  from: '218910000001',
  script: [
    'السلام عليكم',
    'نحب نحجز موعد',
    'أمراض القلب',
    'نهار الاثنين الساعة 10 صباحاً',
    'اسمي محمد العبيدي',
    'من طرابلس، ليبيا',
    'رقم الهاتف متاعي +218 91 000 0001',
    'نعم أكد الحجز',
  ],
};

const frenchFlow = {
  title: '🇱🇾→🇹🇳  French booking · Polyclinique Ennour (Sfax)',
  phoneNumberId: '1000000002',
  from: '218920000002',
  script: [
    'Bonjour',
    'Je voudrais prendre un rendez-vous',
    'Chirurgie esthétique',
    'vendredi à 11h',
    "Je m'appelle Amina Ben Salah",
    'je viens de Benghazi, Libye',
    'mon numéro est +218 92 000 0002',
    'oui je confirme',
  ],
};

// D1 cabinet mode: a single-doctor practice. The bot speaks as the doctor's
// assistant and NEVER asks "which specialty?" — note the script goes straight
// from booking intent to the day/time answer.
const cabinetFlow = {
  title: '🩺  Cabinet mode · Cabinet Dr. Ben Salem — Cardiologie (Sousse)',
  phoneNumberId: '1000000003',
  from: '21655000004',
  script: [
    'أهلا',
    'نحب ناخذ موعد مع الدكتور',
    'نهار الثلاثاء الساعة 9 صباحاً',
    'اسمي علي بن عمر',
    'من سوسة',
    'رقمي +216 22 123 456',
    'نعم',
  ],
};

// D2 facilitator mode: a medical-tourism agency. No booking flow exists — the
// conversation QUALIFIES the patient (procedure → origin → travel window →
// contact) and ends on the same-day-offer promise. The lead lands on the
// agency's Leads board (persisted below exactly as the webhook ingest does).
const facilitatorFlow = {
  title: '🤝  Facilitator mode · MedTour — Tripoli ⇄ Sousse (agency concierge)',
  phoneNumberId: '1000000004',
  from: '218925550066',
  script: [
    'السلام عليكم',
    'نحب نعمل زرع أسنان في تونس',
    'من طرابلس، ليبيا',
    'الشهر الجاي إن شاء الله',
    'رقمي +218 92 555 0066',
  ],
};

// A short English showcase (no booking): pricing, travel, FAQ, handoff.
const englishShowcase = {
  title: '🇬🇧  English concierge showcase · El Amen (pricing / travel / FAQ / handoff)',
  phoneNumberId: '1000000001',
  from: '218930000003',
  script: [
    'Hello',
    'How much is dental?',
    'Do I need a visa to travel from Libya?',
    'Can I talk to a human?',
  ],
};

// Safety guardrail showcase: a booking that turns into an emergency mid-flow.
// The detector OVERRIDES the engine reply with the localized emergency message
// (numbers + "the bot is stepping back"), exactly as the live webhook does.
const emergencyShowcase = {
  title: '🚨  Safety guardrail · El Amen (emergency → bot steps back)',
  phoneNumberId: '1000000001',
  from: '218940000005',
  script: ['نحب نحجز موعد', 'صدري يوجعني برشا وما نجمّش نتنفّس'],
};

async function main() {
  line('\n╔══════════════════════════════════════════════════════════════╗');
  line('║   omen-clinic-agent — offline conversation simulator          ║');
  line('║   provider: ' + provider.name.padEnd(48) + ' ║');
  line('╚══════════════════════════════════════════════════════════════╝');

  const arAppt = await runFlow(arabicFlow);
  const frAppt = await runFlow(frenchFlow);
  const cabAppt = await runFlow(cabinetFlow);
  await runFlow(facilitatorFlow);
  await runFlow(englishShowcase);
  await runFlow(emergencyShowcase);

  hr();
  line('  📋  STORED APPOINTMENTS');
  hr();
  const appts = store.listAppointments();
  line(JSON.stringify(appts, null, 2));
  line('');

  // Validate the demo actually did its job (non-zero exit on failure).
  const problems = [];
  if (appts.length < 3) problems.push(`expected >= 3 appointments, got ${appts.length}`);
  // D1: the cabinet booking must exist, on the cabinet tenant, under its single
  // specialty — proof the flow completed WITHOUT a specialty question.
  const cab = appts.find((a) => a.clinicId === 'cabinet-bensalem-sousse');
  if (!cab) problems.push('cabinet scenario booked no appointment');
  else if (cab.specialty !== 'cardiology') problems.push(`cabinet appointment specialty ${cab.specialty}, expected cardiology`);
  // D2: the facilitator scenario must have produced a RICH lead — and no
  // appointment (an agency has no calendar to book).
  const facLeads = await store.leads.list('medtour-tripoli-sousse', {});
  const facLead = facLeads[0];
  if (!facLead) problems.push('facilitator scenario produced no lead');
  else {
    if (facLead.procedure !== 'dental') problems.push(`facilitator lead procedure ${facLead.procedure}, expected dental`);
    if (facLead.originCountry !== 'Libya') problems.push(`facilitator lead country ${facLead.originCountry}, expected Libya`);
    if (!facLead.details?.travelWindow) problems.push('facilitator lead missing travel window');
  }
  if (appts.some((a) => a.clinicId === 'medtour-tripoli-sousse')) {
    problems.push('facilitator tenant must never book an appointment');
  }
  for (const a of appts) {
    const clinic = store.getClinicById(a.clinicId);
    const d = new Date(a.datetimeISO);
    if (Number.isNaN(d.getTime())) problems.push(`${a.ref}: invalid datetime`);
    else if (!isWithinWorkingHours(clinic, d)) problems.push(`${a.ref}: slot outside working hours`);
    if (a.status !== 'confirmed') problems.push(`${a.ref}: status ${a.status}`);
    if (!a.patientName) problems.push(`${a.ref}: missing patient name`);
    if (!a.contact) problems.push(`${a.ref}: missing contact`);
  }

  hr();
  if (problems.length) {
    line('  ❌  DEMO FAILED');
    for (const p of problems) line('     - ' + p);
    hr();
    process.exit(1);
  }
  line(`  ✅  DEMO OK — ${appts.length} appointments booked, all valid & in working hours.`);
  if (arAppt && frAppt) {
    line(`      AR ref ${arAppt.ref} · ${arAppt.specialtyLabel} · ${arAppt.datetimeISO}`);
    line(`      FR ref ${frAppt.ref} · ${frAppt.specialtyLabel} · ${frAppt.datetimeISO}`);
  }
  if (cabAppt) {
    line(`      🩺 cabinet ref ${cabAppt.ref} · Dr Ben Salem · ${cabAppt.datetimeISO} (no specialty question asked)`);
  }
  if (facLead) {
    line(`      🤝 facilitator lead · ${facLead.procedure} · ${facLead.details?.originCity || '?'} (${facLead.originCountry}) · window "${facLead.details?.travelWindow}" — offer promised today`);
  }
  hr();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
