// Shared HTTP client for the API test suites (P1-C). Lives OUTSIDE test/ so the
// node:test runner's `**/test/**` glob never executes it as a test file.
//
// Each makeTestApp() builds a fully isolated app: its own JSON store under a
// temp runtimeDir, its own bus and mock sender (outbox also under the temp dir),
// so suites never touch data/runtime or each other.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createBus } from '../src/events/bus.js';

export function makeTestApp(overrides = {}, appOpts = {}) {
  const runtimeDir = path.join(os.tmpdir(), `omen-api-${randomUUID()}`);
  const config = getConfig({
    runtimeDir,
    mediaDir: path.join(runtimeDir, 'media'), // isolated — never the repo's data/media
    sessionSecret: `test-secret-${randomUUID()}`,
    cookieSecure: false,
    sseHeartbeatMs: 40,
    // Hermetic by construction: never let a developer's .env WHATSAPP_TOKEN or
    // LLM keys flip a test app onto real transports/providers, and never let a
    // machine-global CONVERSATION_MODE turn LLM dialogue on under test.
    whatsappTransport: 'mock',
    anthropicApiKey: '',
    geminiApiKey: '',
    conversationMode: 'classic',
    // A machine-global DATABASE_URL (e.g. while running the PG suites) must
    // never flip app-level tests onto Postgres — they assert on isolated
    // JSON runtime dirs (P1-G).
    databaseUrl: '',
    store: '',
    // No self-ticking timers under test: reminder/followup tests call tick(now).
    remindersIntervalMs: 0,
    followupsIntervalMs: 0,
    // Voice calls (V1) are pinned the same way the sender is. Without this, a
    // machine-global VOICE_CALL_TRANSPORT=real (the exact combo the call-harness
    // recipe documents) would point a test app's call actions at
    // graph.facebook.com with the developer's live token, and VOICE_CALLS=off
    // would silently un-compose the service the suites assert on.
    voiceCalls: true,
    voiceCallTransport: 'mock',
    voiceCallGraphBase: '',
    // V2: every EXISTING suite asserts V1 echo behaviour, and a machine-global
    // GEMINI_API_KEY would auto-select 'brain' and try to open a WebSocket to
    // Google from a unit test. Brain tests opt in EXPLICITLY, with a fake.
    voiceCallMode: 'echo',
    geminiLiveModel: 'test-live-model',
    ...overrides,
  });
  const bus = createBus();
  // appOpts forwards createApp injection points (provider, sender, notifier, …)
  // — config overrides alone can't reach them (P2-HUMANIZE fake providers).
  const composed = createApp({ config, bus, ...appOpts });
  return { ...composed, runtimeDir };
}

export function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function extractSessionCookie(setCookie = []) {
  for (const c of setCookie) {
    const m = /^omen_session=([^;]*)/.exec(c);
    if (m) return `omen_session=${m[1]}`;
  }
  return null;
}

/** Perform a JSON request. Returns { status, headers, body, raw, cookie }. */
export function request(server, method, pathname, { body, headers = {}, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...headers };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    if (cookie) h.Cookie = cookie;
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, method, path: pathname, headers: h },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = null;
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: json,
            raw,
            cookie: extractSessionCookie(res.headers['set-cookie'] || []),
          });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Bootstrap the first owner for a tenant; returns the session cookie. */
export async function setupOwner(server, { tenantId, email, password = 'password123', name = 'Owner' }) {
  const res = await request(server, 'POST', '/api/auth/setup', {
    body: { tenantId, email, password, name },
  });
  return { res, cookie: res.cookie };
}

/** Open a raw SSE connection; returns { req, res, chunks, waitFor, close }. */
export function openSse(server, pathname, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        method: 'GET',
        path: pathname,
        headers: { Accept: 'text/event-stream', Cookie: cookie || '' },
      },
      (res) => {
        let buffer = '';
        const waiters = [];
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          for (const w of waiters.slice()) {
            if (w.test(buffer)) {
              waiters.splice(waiters.indexOf(w), 1);
              w.resolve(buffer);
            }
          }
        });
        // waitFor(predicate) resolves when the accumulated buffer satisfies it.
        const waitFor = (test, timeoutMs = 2000) =>
          new Promise((res2, rej2) => {
            if (test(buffer)) return res2(buffer);
            const w = { test, resolve: res2 };
            waiters.push(w);
            setTimeout(() => {
              const i = waiters.indexOf(w);
              if (i >= 0) waiters.splice(i, 1);
              rej2(new Error(`SSE waitFor timed out; buffer so far:\n${buffer}`));
            }, timeoutMs).unref?.();
          });
        resolve({ req, res, get buffer() { return buffer; }, waitFor, close: () => req.destroy() });
      }
    );
    req.on('error', reject);
    req.end();
  });
}
