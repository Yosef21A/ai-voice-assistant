// Tenant isolation: a user of tenant A can never read or mutate tenant B's rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeTestApp, listen, request, setupOwner } from '../test-helpers/client.js';

const A = 'el-amen-sousse';
const B = 'ennour-sfax';

test('cross-tenant conversation + appointment access is denied', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  t.after(() => new Promise((r) => server.close(r)));
  const store = app.store;

  const a = await setupOwner(server, { tenantId: A, email: `a-${randomUUID()}@x.tn` });
  const b = await setupOwner(server, { tenantId: B, email: `b-${randomUUID()}@x.tn` });
  assert.ok(a.cookie && b.cookie);

  // Seed a conversation + an appointment owned by tenant A.
  const convo = await store.conversations.create(A, { patientWaId: '218900000001', lang: 'ar', status: 'open' });
  const appt = await store.appointments.create(A, {
    ref: 'EAS-ISO-1', patientWaId: '218900000001', patientName: 'X', status: 'confirmed',
    datetimeIso: '2026-08-03T09:00:00.000Z',
  });

  // A can read its own conversation; B gets a 404 for the same id.
  const aRead = await request(server, 'GET', `/api/conversations/${convo.id}`, { cookie: a.cookie });
  assert.equal(aRead.status, 200);
  const bRead = await request(server, 'GET', `/api/conversations/${convo.id}`, { cookie: b.cookie });
  assert.equal(bRead.status, 404);

  // B's conversation list never contains A's thread.
  const bList = await request(server, 'GET', '/api/conversations', { cookie: b.cookie });
  assert.equal(bList.status, 200);
  assert.equal(bList.body.conversations.find((c) => c.id === convo.id), undefined);

  // B cannot change A's appointment status (scoped update -> 404).
  const bAppt = await request(server, 'POST', `/api/appointments/${appt.id}/status`, {
    cookie: b.cookie, body: { status: 'done' },
  });
  assert.equal(bAppt.status, 404);

  // ...but A can.
  const aAppt = await request(server, 'POST', `/api/appointments/${appt.id}/status`, {
    cookie: a.cookie, body: { status: 'done' },
  });
  assert.equal(aAppt.status, 200);
  assert.equal(aAppt.body.appointment.status, 'done');

  // B's tenant profile is B, not A.
  const bTenant = await request(server, 'GET', '/api/tenant', { cookie: b.cookie });
  assert.equal(bTenant.body.tenant.id, B);
});
