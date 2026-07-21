// P2-D media intake — downloader, webhook normalization, ingest branch, owner
// alert and the auth-gated binary route. Fully offline: the media client is
// exercised with an injected fetch (real transport) or the mock transport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMediaClient } from '../src/whatsapp/media.js';
import { normalizeWhatsApp } from '../src/server.js';
import { ingestInbound } from '../src/api/ingest.js';
import { makeTestApp, listen, request, setupOwner } from '../test-helpers/client.js';

const A = 'el-amen-sousse';
const PNID = JSON.parse(fs.readFileSync(new URL('../data/clinics.json', import.meta.url), 'utf8'))
  .clinics.find((c) => c.id === A).whatsapp.phoneNumberId;
const OWNER = '21620111222'; // El Amen handoff phone, normalized
const TENANT = { id: A, whatsapp: { phoneNumberId: PNID } };

const tmpMediaDir = () => path.join(os.tmpdir(), `omen-media-${randomUUID()}`);

function readOutbox(app) {
  const f = path.join(app.runtimeDir, 'outbox.json');
  if (!fs.existsSync(f)) return [];
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) || [];
  } catch {
    return [];
  }
}

function imagePayload({ from, id = 'wamid.MEDIA1', caption }) {
  const image = { id: 'MEDIA-42', mime_type: 'image/jpeg', sha256: 'abc' };
  if (caption) image.caption = caption;
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: PNID },
      messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'image', image }],
    } }] }],
  };
}

// ── media client (real transport, injected fetch) ────────────────────────────
test('media client — 2-step Graph download with Bearer auth, allowlisted ext', async () => {
  const dir = tmpMediaDir();
  const calls = [];
  const bytes = Buffer.from('fake-jpeg-bytes');
  const client = createMediaClient({
    transport: 'real',
    token: 'TESTTOKEN',
    mediaDir: dir,
    fetchImpl: async (url, opts) => {
      calls.push({ url, auth: opts.headers.Authorization });
      if (calls.length === 1) {
        return { ok: true, status: 200, json: async () => ({ url: 'https://lookaside.test/x', mime_type: 'image/jpeg', file_size: bytes.length }), text: async () => '' };
      }
      return { ok: true, status: 200, arrayBuffer: async () => bytes };
    },
  });

  const res = await client.fetchMedia(TENANT, { id: 'MEDIA-42', mimeType: 'image/jpeg' });
  assert.equal(res.ok, true);
  assert.equal(res.mimeType, 'image/jpeg');
  assert.equal(res.size, bytes.length);
  assert.match(res.file, /\.jpg$/);
  assert.ok(res.file.startsWith(A), 'file path starts with tenant id');
  assert.deepEqual(fs.readFileSync(path.join(dir, res.file)), bytes);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/v\d+\.\d+\/MEDIA-42$/);
  assert.equal(calls[0].auth, 'Bearer TESTTOKEN');
  assert.equal(calls[1].url, 'https://lookaside.test/x');
  assert.equal(calls[1].auth, 'Bearer TESTTOKEN');
});

test('media client — refuses oversize (before downloading) and foreign mime types', async () => {
  const dir = tmpMediaDir();
  let binaryFetched = false;
  const client = createMediaClient({
    transport: 'real',
    token: 'T',
    mediaDir: dir,
    maxBytes: 1000,
    fetchImpl: async (url) => {
      if (/MEDIA-BIG$/.test(url)) {
        return { ok: true, status: 200, json: async () => ({ url: 'https://cdn/x', mime_type: 'image/jpeg', file_size: 5000 }) };
      }
      binaryFetched = true;
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.alloc(10) };
    },
  });

  const big = await client.fetchMedia(TENANT, { id: 'MEDIA-BIG', mimeType: 'image/jpeg' });
  assert.equal(big.ok, false);
  assert.match(big.error.message, /too large/);
  assert.equal(binaryFetched, false, 'oversize is rejected from metadata alone');

  const exe = await client.fetchMedia(TENANT, { id: 'MEDIA-EXE', mimeType: 'application/x-msdownload' });
  assert.equal(exe.ok, false);
  assert.match(exe.error.message, /not allowed/);
});

test('media client — missing/NaN file_size fails CLOSED; oversized stream aborts within budget', async () => {
  const dir = tmpMediaDir();
  let binaryFetched = false;

  // (a) metadata without file_size → refused before any byte moves.
  const noSize = createMediaClient({
    transport: 'real',
    token: 'T',
    mediaDir: dir,
    fetchImpl: async (url) => {
      if (/MEDIA-NOSIZE$/.test(url)) {
        return { ok: true, status: 200, json: async () => ({ url: 'https://cdn/x', mime_type: 'image/jpeg' }) };
      }
      binaryFetched = true;
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.alloc(10) };
    },
  });
  const res = await noSize.fetchMedia(TENANT, { id: 'MEDIA-NOSIZE', mimeType: 'image/jpeg' });
  assert.equal(res.ok, false);
  assert.match(res.error.message, /too large or size unknown/);
  assert.equal(binaryFetched, false);

  // (b) declared size lies: the streamed body blows the budget → aborted
  // mid-read, never fully buffered.
  let chunksServed = 0;
  const liar = createMediaClient({
    transport: 'real',
    token: 'T',
    mediaDir: dir,
    maxBytes: 1000,
    fetchImpl: async (url) => {
      if (/MEDIA-LIAR$/.test(url)) {
        return { ok: true, status: 200, json: async () => ({ url: 'https://cdn/liar', mime_type: 'image/jpeg', file_size: 500 }) };
      }
      const chunk = new Uint8Array(600);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null }, // no content-length — the stream budget must catch it
        body: {
          getReader: () => ({
            read: async () => (chunksServed < 5 ? (chunksServed += 1, { done: false, value: chunk }) : { done: true }),
            cancel: async () => {},
          }),
        },
      };
    },
  });
  const lied = await liar.fetchMedia(TENANT, { id: 'MEDIA-LIAR', mimeType: 'image/jpeg' });
  assert.equal(lied.ok, false);
  assert.match(lied.error.message, /body exceeded/);
  assert.ok(chunksServed <= 2, `aborted early (served ${chunksServed} chunks, not the whole body)`);
});

test('media client — mock transport writes a placeholder (offline pipeline works)', async () => {
  const dir = tmpMediaDir();
  const client = createMediaClient({ transport: 'mock', mediaDir: dir });
  const res = await client.fetchMedia(TENANT, { id: 'X', mimeType: 'audio/ogg; codecs=opus' });
  assert.equal(res.ok, true);
  assert.equal(res.mimeType, 'audio/ogg');
  assert.match(res.file, /\.ogg$/);
  assert.ok(fs.existsSync(path.join(dir, res.file)));
});

// ── webhook normalization ─────────────────────────────────────────────────────
test('media — normalizeWhatsApp captures image payloads; caption becomes the text', () => {
  const [norm] = normalizeWhatsApp(imagePayload({ from: '218911112222', caption: 'صورة الأشعة' }));
  assert.equal(norm.media.kind, 'image');
  assert.equal(norm.media.id, 'MEDIA-42');
  assert.equal(norm.media.mimeType, 'image/jpeg');
  assert.equal(norm.text, 'صورة الأشعة');

  const [bare] = normalizeWhatsApp(imagePayload({ from: '218911112222' }));
  assert.equal(bare.text, '');
  assert.equal(bare.media.kind, 'image');
});

// ── ingest: captionless image → persist + ack + 📎 alert, engine silent ───────
test('media — captionless image: persisted with file, ack sent, media.received + 📎 alert, no engine reply', async (t) => {
  const app = makeTestApp();
  t.after(() => app.notifier.stop());
  const events = [];
  app.bus.subscribe((e) => events.push(e));

  const from = '218931114444';
  const [inbound] = normalizeWhatsApp(imagePayload({ from }));
  await ingestInbound(
    { store: app.store, engine: app.engine, sender: app.sender, bus: app.bus, mediaClient: app.mediaClient },
    inbound
  );
  await app.notifier.settled();

  const convoId = `${A}:${from}`;
  const msgs = await app.store.conversations.listMessages(A, convoId, {});
  const inMsg = msgs.find((m) => m.direction === 'inbound');
  assert.equal(inMsg.type, 'image');
  assert.ok(inMsg.body.media.file, 'bytes stored (mock placeholder)');
  assert.equal(inMsg.body.media.error, null);

  // Exactly ONE bot bubble: the localized ack — never an engine fallback.
  const bot = msgs.filter((m) => m.direction === 'outbound');
  assert.equal(bot.length, 1);
  assert.match(bot[0].body.text, /📎/);

  assert.ok(events.some((e) => e.type === 'media.received' && e.conversationId === convoId));
  // 📎 owner alert landed; no message.analyzed for a captionless media turn.
  const ownerAlerts = readOutbox(app).filter((r) => r.ok && r.to === OWNER).map((r) => r.payload.text.body);
  assert.ok(ownerAlerts.some((tx) => tx.includes('📎')), 'owner media alert sent');
  assert.equal((await app.store.events.list(A, { type: 'message.analyzed' })).length, 0);
});

test('media — image WITH caption: engine + detectors run on the caption', async (t) => {
  const app = makeTestApp();
  t.after(() => app.notifier.stop());
  const from = '218932225555';
  const [inbound] = normalizeWhatsApp(imagePayload({ from, caption: 'السلام عليكم' }));
  await ingestInbound(
    { store: app.store, engine: app.engine, sender: app.sender, bus: app.bus, mediaClient: app.mediaClient },
    inbound
  );
  await app.notifier.settled();

  const msgs = await app.store.conversations.listMessages(A, `${A}:${from}`, {});
  const bot = msgs.filter((m) => m.direction === 'outbound' && m.body.by === 'bot');
  assert.ok(bot.length >= 1, 'engine replied to the caption');
  assert.ok(!bot.some((m) => /📎/.test(m.body.text)), 'no duplicate ack when the engine answers');
  assert.equal((await app.store.events.list(A, { type: 'message.analyzed' })).length, 1);
});

// ── the auth-gated binary route ───────────────────────────────────────────────
test('media — GET /api/media/:id: 401 anon, 200 owner with bytes, 404 cross-tenant/bad id', async (t) => {
  const app = makeTestApp();
  const server = await listen(app.app);
  t.after(() => {
    app.notifier.stop();
    server.closeAllConnections?.();
    return new Promise((r) => server.close(r));
  });

  const from = '218933336666';
  const [inbound] = normalizeWhatsApp(imagePayload({ from }));
  await ingestInbound(
    { store: app.store, engine: app.engine, sender: app.sender, bus: app.bus, mediaClient: app.mediaClient },
    inbound
  );
  await app.notifier.settled();
  const msgs = await app.store.conversations.listMessages(A, `${A}:${from}`, {});
  const msgId = msgs.find((m) => m.direction === 'inbound').id;

  assert.equal((await request(server, 'GET', `/api/media/${msgId}`)).status, 401);

  const { cookie } = await setupOwner(server, { tenantId: A, email: `o-${randomUUID()}@x.tn` });
  const ok = await request(server, 'GET', `/api/media/${msgId}`, { cookie });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'image/jpeg');
  assert.ok(ok.raw.includes('mock-media'), 'mock placeholder bytes served');

  const b = await setupOwner(server, { tenantId: 'ennour-sfax', email: `o-${randomUUID()}@x.tn` });
  assert.equal((await request(server, 'GET', `/api/media/${msgId}`, { cookie: b.cookie })).status, 404);
  assert.equal((await request(server, 'GET', '/api/media/../../etc/passwd', { cookie })).status, 404);
  assert.equal((await request(server, 'GET', `/api/media/${randomUUID()}`, { cookie })).status, 404);
});

// ── failed download degrades gracefully ───────────────────────────────────────
// ── paused conversation still alerts the owner ────────────────────────────────
test('media — paused conversation: 📎 media.received still fires, bot stays silent', async (t) => {
  const app = makeTestApp();
  t.after(() => app.notifier.stop());
  const from = '218935558888';
  const convo = await app.store.conversations.create(A, { patientWaId: from, status: 'open' });
  await app.store.conversations.update(A, convo.id, { aiPaused: true });

  const events = [];
  app.bus.subscribe((e) => events.push(e));
  const [inbound] = normalizeWhatsApp(imagePayload({ from }));
  const res = await ingestInbound(
    { store: app.store, engine: app.engine, sender: app.sender, bus: app.bus, mediaClient: app.mediaClient },
    inbound
  );
  await app.notifier.settled();

  assert.equal(res.paused, true);
  assert.ok(events.some((e) => e.type === 'media.received'), 'owner alert event fired despite pause');
  const ownerAlerts = readOutbox(app).filter((r) => r.ok && r.to === OWNER).map((r) => r.payload.text.body);
  assert.ok(ownerAlerts.some((tx) => tx.includes('📎')), '📎 WhatsApp alert sent');
  const msgs = await app.store.conversations.listMessages(A, convo.id, {});
  assert.equal(msgs.filter((m) => m.direction === 'outbound').length, 0, 'bot stayed silent (no ack) while paused');
});

// ── retention purge ───────────────────────────────────────────────────────────
test('media — purge removes files past retention, keeps fresh ones, prunes empty dirs', async () => {
  const { purgeMediaDir } = await import('../scripts/purge-media.js');
  const dir = tmpMediaDir();
  const oldDir = path.join(dir, A, '202601');
  const newDir = path.join(dir, A, '202607');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  const oldFile = path.join(oldDir, 'old.jpg');
  const newFile = path.join(newDir, 'new.jpg');
  fs.writeFileSync(oldFile, 'x');
  fs.writeFileSync(newFile, 'y');
  const old = new Date('2026-01-10T00:00:00Z');
  fs.utimesSync(oldFile, old, old);
  // A stray nested directory must be skipped, not abort the sweep.
  fs.mkdirSync(path.join(newDir, 'stray-subdir'));

  const res = purgeMediaDir(dir, 90, new Date('2026-07-20T00:00:00Z'));
  assert.deepEqual(res, { removed: 1, kept: 1, skipped: 1 });
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(oldDir), false, 'empty month dir pruned');
  assert.equal(fs.existsSync(newFile), true);
});

test('media — failed download persists metadata (available:false), ack still sent', async (t) => {
  const app = makeTestApp();
  t.after(() => app.notifier.stop());
  const failingClient = { fetchMedia: async () => ({ ok: false, error: { message: 'boom' } }) };
  const from = '218934447777';
  const [inbound] = normalizeWhatsApp(imagePayload({ from }));
  await ingestInbound(
    { store: app.store, engine: app.engine, sender: app.sender, bus: app.bus, mediaClient: failingClient },
    inbound
  );
  await app.notifier.settled();

  const msgs = await app.store.conversations.listMessages(A, `${A}:${from}`, {});
  const inMsg = msgs.find((m) => m.direction === 'inbound');
  assert.equal(inMsg.body.media.file, null);
  assert.equal(inMsg.body.media.error, 'boom');
  const { publicMessage } = await import('../src/api/outbound.js');
  const pub = publicMessage(inMsg);
  assert.equal(pub.media.available, false);
  assert.equal(pub.media.url, null);
  assert.equal(msgs.filter((m) => m.direction === 'outbound').length, 1, 'ack still sent');
});
