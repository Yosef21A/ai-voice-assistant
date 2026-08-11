// Auth: setup (first-owner bootstrap), login, logout, /me, and signed-cookie
// tamper rejection. Runs raw HTTP against the Express app on an ephemeral port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeTestApp, listen, request, setupOwner } from '../test-helpers/client.js';

const A = 'el-amen-sousse';

async function boot(t) {
  const app = makeTestApp();
  const server = await listen(app.app);
  t.after(() => new Promise((r) => server.close(r)));
  return { app, server };
}

test('setup creates the first owner, sets a session cookie, rejects re-init', async (t) => {
  const { server } = await boot(t);
  const email = `owner-${randomUUID()}@clinic.tn`;
  const r = await request(server, 'POST', '/api/auth/setup', {
    body: { tenantId: A, email, password: 'password123', name: 'Youssef' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.role, 'owner');
  assert.equal(r.body.user.tenantId, A);
  assert.ok(r.cookie, 'a session cookie was set');
  // Second setup for the same tenant is rejected.
  const dup = await request(server, 'POST', '/api/auth/setup', {
    body: { tenantId: A, email: `other-${randomUUID()}@x.tn`, password: 'password123' },
  });
  assert.equal(dup.status, 409);
});

test('setup validates tenant + password', async (t) => {
  const { server } = await boot(t);
  const unknown = await request(server, 'POST', '/api/auth/setup', {
    body: { tenantId: 'nope', email: 'a@b.tn', password: 'password123' },
  });
  assert.equal(unknown.status, 404);
  const weak = await request(server, 'POST', '/api/auth/setup', {
    body: { tenantId: A, email: 'a@b.tn', password: 'short' },
  });
  assert.equal(weak.status, 400);
});

test('login rejects wrong password, accepts correct, /me needs a cookie', async (t) => {
  const { server } = await boot(t);
  const email = `owner-${randomUUID()}@clinic.tn`;
  await setupOwner(server, { tenantId: A, email });

  const bad = await request(server, 'POST', '/api/auth/login', {
    body: { email, password: 'wrongpass1' },
  });
  assert.equal(bad.status, 401);

  const good = await request(server, 'POST', '/api/auth/login', {
    body: { email, password: 'password123' },
  });
  assert.equal(good.status, 200);
  assert.ok(good.cookie);

  const meNoCookie = await request(server, 'GET', '/api/auth/me');
  assert.equal(meNoCookie.status, 401);

  const me = await request(server, 'GET', '/api/auth/me', { cookie: good.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, email);
});

test('logout clears the cookie', async (t) => {
  const { server } = await boot(t);
  const email = `owner-${randomUUID()}@clinic.tn`;
  const { cookie } = await setupOwner(server, { tenantId: A, email });
  const out = await request(server, 'POST', '/api/auth/logout', { cookie });
  assert.equal(out.status, 204);
  const cleared = (out.headers['set-cookie'] || []).join(';');
  assert.match(cleared, /omen_session=;|Max-Age=0/);
});

test('a tampered session cookie is rejected', async (t) => {
  const { server } = await boot(t);
  const email = `owner-${randomUUID()}@clinic.tn`;
  const { cookie } = await setupOwner(server, { tenantId: A, email });

  // Flip the last character of the token -> HMAC no longer matches.
  const val = cookie.split('=')[1];
  const flipped = val.slice(0, -1) + (val.slice(-1) === 'A' ? 'B' : 'A');
  const tamperedCookie = `omen_session=${flipped}`;

  const me = await request(server, 'GET', '/api/auth/me', { cookie: tamperedCookie });
  assert.equal(me.status, 401);
  const tenant = await request(server, 'GET', '/api/tenant', { cookie: tamperedCookie });
  assert.equal(tenant.status, 401);
  const garbage = await request(server, 'GET', '/api/tenant', { cookie: 'omen_session=not.a.token' });
  assert.equal(garbage.status, 401);
});
