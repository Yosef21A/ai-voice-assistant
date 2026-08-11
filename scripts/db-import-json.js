// One-shot JSON-runtime → Postgres import (P1-G cutover). Reads the pilot's
// data/runtime/*.json through the JSON adapter and writes every collection
// through the Postgres adapter, so the mapping logic lives in the adapters —
// not re-invented here. Idempotent where the schema allows (upserts / unique
// keys); safe to re-run after a partial import.
//
//   1. npm run db:migrate && npm run db:seed       (schema + tenants/KB)
//   2. DATABASE_URL=... node scripts/db-import-json.js
//   3. flip DATABASE_URL on for the server (RUNBOOK §G)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../src/config.js';
import { createJsonStore, createPostgresStore } from '../src/store/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const config = getConfig();
  const url = config.databaseUrl || process.env.DATABASE_URL;
  if (!url) {
    console.error('db-import-json — DATABASE_URL is not set. Nothing to do.');
    process.exit(1);
  }
  const src = createJsonStore({
    clinicsFile: config.clinicsFile,
    runtimeDir: process.env.RUNTIME_DIR || path.join(ROOT, 'data', 'runtime'),
  });
  const dst = createPostgresStore({ databaseUrl: url });
  await dst.ready;

  const counts = {};
  const bump = (k, n = 1) => (counts[k] = (counts[k] || 0) + n);

  for (const clinic of src.listClinics()) {
    const tid = clinic.id;
    if (!dst.getClinicById(tid)) {
      console.warn(`! tenant ${tid} missing in Postgres — run npm run db:seed first`);
      continue;
    }

    for (const p of await src.patients.list(tid)) {
      await dst.patients.upsert(tid, p.waId, p);
      bump('patients');
    }

    for (const convo of await src.conversations.list(tid)) {
      const created = await dst.conversations.create(tid, {
        patientWaId: convo.waId,
        lang: convo.lang ?? null,
        status: convo.status ?? 'open',
        aiPaused: !!convo.aiPaused,
        state: convo.state ?? null,
      });
      // Engine memory + V2/V4 bookkeeping ride saveConversation (P1-G bridge).
      await dst.saveConversation({
        ...created,
        clinicId: tid,
        lang: convo.lang ?? null,
        state: convo.state ?? null,
        messages: convo.messages || [],
        nudge: convo.nudge ?? null,
        nudgeOptOut: !!convo.nudgeOptOut,
        lastReminder: convo.lastReminder ?? null,
        facilitatorAlerted: !!convo.facilitatorAlerted,
      });
      bump('conversations');
      // Inbox transcript rows (skip duplicates via the wa_message_id unique key).
      for (const m of await src.conversations.listMessages(tid, convo.id, {})) {
        try {
          await dst.conversations.appendMessage(tid, created.id, m);
          bump('messages');
        } catch {
          bump('messages_skipped');
        }
      }
    }

    // id maps for FK-carrying rows (JSON uses its own uuids; PG re-keys).
    const convoIdByWa = new Map(
      (await dst.conversations.list(tid, {})).map((c) => [c.waId ?? c.patientWaId, c.id])
    );

    for (const a of await src.appointments.list(tid, {})) {
      await dst.appointments.create(tid, {
        ...a,
        conversationId: convoIdByWa.get(a.patientWaId) ?? null,
        datetimeIso: a.datetimeISO ?? a.datetimeIso ?? null,
      });
      bump('appointments');
    }

    // Reminders need the NEW appointment ids — map by (ref, kind).
    const pgAppts = await dst.appointments.list(tid, {});
    const apptIdByRef = new Map(pgAppts.map((a) => [a.ref, a.id]));
    const srcAppts = await src.appointments.list(tid, {});
    const refByOldId = new Map(srcAppts.map((a) => [a.id, a.ref]));
    for (const r of await src.reminders.list(tid, {})) {
      const newApptId = apptIdByRef.get(r.ref ?? refByOldId.get(r.apptId));
      if (!newApptId) {
        bump('reminders_skipped');
        continue;
      }
      await dst.reminders.record(tid, { ...r, apptId: newApptId });
      bump('reminders');
    }

    for (const l of await src.leads.list(tid, {})) {
      await dst.leads.create(tid, {
        ...l,
        conversationId: convoIdByWa.get(l.patientWaId) ?? null,
      });
      bump('leads');
    }

    // JSON conversation ids are `${tenantId}:${waId}` strings, not uuids — map
    // them to the NEW PG conversation ids (or drop the reference).
    const waFromJsonConvoId = (id) => (typeof id === 'string' ? id.slice(id.lastIndexOf(':') + 1) : null);
    for (const u of await src.unanswered.list(tid, {})) {
      await dst.unanswered.upsertByNorm(tid, {
        ...u,
        conversationId: convoIdByWa.get(waFromJsonConvoId(u.conversationId)) ?? null,
      });
      bump('unanswered');
    }

    for (const k of await src.kbEntries.list(tid, {})) {
      await dst.kbEntries.upsert(tid, k);
      bump('kb_entries');
    }

    for (const pref of await src.notificationPrefs.list(tid)) {
      await dst.notificationPrefs.upsert(tid, pref);
      bump('notification_prefs');
    }

    for (const u of await src.users.list(tid)) {
      try {
        await dst.users.create(tid, u);
        bump('users');
      } catch {
        bump('users_skipped'); // already imported (unique email)
      }
    }
  }

  console.log('db-import-json — done:', JSON.stringify(counts));
  await dst.close();
}

main().catch((err) => {
  console.error('db-import-json — FAILED:', err);
  process.exit(1);
});
