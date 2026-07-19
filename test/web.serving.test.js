// P1-D: the Express server serves the built dashboard SPA (web/dist) at / with
// an SPA fallback for unknown GET routes, WITHOUT shadowing the /api, /webhook,
// /simulate or /health surfaces. When the bundle is missing, a build hint 503 is
// returned. webDistDir is pointed at a hermetic fixture via config override.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTestApp, listen, request } from '../test-helpers/client.js';

const SENTINEL = '<div id="root"></div><!--OMEN_SPA_FIXTURE-->';

function makeDistFixture() {
  const dir = path.join(os.tmpdir(), `omen-dist-${randomUUID()}`);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html><body>${SENTINEL}</body></html>`);
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'export const OMEN_ASSET = 42;\n');
  return dir;
}

test('serves the SPA at / and on unknown GET routes; API/webhook untouched', async (t) => {
  const webDistDir = makeDistFixture();
  const app = makeTestApp({ webDistDir });
  const server = await listen(app.app);
  t.after(() => new Promise((r) => server.close(r)));

  // 1) Root serves index.html.
  const root = await request(server, 'GET', '/');
  assert.equal(root.status, 200);
  assert.match(root.raw, /OMEN_SPA_FIXTURE/);

  // 2) Unknown client-side route falls back to index.html (SPA deep-link refresh).
  const deep = await request(server, 'GET', '/appointments');
  assert.equal(deep.status, 200);
  assert.match(deep.raw, /OMEN_SPA_FIXTURE/);

  // 3) Static assets are served from the bundle.
  const asset = await request(server, 'GET', '/assets/app.js');
  assert.equal(asset.status, 200);
  assert.match(asset.raw, /OMEN_ASSET/);

  // 4) /api is NOT shadowed — an unauthenticated call still returns 401 JSON.
  const me = await request(server, 'GET', '/api/auth/me');
  assert.equal(me.status, 401);
  assert.equal(me.body.error, 'unauthenticated');

  // 5) /webhook is NOT shadowed — verification handshake still runs (403 here).
  const hook = await request(server, 'GET', '/webhook');
  assert.equal(hook.status, 403);

  // 6) /health is NOT shadowed — returns the JSON liveness payload.
  const health = await request(server, 'GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  // 7) Non-GET requests never hit the SPA fallback: POST /simulate runs the engine.
  const sim = await request(server, 'POST', '/simulate', { body: { text: 'bonjour' } });
  assert.equal(sim.status, 200);
  assert.ok(sim.body && typeof sim.body === 'object' && 'reply' in sim.body);
});

test('returns a build-hint 503 when web/dist is missing', async (t) => {
  const webDistDir = path.join(os.tmpdir(), `omen-nodist-${randomUUID()}`);
  const app = makeTestApp({ webDistDir });
  const server = await listen(app.app);
  t.after(() => new Promise((r) => server.close(r)));

  const root = await request(server, 'GET', '/');
  assert.equal(root.status, 503);
  assert.match(root.raw, /web:build/);

  // API still works even without a built dashboard.
  const health = await request(server, 'GET', '/health');
  assert.equal(health.status, 200);
});
