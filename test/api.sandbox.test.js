// Sandbox test-drive: the SAME engine, the caller's tenant, hidden from the live
// inbox, and resettable. Arabic greeting -> Arabic greeting reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeTestApp, listen, request, setupOwner } from '../test-helpers/client.js';

const A = 'el-amen-sousse';

test('sandbox returns an engine reply, keeps state, hides from inbox, resets', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  t.after(() => new Promise((r) => server.close(r)));

  const { cookie } = await setupOwner(server, { tenantId: A, email: `o-${randomUUID()}@x.tn` });

  // Arabic greeting -> Arabic greeting reply.
  const greet = await request(server, 'POST', '/api/sandbox/message', {
    cookie, body: { text: 'السلام عليكم' },
  });
  assert.equal(greet.status, 200);
  assert.equal(greet.body.lang, 'ar');
  assert.equal(greet.body.intent, 'greeting');
  assert.ok(greet.body.reply.includes('أهلا'), 'replied with the Arabic greeting');

  // State persists across turns (booking flow starts).
  const book = await request(server, 'POST', '/api/sandbox/message', {
    cookie, body: { text: 'نحب نحجز موعد' },
  });
  assert.equal(book.body.intent, 'book_appointment');

  // The sandbox thread is hidden from the live inbox.
  const inbox = await request(server, 'GET', '/api/conversations', { cookie });
  assert.equal(inbox.body.conversations.some((c) => String(c.patientWaId).startsWith('sandbox:')), false);

  // Reset clears it.
  const reset = await request(server, 'DELETE', '/api/sandbox', { cookie });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.reset, true);

  // After reset, a greeting starts fresh (no active booking state).
  const again = await request(server, 'POST', '/api/sandbox/message', {
    cookie, body: { text: 'السلام عليكم' },
  });
  assert.equal(again.body.intent, 'greeting');
});
