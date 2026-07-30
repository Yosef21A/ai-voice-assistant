// P1-G — the ENGINE runs on Postgres. Skips cleanly without DATABASE_URL
// (same contract as store.postgres.test.js). With a migrated + seeded DB it
// drives a full classic booking through the real engine against the PG
// adapter and round-trips the V2/V4 conversation bookkeeping.
//
//   npm run db:migrate && npm run db:seed && DATABASE_URL=... node --test test/p1g.engine.pg.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../src/config.js';
import { createStore } from '../src/store/index.js';
import { createEngine } from '../src/engine/index.js';
import { MockProvider } from '../src/llm/mockProvider.js';

const DATABASE_URL = process.env.DATABASE_URL || '';
const NOW = new Date(2026, 7, 2, 9, 0, 0);

test(
  'engine on Postgres (P1-G)',
  { skip: DATABASE_URL ? false : 'DATABASE_URL not set — skipping engine-on-Postgres suite' },
  async (t) => {
    const store = createStore({ store: 'postgres', databaseUrl: DATABASE_URL });
    await store.ready;
    const config = getConfig();
    const engine = createEngine({ store, provider: new MockProvider(), config });

    const WA = `21891${String(Date.now()).slice(-7)}`; // unique patient per run
    t.after(async () => {
      // Clean this run's residue (appointments/reminders cascade via convo/tenant FKs
      // only partially — delete explicitly by patient).
      const pg = (await import('pg')).default;
      const c = new pg.Client({ connectionString: DATABASE_URL });
      await c.connect();
      await c.query('DELETE FROM reminders WHERE "to" = $1', [WA]);
      await c.query('DELETE FROM appointments WHERE patient_wa_id = $1', [WA]);
      await c.query('DELETE FROM conversations WHERE patient_wa_id = $1', [WA]);
      await c.query('DELETE FROM patients WHERE wa_id = $1', [WA]);
      await c.end();
      await store.close();
    });

    await t.test('clinic cache hydrates the registry from tenants', () => {
      const clinics = store.listClinics();
      assert.ok(clinics.length >= 4, 'seeded tenants visible');
      const amen = store.getClinicByPhoneNumberId('1153135121224452');
      assert.equal(amen.id, 'el-amen-sousse');
      assert.ok(Array.isArray(amen.specialties) && amen.specialties.length >= 5, 'config fields live on the clinic');
      assert.equal(store.getDefaultClinic().id, store.listClinics()[0].id);
    });

    await t.test('full classic AR booking end-to-end persists in Postgres', async () => {
      const drive = async (text) =>
        engine.handleMessage(
          { channel: 'simulate', from: WA, text, phoneNumberId: '1153135121224452', messageId: 'm', timestamp: NOW.getTime() },
          { now: NOW }
        );
      await drive('السلام عليكم');
      await drive('نحب نحجز موعد');
      await drive('أمراض القلب');
      await drive('نهار الاثنين الساعة 10 صباحاً');
      await drive('اسمي محمد العبيدي');
      await drive('من طرابلس، ليبيا');
      await drive('+218 91 000 0001');
      const last = await drive('نعم أكد');

      assert.ok(last.appointment, 'appointment returned');
      const rows = await store.appointments.list('el-amen-sousse', { patientWaId: WA });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].specialty, 'cardiology');
      assert.equal(rows[0].status, 'confirmed');
      assert.equal(rows[0].patientName, 'محمد العبيدي');
      assert.ok(rows[0].datetimeISO, 'legacy datetimeISO alias present');
      assert.match(rows[0].ref, /^EAS-\d{6}-\d{3}$/);

      // Engine memory survived the round-trips: the convo holds the dialogue.
      const convo = await store.getConversation('el-amen-sousse', WA);
      assert.ok(convo.messages.length >= 16, 'engine turn history persisted');
      assert.equal(convo.state, null, 'flow completed and cleared');
    });

    await t.test('V2/V4 bookkeeping round-trips through the PG whitelist', async () => {
      const convo = await store.conversations.get('el-amen-sousse', WA);
      await store.conversations.update('el-amen-sousse', convo.id, {
        lastReminder: { apptId: 'x', ref: 'R', kind: 't48', at: new Date().toISOString() },
        nudge: { type: 'leadSilent', at: new Date().toISOString() },
        nudgeOptOut: true,
      });
      const fresh = await store.conversations.get('el-amen-sousse', WA);
      assert.equal(fresh.lastReminder.kind, 't48');
      assert.equal(fresh.nudge.type, 'leadSilent');
      assert.equal(fresh.nudgeOptOut, true);
    });

    await t.test('reminders collection: record/find/list/update + DB-level dedupe', async () => {
      const appt = (await store.appointments.list('el-amen-sousse', { patientWaId: WA }))[0];
      const row = await store.reminders.record('el-amen-sousse', {
        apptId: appt.id, ref: appt.ref, kind: 't48', status: 'sent',
        apptIso: appt.datetimeISO, to: WA, lang: 'ar', sentAt: new Date().toISOString(),
      });
      assert.ok(row.id);
      const found = await store.reminders.find('el-amen-sousse', appt.id, 't48');
      assert.equal(found.status, 'sent');
      await store.reminders.update('el-amen-sousse', row.id, { status: 'confirmed' });
      const listed = await store.reminders.list('el-amen-sousse', { apptId: appt.id });
      assert.equal(listed[0].status, 'confirmed');
      // Re-record upserts the SAME row (unique key) — never a duplicate.
      await store.reminders.record('el-amen-sousse', { apptId: appt.id, kind: 't48', status: 'sent' });
      assert.equal((await store.reminders.list('el-amen-sousse', { apptId: appt.id })).length, 1);
    });
  }
);
