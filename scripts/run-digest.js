#!/usr/bin/env node
// scripts/run-digest.js — send owner WhatsApp digests for every tenant.
//
// Cron-driven ONLY (no in-process scheduler; see deploy/RUNBOOK.md §F7):
//   node scripts/run-digest.js daily     # morning summary (yesterday's numbers)
//   node scripts/run-digest.js weekly    # weekly report + the money line
//   npm run digest:daily   /   npm run digest:weekly
//
// It composes the SAME store + sender the server uses, so it honors per-recipient
// notification_prefs, the digest on/off toggles, and the money line. Digests are
// cron-scheduled at a chosen hour, so they intentionally ignore quiet-hours.
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { createStore } from '../src/store/index.js';
import { createBus } from '../src/events/bus.js';
import { createSender } from '../src/whatsapp/index.js';
import { createNotificationService } from '../src/notifications/index.js';

// Mirror src/server.js storeFromConfig: JSON by default, Postgres only when the
// composition layer is explicitly pointed at it (never from ambient env alone).
function storeFromConfig(config) {
  if (config.databaseUrl || config.store === 'postgres') {
    return createStore({
      store: config.store || undefined,
      databaseUrl: config.databaseUrl || undefined,
    });
  }
  return createStore({ clinicsFile: config.clinicsFile, runtimeDir: config.runtimeDir });
}

async function listTenantIds(store) {
  if (store.tenants && typeof store.tenants.list === 'function') {
    const rows = await store.tenants.list();
    return rows.map((t) => t.id).filter(Boolean);
  }
  if (typeof store.listClinics === 'function') return store.listClinics().map((c) => c.id);
  return [];
}

async function main() {
  const arg = String(process.argv[2] || 'daily').toLowerCase();
  const kind = arg === 'weekly' ? 'weekly' : 'daily';
  const config = getConfig();
  const store = storeFromConfig(config);
  const bus = createBus();
  const sender = createSender({ outboxFile: path.join(config.runtimeDir, 'outbox.json') });
  const notifier = createNotificationService({ bus, sender, store });

  const ids = await listTenantIds(store);
  let sentTenants = 0;
  for (const id of ids) {
    const res =
      kind === 'weekly' ? await notifier.runWeeklyDigest(id) : await notifier.runDailyDigest(id);
    if (res && res.ok) {
      const n = (res.sent || []).length;
      if (n > 0) sentTenants += 1;
      console.log(`[digest:${kind}] ${id} — ${n} recipient(s)`);
    } else {
      console.warn(`[digest:${kind}] ${id} — skipped (${(res && res.reason) || 'no recipients'})`);
    }
  }

  await notifier.settled();
  notifier.stop();
  if (typeof store.close === 'function') await store.close();
  console.log(`[digest:${kind}] done — ${sentTenants}/${ids.length} tenant(s) alerted`);
}

main().catch((err) => {
  console.error('[digest] failed:', err);
  process.exit(1);
});
