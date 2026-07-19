// Appointments: list (with the seeded/booked rows) and status change, which
// emits appointment.updated on the bus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeTestApp, listen, request, setupOwner } from '../test-helpers/client.js';

const A = 'el-amen-sousse';

test('list + status change emits appointment.updated', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  t.after(() => new Promise((r) => server.close(r)));

  const { cookie } = await setupOwner(server, { tenantId: A, email: `o-${randomUUID()}@x.tn` });

  const events = [];
  app.bus.on('appointment.updated', (e) => events.push(e));

  const appt = await app.store.appointments.create(A, {
    ref: 'EAS-APPT-1', patientWaId: '218900000001', patientName: 'Mohamed', status: 'pending',
    datetimeIso: '2026-08-03T09:00:00.000Z', specialty: 'cardiology',
  });

  const list = await request(server, 'GET', '/api/appointments', { cookie });
  assert.equal(list.status, 200);
  assert.ok(list.body.appointments.some((a) => a.id === appt.id));

  const bad = await request(server, 'POST', `/api/appointments/${appt.id}/status`, {
    cookie, body: { status: 'not-a-status' },
  });
  assert.equal(bad.status, 400);

  const ok = await request(server, 'POST', `/api/appointments/${appt.id}/status`, {
    cookie, body: { status: 'confirmed' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.appointment.status, 'confirmed');

  assert.equal(events.length, 1);
  assert.equal(events[0].tenantId, A);
  assert.equal(events[0].status, 'confirmed');
  assert.equal(events[0].appointmentId, appt.id);

  // Range filter narrows correctly.
  const inRange = await request(server, 'GET', '/api/appointments?from=2026-08-01&to=2026-08-31', { cookie });
  assert.ok(inRange.body.appointments.some((a) => a.id === appt.id));
  const outRange = await request(server, 'GET', '/api/appointments?from=2026-09-01&to=2026-09-30', { cookie });
  assert.equal(outRange.body.appointments.some((a) => a.id === appt.id), false);
});
