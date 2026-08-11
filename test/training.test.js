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

// ── review hardening regressions (13 confirmed findings) ─────────────────────
test('training — trained answers never hijack unrelated questions (stopword keywords)', async (t) => {
  const app = makeTestApp();
  t.after(() => app.notifier.stop());
  await app.kbReady;
  const server = await listen(app.app);
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((r) => server.close(r));
  });
  const { cookie } = await setupOwner(server, { tenantId: A, email: `o-${randomUUID()}@x.tn` });

  // Stopwords are filtered out of derived keywords entirely.
  const kws = deriveKeywords(QUESTION);
  for (const stop of ['est', 'que', 'vous', 'faites']) {
    assert.ok(!kws.includes(stop), `'${stop}' must not become a keyword`);
  }
  assert.ok(kws.includes('blanchiment') && kws.includes('laser'), 'content words kept');

  // Train the laser answer, then ask an UNRELATED payment question: the seed
  // payment FAQ must win (pre-fix: 'est'+'que' tied it and KB-first hijacked).
  await feed(app, '218951112221', QUESTION);
  const [row] = await app.store.unanswered.list(A, { status: 'new' });
  const ans = await request(server, 'POST', `/api/kb/unanswered/${row.id}/answer`, {
    cookie,
    body: { answer: { fr: TRAINED } },
  });
  assert.equal(ans.status, 200);

  const pay = await feed(app, '218951112222', 'Est-ce que je peux payer en cash ?');
  const payReply = (pay.out.replies || []).join(' ');
  assert.ok(!payReply.includes('blanchiment'), 'payment question NOT answered with the laser entry');

  // And a genuinely-unknown French question is still captured (no starvation).
  await feed(app, '218951112223', 'Est-ce que vous proposez des séances de yoga prénatal ?');
  const rows = await app.store.unanswered.list(A, { status: 'new' });
  assert.ok(
    rows.some((r) => r.question.includes('yoga')),
    'unknown question still reaches the training queue after training an answer'
  );
});

test('training — a Settings save never reverts trained answers nor resurrects deleted ones', async (t) => {
  const app = makeTestApp();
  t.after(() => app.notifier.stop());
  await app.kbReady;
  const server = await listen(app.app);
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((r) => server.close(r));
  });
  const { cookie } = await setupOwner(server, { tenantId: A, email: `o-${randomUUID()}@x.tn` });

  // Settings save #1 (pre-fix this snapshotted the merged faq into tenants.json).
  assert.equal((await request(server, 'PUT', '/api/tenant', { cookie, body: { city: 'Sousse' } })).status, 200);

  // Train an answer, then delete the KB entry, then save Settings again.
  await feed(app, '218952223331', QUESTION);
  const [row] = await app.store.unanswered.list(A, { status: 'new' });
  const ans = await request(server, 'POST', `/api/kb/unanswered/${row.id}/answer`, {
    cookie,
    body: { answer: { fr: TRAINED } },
  });
  assert.equal(ans.status, 200);
  const trainedKey = ans.body.entry.key;

  const del = await request(server, 'DELETE', `/api/kb/${encodeURIComponent(trainedKey)}`, { cookie });
  assert.equal(del.status, 200);

  assert.equal((await request(server, 'PUT', '/api/tenant', { cookie, body: { city: 'Sousse 2' } })).status, 200);

  // The deleted (archived) entry must NOT be served after the settings save.
  const live = app.store.getClinicById(A);
  assert.ok(!live.faq.some((f) => f.id === `kb:${trainedKey}`), 'archived entry not resurrected');
  // And the persisted tenant config carries no merge state.
  const tenant = await app.store.tenants.getById(A);
  assert.equal(tenant.config.faq, undefined, 'merged faq never persisted');
  assert.equal(tenant.config._baseFaq, undefined, 'base snapshot never persisted');

  // Train ANOTHER answer after a save: still served (merge survives assigns).
  await feed(app, '218952223332', 'Proposez-vous des consultations en visio ?');
  const rows = await app.store.unanswered.list(A, { status: 'new' });
  const visio = rows.find((r) => r.question.includes('visio'));
  const ans2 = await request(server, 'POST', `/api/kb/unanswered/${visio.id}/answer`, {
    cookie,
    body: { answer: { fr: 'Oui, sur rendez-vous — demandez le lien visio à la réception.' } },
  });
  assert.equal(ans2.status, 200);
  assert.equal((await request(server, 'PUT', '/api/tenant', { cookie, body: { city: 'Sousse 3' } })).status, 200);
  const after = await feed(app, '218952223333', 'Proposez-vous des consultations en visio ?');
  assert.ok((after.out.replies || []).join(' ').includes('visio'), 'trained answer survives Settings saves');
});

test('training — unanswered ring cap drops triaged rows first; norm/question capped', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const { createStore } = await import('../src/store/index.js');
  const { getConfig } = await import('../src/config.js');
  const store = createStore({
    clinicsFile: getConfig().clinicsFile,
    runtimeDir: path.join(os.tmpdir(), `omen-unanswered-cap-${randomUUID()}`),
    reset: true,
    unansweredMax: 3,
  });
  const r1 = await store.unanswered.upsertByNorm(A, { norm: 'q1', question: 'q1' });
  await store.unanswered.setStatus(A, r1.id, 'dismissed'); // triaged → first victim
  await store.unanswered.upsertByNorm(A, { norm: 'q2', question: 'q2' });
  await store.unanswered.upsertByNorm(A, { norm: 'q3', question: 'q3' });
  await store.unanswered.upsertByNorm(A, { norm: 'q4', question: 'q4' });
  const rows = await store.unanswered.list(A, {});
  assert.equal(rows.length, 3, 'capped at unansweredMax');
  assert.ok(!rows.some((r) => r.norm === 'q1'), 'oldest TRIAGED row evicted first');
  assert.ok(rows.some((r) => r.norm === 'q4'), 'newest kept');

  const long = await store.unanswered.upsertByNorm(A, { norm: 'x'.repeat(999), question: 'y'.repeat(999) });
  assert.ok(long.norm.length <= 200 && long.question.length <= 300, 'untrusted sizes capped');
  await store.close();
});

test('training — countOnly badge path, list pagination, and collision-proof keys', async (t) => {
  const app = makeTestApp();
  t.after(() => app.notifier.stop());
  await app.kbReady;
  const server = await listen(app.app);
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((r) => server.close(r));
  });
  const { cookie } = await setupOwner(server, { tenantId: A, email: `o-${randomUUID()}@x.tn` });

  // Two DIFFERENT questions engineered to share a slug.
  await app.store.unanswered.upsertByNorm(A, { norm: 'n1', question: 'Parking gratuit ?' });
  await app.store.unanswered.upsertByNorm(A, { norm: 'n2', question: 'Parking gratuit !!' });

  const count = await request(server, 'GET', '/api/kb/unanswered?countOnly=1', { cookie });
  assert.equal(count.status, 200);
  assert.equal(count.body.count, 2);

  const limited = await request(server, 'GET', '/api/kb/unanswered?limit=1', { cookie });
  assert.equal(limited.body.unanswered.length, 1);
  assert.equal(limited.body.total, 2);

  const rows = await app.store.unanswered.list(A, {});
  const k1 = await request(server, 'POST', `/api/kb/unanswered/${rows[0].id}/answer`, {
    cookie,
    body: { answer: { fr: 'Oui, parking gratuit devant la clinique.' } },
  });
  const k2 = await request(server, 'POST', `/api/kb/unanswered/${rows[1].id}/answer`, {
    cookie,
    body: { answer: { fr: 'Oui — même réponse, autre formulation.' } },
  });
  assert.equal(k1.status, 200);
  assert.equal(k2.status, 200);
  assert.notEqual(k1.body.entry.key, k2.body.entry.key, 'same slug never overwrites a different entry');
});

test('training — draft route validates lengths and rate-limits the paid LLM path', async (t) => {
  const app = makeTestApp();
  t.after(() => app.notifier.stop());
  await app.kbReady;
  const server = await listen(app.app);
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((r) => server.close(r));
  });
  const { cookie } = await setupOwner(server, { tenantId: A, email: `o-${randomUUID()}@x.tn` });

  const tooLong = await request(server, 'POST', '/api/kb/draft', {
    cookie,
    body: { question: 'q'.repeat(600), answer: { fr: 'ok' } },
  });
  assert.equal(tooLong.status, 400);

  let last = null;
  for (let i = 0; i < 12; i += 1) {
    last = await request(server, 'POST', '/api/kb/draft', {
      cookie,
      body: { question: `Question numéro ${i} ?`, answer: { fr: 'Réponse.' } },
    });
  }
  assert.equal(last.status, 429, 'draft spam throttled per tenant');
});
