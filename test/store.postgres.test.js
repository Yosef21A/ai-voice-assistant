// Postgres adapter suite. SKIPS cleanly when DATABASE_URL is unset (so the
// default `npm test` stays green offline). With DATABASE_URL set (and the
// schema migrated) it exercises every collection: CRUD round-trips, strict
// tenant scoping (A cannot read/mutate B), the appointment lifecycle, and
// message append ordering.
//
//   npm run db:migrate && DATABASE_URL=... node --test test/store.postgres.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';

const DATABASE_URL = process.env.DATABASE_URL || '';
const A = 'pgtest-clinic-a';
const B = 'pgtest-clinic-b';

async function wipe() {
  const pg = (await import('pg')).default;
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  await c.query('DELETE FROM tenants WHERE id = ANY($1)', [[A, B]]); // cascades to child rows
  await c.end();
}

test(
  'postgres storage adapter',
  { skip: DATABASE_URL ? false : 'DATABASE_URL not set — skipping Postgres adapter suite' },
  async (t) => {
    const store = createStore({ store: 'postgres', databaseUrl: DATABASE_URL });
    await wipe(); // clean any residue from a previous run
    t.after(async () => {
      await wipe();
      await store.close();
    });

    await store.tenants.upsert({
      id: A, phoneNumberId: 'pg-9990001', name: 'PG Test A', city: 'Sousse',
      country: 'Tunisia', languages: ['ar', 'fr'], config: { specialties: ['dental'] },
    });
    await store.tenants.upsert({ id: B, phoneNumberId: 'pg-9990002', name: 'PG Test B', languages: ['en'], config: {} });

    await t.test('tenants: upsert + lookup by id and phone_number_id', async () => {
      const a = await store.tenants.getById(A);
      assert.equal(a.name, 'PG Test A');
      assert.deepEqual(a.languages, ['ar', 'fr']);
      assert.equal(a.config.specialties[0], 'dental');
      assert.equal((await store.tenants.getByPhoneNumberId('pg-9990001')).id, A);
      const upd = await store.tenants.upsert({ id: A, phoneNumberId: 'pg-9990001', name: 'PG Test A2', config: { specialties: ['dental', 'cardiology'] } });
      assert.equal(upd.name, 'PG Test A2');
      assert.equal((await store.tenants.getById(A)).config.specialties.length, 2);
      assert.ok((await store.tenants.list()).length >= 2);
    });

    await t.test('patients: upsert merge + tenant scoping', async () => {
      const p = await store.patients.upsert(A, '218910000001', { name: 'Mohamed', originCity: 'Tripoli', lang: 'ar' });
      assert.equal(p.name, 'Mohamed');
      const merged = await store.patients.upsert(A, '218910000001', { contact: '+218910000001' });
      assert.equal(merged.name, 'Mohamed'); // preserved through COALESCE merge
      assert.equal(merged.contact, '+218910000001');
      assert.equal(await store.patients.get(B, '218910000001'), null);
      assert.equal((await store.patients.list(B)).length, 0);
      assert.equal((await store.patients.list(A)).length, 1);
    });

    let convId;
    await t.test('conversations + messages: create, takeover, append ordering, scoping', async () => {
      const c = await store.conversations.create(A, { patientWaId: '218910000001', lang: 'ar' });
      convId = c.id;
      assert.equal(c.status, 'open');
      assert.equal(c.aiPaused, false);
      assert.equal((await store.conversations.create(A, { patientWaId: '218910000001' })).id, convId); // idempotent

      const paused = await store.conversations.update(A, convId, { aiPaused: true, status: 'needs_human' });
      assert.equal(paused.aiPaused, true);
      assert.equal(paused.status, 'needs_human');

      const t0 = Date.parse('2026-08-02T09:00:00Z');
      await store.conversations.appendMessage(A, convId, { direction: 'inbound', body: { text: 'm1' }, ts: new Date(t0).toISOString() });
      await store.conversations.appendMessage(A, convId, { direction: 'outbound', body: { text: 'm2' }, ts: new Date(t0 + 1000).toISOString() });
      await store.conversations.appendMessage(A, convId, { direction: 'inbound', body: { text: 'm3' }, ts: new Date(t0 + 2000).toISOString() });
      const msgs = await store.conversations.listMessages(A, convId);
      assert.deepEqual(msgs.map((m) => m.body.text), ['m1', 'm2', 'm3']);
      assert.equal(msgs[0].direction, 'inbound');

      // tenant B is fully walled off
      assert.equal(await store.conversations.getById(B, convId), null);
      assert.equal((await store.conversations.listMessages(B, convId)).length, 0);
      await assert.rejects(store.conversations.appendMessage(B, convId, { body: { text: 'x' } }));
    });

    let apptId;
    await t.test('appointments: create -> list -> updateStatus (+ scoping + filter)', async () => {
      const a = await store.appointments.create(A, {
        ref: 'EAS-260802-001', patientWaId: '218910000001', patientName: 'Mohamed', specialty: 'cardiology',
        datetimeIso: '2026-08-03T09:00:00Z', contact: '+218910000001', lang: 'ar', status: 'confirmed', createdBy: 'bot',
      });
      apptId = a.id;
      assert.equal(a.status, 'confirmed');
      const listed = await store.appointments.list(A, {});
      assert.equal(listed.length, 1);
      assert.equal(listed[0].ref, 'EAS-260802-001');
      assert.equal((await store.appointments.updateStatus(A, apptId, 'done')).status, 'done');
      assert.equal(await store.appointments.get(B, apptId), null);
      assert.equal(await store.appointments.updateStatus(B, apptId, 'cancelled'), null);
      assert.equal((await store.appointments.list(B)).length, 0);
      assert.equal((await store.appointments.list(A, { status: 'done' })).length, 1);
      assert.equal((await store.appointments.list(A, { status: 'pending' })).length, 0);
    });

    await t.test('leads: lifecycle + scoping', async () => {
      const l = await store.leads.create(A, { patientWaId: '218910000001', procedure: 'dental', originCountry: 'Libya' });
      assert.equal(l.status, 'new');
      assert.equal((await store.leads.list(A)).length, 1);
      assert.equal((await store.leads.updateStatus(A, l.id, 'quoted')).status, 'quoted');
      assert.equal(await store.leads.get(B, l.id), null);
      assert.equal((await store.leads.list(B)).length, 0);
    });

    await t.test('kb_entries: upsert + archive + scoping', async () => {
      const k = await store.kbEntries.upsert(A, { key: 'visa', question: 'visa?', answer: { en: 'no visa' }, keywords: ['visa'] });
      assert.equal(k.answer.en, 'no visa');
      assert.equal((await store.kbEntries.upsert(A, { key: 'visa', answer: { en: 'visa-free' } })).answer.en, 'visa-free');
      assert.equal((await store.kbEntries.list(A, { status: 'active' })).length, 1);
      await store.kbEntries.remove(A, 'visa');
      assert.equal((await store.kbEntries.list(A, { status: 'active' })).length, 0);
      assert.equal((await store.kbEntries.list(A, { status: 'archived' })).length, 1);
      assert.equal(await store.kbEntries.get(B, 'visa'), null);
    });

    await t.test('events: append-only + insertion order + scoping', async () => {
      await store.events.append(A, { type: 'appointment.created', actor: 'bot', payload: { ref: 'EAS-260802-001' } });
      await store.events.append(A, { type: 'lead.created', actor: 'bot' });
      const evs = await store.events.list(A);
      assert.equal(evs.length, 2);
      assert.equal(evs[0].type, 'appointment.created');
      assert.equal(evs[0].payload.ref, 'EAS-260802-001');
      assert.equal((await store.events.list(A, { type: 'lead.created' })).length, 1);
      assert.equal((await store.events.list(B)).length, 0);
    });

    await t.test('notification_prefs: upsert + get + scoping', async () => {
      const n = await store.notificationPrefs.upsert(A, { recipient: '+21620111222', role: 'owner', events: { booking: true, hot_lead: true } });
      assert.equal(n.events.booking, true);
      assert.equal((await store.notificationPrefs.get(A, '+21620111222', 'whatsapp')).role, 'owner');
      assert.equal((await store.notificationPrefs.list(A)).length, 1);
      assert.equal(await store.notificationPrefs.get(B, '+21620111222'), null);
      assert.equal((await store.notificationPrefs.list(B)).length, 0);
    });

    await t.test('health', async () => {
      assert.equal((await store.health()).ok, true);
    });
  }
);
