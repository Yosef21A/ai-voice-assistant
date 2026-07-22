// P2-B "bot didn't know" training loop — capture, dedupe, owner answer → live
// KB, boot hydration, API auth/scoping, draft endpoint, digest line. The full
// circle is asserted end-to-end: unknown question → queue → owner answers →
// the SAME question now gets the trained answer with no restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeTestApp, listen, request, setupOwner } from '../test-helpers/client.js';
import { ingestInbound } from '../src/api/ingest.js';
import { computeDigestStats, computeAnalytics } from '../src/stats/index.js';
import { formatDailyDigest } from '../src/notifications/index.js';
import { kbToFaqEntries, deriveKeywords } from '../src/store/kbLive.js';

const A = 'el-amen-sousse';
const PNID = JSON.parse(fs.readFileSync(new URL('../data/clinics.json', import.meta.url), 'utf8'))
  .clinics.find((c) => c.id === A).whatsapp.phoneNumberId;

const QUESTION = 'Est-ce que vous faites le blanchiment dentaire au laser ?';
const VARIANT = 'est-ce que vous faites le blanchiment dentaire au laser'; // accents/punct differ
const TRAINED = 'Oui — blanchiment au laser sur rendez-vous, séance d’environ 45 minutes.';

function feed(app, from, text) {
  return ingestInbound(
    { store: app.store, engine: app.engine, sender: app.sender, bus: app.bus, mediaClient: app.mediaClient },
    { channel: 'whatsapp', from, text, phoneNumberId: PNID, messageId: `m_${randomUUID()}`, timestamp: Date.now() }
  );
}

// ── capture + dedupe ──────────────────────────────────────────────────────────
test('training — unknown question is captured once, variants bump count, kb.unanswered fires', async (t) => {
  const app = makeTestApp();
  t.after(() => app.notifier.stop());
  await app.kbReady;
  const events = [];
  app.bus.subscribe((e) => events.push(e));

  const res1 = await feed(app, '218941110001', QUESTION);
  assert.equal(res1.out.knew, false, 'engine flagged the miss');
  await feed(app, '218941110002', VARIANT); // different patient, same normalized question

  const rows = await app.store.unanswered.list(A, { status: 'new' });
  assert.equal(rows.length, 1, 'accent/punctuation variants dedupe into one row');
  assert.equal(rows[0].count, 2);
  assert.ok(events.filter((e) => e.type === 'kb.unanswered').length >= 1, 'badge event fired');
  await app.notifier.settled();
});

test('training — greetings and answered FAQs are NOT captured', async (t) => {
  const app = makeTestApp();
  t.after(() => app.notifier.stop());
  await app.kbReady;
  await feed(app, '218941110003', 'السلام عليكم'); // greeting → knew
  const rows = await app.store.unanswered.list(A, {});
  assert.equal(rows.length, 0);
  await app.notifier.settled();
});

// ── the full loop: capture → owner answers → bot knows it NOW ────────────────
test('training — owner answer becomes a live KB entry; the same question is answered, no re-capture', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  t.after(() => {
    app.notifier.stop();
    server.closeAllConnections?.();
    return new Promise((r) => server.close(r));
  });
  await app.kbReady;

  await feed(app, '218941110004', QUESTION);
  const [row] = await app.store.unanswered.list(A, { status: 'new' });
  assert.ok(row, 'question queued');

  const { cookie } = await setupOwner(server, { tenantId: A, email: `o-${randomUUID()}@x.tn` });
  const ans = await request(server, 'POST', `/api/kb/unanswered/${row.id}/answer`, {
    cookie,
    body: { answer: { fr: TRAINED } },
  });
  assert.equal(ans.status, 200);
  assert.equal(ans.body.entry.source, 'didnt_know');
  assert.equal(ans.body.unanswered.status, 'answered');

  // The bot answers the SAME question immediately — no restart, engine path.
  const res = await feed(app, '218941110005', QUESTION);
  assert.equal(res.out.knew, true, 'bot now knows');
  assert.ok(res.out.reply.includes(TRAINED), 'trained answer served');

  // No re-capture, and the triaged row keeps its status on re-ask.
  const after = await app.store.unanswered.list(A, {});
  assert.equal(after.length, 1);
  assert.equal(after[0].status, 'answered');
  await app.notifier.settled();
});

// ── boot hydration: trained answers survive a restart ────────────────────────
test('training — kb entries hydrate into the engine on a fresh composition (restart survives)', async (t) => {
  const appA = makeTestApp();
  await appA.kbReady;
  await appA.store.kbEntries.upsert(A, {
    key: 'laser_whitening',
    question: QUESTION,
    answer: { fr: TRAINED },
    keywords: deriveKeywords(QUESTION),
    source: 'didnt_know',
    status: 'active',
  });
  appA.notifier.stop();

  // Same runtimeDir = same persisted store; fresh process composition.
  const appB = makeTestApp({ runtimeDir: appA.runtimeDir });
  t.after(() => appB.notifier.stop());
  await appB.kbReady;
  const res = await feed(appB, '218941110006', QUESTION);
  assert.equal(res.out.knew, true);
  assert.ok(res.out.reply.includes(TRAINED));
  await appB.notifier.settled();
});

// ── kbLive mapping rules ──────────────────────────────────────────────────────
test('training — kbToFaqEntries skips price rows, archived rows and keywordless entries', () => {
  const rows = kbToFaqEntries([
    { key: 'a', status: 'active', source: 'manual', question: QUESTION, answer: { fr: 'x' }, keywords: [] },
    { key: 'p', status: 'active', source: 'price', answer: { from: '900', currency: 'EUR' } },
    { key: 'z', status: 'archived', source: 'manual', question: QUESTION, answer: { fr: 'x' }, keywords: [] },
    { key: 'nokw', status: 'active', source: 'manual', question: '؟', answer: { fr: 'x' }, keywords: [] },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'kb:a');
  assert.ok(rows[0].keywords.length > 0, 'keywords derived from the question');
});

// ── API auth + tenant scoping + draft ────────────────────────────────────────
test('training — unanswered API: 401 anon, tenant-scoped, dismiss works, draft fills languages', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  t.after(() => {
    app.notifier.stop();
    server.closeAllConnections?.();
    return new Promise((r) => server.close(r));
  });
  await app.kbReady;
  await feed(app, '218941110007', QUESTION);

  assert.equal((await request(server, 'GET', '/api/kb/unanswered')).status, 401);

  const { cookie } = await setupOwner(server, { tenantId: A, email: `o-${randomUUID()}@x.tn` });
  const list = await request(server, 'GET', '/api/kb/unanswered', { cookie });
  assert.equal(list.status, 200);
  assert.equal(list.body.unanswered.length, 1);

  // The other tenant sees nothing.
  const b = await setupOwner(server, { tenantId: 'ennour-sfax', email: `o-${randomUUID()}@x.tn` });
  const other = await request(server, 'GET', '/api/kb/unanswered', { cookie: b.cookie });
  assert.equal(other.body.unanswered.length, 0);
  // …and cannot dismiss tenant A's row.
  const id = list.body.unanswered[0].id;
  assert.equal(
    (await request(server, 'POST', `/api/kb/unanswered/${id}/dismiss`, { cookie: b.cookie })).status,
    404
  );

  const dis = await request(server, 'POST', `/api/kb/unanswered/${id}/dismiss`, { cookie });
  assert.equal(dis.body.unanswered.status, 'dismissed');

  // Draft: the mock provider passes the source answer through to missing langs.
  const draft = await request(server, 'POST', '/api/kb/draft', {
    cookie,
    body: { question: QUESTION, answer: { fr: TRAINED } },
  });
  assert.equal(draft.status, 200);
  assert.equal(draft.body.draft.fr, TRAINED);
  assert.equal(draft.body.draft.ar, TRAINED);
  assert.equal(draft.body.draft.en, TRAINED);
  await app.notifier.settled();
});

// ── stats + digest ────────────────────────────────────────────────────────────
test('training — digest gains the learned line; analytics exposes unansweredNew', () => {
  const range = { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z', tz: 'Africa/Tunis' };
  const tenant = { id: A, name: 'Clinique Test', timezone: 'Africa/Tunis', config: {} };
  const stats = computeDigestStats(
    {
      tenant,
      conversations: [],
      appointments: [],
      leads: [],
      kbEntries: [
        { source: 'didnt_know', status: 'active', updatedAt: '2026-08-10T10:00:00Z' },
        { source: 'didnt_know', status: 'active', updatedAt: '2026-07-01T10:00:00Z' }, // out of window
        { source: 'manual', status: 'active', updatedAt: '2026-08-10T10:00:00Z' }, // not trained
      ],
    },
    range
  );
  assert.equal(stats.learned, 1);
  assert.match(formatDailyDigest(stats, { tenant, lang: 'fr' }), /🧠 Réponses apprises : 1/);

  const zero = computeDigestStats({ tenant, conversations: [], appointments: [], leads: [] }, range);
  assert.ok(!formatDailyDigest(zero, { tenant, lang: 'fr' }).includes('🧠'), 'line hidden at 0');

  const analytics = computeAnalytics(
    {
      tenant,
      conversations: [],
      appointments: [],
      leads: [],
      events: [],
      unanswered: [{ status: 'new' }, { status: 'new' }, { status: 'answered' }],
      messagesByConvo: new Map(),
    },
    range
  );
  assert.equal(analytics.unansweredNew, 2);
});
