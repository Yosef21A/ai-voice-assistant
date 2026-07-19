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

const base = getConfig();
const config = { ...base, runtimeDir: path.join(base.dataDir, 'runtime-sim') };
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
  let booked = null;
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
    line(`\n👤  ${msg}`);
    line(`🤖  ${out.reply.replace(/\n/g, '\n    ')}`);
    if (out.appointment) booked = out.appointment;
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

async function main() {
  line('\n╔══════════════════════════════════════════════════════════════╗');
  line('║   omen-clinic-agent — offline conversation simulator          ║');
  line('║   provider: ' + provider.name.padEnd(48) + ' ║');
  line('╚══════════════════════════════════════════════════════════════╝');

  const arAppt = await runFlow(arabicFlow);
  const frAppt = await runFlow(frenchFlow);
  await runFlow(englishShowcase);

  hr();
  line('  📋  STORED APPOINTMENTS');
  hr();
  const appts = store.listAppointments();
  line(JSON.stringify(appts, null, 2));
  line('');

  // Validate the demo actually did its job (non-zero exit on failure).
  const problems = [];
  if (appts.length < 2) problems.push(`expected >= 2 appointments, got ${appts.length}`);
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
  hr();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
