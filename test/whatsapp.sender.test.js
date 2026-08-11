// Tests for the outbound WhatsApp sender (src/whatsapp).
// Strategy: stub the GLOBAL fetch and assert URL/headers/payload correctness for
// every send type, retry + backoff behavior, the error taxonomy, the mock
// transport's outbox writes, and the sendEngineReply adapter. sleep + jitter are
// injected so retry timing is deterministic and the suite runs instantly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSender, classifyHttpError } from '../src/whatsapp/index.js';

const TENANT = { id: 'el-amen-sousse', whatsapp: { phoneNumberId: '1000000001' } };

// ── test doubles ──────────────────────────────────────────────────────────────
function makeRes(opts = {}) {
  const { status = 200, json = null, headers = {} } = opts;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async text() {
      return json == null ? '' : JSON.stringify(json);
    },
  };
}

// A queue of fetch outcomes. Each entry is a response spec, or an Error to throw
// (network failure). The LAST entry repeats for any further calls (handy for the
// "always 500" exhaustion case).
function queueFetch(steps) {
  const calls = [];
  const q = steps.slice();
  async function impl(url, opts) {
    calls.push({
      url,
      opts,
      headers: (opts && opts.headers) || {},
      body: opts && opts.body ? JSON.parse(opts.body) : null,
    });
    const step = q.length > 1 ? q.shift() : q[0];
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(calls.length);
    return makeRes(step);
  }
  return { impl, calls };
}

async function withFetch(steps, run) {
  const q = queueFetch(steps);
  const orig = globalThis.fetch;
  globalThis.fetch = q.impl;
  try {
    return await run(q);
  } finally {
    globalThis.fetch = orig;
  }
}

function sleeper() {
  const calls = [];
  return { fn: async (ms) => calls.push(ms), calls };
}

// A real-transport sender with deterministic sleep + zero jitter and an
// onOutbound collector, so tests can assert on both the wire and the audit hook.
function realSender(extra = {}) {
  const s = sleeper();
  const outbound = [];
  const sender = createSender({
    transport: 'real',
    token: 'TESTTOKEN',
    graphVersion: 'v23.0',
    apiBase: 'https://graph.facebook.com',
    maxRetries: 3,
    retryBaseMs: 500,
    retryMaxMs: 8000,
    sleep: s.fn,
    randomFn: () => 0,
    onOutbound: (r) => outbound.push(r),
    ...extra,
  });
  return { sender, sleeps: s.calls, outbound };
}

// ── payload / URL / auth correctness ───────────────────────────────────────────
test('sendText posts the correct URL, auth header and text payload', async () => {
  await withFetch([{ status: 200, json: { messages: [{ id: 'wamid.AAA' }] } }], async (q) => {
    const { sender, outbound } = realSender();
    const r = await sender.sendText(TENANT, '218910000001', 'Bonjour');
    assert.equal(r.ok, true);
    assert.equal(r.waMessageId, 'wamid.AAA');
    assert.equal(q.calls.length, 1);
    const c = q.calls[0];
    assert.equal(c.url, 'https://graph.facebook.com/v23.0/1000000001/messages');
    assert.equal(c.opts.method, 'POST');
    assert.equal(c.headers.Authorization, 'Bearer TESTTOKEN');
    assert.equal(c.headers['Content-Type'], 'application/json');
    assert.deepEqual(c.body, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '218910000001',
      type: 'text',
      text: { body: 'Bonjour', preview_url: false },
    });
    // onOutbound audit hook fired for the real transport too.
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].ok, true);
    assert.equal(outbound[0].kind, 'text');
    assert.equal(outbound[0].transport, 'real');
    assert.equal(outbound[0].tenantId, 'el-amen-sousse');
  });
});

test('sendTemplate builds a template payload with language + components', async () => {
  await withFetch([{ status: 200, json: { messages: [{ id: 'wamid.T' }] } }], async (q) => {
    const { sender } = realSender();
    const comps = [{ type: 'body', parameters: [{ type: 'text', text: 'Ahmed' }] }];
    const r = await sender.sendTemplate(TENANT, '2189', 'appt_reminder', 'ar', comps);
    assert.equal(r.ok, true);
    assert.deepEqual(q.calls[0].body, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '2189',
      type: 'template',
      template: { name: 'appt_reminder', language: { code: 'ar' }, components: comps },
    });
  });
});

test('sendMedia detects link vs id and only captions captionable types', async () => {
  await withFetch(
    [
      { status: 200, json: { messages: [{ id: 'wamid.M1' }] } },
      { status: 200, json: { messages: [{ id: 'wamid.M2' }] } },
    ],
    async (q) => {
      const { sender } = realSender();
      await sender.sendMedia(TENANT, '2189', {
        type: 'image',
        idOrLink: 'https://cdn/x.jpg',
        caption: 'X-ray',
      });
      assert.equal(q.calls[0].body.type, 'image');
      assert.deepEqual(q.calls[0].body.image, { link: 'https://cdn/x.jpg', caption: 'X-ray' });

      await sender.sendMedia(TENANT, '2189', {
        type: 'document',
        idOrLink: 'MEDIA_ID_123',
        filename: 'report.pdf',
      });
      assert.deepEqual(q.calls[1].body.document, { id: 'MEDIA_ID_123', filename: 'report.pdf' });
    }
  );
});

test('sendMedia rejects an unsupported type without touching the network', async () => {
  await withFetch([], async (q) => {
    const { sender } = realSender();
    const r = await sender.sendMedia(TENANT, '2189', { type: 'gif', idOrLink: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'invalid_request');
    assert.equal(q.calls.length, 0);
  });
});

test('sendButtons builds interactive reply buttons, normalizes + truncates', async () => {
  await withFetch([{ status: 200, json: { messages: [{ id: 'wamid.B' }] } }], async (q) => {
    const { sender } = realSender();
    const r = await sender.sendButtons(TENANT, '2189', 'Confirm your slot?', [
      { id: 'yes', title: 'Yes' },
      'Maybe',
      { id: 'no', title: 'This title is definitely longer than twenty chars' },
    ]);
    assert.equal(r.ok, true);
    const inter = q.calls[0].body.interactive;
    assert.equal(q.calls[0].body.type, 'interactive');
    assert.equal(inter.type, 'button');
    assert.equal(inter.body.text, 'Confirm your slot?');
    assert.equal(inter.action.buttons.length, 3);
    assert.deepEqual(inter.action.buttons[0], { type: 'reply', reply: { id: 'yes', title: 'Yes' } });
    assert.equal(inter.action.buttons[1].reply.id, 'btn_2'); // bare string got a generated id
    assert.equal(inter.action.buttons[1].reply.title, 'Maybe');
    assert.equal(inter.action.buttons[2].reply.title.length, 20); // truncated to the WA limit
  });
});

test('sendButtons rejects more than three buttons without a network call', async () => {
  await withFetch([], async (q) => {
    const { sender } = realSender();
    const r = await sender.sendButtons(TENANT, '2189', 'x', ['a', 'b', 'c', 'd']);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'invalid_request');
    assert.equal(q.calls.length, 0);
  });
});

test('markRead posts a read status and returns ok with no message id', async () => {
  await withFetch([{ status: 200, json: { success: true } }], async (q) => {
    const { sender } = realSender();
    const r = await sender.markRead(TENANT, 'wamid.INBOUND');
    assert.equal(r.ok, true);
    assert.equal(r.waMessageId, undefined);
    assert.deepEqual(q.calls[0].body, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.INBOUND',
    });
  });
});

test('resolves phone_number_id from several tenant shapes', async () => {
  const shapes = [
    { whatsapp: { phoneNumberId: 'PNID1' } },
    { phone_number_id: 'PNID2' },
    { phoneNumberId: 'PNID3' },
    'PNID4',
  ];
  for (let i = 0; i < shapes.length; i++) {
    await withFetch([{ status: 200, json: { messages: [{ id: 'x' }] } }], async (q) => {
      const { sender } = realSender();
      await sender.sendText(shapes[i], '2189', 'hi');
      assert.match(q.calls[0].url, new RegExp(`/PNID${i + 1}/messages$`));
    });
  }
});

// ── reliability: retries + backoff ──────────────────────────────────────────────
test('retries a 429 honoring Retry-After, then succeeds', async () => {
  await withFetch(
    [
      { status: 429, headers: { 'retry-after': '2' }, json: { error: { message: 'rate' } } },
      { status: 200, json: { messages: [{ id: 'wamid.OK' }] } },
    ],
    async (q) => {
      const { sender, sleeps } = realSender();
      const r = await sender.sendText(TENANT, '2189', 'hi');
      assert.equal(r.ok, true);
      assert.equal(r.waMessageId, 'wamid.OK');
      assert.equal(q.calls.length, 2);
      assert.deepEqual(sleeps, [2000]); // 2s from Retry-After, honored verbatim
    }
  );
});

test('retries a 5xx using exponential backoff with jitter', async () => {
  await withFetch(
    [
      { status: 500, json: { error: { message: 'server' } } },
      { status: 200, json: { messages: [{ id: 'wamid.OK' }] } },
    ],
    async (q) => {
      const { sender, sleeps } = realSender();
      const r = await sender.sendText(TENANT, '2189', 'hi');
      assert.equal(r.ok, true);
      assert.equal(q.calls.length, 2);
      assert.deepEqual(sleeps, [250]); // capped(500*2^0)/2 + 0*jitter
    }
  );
});

test('retries network errors up to maxRetries then returns TransportError', async () => {
  await withFetch([new TypeError('fetch failed')], async (q) => {
    const { sender, sleeps } = realSender({ maxRetries: 2 });
    const r = await sender.sendText(TENANT, '2189', 'hi');
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'TransportError');
    assert.equal(r.error.retriable, true);
    assert.equal(q.calls.length, 3); // 1 initial + 2 retries
    assert.equal(sleeps.length, 2);
  });
});

test('exhausts retries on persistent 500s (4 attempts at default maxRetries=3)', async () => {
  await withFetch([{ status: 500, json: { error: { message: 'down' } } }], async (q) => {
    const { sender, sleeps } = realSender();
    const r = await sender.sendText(TENANT, '2189', 'hi');
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'TransportError');
    assert.equal(q.calls.length, 4);
    assert.equal(sleeps.length, 3);
  });
});

test('does NOT retry a logical 400', async () => {
  await withFetch([{ status: 400, json: { error: { code: 100, message: 'bad param' } } }], async (q) => {
    const { sender, sleeps } = realSender();
    const r = await sender.sendText(TENANT, '2189', 'hi');
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'WhatsAppError');
    assert.equal(r.error.code, 'invalid_request');
    assert.equal(q.calls.length, 1);
    assert.equal(sleeps.length, 0);
  });
});

test('does NOT retry WindowExpired (131047) and surfaces the graph code', async () => {
  await withFetch([{ status: 400, json: { error: { code: 131047, message: 're-engage' } } }], async (q) => {
    const { sender } = realSender();
    const r = await sender.sendText(TENANT, '2189', 'hi');
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'WindowExpired');
    assert.equal(r.error.graphCode, 131047);
    assert.equal(r.error.retriable, false);
    assert.equal(q.calls.length, 1);
  });
});

// ── error taxonomy (direct) ─────────────────────────────────────────────────────
test('classifyHttpError maps Graph codes + HTTP status to the taxonomy', () => {
  const H = (h = {}) => new Headers(h);
  assert.equal(classifyHttpError(401, { error: { code: 190 } }, H()).type, 'AuthError');
  assert.equal(classifyHttpError(403, { error: { code: 10 } }, H()).type, 'AuthError');
  assert.equal(classifyHttpError(200, { error: { code: 230 } }, H()).type, 'AuthError'); // 200-299 perms
  assert.equal(classifyHttpError(429, { error: {} }, H({ 'retry-after': '3' })).type, 'RateLimited');
  assert.equal(classifyHttpError(400, { error: { code: 130429 } }, H()).type, 'RateLimited');
  assert.equal(classifyHttpError(400, { error: { code: 131047 } }, H()).type, 'WindowExpired');
  assert.equal(classifyHttpError(400, { error: { code: 131030 } }, H()).type, 'InvalidRecipient');
  assert.equal(classifyHttpError(400, { error: { code: 131026 } }, H()).type, 'InvalidRecipient');
  assert.equal(classifyHttpError(503, { error: { code: 1 } }, H()).type, 'TransportError');
  const generic = classifyHttpError(400, { error: { code: 100 } }, H());
  assert.equal(generic.type, 'WhatsAppError');
  assert.equal(generic.retriable, false);
  // Retry-After parsed to milliseconds.
  assert.equal(classifyHttpError(429, {}, H({ 'retry-after': '3' })).retryAfter, 3000);
});

// ── mock transport ──────────────────────────────────────────────────────────────
test('mock transport records to the outbox and never calls fetch', async () => {
  const orig = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => {
    called += 1;
    throw new Error('mock transport must not hit the network');
  };
  const outboxFile = path.join(os.tmpdir(), `omen-outbox-${randomUUID()}.json`);
  const seen = [];
  try {
    const sender = createSender({ transport: 'mock', outboxFile, onOutbound: (r) => seen.push(r) });
    assert.equal(sender.transport, 'mock');
    const r = await sender.sendText(TENANT, '218910000001', 'Salut');
    assert.equal(r.ok, true);
    assert.match(r.waMessageId, /^wamid\.MOCK-/);
    assert.equal(called, 0);

    const disk = JSON.parse(fs.readFileSync(outboxFile, 'utf8'));
    assert.equal(disk.length, 1);
    assert.equal(disk[0].kind, 'text');
    assert.equal(disk[0].transport, 'mock');
    assert.equal(disk[0].payload.text.body, 'Salut');
    assert.equal(disk[0].waMessageId, r.waMessageId);
    // onOutbound hook receives the same record.
    assert.equal(seen.length, 1);
    assert.equal(seen[0].waMessageId, r.waMessageId);
  } finally {
    globalThis.fetch = orig;
    try {
      fs.rmSync(outboxFile, { force: true });
    } catch {
      /* ignore */
    }
  }
});

test('mock transport appends multiple records to the same outbox', async () => {
  const outboxFile = path.join(os.tmpdir(), `omen-outbox-${randomUUID()}.json`);
  try {
    const sender = createSender({ transport: 'mock', outboxFile });
    await sender.sendText(TENANT, '2189', 'one');
    await sender.sendButtons(TENANT, '2189', 'pick', ['a', 'b']);
    await sender.markRead(TENANT, 'wamid.IN');
    const disk = JSON.parse(fs.readFileSync(outboxFile, 'utf8'));
    assert.equal(disk.length, 3);
    assert.deepEqual(
      disk.map((r) => r.kind),
      ['text', 'buttons', 'read']
    );
    assert.equal(disk[2].waMessageId, null); // markRead has no id
  } finally {
    try {
      fs.rmSync(outboxFile, { force: true });
    } catch {
      /* ignore */
    }
  }
});

test('defaults to the mock transport when no token is configured', () => {
  const savedTok = process.env.WHATSAPP_TOKEN;
  const savedTr = process.env.WHATSAPP_TRANSPORT;
  delete process.env.WHATSAPP_TOKEN;
  delete process.env.WHATSAPP_TRANSPORT;
  try {
    const sender = createSender({ outboxFile: path.join(os.tmpdir(), `ob-${randomUUID()}.json`) });
    assert.equal(sender.transport, 'mock');
  } finally {
    if (savedTok !== undefined) process.env.WHATSAPP_TOKEN = savedTok;
    if (savedTr !== undefined) process.env.WHATSAPP_TRANSPORT = savedTr;
  }
});

test('real transport without a token returns AuthError and does not fetch', async () => {
  const orig = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => {
    called += 1;
    return makeRes({ status: 200, json: {} });
  };
  try {
    const sender = createSender({ transport: 'real', token: '' });
    const r = await sender.sendText(TENANT, '2189', 'hi');
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'AuthError');
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = orig;
  }
});

// ── sendEngineReply adapter ─────────────────────────────────────────────────────
test('sendEngineReply sends each engine text reply as its own message', async () => {
  await withFetch(
    [
      { status: 200, json: { messages: [{ id: 'wamid.1' }] } },
      { status: 200, json: { messages: [{ id: 'wamid.2' }] } },
    ],
    async (q) => {
      const { sender } = realSender();
      const r = await sender.sendEngineReply(TENANT, '2189', {
        reply: 'a\n\nb',
        replies: ['a', 'b'],
        intent: 'greeting',
      });
      assert.equal(r.ok, true);
      assert.equal(r.results.length, 2);
      assert.equal(q.calls.length, 2);
      assert.equal(q.calls[0].body.text.body, 'a');
      assert.equal(q.calls[1].body.text.body, 'b');
      assert.equal(r.waMessageId, 'wamid.2');
    }
  );
});

test('sendEngineReply emits buttons when the reply declares quick options', async () => {
  await withFetch(
    [
      { status: 200, json: { messages: [{ id: 'wamid.txt' }] } },
      { status: 200, json: { messages: [{ id: 'wamid.btn' }] } },
    ],
    async (q) => {
      const { sender } = realSender();
      const r = await sender.sendEngineReply(TENANT, '2189', {
        replies: ['Intro line', 'Choose a time'],
        buttons: [
          { id: 'm', title: 'Morning' },
          { id: 'a', title: 'Afternoon' },
        ],
      });
      assert.equal(r.ok, true);
      assert.equal(q.calls.length, 2);
      assert.equal(q.calls[0].body.type, 'text');
      assert.equal(q.calls[0].body.text.body, 'Intro line');
      assert.equal(q.calls[1].body.type, 'interactive');
      assert.equal(q.calls[1].body.interactive.body.text, 'Choose a time');
      assert.equal(q.calls[1].body.interactive.action.buttons.length, 2);
    }
  );
});

test('sendEngineReply accepts a plain string reply', async () => {
  await withFetch([{ status: 200, json: { messages: [{ id: 'wamid.s' }] } }], async (q) => {
    const { sender } = realSender();
    const r = await sender.sendEngineReply(TENANT, '2189', 'hello');
    assert.equal(r.ok, true);
    assert.equal(q.calls.length, 1);
    assert.equal(q.calls[0].body.text.body, 'hello');
  });
});
