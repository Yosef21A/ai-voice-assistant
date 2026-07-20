// JSON adapter — async collection interface smoke test. Runs with zero config in
// the default `npm test`, proving the JSON adapter implements the same interface
// contract as Postgres (tenant scoping, message ordering, entity lifecycles).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../src/config.js';
import { createStore } from '../src/store/index.js';

function freshStore() {
  const base = getConfig();
  const runtimeDir = path.join(os.tmpdir(), `omen-json-adapter-${randomUUID()}`);
  return createStore({ clinicsFile: base.clinicsFile, runtimeDir, reset: true });
}
const A = 'el-amen-sousse';
const B = 'ennour-sfax';
// Derive the pnid from the registry: the contract under test is the SEEDING +
// MAPPING, not a hard-coded id (the registry re-keys when a real number lands).
const CLINICS = JSON.parse(readFileSync(new URL('../data/clinics.json', import.meta.url), 'utf8')).clinics;
const A_PNID = CLINICS.find((c) => c.id === A).whatsapp.phoneNumberId;

test('json adapter — is the default and seeds tenants from clinics.json', async () => {
  const s = freshStore();
  assert.equal(s.name, 'json');
  const t = await s.tenants.getByPhoneNumberId(A_PNID);
  assert.equal(t.id, A);
  assert.ok(Array.isArray(t.languages));
  assert.ok(t.config.specialties?.length);
  assert.ok((await s.tenants.list()).length >= 2);
  await s.close();
});

test('json adapter — patient scoping + conversation message ordering', async () => {
  const s = freshStore();
  await s.patients.upsert(A, 'wa1', { name: 'X', lang: 'ar' });
  assert.equal((await s.patients.list(A)).length, 1);
  assert.equal((await s.patients.list(B)).length, 0); // scoped
  const c = await s.conversations.create(A, { patientWaId: 'wa1', lang: 'ar' });
  await s.conversations.appendMessage(A, c.id, { direction: 'inbound', body: { text: 'm1' }, ts: '2026-08-02T09:00:00.000Z' });
  await s.conversations.appendMessage(A, c.id, { direction: 'outbound', body: { text: 'm2' }, ts: '2026-08-02T09:00:01.000Z' });
  const msgs = await s.conversations.listMessages(A, c.id);
  assert.deepEqual(msgs.map((m) => m.body.text), ['m1', 'm2']);
  assert.equal((await s.conversations.listMessages(B, c.id)).length, 0); // scoped
  assert.equal((await s.conversations.update(A, c.id, { aiPaused: true })).aiPaused, true);
  await s.close();
});

test('json adapter — appointment/lead/kb/event/prefs lifecycles + scoping', async () => {
  const s = freshStore();
  const a = await s.appointments.create(A, { ref: 'R1', patientWaId: 'wa1', status: 'confirmed', datetimeIso: '2026-08-03T09:00:00Z' });
  assert.equal((await s.appointments.list(A)).length, 1);
  assert.equal((await s.appointments.list(B)).length, 0);
  assert.equal((await s.appointments.updateStatus(A, a.id, 'done')).status, 'done');
  assert.equal(await s.appointments.get(B, a.id), null);

  const l = await s.leads.create(A, { procedure: 'dental' });
  assert.equal((await s.leads.updateStatus(A, l.id, 'quoted')).status, 'quoted');
  assert.equal(await s.leads.get(B, l.id), null);

  await s.kbEntries.upsert(A, { key: 'k1', answer: { en: 'a' } });
  assert.equal((await s.kbEntries.list(A, { status: 'active' })).length, 1);
  await s.kbEntries.remove(A, 'k1');
  assert.equal((await s.kbEntries.list(A, { status: 'active' })).length, 0);

  await s.events.append(A, { type: 'x' });
  await s.events.append(A, { type: 'y' });
  assert.deepEqual((await s.events.list(A)).map((e) => e.type), ['x', 'y']);
  assert.equal((await s.events.list(B)).length, 0);

  const n = await s.notificationPrefs.upsert(A, { recipient: '+216', events: { booking: true } });
  assert.equal(n.events.booking, true);
  assert.equal(await s.notificationPrefs.get(B, '+216'), null);
  await s.close();
});
