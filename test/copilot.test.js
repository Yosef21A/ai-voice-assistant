// V6 — owner copilot. Grounding (the system prompt carries ONLY this tenant's
// digest and the answer comes from the provider verbatim), role gate, rate
// limit, tenant-type awareness, and the honesty/privacy contract (no names or
// phone numbers ever reach the model).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeTestApp, listen, request, setupOwner } from '../test-helpers/client.js';

const TENANT = 'el-amen-sousse';
const FAC = 'medtour-tripoli-sousse';

function capturingProvider() {
  const calls = [];
  return {
    name: 'fake-copilot',
    calls,
    async generate(req) {
      calls.push(req);
      return { text: 'GROUNDED-ANSWER', provider: 'fake-copilot' };
    },
    async generateStructured() {
      throw new Error('not used');
    },
  };
}

async function appWithProvider() {
  const provider = capturingProvider();
  const composed = makeTestApp({}, { provider });
  const server = await listen(composed.app);
  return { composed, server, provider };
}

test('copilot answers from the provider, grounded on THIS tenant only', async () => {
  const { composed, server, provider } = await appWithProvider();
  try {
    const { store } = composed;
    // Seed data for BOTH tenants — only El Amen's may reach the prompt.
    await store.appointments.create(TENANT, {
      patientWaId: '218910000400', specialty: 'cardiology', status: 'confirmed',
      datetimeISO: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      patientName: 'SECRET-NAME', contact: '+218910000400', createdAt: new Date().toISOString(),
    });
    await store.leads.upsertOpen(FAC, {
      conversationId: `${FAC}:218000`, patientWaId: '218000',
      procedure: 'OTHER-TENANT-PROC', details: {},
    });

    const { cookie } = await setupOwner(server, { tenantId: TENANT, email: `c-${randomUUID()}@t.tn` });
    const res = await request(server, 'POST', '/api/copilot', {
      cookie, body: { question: 'قداش عندي حجوزات؟' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.answer, 'GROUNDED-ANSWER');

    const req = provider.calls[0];
    assert.ok(req.system.includes('"bookings":1'), 'digest carries the seeded booking');
    assert.ok(req.system.includes('Every number you state must appear in the DATA'), 'honesty law');
    assert.ok(!req.system.includes('OTHER-TENANT-PROC'), 'no cross-tenant leakage');
    assert.ok(!req.system.includes('SECRET-NAME'), 'no patient names in the context');
    assert.ok(!req.system.includes('218910000400'), 'no phone numbers in the context');
    assert.equal(req.userText, 'قداش عندي حجوزات؟');
    assert.equal(req.lang, 'ar');

    // Audit row written.
    const events = await store.events.list(TENANT, { type: 'copilot.asked' });
    assert.equal(events.length, 1);
  } finally {
    server.close();
  }
});

test('facilitator copilot speaks leads/quotes, not a local calendar', async () => {
  const { server, provider } = await appWithProvider();
  try {
    const { cookie } = await setupOwner(server, { tenantId: FAC, email: `f-${randomUUID()}@t.tn` });
    const res = await request(server, 'POST', '/api/copilot', {
      cookie, body: { question: 'How is my pipeline?' },
    });
    assert.equal(res.status, 200);
    const req = provider.calls[0];
    assert.ok(req.system.includes('facilitator AGENCY'), 'agency persona');
    assert.ok(req.system.includes('LEADS and QUOTES'), 'speaks the agency language');
  } finally {
    server.close();
  }
});

test('role gate: staff cannot use the copilot; anonymous gets 401', async () => {
  const { composed, server } = await appWithProvider();
  try {
    const anon = await request(server, 'POST', '/api/copilot', { body: { question: 'x' } });
    assert.equal(anon.status, 401);

    await setupOwner(server, { tenantId: TENANT, email: `o-${randomUUID()}@t.tn` });
    const { hashPassword } = await import('../src/auth/passwords.js');
    await composed.store.users.create(TENANT, {
      email: `staff-${randomUUID()}@t.tn`,
      passwordHash: await hashPassword('password123'),
      role: 'staff',
    });
    const staffEmail = (await composed.store.users.list(TENANT)).find((u) => u.role === 'staff').email;
    const login = await request(server, 'POST', '/api/auth/login', {
      body: { email: staffEmail, password: 'password123' },
    });
    assert.equal(login.status, 200);
    const res = await request(server, 'POST', '/api/copilot', {
      cookie: login.cookie, body: { question: 'x' },
    });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('rate limit: the 11th question in a minute is 429', async () => {
  const { server } = await appWithProvider();
  try {
    const { cookie } = await setupOwner(server, { tenantId: TENANT, email: `r-${randomUUID()}@t.tn` });
    let last;
    for (let i = 0; i < 11; i++) {
      last = await request(server, 'POST', '/api/copilot', { cookie, body: { question: `q${i}` } });
    }
    assert.equal(last.status, 429);
  } finally {
    server.close();
  }
});
