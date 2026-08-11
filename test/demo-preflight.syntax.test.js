// V8 D5 — the ONLY test for scripts/demo-preflight.js: it must parse, and
// `--help` must print usage and exit 0 with ZERO network calls (so this test
// stays hermetic and fast, unlike the full gate which sends a real WhatsApp
// message and hits live Graph endpoints — never run that from `npm test`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'demo-preflight.js');

test('demo-preflight.js is syntactically valid', () => {
  // Throws on a syntax error; no output on success.
  execFileSync(process.execPath, ['--check', SCRIPT], { timeout: 10000 });
});

test('demo-preflight.js --help prints usage and exits 0 with no network', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--help'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstderr: ${res.stderr}`);
  assert.match(res.stdout, /demo-preflight/i);
  assert.match(res.stdout, /Usage:/);
  assert.match(res.stdout, /GO \(warnings allowed\), 1 = NO-GO/);
  // No check output should have run — --help exits before any check fires, so
  // none of the per-check result lines ("(a) .env sanity —", etc.) appear.
  assert.doesNotMatch(res.stdout, /—\s*(pass|fail|warn)/i);
  assert.doesNotMatch(res.stdout, /FIX:/);
});
