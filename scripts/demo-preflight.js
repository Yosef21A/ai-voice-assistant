// V8 D5 — demo-day GO/NO-GO gate. ONE command, ~90s worst case, zero
// interactivity: run it 30 min before every founder visit (docs/DEMO-DAY.md
// §1) and either "GO" or fix the ordered list it prints.
//
//   node scripts/demo-preflight.js --tunnel https://<current>.trycloudflare.com
//   npm run demo:preflight -- --tunnel https://<current>.trycloudflare.com
//   node scripts/demo-preflight.js --help      (usage only, no network, no .env read)
//
// Mirrors the probe style of scripts/probe-calling.js: print Graph responses
// (truncated), never guess. Every check prints ✅ / ❌ / ⚠️ plus a FIX ACTION
// on failure — the founder should never have to open this file to know what
// to do next. The WhatsApp token is NEVER printed, only whether it is set and
// whether Graph accepts it.
//
// Exit code: 0 = GO (warnings allowed), 1 = NO-GO (any ❌).

const HELP = `demo-preflight — V8 D5 GO/NO-GO gate for the founder's demo (docs/DEMO-DAY.md)

Usage:
  node scripts/demo-preflight.js --tunnel <https-url>
  node scripts/demo-preflight.js                      (uses DEMO_TUNNEL_URL env if --tunnel omitted)
  node scripts/demo-preflight.js --help                (this message; no network, no .env access)

Options:
  --tunnel <url>   Public tunnel base URL (e.g. https://xxxx.trycloudflare.com), no trailing
                    /webhook. Falls back to the DEMO_TUNNEL_URL env var. Required for check (d).
  --help, -h       Print this usage and exit 0. Touches no network and reads no config.

What it checks, in order (each prints ✅/❌/⚠️ + a fix action on failure):
  (a) .env sanity        WHATSAPP_TOKEN / GEMINI_API_KEY / FISH_AUDIO_API present (required);
                          DEEPGRAM_API_KEY / CEREBRAS_API_KEY / GROQ_API_KEY (warn-only, optional).
  (b) Token alive         GET /{phone_number_id}?fields=verified_name
  (c) Server up           GET localhost:{PORT}/health -> ok, waToken not degraded, calls.active===0
  (d) Tunnel + webhook    GET {tunnel}/health, then the hub.challenge handshake self-test
  (e) WABA subscription   GET /{waba}/subscribed_apps contains omen-clinic-agent (auto-fix: POST it)
  (f) Delivery            POST a real text to the allow-listed founder number
  (g) Calling enabled     GET /{phone_number_id}/settings -> calling.status === 'ENABLED'
  (h) Working hours       data/clinics.json el-amen, TODAY in clinic tz (warn-only if closed)

Exit codes: 0 = GO (warnings allowed), 1 = NO-GO (any ❌). The token is never printed.
`;

// --help must work with ZERO network access and ZERO config/env reads — check
// it before importing anything that touches .env (getConfig() reads .env as a
// side effect of import, so this guard has to run first).
const RAW_ARGS = process.argv.slice(2);
if (RAW_ARGS.includes('--help') || RAW_ARGS.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

const { getConfig } = await import('../src/config.js');
const { readFileSync } = await import('node:fs');
const { WD_KEYS, isWithinWorkingHours } = await import('../src/store/availability.js');

// ── argv ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}
const args = parseArgs(RAW_ARGS);

const cfg = getConfig();
const TIMEOUT_MS = 8000;
const GRAPH_V = process.env.WHATSAPP_GRAPH_VERSION || 'v25.0';
const GRAPH_BASE = 'https://graph.facebook.com';
const WABA_ID = process.env.WABA_ID || '1038353382027655';
const PNID = cfg.phoneNumberId;
const TUNNEL = String(args.tunnel || process.env.DEMO_TUNNEL_URL || '').replace(/\/+$/, '');
const APP_NAME = 'omen-clinic-agent';
const LOCAL_HEALTH_URL = `http://localhost:${cfg.port}/health`;

// ── tiny fetch-with-timeout, mirrors src/whatsapp/sender.js's AbortController
// pattern. Never throws — network/timeout failures come back as a result
// object so a dead endpoint can never hang or crash the whole gate.
async function fetchSafe(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON (e.g. the raw hub.challenge echo) — text is still useful */
    }
    return { ok: true, status: res.status, text, json };
  } catch (err) {
    const timedOut = err?.name === 'AbortError';
    return { ok: false, status: 0, text: '', json: null, error: timedOut ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

function authHeader() {
  return { Authorization: `Bearer ${cfg.whatsappToken}` };
}

// ── result tracking + printing ───────────────────────────────────────────
const results = [];
function record(id, title, status, detail, fix) {
  results.push({ id, title, status, detail, fix });
  const icon = status === 'pass' ? '✅' : status === 'warn' ? '⚠️' : '❌';
  console.log(`${icon} (${id}) ${title} — ${detail}`);
  if (status !== 'pass' && fix) console.log(`   → FIX: ${fix}`);
  return status;
}

/** Runs one check; an unexpected throw becomes a ❌ instead of crashing the gate. */
async function runCheck(id, title, fn) {
  try {
    await fn();
  } catch (err) {
    record(id, title, 'fail', `unexpected error: ${err?.message || err}`, 'see error above; re-run once fixed');
  }
}

// ── clinic lookup (checks f + h) ─────────────────────────────────────────
function loadElAmen() {
  const raw = JSON.parse(readFileSync(cfg.clinicsFile, 'utf8'));
  const clinics = Array.isArray(raw?.clinics) ? raw.clinics : [];
  return (
    clinics.find((c) => c.id === 'el-amen-sousse') ||
    clinics.find((c) => c.whatsapp?.phoneNumberId === PNID) ||
    clinics[0] ||
    null
  );
}

/** Weekday key + minutes-since-midnight for `timezone`, right now. */
function nowInTimezone(timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date())) parts[p.type] = p.value;
  const weekdayMap = { Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat' };
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0; // some locales render midnight as "24:00"
  return { weekdayKey: weekdayMap[parts.weekday], minutes: hour * 60 + Number(parts.minute) };
}

// ── (a) .env sanity ───────────────────────────────────────────────────────
await runCheck('a', '.env sanity', async () => {
  const required = [
    ['WHATSAPP_TOKEN', cfg.whatsappToken],
    ['GEMINI_API_KEY', cfg.geminiApiKey],
    ['FISH_AUDIO_API', cfg.fishAudioApi],
  ];
  const optional = [
    ['DEEPGRAM_API_KEY', cfg.deepgramApiKey],
    ['CEREBRAS_API_KEY', cfg.cerebrasApiKey],
    ['GROQ_API_KEY', cfg.groqApiKey],
  ];
  const missingRequired = required.filter(([, v]) => !v).map(([k]) => k);
  const missingOptional = optional.filter(([, v]) => !v).map(([k]) => k);
  if (missingRequired.length) {
    record(
      'a',
      '.env sanity',
      'fail',
      `missing: ${missingRequired.join(', ')}`,
      `set ${missingRequired.join(', ')} in .env, then restart the server`
    );
  } else {
    record('a', '.env sanity', 'pass', 'WHATSAPP_TOKEN / GEMINI_API_KEY / FISH_AUDIO_API all set');
  }
  if (missingOptional.length) {
    record(
      'a',
      '.env sanity (optional)',
      'warn',
      `not set: ${missingOptional.join(', ')} — rotation targets only, chat/voice still work`,
      null
    );
  }
});

// ── (b) token alive ───────────────────────────────────────────────────────
await runCheck('b', 'token alive', async () => {
  if (!cfg.whatsappToken) {
    record('b', 'token alive', 'fail', 'WHATSAPP_TOKEN is empty, skipping the Graph call', 'set WHATSAPP_TOKEN first (see check a)');
    return;
  }
  const res = await fetchSafe(`${GRAPH_BASE}/${GRAPH_V}/${PNID}?fields=verified_name`, { headers: authHeader() });
  if (res.ok && res.status === 200 && !res.text.includes('OAuthException')) {
    const name = res.json?.verified_name || '(no verified_name on this test number)';
    record('b', 'token alive', 'pass', `HTTP 200 — ${name}`);
  } else if (res.text.includes('OAuthException') || res.status === 401) {
    record(
      'b',
      'token alive',
      'fail',
      `Graph rejected the token (HTTP ${res.status})`,
      'regenerate via Étape 1 popup, paste into .env, restart server'
    );
  } else {
    record('b', 'token alive', 'fail', `HTTP ${res.status}${res.error ? ` (${res.error})` : ''}: ${res.text.slice(0, 200)}`, 'check network / Graph status, then re-run');
  }
});

// ── (c) server up ─────────────────────────────────────────────────────────
await runCheck('c', 'server up', async () => {
  const res = await fetchSafe(LOCAL_HEALTH_URL);
  if (!res.ok || res.status !== 200 || !res.json) {
    record(
      'c',
      'server up',
      'fail',
      `GET ${LOCAL_HEALTH_URL} failed (HTTP ${res.status}${res.error ? `, ${res.error}` : ''})`,
      'start the server: npm start (kill any stale :3000 listener first — see docs/HANDOFF-STATE.md)'
    );
    return;
  }
  const h = res.json;
  const problems = [];
  if (!h.ok) problems.push('ok:false (store not writable — see storeWritable)');
  if (h.degraded?.waToken) problems.push('waToken degraded (see check b)');
  if ((h.calls?.active ?? 0) !== 0) problems.push(`calls.active=${h.calls?.active} (a call is already in progress)`);
  const impliedBrain = `voiceCallMode=${cfg.voiceCallMode}, voiceBrain=${cfg.voiceBrain}`;
  const note = `provider=${h.provider}, store=${h.store} — implied from THIS process's .env: ${impliedBrain} (not confirmed against the running server unless it was started from the same .env)`;
  if (problems.length) {
    record('c', 'server up', 'fail', `${problems.join('; ')} — ${note}`, 'fix the flagged item, restart the server, re-run');
  } else {
    record('c', 'server up', 'pass', note);
  }
});

// ── (d) tunnel + webhook handshake ───────────────────────────────────────
await runCheck('d', 'tunnel + webhook', async () => {
  if (!TUNNEL) {
    record(
      'd',
      'tunnel + webhook',
      'fail',
      'no tunnel URL given',
      'pass --tunnel <https-url> or set DEMO_TUNNEL_URL, e.g.: npm run demo:preflight -- --tunnel https://xxxx.trycloudflare.com'
    );
    return;
  }
  const health = await fetchSafe(`${TUNNEL}/health`);
  if (!health.ok || health.status !== 200) {
    record(
      'd',
      'tunnel + webhook',
      'fail',
      `${TUNNEL}/health -> HTTP ${health.status}${health.error ? ` (${health.error})` : ''}`,
      'tunnel dead or webhook URL not re-pointed in the Meta console'
    );
    return;
  }
  const challenge = 'PREFLIGHT';
  const hs = await fetchSafe(
    `${TUNNEL}/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(cfg.verifyToken)}&hub.challenge=${challenge}`
  );
  if (hs.ok && hs.status === 200 && hs.text.trim() === challenge) {
    record('d', 'tunnel + webhook', 'pass', `${TUNNEL} is up and the verify-token handshake echoes correctly`);
  } else {
    record(
      'd',
      'tunnel + webhook',
      'fail',
      `handshake did not echo "${challenge}" (HTTP ${hs.status}, body: ${hs.text.slice(0, 120)})`,
      'tunnel dead or webhook URL not re-pointed in the Meta console'
    );
  }
});

// ── (e) WABA subscription (auto-fix) ─────────────────────────────────────
await runCheck('e', 'WABA subscription', async () => {
  const url = `${GRAPH_BASE}/${GRAPH_V}/${WABA_ID}/subscribed_apps`;
  const get1 = await fetchSafe(url, { headers: authHeader() });
  if (get1.ok && get1.status === 200 && get1.text.includes(APP_NAME)) {
    record('e', 'WABA subscription', 'pass', `${APP_NAME} is subscribed`);
    return;
  }
  // Auto-fix: POST re-subscribes the app, then re-check.
  const post = await fetchSafe(url, { method: 'POST', headers: authHeader() });
  const get2 = await fetchSafe(url, { headers: authHeader() });
  if (get2.ok && get2.status === 200 && get2.text.includes(APP_NAME)) {
    record('e', 'WABA subscription', 'pass', `auto-repaired (POST returned ${post.text.slice(0, 80)})`);
  } else {
    record(
      'e',
      'WABA subscription',
      'fail',
      `still not subscribed after auto-fix attempt (GET: HTTP ${get2.status}, POST: HTTP ${post.status})`,
      `check the token and WABA id (${WABA_ID}), then POST ${url} manually`
    );
  }
});

// ── (f) delivery ──────────────────────────────────────────────────────────
await runCheck('f', 'delivery', async () => {
  const clinic = loadElAmen();
  const recipient = String(args.recipient || process.env.DEMO_RECIPIENT_WAID || clinic?.notifications?.recipients?.[0] || '21629496305');
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient,
    type: 'text',
    text: { body: `🔧 preflight ${new Date().toISOString()}` },
  };
  const res = await fetchSafe(`${GRAPH_BASE}/${GRAPH_V}/${PNID}/messages`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const waId = res.json?.messages?.[0]?.id;
  if (res.ok && res.status === 200 && waId) {
    record('f', 'delivery', 'pass', `sent to ${recipient} — ${waId}`);
  } else {
    record(
      'f',
      'delivery',
      'fail',
      `HTTP ${res.status}${res.error ? ` (${res.error})` : ''}: ${res.text.slice(0, 200)}`,
      'check token validity (see check b) and that the recipient is allow-listed (Étape 1 → To, max 5 numbers)'
    );
  }
});

// ── (g) calling enabled ───────────────────────────────────────────────────
await runCheck('g', 'calling enabled', async () => {
  const res = await fetchSafe(`${GRAPH_BASE}/${GRAPH_V}/${PNID}/settings`, { headers: authHeader() });
  const status = res.json?.calling?.status;
  if (res.ok && res.status === 200 && status === 'ENABLED') {
    record('g', 'calling enabled', 'pass', 'calling.status = ENABLED');
  } else {
    record(
      'g',
      'calling enabled',
      'fail',
      `calling.status = ${status ?? 'unknown'} (HTTP ${res.status})`,
      'node scripts/probe-calling.js --enable, then re-run preflight'
    );
  }
});

// ── (h) working hours (warn-only) ────────────────────────────────────────
await runCheck('h', 'working hours', async () => {
  const clinic = loadElAmen();
  if (!clinic) {
    record('h', 'working hours', 'warn', 'el-amen tenant not found in data/clinics.json', null);
    return;
  }
  const timezone = clinic.timezone || 'Africa/Tunis';
  const tzNow = nowInTimezone(timezone);
  const weekdayIndex = WD_KEYS.indexOf(tzNow.weekdayKey);
  const fakeDate = {
    getDay: () => weekdayIndex,
    getHours: () => Math.floor(tzNow.minutes / 60),
    getMinutes: () => tzNow.minutes % 60,
  };
  const open = isWithinWorkingHours(clinic, fakeDate);
  const hh = String(Math.floor(tzNow.minutes / 60)).padStart(2, '0');
  const mm = String(tzNow.minutes % 60).padStart(2, '0');
  if (open) {
    record('h', 'working hours', 'pass', `${clinic.name} is open now (${tzNow.weekdayKey} ${hh}:${mm} ${timezone})`);
  } else {
    record(
      'h',
      'working hours',
      'warn',
      `${clinic.name} is closed right now (${tzNow.weekdayKey} ${hh}:${mm} ${timezone})`,
      'demo calls will be rejected as closed — widen hours or demo in-hours'
    );
  }
});

// ── verdict ────────────────────────────────────────────────────────────────
const fails = results.filter((r) => r.status === 'fail');
const warns = results.filter((r) => r.status === 'warn');
const passes = results.filter((r) => r.status === 'pass');

console.log('');
console.log(`${passes.length} pass / ${warns.length} warn / ${fails.length} fail`);
console.log('');

if (fails.length === 0) {
  console.log('✅✅✅  GO ✅✅✅');
  if (warns.length) {
    console.log('(warnings above are non-blocking — read them anyway)');
  }
  process.exit(0);
} else {
  console.log('❌❌❌  NO-GO ❌❌❌');
  console.log('Fix, in order:');
  fails.forEach((r, i) => {
    console.log(`  ${i + 1}. (${r.id}) ${r.title}: ${r.fix || 'see detail above'}`);
  });
  process.exit(1);
}
