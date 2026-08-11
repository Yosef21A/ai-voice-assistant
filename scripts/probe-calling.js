// G0 probe — is WhatsApp Calling enable-able on our number/WABA?
// Run when a fresh WHATSAPP_TOKEN is in .env:
//   node scripts/probe-calling.js            # read-only probe
//   node scripts/probe-calling.js --enable   # attempt to enable calling
// Prints Graph responses verbatim so the gate decision (VOICE-AGENT-SPEC §G0)
// can be made from evidence, not guesses. Never prints the token.
import { getConfig } from '../src/config.js';

const cfg = getConfig();
const TOK = cfg.whatsappToken;
const PNID = cfg.phoneNumberId;
const WABA = process.env.WABA_ID || '1038353382027655';
const V = 'v25.0';

if (!TOK) {
  console.error('WHATSAPP_TOKEN missing — paste a fresh token into .env first.');
  process.exit(1);
}

const H = { Authorization: `Bearer ${TOK}` };

async function show(label, url, init) {
  try {
    const res = await fetch(url, init);
    const body = await res.text();
    console.log(`\n== ${label} → HTTP ${res.status}\n${body.slice(0, 2000)}`);
    return { status: res.status, body };
  } catch (err) {
    console.log(`\n== ${label} → FETCH ERROR: ${err.message}`);
    return { status: 0, body: '' };
  }
}

const sanity = await show(
  'token sanity (phone number lookup)',
  `https://graph.facebook.com/${V}/${PNID}?fields=display_phone_number,verified_name`,
  { headers: H }
);
if (sanity.body.includes('OAuthException')) {
  console.log('\nToken is dead (OAuthException). Regenerate via console Étape 1 popup, paste into .env, rerun.');
  process.exit(1);
}

await show(
  'app subscription on WABA (expect omen-clinic-agent listed)',
  `https://graph.facebook.com/${V}/${WABA}/subscribed_apps`,
  { headers: H }
);

await show(
  'phone number settings (look for a calling block)',
  `https://graph.facebook.com/${V}/${PNID}/settings`,
  { headers: H }
);

if (process.argv.includes('--enable')) {
  await show('ENABLE calling', `https://graph.facebook.com/${V}/${PNID}/settings`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ calling: { status: 'ENABLED' } }),
  });
  await show(
    'phone number settings AFTER enable attempt',
    `https://graph.facebook.com/${V}/${PNID}/settings`,
    { headers: H }
  );
}

console.log(
  '\nInterpretation: calling.status ENABLED in settings → Path A (real calls; do a live test).\n' +
    'An error naming tier/eligibility/test-number → stay Path B (local harness; VOICE-AGENT-SPEC §G0).'
);
