// P2-C leads pipeline — hot-lead capture (upsertOpen dedupe), the /api/leads
// board (list + waiting-on-you derivation + status transitions + edits), and
// the pipeline stats. A hot lead is a foreign-origin (+218 Libya) price ask on
// a high-value specialty (the same signal the integration suite uses).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTestApp, listen, request, setupOwner } from '../test-helpers/client.js';
import { ingestInbound } from '../src/api/ingest.js';
import { computeAnalytics } from '../src/stats/index.js';
import { LEAD_STATUSES } from '../src/leads/status.js';

const A = 'el-amen-sousse';
const B = 'ennour-sfax';
const PNID = JSON.parse(fs.readFileSync(new URL('../data/clinics.json', import.meta.url), 'utf8'))
  .clinics.find((c) => c.id === A).whatsapp.phoneNumberId;

function feed(app, from, text) {
  return ingestInbound(
    { store: app.store, engine: app.engine, sender: app.sender, bus: app.bus, mediaClient: app.mediaClient },
    { channel: 'whatsapp', from, text, phoneNumberId: PNID, messageId: `m_${randomUUID()}`, timestamp: Date.now() }
  );
}

// ── capture + dedupe ──────────────────────────────────────────────────────────
test('leads — a hot lead is persisted once per conversation (upsertOpen dedupe)', async (t) => {
  const app = makeTestApp();
  t.after(() => app.notifier.stop());
  await app.kbReady;

  const from = '218955000005'; // +218 Libyan (foreign) number
  const res1 = await feed(app, from, 'How much does cosmetic surgery cost?');
  assert.ok(res1.lead, 'analyzeInbound flagged a hot lead');

  let rows = await app.store.leads.list(A, {});
  assert.equal(rows.length, 1, 'one lead row persisted');
  assert.equal(rows[0].conversationId, `${A}:${from}`);
  assert.equal(rows[0].status, 'new');
  assert.ok(rows[0].details.reason, 'reason stored in details (not a lost column)');
  assert.ok(rows[0].details.snippet, 'snippet stored in details');

  // A second hot turn on the SAME conversation must NOT create a duplicate row.
  await feed(app, from, 'And how much for a rhinoplasty specifically?');
  rows = await app.store.leads.list(A, {});
  assert.equal(rows.length, 1, 'deduped — still one lead for the conversation');

  // A different patient starts a distinct lead.
  const res2 = await feed(app, '218955000006', 'What does a facelift cosmetic surgery cost?');
  assert.ok(res2.lead, 'second patient also flagged hot');
  rows = await app.store.leads.list(A, {});
  assert.equal(rows.length, 2);

  // Field-map contract: country → originCountry column, reason/snippet → details
  // (the Postgres adapter drops unmapped columns, so this must be explicit).
  const mapped = await app.store.leads.upsertOpen(A, {
    conversationId: `${A}:218970000000`,
    patientWaId: '218970000000',
    procedure: 'cosmetic_surgery',
    originCountry: 'Libya',
    details: { reason: 'stated_foreign_origin', snippet: 'from Tripoli' },
  });
  assert.equal(mapped.originCountry, 'Libya');
  assert.equal(mapped.procedure, 'cosmetic_surgery');
  assert.equal(mapped.details.reason, 'stated_foreign_origin');
});

// ── the board API ─────────────────────────────────────────────────────────────
test('leads — GET /api/leads: waiting-on-you derived, sandbox excluded, tenant-scoped', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  t.after(() => {
    app.notifier.stop();
    server.closeAllConnections?.();
    return new Promise((r) => server.close(r));
  });
  await app.kbReady;

  const from = '218955000007';
  await feed(app, from, 'How much does cosmetic surgery cost?'); // last msg is the bot's reply

  const { cookie } = await setupOwner(server, { tenantId: A, email: `o-${randomUUID()}@x.tn` });

  // Unauthenticated → 401.
  assert.equal((await request(server, 'GET', '/api/leads')).status, 401);

  let list = await request(server, 'GET', '/api/leads', { cookie });
  assert.equal(list.status, 200);
  assert.equal(list.body.leads.length, 1);
  // The bot answered, so the last message is outbound → NOT waiting on a human.
  assert.equal(list.body.leads[0].waitingSince, null);

  // Patient sends another message with no bot reply after it (staff-paused) →
  // now the last message is inbound → waiting on you.
  await app.store.conversations.update(A, `${A}:${from}`, { aiPaused: true });
  await feed(app, from, 'are you there?');
  list = await request(server, 'GET', '/api/leads', { cookie });
  assert.ok(list.body.leads[0].waitingSince, 'inbound last message ⇒ waitingSince set');

  // A sandbox lead is never listed.
  await app.store.leads.create(A, { conversationId: `${A}:sandbox:x`, patientWaId: 'sandbox:x' });
  list = await request(server, 'GET', '/api/leads', { cookie });
  assert.equal(list.body.leads.length, 1, 'sandbox lead excluded');

  // Other-tenant owner sees none of A's leads.
  const b = await setupOwner(server, { tenantId: B, email: `o-${randomUUID()}@x.tn` });
  const other = await request(server, 'GET', '/api/leads', { cookie: b.cookie });
  assert.equal(other.body.leads.length, 0);
});

test('leads — status transitions validated + lead.updated emitted; PATCH assignee/value/note', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  t.after(() => {
    app.notifier.stop();
    server.closeAllConnections?.();
    return new Promise((r) => server.close(r));
  });
  await app.kbReady;
  const events = [];
  app.bus.subscribe((e) => events.push(e));

  await feed(app, '218955000008', 'How much does cosmetic surgery cost?');
  const { cookie } = await setupOwner(server, { tenantId: A, email: `o-${randomUUID()}@x.tn` });
  const id = (await request(server, 'GET', '/api/leads', { cookie })).body.leads[0].id;

  // Bad status → 400 with the allow-list.
  const bad = await request(server, 'POST', `/api/leads/${id}/status`, { cookie, body: { status: 'frobnicate' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.allowed, LEAD_STATUSES);

  // Valid transition → 200 + lead.updated.
  const mv = await request(server, 'POST', `/api/leads/${id}/status`, { cookie, body: { status: 'contacted' } });
  assert.equal(mv.status, 200);
  assert.equal(mv.body.lead.status, 'contacted');
  assert.ok(events.some((e) => e.type === 'lead.updated' && e.leadId === id));

  // PATCH assignee + value + append a note.
  const patched = await request(server, 'PATCH', `/api/leads/${id}`, {
    cookie,
    body: { assignee: 'Hajer', value: 3500, note: 'Called — wants dates in August.' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.lead.assignee, 'Hajer');
  assert.equal(patched.body.lead.value, 3500);
  assert.equal(patched.body.lead.notes.length, 1);
  assert.match(patched.body.lead.notes[0].text, /August/);

  // Negative value is rejected to null; empty PATCH is 400.
  const nan = await request(server, 'PATCH', `/api/leads/${id}`, { cookie, body: { value: -5 } });
  assert.equal(nan.body.lead.value, null);
  assert.equal((await request(server, 'PATCH', `/api/leads/${id}`, { cookie, body: {} })).status, 400);

  // 404 on a missing lead.
  assert.equal((await request(server, 'POST', `/api/leads/${randomUUID()}/status`, { cookie, body: { status: 'lost' } })).status, 404);
});

// ── review hardening regressions ──────────────────────────────────────────────
test('leads — conversation removal erases the lead (GDPR: snippet + wa id gone)', async (t) => {
  const app = makeTestApp();
  t.after(() => app.notifier.stop());
  await app.kbReady;

  const from = '218955000009';
  await feed(app, from, 'How much does cosmetic surgery cost?');
  const convoId = `${A}:${from}`;
  assert.equal((await app.store.leads.list(A, {})).length, 1);

  await app.store.conversations.remove(A, convoId);
  assert.equal((await app.store.leads.list(A, {})).length, 0, 'lead PII erased with the conversation');
});

test('leads — JSON ring cap evicts oldest terminal leads first', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const { createStore } = await import('../src/store/index.js');
  const { getConfig } = await import('../src/config.js');
  const store = createStore({
    clinicsFile: getConfig().clinicsFile,
    runtimeDir: path.join(os.tmpdir(), `omen-leads-cap-${randomUUID()}`),
    reset: true,
    leadsMax: 2,
  });
  // Two terminal (older), then two OPEN leads push past the cap of 2: both
  // terminals must be evicted before either open lead.
  const l1 = await store.leads.create(A, { conversationId: `${A}:c1`, patientWaId: 'c1', status: 'lost' });
  const l2 = await store.leads.create(A, { conversationId: `${A}:c2`, patientWaId: 'c2', status: 'booked' });
  const o3 = await store.leads.create(A, { conversationId: `${A}:c3`, patientWaId: 'c3' });
  const o4 = await store.leads.create(A, { conversationId: `${A}:c4`, patientWaId: 'c4' });
  const rows = await store.leads.list(A, {});
  assert.equal(rows.length, 2, 'capped at leadsMax');
  assert.ok(!rows.some((r) => r.id === l1.id || r.id === l2.id), 'terminal leads evicted first');
  assert.ok(rows.some((r) => r.id === o3.id) && rows.some((r) => r.id === o4.id), 'open leads kept');
  await store.close();
});

// ── pipeline stats ────────────────────────────────────────────────────────────
test('leads — pipeline stats: by-status counts, value sum, conversion (sandbox excluded)', () => {
  const tenant = { id: A, timezone: 'Africa/Tunis', config: {} };
  const leads = [
    { patientWaId: '218900000001', status: 'new', value: 1000 },
    { patientWaId: '218900000002', status: 'quoted', value: 2000 },
    { patientWaId: '218900000003', status: 'booked', value: 3000 },
    { patientWaId: '218900000004', status: 'arrived', value: 4000 },
    { patientWaId: '218900000005', status: 'lost', value: 999 },
    { patientWaId: 'sandbox:z', status: 'new', value: 9999 }, // excluded
  ];
  const s = computeAnalytics(
    { tenant, conversations: [], appointments: [], leads, events: [], messagesByConvo: new Map() },
    { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z', tz: 'Africa/Tunis' }
  );
  assert.equal(s.leadsByStatus.new, 1);
  assert.equal(s.leadsByStatus.booked, 1);
  assert.equal(s.leadsByStatus.arrived, 1);
  assert.equal(s.leadsByStatus.lost, 1);
  assert.equal(s.pipelineValue, 1000 + 2000 + 3000 + 4000 + 999); // sandbox 9999 excluded
  assert.equal(s.pipelineOpen, 2); // 5 total − lost(1) − won(2) = new+quoted
  // won = booked+arrived = 2, total non-sandbox = 5 → conversion 2/5.
  assert.ok(Math.abs(s.leadConversion - 2 / 5) < 1e-9);
});
