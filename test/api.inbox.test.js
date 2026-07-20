// Live inbox: webhook ingest persists inbound + bot reply; human takeover
// persists ai_paused; a paused bot stays silent; staff send lands in the mock
// outbox, is attributed to the staff member, and auto-pauses the bot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTestApp, listen, request, setupOwner } from '../test-helpers/client.js';
import { ingestInbound } from '../src/api/ingest.js';

const A = 'el-amen-sousse';
// Derived, not hard-coded: the registry re-keys this tenant to the real Meta
// phone_number_id when a live number is wired (see 2b92c67).
const PNID = JSON.parse(fs.readFileSync(new URL('../data/clinics.json', import.meta.url), 'utf8'))
  .clinics.find((c) => c.id === A).whatsapp.phoneNumberId;

function waPayload({ from, text, id }) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: PNID },
              messages: [
                { from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function until(fn, { timeout = 2000, interval = 20 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

test('webhook persists inbound + bot reply, takeover + staff send work', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  t.after(() => new Promise((r) => server.close(r)));
  const store = app.store;

  const { res: setup, cookie } = await setupOwner(server, { tenantId: A, email: `o-${randomUUID()}@x.tn` });
  const userId = setup.body.user.id;

  // 1) Drive the real webhook with an Arabic greeting; processing is async.
  const from = '218900000123';
  const convoId = `${A}:${from}`;
  const hook = await request(server, 'POST', '/webhook', {
    body: waPayload({ from, text: 'السلام عليكم', id: 'wamid.in1' }),
  });
  assert.equal(hook.status, 200);

  // Inbound + at least one bot reply get persisted to the normalized transcript.
  const msgs = await until(async () => {
    const m = await store.conversations.listMessages(A, convoId, {});
    return m.filter((x) => x.direction === 'outbound').length >= 1 ? m : null;
  });
  assert.equal(msgs[0].direction, 'inbound');
  assert.ok(msgs.some((m) => m.direction === 'outbound'), 'bot replied');

  // 2) It shows up in the inbox list + detail.
  const list = await request(server, 'GET', '/api/conversations', { cookie });
  assert.equal(list.status, 200);
  assert.ok(list.body.conversations.some((c) => c.id === convoId));
  const detail = await request(server, 'GET', `/api/conversations/${convoId}`, { cookie });
  assert.equal(detail.status, 200);
  assert.ok(detail.body.messages.length >= 2);

  // 3) Human takeover persists ai_paused.
  const takeover = await request(server, 'POST', `/api/conversations/${convoId}/takeover`, {
    cookie, body: { paused: true },
  });
  assert.equal(takeover.status, 200);
  assert.equal(takeover.body.conversation.aiPaused, true);
  const afterPause = await request(server, 'GET', `/api/conversations/${convoId}`, { cookie });
  assert.equal(afterPause.body.conversation.aiPaused, true);

  // 4) While paused, another inbound does NOT trigger a bot reply (deterministic:
  //    ingestInbound is awaited directly).
  const outBefore = (await store.conversations.listMessages(A, convoId, {})).filter((m) => m.direction === 'outbound').length;
  await ingestInbound(
    { store, engine: app.engine, sender: app.sender, bus: app.bus },
    { channel: 'whatsapp', from, text: 'مرحبا مرة أخرى', phoneNumberId: PNID, messageId: 'wamid.in2', timestamp: Date.now() }
  );
  const outAfter = (await store.conversations.listMessages(A, convoId, {})).filter((m) => m.direction === 'outbound').length;
  assert.equal(outAfter, outBefore, 'bot stayed silent while paused');

  // 5) Staff send: auto-pauses a fresh conversation, lands in the mock outbox,
  //    is attributed to the staff member.
  const fresh = await store.conversations.create(A, { patientWaId: '218900000999', status: 'open' });
  assert.equal(fresh.aiPaused, false);
  const staffText = `Bonjour, ici la clinique ${randomUUID()}`;
  const sent = await request(server, 'POST', `/api/conversations/${fresh.id}/send`, {
    cookie, body: { text: staffText },
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.ok, true);

  const reloaded = await request(server, 'GET', `/api/conversations/${fresh.id}`, { cookie });
  assert.equal(reloaded.body.conversation.aiPaused, true, 'staff send auto-paused the bot');
  const staffMsg = reloaded.body.messages.find((m) => m.text === staffText);
  assert.ok(staffMsg, 'staff message persisted to the transcript');
  assert.equal(staffMsg.direction, 'outbound');
  assert.equal(staffMsg.by, `staff:${userId}`);

  const outboxPath = path.join(app.runtimeDir, 'outbox.json');
  const outbox = JSON.parse(fs.readFileSync(outboxPath, 'utf8'));
  assert.ok(outbox.some((r) => r.payload?.text?.body === staffText), 'staff text hit the mock outbox');
});
