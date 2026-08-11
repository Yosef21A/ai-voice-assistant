// Tenant profile: GET returns the clinic config; PUT (owner-only) validates,
// persists into the same clinic-shaped config, and is visible to the LIVE engine
// immediately (same store instance). Staff are forbidden from editing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeTestApp, listen, request, setupOwner } from '../test-helpers/client.js';
import { hashPassword } from '../src/auth/passwords.js';

const A = 'el-amen-sousse';

test('GET/PUT tenant: owner edits persist + reach the live engine; staff is 403', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  t.after(() => new Promise((r) => server.close(r)));
  const store = app.store;

  const { cookie } = await setupOwner(server, { tenantId: A, email: `owner-${randomUUID()}@x.tn` });

  const get = await request(server, 'GET', '/api/tenant', { cookie });
  assert.equal(get.status, 200);
  assert.equal(get.body.tenant.id, A);
  assert.ok(Array.isArray(get.body.tenant.languages));

  // Owner updates name, languages and the escalation (human-handoff) contact.
  const put = await request(server, 'PUT', '/api/tenant', {
    cookie,
    body: {
      name: 'Clinique El Amen — Sousse (updated)',
      languages: ['fr', 'en'],
      escalation: { handoff: { name: 'Cellule VIP', phone: '+216 20 999 000' } },
      persona: { botName: 'Amina', tone: 'warm' },
    },
  });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.tenant.languages, ['fr', 'en']);
  assert.equal(put.body.tenant.config.handoff.phone, '+216 20 999 000');

  // Persisted: a fresh GET reflects it.
  const get2 = await request(server, 'GET', '/api/tenant', { cookie });
  assert.equal(get2.body.tenant.name, 'Clinique El Amen — Sousse (updated)');
  assert.equal(get2.body.tenant.config.persona.tone, 'warm');

  // LIVE engine sees it: the legacy clinic object the engine reads was mutated.
  const liveClinic = store.getClinicById(A);
  assert.deepEqual(liveClinic.languages, ['fr', 'en']);
  assert.equal(liveClinic.handoff.phone, '+216 20 999 000');

  // Validation: bad language code -> 400.
  const bad = await request(server, 'PUT', '/api/tenant', {
    cookie, body: { languages: ['xx'] },
  });
  assert.equal(bad.status, 400);

  // A staff user cannot edit the tenant.
  const staffEmail = `staff-${randomUUID()}@x.tn`;
  await store.users.create(A, {
    email: staffEmail, passwordHash: await hashPassword('password123'), role: 'staff', name: 'Reception',
  });
  const staffLogin = await request(server, 'POST', '/api/auth/login', {
    body: { email: staffEmail, password: 'password123' },
  });
  assert.equal(staffLogin.status, 200);
  const staffPut = await request(server, 'PUT', '/api/tenant', {
    cookie: staffLogin.cookie, body: { name: 'nope' },
  });
  assert.equal(staffPut.status, 403);
  // ...but staff CAN use the shared inbox (requireAuth, not owner).
  const staffInbox = await request(server, 'GET', '/api/conversations', { cookie: staffLogin.cookie });
  assert.equal(staffInbox.status, 200);
});
