// The deterministic law of a voice call (V2) — the two-phase booking gate.
//
// These tests exist because of one specific failure mode: a large model on a
// phone line telling a patient "you're booked for Thursday at ten" when nothing
// exists anywhere. Everything below is an attempt to make that impossible
// rather than unlikely. Real store, real bus, real clinic records; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers/client.js';
import {
  buildToolDeclarations,
  createToolExecutor,
  nextOpenSlots,
  detectHalfDay,
  formatWhenSpoken,
} from '../src/voice-call/brain/tools.js';
import { windowFor, SLOT_MIN } from '../src/store/availability.js';

const CLINIC = 'el-amen-sousse';
const CABINET = 'cabinet-bensalem-sousse';
const FACILITATOR = 'medtour-tripoli-sousse';
const WA = '218911234567'; // a Libyan caller

// Wednesday 5 Aug 2026, 10:00 LOCAL. Built from parts on purpose: the datetime
// helpers work in machine-local time, so a 'Z' literal would make this suite's
// expectations depend on the CI box's timezone.
const NOW = () => new Date(2026, 7, 5, 10, 0, 0);

async function setup(tenantId = CLINIC, over = {}) {
  const app = makeTestApp();
  const clinic = app.store.getClinicById(tenantId);
  const convo = await app.store.conversations.create(tenantId, { patientWaId: WA, status: 'open' });
  const events = [];
  const unsub = app.bus.subscribe((e) => events.push(e));
  // The loop maintains these three; here the test plays the loop.
  const callState = {
    staged: null,
    booked: null,
    handoff: false,
    emergency: false,
    toolBatchId: 0,
    lastCallerSpeechAt: 0,
    speechSinceStage: '',
  };
  const executor = createToolExecutor({
    clinic,
    convo,
    store: app.store,
    bus: app.bus,
    callState,
    lang: 'ar',
    now: NOW,
    ...over,
  });
  /** Run one tool call inside its own batch, the way the loop does. */
  const exec = async (call) => {
    callState.toolBatchId += 1;
    return executor.exec(call);
  };
  /** The caller says something — what unlocks confirm_booking. */
  const caller = (text) => {
    callState.lastCallerSpeechAt = NOW().getTime() + 1000;
    if (callState.staged) callState.speechSinceStage += text;
  };
  return { app, clinic, convo, events, unsub, callState, exec, caller, tenantId, executor };
}

const ofType = (events, type) => events.filter((e) => e.type === type);
const appts = (app, tenantId) => app.store.listAppointments({ clinicId: tenantId });

// ── declarations: capability, not just prose ────────────────────────────────

test('a clinic gets five tools; a facilitator gets ONE booking-free pair, plus the hang-up', () => {
  const app = makeTestApp();
  const names = (id) => buildToolDeclarations({ clinic: app.store.getClinicById(id) }).map((d) => d.name);

  assert.deepEqual(names(CLINIC), [
    'get_available_slots',
    'stage_booking',
    'confirm_booking',
    'request_handoff',
    'end_call',
  ]);
  assert.deepEqual(names(CABINET), [
    'get_available_slots',
    'stage_booking',
    'confirm_booking',
    'request_handoff',
    'end_call',
  ]);
  // D2: an agency has no calendar. The booking capability does not EXIST for it
  // — a gate in code, not a sentence in a prompt asking it not to. What it DOES
  // get is the lead capture, because a qualified caller the team never hears
  // about is worth the same as a call that never came.
  assert.deepEqual(names(FACILITATOR), ['capture_lead', 'request_handoff', 'end_call']);
  // V5-T2: EVERY tenant type can put the phone down. A facilitator that
  // finishes a qualification and then holds the line open is the same bug.
  for (const id of [CLINIC, CABINET, FACILITATOR]) assert.ok(names(id).includes('end_call'));
  // …and the reverse: a clinic must never be handed the agency's tool.
  assert.ok(!names(CLINIC).includes('capture_lead'));
  assert.ok(!names(CABINET).includes('capture_lead'));
});

test('there is deliberately no pricing or quoting tool on any tenant type', () => {
  const app = makeTestApp();
  for (const id of [CLINIC, CABINET, FACILITATOR]) {
    const decls = buildToolDeclarations({ clinic: app.store.getClinicById(id) });
    const blob = JSON.stringify(decls).toLowerCase();
    assert.ok(!/price|pricing|quote|tarif|cost/.test(blob), `${id} exposes a pricing action`);
  }
});

// ── stage: validate, echo, write NOTHING ────────────────────────────────────

test('stage_booking validates deterministically and returns a spoken recap — writing nothing', async (t) => {
  const s = await setup();
  t.after(() => s.unsub());

  const r = await s.exec({
    name: 'stage_booking',
    args: { specialty: 'قلب', datetimeText: 'الخميس 10', name: 'محمد الهادي', contact: '0021650123456' },
  });

  assert.equal(r.ok, true);
  assert.ok(r.recap.includes('محمد الهادي'), 'the recap names the patient');
  assert.ok(r.recap.includes('0021650123456'), 'and reads back the number they gave');
  // SPOKEN, not "06/08/2026 10:00" — nobody says a slash out loud.
  assert.ok(r.recap.includes('الخميس 6 أوت'), 'the date is spoken, not printed');
  assert.ok(r.recap.includes('10 صباحاً'), 'and so is the hour');
  assert.ok(!/\d{2}\/\d{2}\/\d{4}/.test(r.recap), 'no dd/mm/yyyy ever reaches a mouth');
  assert.equal(r.adjusted, false);
  assert.equal(s.callState.staged.specialty, 'cardiology', 'derja "قلب" resolved by the engine extractor');
  assert.match(s.callState.staged.slotIso, /T10:00$/);

  // THE POINT: nothing exists yet.
  assert.equal((await appts(s.app, CLINIC)).length, 0, 'staging must never write');
  assert.equal(ofType(s.events, 'appointment.created').length, 0);
});

test('a time we had to move is disclosed IN the recap, not silently swallowed', async (t) => {
  const s = await setup();
  t.after(() => s.unsub());

  // 23:00 is nowhere near the 08:30–17:30 window; resolveSlot clamps it.
  const r = await s.exec({
    name: 'stage_booking',
    args: { specialty: 'dental', datetimeText: 'الخميس 23:00', name: 'Sara', contact: '21650111222' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.adjusted, true);
  assert.ok(r.recap.length > 40);
  assert.ok(!/23:00/.test(r.recap), 'the recap states the REAL time, not the requested one');
  // The disclosure sentence precedes the recap so both are heard in one breath.
  assert.ok(/17:00|الوقت اللي طلبتو/.test(r.recap), 'the adjustment is spoken');
});

test('stage_booking refuses instead of guessing when a field is unusable', async (t) => {
  const s = await setup();
  t.after(() => s.unsub());

  const noName = await s.exec({
    name: 'stage_booking',
    args: { specialty: 'dental', datetimeText: 'غدوة', name: '', contact: '21650111222' },
  });
  assert.equal(noName.ok, false);
  assert.equal(noName.error, 'missing_name');
  assert.equal(s.callState.staged, null);

  const noSpecialty = await s.exec({
    name: 'stage_booking',
    args: { specialty: 'astrology', datetimeText: 'غدوة', name: 'Ali', contact: '21650111222' },
  });
  assert.equal(noSpecialty.ok, false);
  assert.equal(noSpecialty.error, 'unknown_specialty');
  assert.ok(noSpecialty.options.length >= 5, 'the agent is handed the real list to offer');
});

test('the contact falls back to the number they are CALLING from, never to nothing', async (t) => {
  const s = await setup();
  t.after(() => s.unsub());
  const r = await s.exec({
    name: 'stage_booking',
    args: { specialty: 'dental', datetimeText: 'الخميس 10', name: 'Ali Ben Salah' },
  });
  assert.equal(r.ok, true);
  assert.equal(s.callState.staged.contact, WA);
  assert.ok(r.recap.includes(WA));
});

// ── THE GATE ────────────────────────────────────────────────────────────────

test('REGRESSION: stage + confirm in ONE tool batch books nothing', async (t) => {
  // Reproduced before the fix: a single batch carrying both calls wrote
  // appointment CX-260803-001 with ZERO caller speech in the transcript. The
  // recap had not been synthesized, let alone spoken, let alone agreed to.
  const s = await setup();
  t.after(() => s.unsub());

  s.callState.toolBatchId += 1; // ONE batch, both calls — what the model did
  const staged = await s.executor.exec({
    name: 'stage_booking',
    args: { specialty: 'cardiology', datetimeText: 'الخميس 10', name: 'محمد', contact: '21650123456' },
  });
  assert.equal(staged.ok, true);
  const confirmed = await s.executor.exec({ name: 'confirm_booking', args: {} });

  assert.equal(confirmed.ok, false);
  assert.equal(confirmed.error, 'read_recap_first');
  assert.ok(confirmed.recap, 'the tool hands the recap back so the agent can read it');
  assert.equal((await appts(s.app, CLINIC)).length, 0, 'nothing may reach the database');
  assert.equal(ofType(s.events, 'appointment.created').length, 0);
  assert.ok(s.callState.staged, 'the stage survives — the agent just has to read it');

  // …and once it IS read and answered, the same confirm succeeds.
  s.caller('نعم صحيح');
  const second = await s.exec({ name: 'confirm_booking', args: {} });
  assert.equal(second.ok, true);
  assert.equal((await appts(s.app, CLINIC)).length, 1);
});

test('REGRESSION: a later batch is still refused until the caller has SPOKEN', async (t) => {
  const s = await setup();
  t.after(() => s.unsub());

  await s.exec({
    name: 'stage_booking',
    args: { specialty: 'cardiology', datetimeText: 'الخميس 10', name: 'محمد', contact: '21650123456' },
  });
  // New batch, but dead air on the line — the agent never got an answer.
  const r = await s.exec({ name: 'confirm_booking', args: {} });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'read_recap_first');
  assert.equal((await appts(s.app, CLINIC)).length, 0);
});

test('REGRESSION: a spoken "لا" after the recap drops the stage instead of booking it', async (t) => {
  const s = await setup();
  t.after(() => s.unsub());

  await s.exec({
    name: 'stage_booking',
    args: { specialty: 'cardiology', datetimeText: 'الخميس 10', name: 'محمد', contact: '21650123456' },
  });
  s.caller('لا، ما يمشيش');
  const r = await s.exec({ name: 'confirm_booking', args: {} });

  assert.equal(r.ok, false);
  assert.equal(r.error, 'caller_declined');
  assert.equal(s.callState.staged, null, 'a refused booking must not stay confirmable');
  assert.equal((await appts(s.app, CLINIC)).length, 0);

  // A bare retry now hits the first condition, not the third.
  assert.equal((await s.exec({ name: 'confirm_booking', args: {} })).error, 'nothing_staged');
});

test('confirm_booking REFUSES when nothing was staged and read aloud', async (t) => {
  const s = await setup();
  t.after(() => s.unsub());

  const r = await s.exec({ name: 'confirm_booking', args: {} });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'nothing_staged');
  assert.equal((await appts(s.app, CLINIC)).length, 0, 'a bare confirm cannot create an appointment');
  assert.equal(ofType(s.events, 'appointment.created').length, 0);
});

test('confirm_booking after a stage, a read-back and a yes writes the appointment', async (t) => {
  const s = await setup();
  t.after(() => s.unsub());

  await s.exec({
    name: 'stage_booking',
    args: { specialty: 'cardiology', datetimeText: 'الخميس 10', name: 'محمد', contact: '21650123456' },
  });
  s.caller('نعم صحيح'); // the agent read the recap; the caller answered
  const r = await s.exec({ name: 'confirm_booking', args: {} });

  assert.equal(r.ok, true);
  assert.match(r.ref, /^EAS-\d{6}-\d{3}$/, 'the SAME reference format the chat flow mints');

  const rows = await appts(s.app, CLINIC);
  assert.equal(rows.length, 1);
  const a = rows[0];
  assert.equal(a.ref, r.ref);
  assert.equal(a.channel, 'call', 'the clinic can tell a phone booking from a chat one');
  assert.equal(a.createdBy, 'bot');
  assert.equal(a.status, 'confirmed');
  assert.equal(a.patientWaId, WA);
  assert.equal(a.patientName, 'محمد');
  assert.equal(a.contact, '21650123456');
  assert.equal(a.specialty, 'cardiology');
  assert.equal(a.specialtyLabel, 'أمراض القلب');
  assert.match(a.datetimeISO, /T10:00$/);
  assert.equal(a.originCountry, 'Libya', 'a clinic sits on the medical-tourism corridor');
  assert.equal(a.lang, 'ar');

  const published = ofType(s.events, 'appointment.created');
  assert.equal(published.length, 1);
  assert.equal(published[0].tenantId, CLINIC);
  assert.equal(published[0].conversationId, s.convo.id);
  assert.equal(published[0].appointment.ref, r.ref);

  // The stage is consumed: a second confirm cannot double-book the same slot.
  //
  // V8 — and it now IDEMPOTENTLY returns the same reference rather than an
  // error. The orchestrator fires confirm_booking itself the moment the caller
  // says yes to a recap it heard, so a model that then emits its own
  // confirm_booking is the ordinary case, not a bug. It must never produce a
  // second appointment, and it must never be told "nothing is staged" about a
  // booking it can already read the reference of.
  const again = await s.exec({ name: 'confirm_booking', args: {} });
  assert.equal(again.ok, true);
  assert.equal(again.already, true, 'a no-op, not a write');
  assert.equal(again.ref, r.ref, 'the SAME reference, never a new one');
  assert.equal((await appts(s.app, CLINIC)).length, 1);
  assert.equal(ofType(s.events, 'appointment.created').length, 1, 'and no second publish');
});

test('a re-stage replaces the previous one (the caller said "no, Friday")', async (t) => {
  const s = await setup();
  t.after(() => s.unsub());

  await s.exec({
    name: 'stage_booking',
    args: { specialty: 'dental', datetimeText: 'الخميس 10', name: 'Ali', contact: '21650111222' },
  });
  const first = s.callState.staged.slotIso;
  s.caller('لا، الجمعة أحسن');
  await s.exec({
    name: 'stage_booking',
    args: { specialty: 'dental', datetimeText: 'الجمعة 9', name: 'Ali', contact: '21650111222' },
  });
  assert.notEqual(s.callState.staged.slotIso, first);
  assert.equal(s.callState.speechSinceStage, '', 'the re-stage resets the answer window');

  s.caller('نعم');
  await s.exec({ name: 'confirm_booking', args: {} });
  const rows = await appts(s.app, CLINIC);
  assert.equal(rows.length, 1, 'one appointment, the corrected one');
  assert.equal(rows[0].datetimeISO, s.callState.appointment.datetimeISO);
});

// ── tenant types ────────────────────────────────────────────────────────────

test('a cabinet books under its OWN specialty and never asks which one', async (t) => {
  const s = await setup(CABINET);
  t.after(() => s.unsub());

  // The caller says something else entirely; a doctor's practice has one
  // discipline and the config, not the conversation, decides it.
  await s.exec({
    name: 'stage_booking',
    args: { specialty: 'أسنان', datetimeText: 'الخميس 9', name: 'Nour', contact: '21650999888' },
  });
  assert.equal(s.callState.staged.specialty, 'cardiology');
  assert.equal(s.callState.staged.specialtyForced, true);

  s.caller('نعم');
  const r = await s.exec({ name: 'confirm_booking', args: {} });
  const rows = await appts(s.app, CABINET);
  assert.equal(rows[0].specialty, 'cardiology');
  assert.equal(rows[0].originCountry, 'Tunisia', 'a local practice is not a tourism corridor');
  assert.ok(r.ref);
});

test('a cabinet REFUSES a different discipline it really lists, instead of substituting', async (t) => {
  // A misconfigured (multi-entry) cabinet: the caller names one of the other
  // disciplines. Silently booking them under the primary would put a patient in
  // front of the wrong doctor — an honest refusal is the only safe answer.
  const app = makeTestApp();
  const clinic = app.store.getClinicById(CABINET);
  const original = clinic.specialties;
  const dental = app.store.getClinicById(CLINIC).specialties.find((sp) => sp.id === 'dental');
  clinic.specialties = [...original, dental];
  t.after(() => {
    clinic.specialties = original;
  });

  const convo = await app.store.conversations.create(CABINET, { patientWaId: WA, status: 'open' });
  const { exec } = createToolExecutor({
    clinic,
    convo,
    store: app.store,
    bus: app.bus,
    callState: { toolBatchId: 0 },
    lang: 'ar',
    patientWaId: WA,
    now: NOW,
  });

  const r = await exec({
    name: 'stage_booking',
    args: { specialty: 'أسنان', datetimeText: 'الخميس 9', name: 'Nour', contact: '21650999888' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'specialty_not_offered');
  assert.equal(r.requested, 'طب الأسنان', 'the tool names the discipline in the tenant\'s own words');
  assert.equal(r.offered, 'أمراض القلب');
  assert.equal((await appts(app, CABINET)).length, 0);
});

test("a cabinet's recap speaks the doctor's name", async (t) => {
  const s = await setup(CABINET);
  t.after(() => s.unsub());
  const r = await s.exec({
    name: 'stage_booking',
    args: { datetimeText: 'الخميس 9', name: 'Nour', contact: '21650999888' },
  });
  assert.ok(r.recap.includes('بن سالم'), 'the doctor persona reaches the spoken read-back');
});

test('a facilitator cannot book even if the model invents the tool name', async (t) => {
  const s = await setup(FACILITATOR);
  t.after(() => s.unsub());

  for (const name of ['stage_booking', 'confirm_booking', 'get_available_slots']) {
    const r = await s.exec({ name, args: { datetimeText: 'غدوة', name: 'X', contact: '218911111111' } });
    assert.equal(r.ok, false, `${name} must be refused for an agency`);
    assert.equal(r.error, 'booking_not_supported');
  }
  assert.equal((await appts(s.app, FACILITATOR)).length, 0);

  // …but the handoff works.
  const h = await s.exec({ name: 'request_handoff', args: { reason: 'wants a person' } });
  assert.equal(h.ok, true);
});

test('a clinic cannot use the agency tool either — the gate cuts both ways', async (t) => {
  const s = await setup();
  t.after(() => s.unsub());
  const r = await s.exec({ name: 'capture_lead', args: { procedure: 'dental' } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_supported');
});

// ── D2: the product moment ──────────────────────────────────────────────────

test('capture_lead files the qualified caller and pings the owner', async (t) => {
  const s = await setup(FACILITATOR);
  t.after(() => s.unsub());

  const r = await s.exec({
    name: 'capture_lead',
    args: { procedure: 'زراعة أسنان', originCity: 'طرابلس', travelWindow: 'الشهر الجاي', notes: 'مع مرافق' },
  });
  assert.equal(r.ok, true);
  assert.match(r.note, /NOW you may make the promise/, 'the promise comes AFTER the save, never before');

  const leads = await s.app.store.leads.list(FACILITATOR, {});
  assert.equal(leads.length, 1);
  assert.equal(leads[0].procedure, 'زراعة أسنان');
  assert.equal(leads[0].patientWaId, WA);
  assert.equal(leads[0].conversationId, s.convo.id);
  assert.equal(leads[0].details.reason, 'facilitator_qualified_voice');
  assert.equal(leads[0].details.originCity, 'طرابلس');
  assert.equal(leads[0].details.travelWindow, 'الشهر الجاي');

  const [hot] = ofType(s.events, 'lead.hot');
  assert.ok(hot, 'the owner is pinged the same way the chat flow pings');
  assert.equal(hot.tenantId, FACILITATOR);
  assert.equal(hot.lead.reason, 'facilitator_qualified');
  assert.equal(hot.lead.procedure, 'زراعة أسنان');
  assert.equal(hot.lead.snippet, '[voice call]');
  assert.equal(s.callState.lead.procedure, 'زراعة أسنان');
});

test('capture_lead refuses an empty procedure, and survives a broken leads table', async (t) => {
  const s = await setup(FACILITATOR);
  t.after(() => s.unsub());
  assert.deepEqual(await s.exec({ name: 'capture_lead', args: {} }), {
    ok: false,
    error: 'missing_procedure',
  });

  const events = [];
  const unsub = s.app.bus.subscribe((e) => events.push(e));
  t.after(() => unsub());
  const { exec } = createToolExecutor({
    clinic: s.clinic,
    convo: s.convo,
    store: {
      leads: {
        upsertOpen: async () => {
          throw new Error('leads table is on fire');
        },
      },
    },
    bus: s.app.bus,
    callState: {},
    lang: 'ar',
    patientWaId: WA,
    now: NOW,
    logger: () => {},
  });
  const r = await exec({ name: 'capture_lead', args: { procedure: 'dental' } });
  assert.equal(r.ok, true, 'a broken table must not also cost the agency the ping');
  assert.equal(events.filter((e) => e.type === 'lead.hot').length, 1);
});

// ── handoff ─────────────────────────────────────────────────────────────────

test('request_handoff flags the thread for a human and pings the owner', async (t) => {
  const s = await setup();
  t.after(() => s.unsub());

  const r = await s.exec({ name: 'request_handoff', args: { reason: 'asked for a person' } });
  assert.equal(r.ok, true);
  assert.equal(s.callState.handoff, true);

  const [ev] = ofType(s.events, 'handoff.requested');
  assert.ok(ev, 'the owner-notification pipeline is fed');
  assert.equal(ev.tenantId, CLINIC);
  assert.equal(ev.conversationId, s.convo.id);
  assert.equal(ev.patientWaId, WA);
  assert.equal(ev.lastMessage, '[voice call]');
  assert.equal(ev.handoff.keepActive, true, 'the bot keeps helping until staff replies');
  assert.equal(ev.handoff.channel, 'call');

  const convo = await s.app.store.conversations.getById(CLINIC, s.convo.id);
  assert.equal(convo.status, 'needs_human');
  assert.notEqual(convo.aiPaused, true, 'keepActive must NOT pause the bot');
});

// ── availability ────────────────────────────────────────────────────────────

// ── REGRESSION: the bare meridiem ───────────────────────────────────────────

test('REGRESSION: "الخميس العشية" offers and stages AFTERNOON slots', async (t) => {
  // Proven before the fix: parseDateTimeRequest only applies a meridiem once an
  // HOUR was parsed, so a bare "العشية" came back { hour: null }, resolved to
  // 08:30, and reported adjusted:false — the caller asked for the afternoon,
  // was booked for the morning, and was told nothing.
  const s = await setup();
  t.after(() => s.unsub());

  const offered = await s.exec({ name: 'get_available_slots', args: { dayText: 'الخميس العشية' } });
  assert.equal(offered.ok, true);
  assert.equal(offered.slots.length, 3);
  for (const slot of offered.slots) {
    assert.ok(slot.when.includes('بعد الظهر'), `"${slot.when}" is not an afternoon slot`);
  }

  const staged = await s.exec({
    name: 'stage_booking',
    args: { specialty: 'cardiology', datetimeText: 'الخميس العشية', name: 'محمد', contact: '21650123456' },
  });
  assert.equal(staged.ok, true);
  const at = new Date(s.callState.staged.slotDate);
  assert.equal(at.getDay(), 4, 'still Thursday — the DAY they asked for');
  assert.ok(at.getHours() >= 12, `staged ${at.getHours()}:00 — that is the morning`);
  assert.equal(staged.adjusted, false, 'we gave them what they asked for: no disclosure needed');
});

test('the French and English half-day words work the same way', async (t) => {
  const s = await setup(CLINIC, { lang: 'fr' });
  t.after(() => s.unsub());

  for (const text of ['jeudi après-midi', 'jeudi aprem', 'Thursday afternoon', 'jeudi soir']) {
    const r = await s.exec({ name: 'get_available_slots', args: { dayText: text } });
    assert.equal(r.ok, true, text);
    for (const slot of r.slots) {
      const hour = Number(slot.when.match(/(\d+)h/)[1]);
      assert.ok(hour >= 12, `"${text}" produced ${slot.when}`);
    }
  }
  // …and the morning words still mean the morning.
  const morning = await s.exec({ name: 'get_available_slots', args: { dayText: 'jeudi matin' } });
  for (const slot of morning.slots) {
    assert.ok(Number(slot.when.match(/(\d+)h/)[1]) < 12, slot.when);
  }
});

test('an unavailable half-day is DISCLOSED, never silently swapped', async (t) => {
  const app = makeTestApp();
  const clinic = app.store.getClinicById(CLINIC);
  const original = clinic.workingHours;
  // A morning-only practice: the afternoon they asked for cannot be honoured.
  clinic.workingHours = { ...original, thu: ['08:30', '12:00'] };
  t.after(() => {
    clinic.workingHours = original;
  });

  const convo = await app.store.conversations.create(CLINIC, { patientWaId: WA, status: 'open' });
  const { exec } = createToolExecutor({
    clinic,
    convo,
    store: app.store,
    bus: app.bus,
    callState: { toolBatchId: 0 },
    lang: 'ar',
    patientWaId: WA,
    now: NOW,
  });

  const r = await exec({
    name: 'stage_booking',
    args: { specialty: 'cardiology', datetimeText: 'الخميس العشية', name: 'محمد', contact: '21650123456' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.adjusted, true, 'we could not honour the afternoon');
  assert.ok(
    r.recap.startsWith('الوقت اللي طلبتو'),
    'and callAdjusted is spoken FIRST, in the same breath as the recap'
  );

  // The offer path is held to the same rule: whatever we substitute — a
  // different half-day or a different day — the agent is told to SAY it first.
  const slots = await exec({ name: 'get_available_slots', args: { dayText: 'الخميس العشية' } });
  assert.equal(slots.ok, true);
  assert.match(slots.note, /say that first/, 'the agent is told to disclose the substitution');
});

test('detectHalfDay does not fire on words that merely contain am/pm', () => {
  assert.equal(detectHalfDay('samedi'), null, '"samedi" contains "am" — it is not the morning');
  assert.equal(detectHalfDay('الخميس'), null);
  assert.equal(detectHalfDay(''), null);
  assert.equal(detectHalfDay('jeudi 15h'), null, 'an explicit hour needs no half-day guess');
  assert.equal(detectHalfDay('الخميس العشية'), 'pm');
  assert.equal(detectHalfDay('lundi matin'), 'am');
  assert.equal(detectHalfDay('Thursday PM'), 'pm');
});

test('formatWhenSpoken reads a date the way a receptionist says it', () => {
  const d = new Date(2026, 7, 6, 15, 30); // Thursday 6 Aug 2026, 15:30
  assert.equal(formatWhenSpoken(d, 'ar'), 'الخميس 6 أوت على الساعة 3 و30 دقيقة بعد الظهر');
  assert.equal(formatWhenSpoken(d, 'fr'), 'jeudi 6 août à 15h30');
  assert.equal(formatWhenSpoken(d, 'en'), 'Thursday 6 August at 3:30 PM');
  const morning = new Date(2026, 7, 6, 9, 0);
  assert.equal(formatWhenSpoken(morning, 'ar'), 'الخميس 6 أوت على الساعة 9 صباحاً');
  assert.equal(formatWhenSpoken(morning, 'en'), 'Thursday 6 August at 9:00 AM');
});

test('get_available_slots offers at most three genuinely open times', async (t) => {
  const s = await setup();
  t.after(() => s.unsub());

  const r = await s.exec({ name: 'get_available_slots', args: { dayText: 'الخميس' } });
  assert.equal(r.ok, true);
  assert.equal(r.slots.length, 3);
  for (const slot of r.slots) assert.ok(slot.when.length > 5);
});

test('nextOpenSlots never proposes a time outside the working window', () => {
  const app = makeTestApp();
  const clinic = app.store.getClinicById(CLINIC);
  const slots = nextOpenSlots(clinic, {}, NOW(), 12);
  assert.equal(slots.length, 12);
  for (const d of slots) {
    const win = windowFor(clinic, d);
    assert.ok(win, `${d} lands on a day the clinic is closed`);
    const mins = d.getHours() * 60 + d.getMinutes();
    assert.ok(mins >= win[0] && mins <= win[1] - SLOT_MIN, `${d} is outside ${win}`);
    assert.ok(d.getTime() > NOW().getTime(), 'a slot in the past is not availability');
  }
  // Sunday is null in the seed and must never appear.
  assert.ok(!slots.some((d) => d.getDay() === 0));
});

test('a clinic with no configured hours reports honestly instead of inventing a slot', async (t) => {
  const app = makeTestApp();
  const clinic = app.store.getClinicById(CLINIC);
  const original = clinic.workingHours;
  clinic.workingHours = {};
  t.after(() => {
    clinic.workingHours = original;
  });

  const convo = await app.store.conversations.create(CLINIC, { patientWaId: WA, status: 'open' });
  const { exec } = createToolExecutor({
    clinic,
    convo,
    store: app.store,
    bus: app.bus,
    callState: {},
    lang: 'fr',
    now: NOW,
  });
  assert.equal((await exec({ name: 'get_available_slots', args: {} })).error, 'no_open_slots');
  const staged = await exec({
    name: 'stage_booking',
    args: { specialty: 'dental', datetimeText: 'demain', name: 'Ali', contact: '21650111222' },
  });
  assert.equal(staged.ok, false);
  assert.equal(staged.error, 'no_slot_available');
});

// ── never throw ─────────────────────────────────────────────────────────────

test('an unknown tool name and a broken store come back as data, not an exception', async (t) => {
  const s = await setup();
  t.after(() => s.unsub());

  assert.deepEqual(await s.exec({ name: 'drop_tables', args: {} }), { ok: false, error: 'unknown_tool' });
  assert.deepEqual(await s.exec({}), { ok: false, error: 'unknown_tool' });

  // A store that fails mid-write must not tear the call down.
  const broken = createToolExecutor({
    clinic: s.clinic,
    convo: s.convo,
    store: {
      createAppointment: async () => {
        throw new Error('db is on fire');
      },
      listAppointments: async () => [],
      conversations: s.app.store.conversations,
    },
    bus: s.app.bus,
    callState: {
      staged: {
        specialty: 'dental',
        specialtyLabel: 'x',
        slotIso: '2026-08-06T10:00',
        name: 'A',
        contact: '1',
        stagedAt: 0,
        batchId: 0,
      },
      toolBatchId: 1,
      lastCallerSpeechAt: 1,
      speechSinceStage: 'نعم',
    },
    lang: 'ar',
    now: NOW,
    logger: () => {},
  });
  assert.deepEqual(await broken.exec({ name: 'confirm_booking', args: {} }), {
    ok: false,
    error: 'internal_error',
  });
});
