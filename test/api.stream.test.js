// SSE: an auth'd client receives a heartbeat + this-tenant events, then closes
// cleanly. sseHeartbeatMs is 40ms in the test config so the heartbeat is quick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeTestApp, listen, request, setupOwner, openSse } from '../test-helpers/client.js';

const A = 'el-amen-sousse';

test('unauthenticated SSE is rejected', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  t.after(() => new Promise((r) => server.close(r)));
  const r = await request(server, 'GET', '/api/stream');
  assert.equal(r.status, 401);
});

test('SSE streams a heartbeat + a tenant-scoped event, then closes cleanly', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  const { cookie } = await setupOwner(server, { tenantId: A, email: `o-${randomUUID()}@x.tn` });

  const appt = await app.store.appointments.create(A, {
    ref: 'EAS-SSE-1', patientWaId: '218900000001', status: 'pending',
    datetimeIso: '2026-08-03T09:00:00.000Z',
  });

  const sse = await openSse(server, '/api/stream', cookie);
  t.after(() => {
    sse.close();
    return new Promise((r) => server.close(r));
  });

  // Handshake + heartbeat (40ms cadence).
  await sse.waitFor((buf) => buf.includes(': connected'));
  await sse.waitFor((buf) => buf.includes(': ping'));

  // Trigger a tenant event and receive it over the stream.
  const upd = await request(server, 'POST', `/api/appointments/${appt.id}/status`, {
    cookie, body: { status: 'confirmed' },
  });
  assert.equal(upd.status, 200);

  await sse.waitFor((buf) => buf.includes('event: appointment.updated'));
  const m = /event: appointment\.updated\ndata: (.+)\n/.exec(sse.buffer);
  assert.ok(m, 'received an appointment.updated SSE frame');
  const payload = JSON.parse(m[1]);
  assert.equal(payload.tenantId, A);
  assert.equal(payload.status, 'confirmed');

  // Clean close: destroying the client must not throw and the server must be
  // able to shut down (asserted implicitly by t.after completing).
  sse.close();
  assert.ok(true);
});
