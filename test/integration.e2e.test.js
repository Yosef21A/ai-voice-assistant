// Full-flow integration (P1-F). Drives the REAL composed app end-to-end — store +
// engine + event bus + mock sender + notification service — through the shared
// ingest pipeline the webhook uses, and asserts the product works as a whole:
//
//   (a) AR greeting + booking → conversation + messages persisted, appointment
//       created with the right fields, appointment.created on the bus, and a
//       ✅ owner alert (with the booking ref) in the mock outbox.
//   (b) staff takeover pauses the bot → an inbound during the pause is persisted
//       and emitted (SSE-forwarded) but gets NO bot reply.
//   (c) emergency ("صدري يوجعني…") → the localized overrideReply is sent to the
//       patient (with the emergency number), the bot is paused, a 🚨 owner alert
//       fires, and emergency.detected reaches a live SSE client.
//   (d) hot lead (+218 cosmetic price ask) → a 🔥 owner alert fires and lead.hot
//       reaches a live SSE client.
//
// The webhook HTTP surface is smoke-tested separately (Meta-shaped payload →
// 200 → persisted). We drive scenarios through ingestInbound directly because
// POST /webhook acknowledges fast and processes asynchronously; calling the
// pipeline is the deterministic, awaitable equivalent (same normalized shape).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTestApp, listen, request, setupOwner, openSse } from '../test-helpers/client.js';
import { ingestInbound } from '../src/api/ingest.js';
import { normalizeWhatsApp } from '../src/server.js';

const A = 'el-amen-sousse';
// Derived, not hard-coded: the registry re-keys this tenant to the real Meta
// phone_number_id when a live number is wired (see 2b92c67).
const EL = JSON.parse(fs.readFileSync(new URL('../data/clinics.json', import.meta.url), 'utf8'))
  .clinics.find((c) => c.id === A);
const PNID = EL.whatsapp.phoneNumberId;
// Owner alert recipient, derived from the seed (notifications.recipients wins
// over handoff.phone) so re-pointing the seed never breaks the suite.
const OWNER = String(EL.notifications?.recipients?.[0] || EL.handoff.phone).replace(/\D/g, '');

// ── helpers ──────────────────────────────────────────────────────────────────
function readOutbox(app) {
  const f = path.join(app.runtimeDir, 'outbox.json');
  if (!fs.existsSync(f)) return [];
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) || [];
  } catch {
    return [];
  }
}
function outboundTextsTo(app, to) {
  return readOutbox(app)
    .filter((r) => r && r.ok && r.to === to && r.payload && r.payload.text && r.payload.text.body)
    .map((r) => r.payload.text.body);
}

// One inbound turn through the real ingest pipeline; then drain notification
// dispatch so the outbox is settled before we assert on it.
async function feed(app, { from, text }) {
  const res = await ingestInbound(
    { store: app.store, engine: app.engine, sender: app.sender, bus: app.bus },
    {
      channel: 'whatsapp',
      from,
      text,
      phoneNumberId: PNID,
      messageId: `m_${randomUUID()}`,
      timestamp: Date.now(),
    }
  );
  await app.notifier.settled();
  return res;
}

// ── (a) booking end-to-end ───────────────────────────────────────────────────
test('(a) AR booking: persisted convo + appointment + appointment.created + ✅ owner alert', async (t) => {
  const app = makeTestApp();
  t.after(() => app.notifier.stop());
  const events = [];
  app.bus.subscribe((e) => events.push(e));

  const from = '218910000001';
  const script = [
    'السلام عليكم',
    'نحب نحجز موعد',
    'أمراض القلب',
    'نهار الاثنين الساعة 10 صباحاً',
    'اسمي محمد العبيدي',
    'من طرابلس، ليبيا',
    'رقم الهاتف متاعي +218 91 000 0001',
    'نعم أكد الحجز',
  ];
  for (const text of script) await feed(app, { from, text }); // eslint-disable-line no-await-in-loop

  const conversationId = `${A}:${from}`;

  // conversation + messages persisted (inbound + bot replies)
  const convo = await app.store.conversations.getById(A, conversationId);
  assert.ok(convo, 'conversation persisted');
  const msgs = await app.store.conversations.listMessages(A, conversationId, {});
  assert.ok(msgs.some((m) => m.direction === 'inbound'), 'inbound persisted');
  assert.ok(
    msgs.some((m) => m.direction === 'outbound' && m.body.by === 'bot'),
    'bot replies persisted'
  );

  // appointment created with the right fields
  const appts = await app.store.appointments.list(A);
  assert.equal(appts.length, 1, 'exactly one appointment');
  const appt = appts[0];
  assert.equal(appt.specialty, 'cardiology');
  assert.equal(appt.status, 'confirmed');
  assert.equal(appt.patientWaId, from);
  assert.ok(appt.patientName, 'appointment has patient name');
  assert.ok(appt.contact, 'appointment has contact');
  assert.ok(appt.ref, 'appointment has a ref');

  // appointment.created on the bus, carrying the same ref
  const created = events.find((e) => e.type === 'appointment.created');
  assert.ok(created, 'appointment.created emitted on the bus');
  assert.equal(created.tenantId, A);
  assert.equal(created.appointment.ref, appt.ref);

  // ✅ owner alert with the booking ref landed in the mock outbox
  const ownerAlerts = outboundTextsTo(app, OWNER);
  assert.ok(
    ownerAlerts.some((tx) => tx.includes('✅') && tx.includes(appt.ref)),
    'owner booking alert with the ref was sent'
  );
});

// ── (b) staff takeover pauses the bot ────────────────────────────────────────
test('(b) staff takeover: paused inbound is persisted + emitted but gets no bot reply', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  t.after(() => {
    app.notifier.stop();
    server.closeAllConnections?.();
    return new Promise((r) => server.close(r));
  });
  const { cookie } = await setupOwner(server, { tenantId: A, email: `o-${randomUUID()}@x.tn` });

  const from = '218920000002';
  await feed(app, { from, text: 'Bonjour' }); // greeting → one bot reply
  const conversationId = `${A}:${from}`;
  const before = await app.store.conversations.listMessages(A, conversationId, {});
  const botBefore = before.filter((m) => m.direction === 'outbound').length;
  assert.ok(botBefore >= 1, 'bot replied before takeover');

  // Staff takes over via the API (pauses the bot).
  const tk = await request(server, 'POST', `/api/conversations/${conversationId}/takeover`, {
    cookie,
    body: { paused: true },
  });
  assert.equal(tk.status, 200);
  assert.equal(tk.body.conversation.aiPaused, true);

  // A new inbound during the pause: persisted + emitted, but no new bot reply.
  const events = [];
  app.bus.subscribe((e) => events.push(e));
  const res = await feed(app, { from, text: 'ثمة حد يسمعني؟' });
  assert.equal(res.paused, true, 'ingest short-circuits while paused');

  const after = await app.store.conversations.listMessages(A, conversationId, {});
  assert.ok(after.length > before.length, 'paused inbound was still persisted');
  const botAfter = after.filter((m) => m.direction === 'outbound').length;
  assert.equal(botAfter, botBefore, 'no new bot reply while paused');
  assert.ok(
    events.some((e) => e.type === 'message.in' && e.conversationId === conversationId),
    'paused inbound emitted (SSE-forwarded)'
  );
});

// ── (c) emergency override ───────────────────────────────────────────────────
test('(c) emergency: overrideReply sent + bot paused + 🚨 owner alert + emergency.detected on SSE', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  const { cookie } = await setupOwner(server, { tenantId: A, email: `o-${randomUUID()}@x.tn` });
  const sse = await openSse(server, '/api/stream', cookie);
  t.after(() => {
    sse.close();
    app.notifier.stop();
    server.closeAllConnections?.(); // drop the long-lived SSE socket so close() resolves
    return new Promise((r) => server.close(r));
  });
  await sse.waitFor((b) => b.includes(': connected'));

  const from = '218930000003';
  await feed(app, { from, text: 'صدري يوجعني برشا وما نجمّش نتنفّس' });

  const conversationId = `${A}:${from}`;
  const convo = await app.store.conversations.getById(A, conversationId);
  assert.equal(convo.aiPaused, true, 'bot paused after emergency');
  assert.equal(convo.status, 'needs_human', 'flagged for a human');

  // overrideReply persisted as a bot bubble, carrying the emergency number.
  const msgs = await app.store.conversations.listMessages(A, conversationId, {});
  const botMsg = msgs.find((m) => m.direction === 'outbound' && m.body.by === 'bot');
  assert.ok(botMsg, 'override reply persisted as a bot bubble');
  assert.ok(botMsg.body.text.includes('🚨'), 'override carries the emergency siren');
  assert.ok(botMsg.body.text.includes('190'), 'override carries the emergency number');

  // 🚨 owner alert in the outbox.
  const ownerAlerts = outboundTextsTo(app, OWNER);
  assert.ok(
    ownerAlerts.some((tx) => tx.includes('🚨')),
    'owner emergency alert was sent'
  );

  // emergency.detected received by the SSE client.
  await sse.waitFor((b) => b.includes('event: emergency.detected'));
  const m = /event: emergency\.detected\ndata: (.+)\n/.exec(sse.buffer);
  assert.ok(m, 'received an emergency.detected SSE frame');
  const payload = JSON.parse(m[1]);
  assert.equal(payload.tenantId, A);
  assert.equal(payload.conversationId, conversationId);
});

// ── (d) hot lead ─────────────────────────────────────────────────────────────
test('(d) hot lead (+218 cosmetic price ask): 🔥 owner alert + lead.hot on SSE', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  const { cookie } = await setupOwner(server, { tenantId: A, email: `o-${randomUUID()}@x.tn` });
  const sse = await openSse(server, '/api/stream', cookie);
  t.after(() => {
    sse.close();
    app.notifier.stop();
    server.closeAllConnections?.(); // drop the long-lived SSE socket so close() resolves
    return new Promise((r) => server.close(r));
  });
  await sse.waitFor((b) => b.includes(': connected'));

  const from = '218955000005'; // +218 Libyan (foreign) number
  await feed(app, { from, text: 'How much does cosmetic surgery cost?' });

  const ownerAlerts = outboundTextsTo(app, OWNER);
  assert.ok(
    ownerAlerts.some((tx) => tx.includes('🔥')),
    'owner hot-lead alert was sent'
  );

  await sse.waitFor((b) => b.includes('event: lead.hot'));
  const m = /event: lead\.hot\ndata: (.+)\n/.exec(sse.buffer);
  assert.ok(m, 'received a lead.hot SSE frame');
  const payload = JSON.parse(m[1]);
  assert.equal(payload.tenantId, A);
  assert.equal(payload.conversationId, `${A}:${from}`);
});

// ── webhook HTTP smoke ───────────────────────────────────────────────────────
test('POST /webhook (Meta-shaped) is accepted (200) and persists the inbound', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  t.after(() => {
    app.notifier.stop();
    server.closeAllConnections?.();
    return new Promise((r) => server.close(r));
  });

  const from = '218999000009';
  const body = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: PNID },
              messages: [
                {
                  from,
                  id: 'wamid.SMOKE',
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: 'السلام عليكم' },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  // The normalizer understands the shape.
  const norm = normalizeWhatsApp(body);
  assert.equal(norm.length, 1);
  assert.equal(norm[0].from, from);
  assert.equal(norm[0].phoneNumberId, PNID);

  const res = await request(server, 'POST', '/webhook', { body });
  assert.equal(res.status, 200, 'webhook acknowledges fast');

  // Processing is async after the 200 — poll for the persisted conversation.
  const conversationId = `${A}:${from}`;
  let convo = null;
  for (let i = 0; i < 60 && !convo; i += 1) {
    convo = await app.store.conversations.getById(A, conversationId); // eslint-disable-line no-await-in-loop
    if (!convo) await new Promise((r) => setTimeout(r, 25)); // eslint-disable-line no-await-in-loop
  }
  assert.ok(convo, 'webhook persisted the inbound conversation');
  await app.notifier.settled();
});
