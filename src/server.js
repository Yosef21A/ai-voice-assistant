// Express transport for the agent.
//   GET  /webhook   Meta verification handshake (echo hub.challenge)
//   POST /webhook   receive WhatsApp Cloud API messages
//   POST /simulate  local JSON testing endpoint (no WhatsApp needed)
//   GET  /health    liveness + loaded tenants
//
// The engine is transport-agnostic: every inbound payload is normalized to a
// common shape before it reaches core logic.
import express from 'express';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { getConfig } from './config.js';
import { createStore } from './store/index.js';
import { createEngine } from './engine/index.js';
import { getProvider } from './llm/index.js';

const config = getConfig();
const store = createStore({ clinicsFile: config.clinicsFile, runtimeDir: config.runtimeDir });
const provider = getProvider(config);
const engine = createEngine({ store, provider, config });

const app = express();
// Capture the raw body so we can verify Meta's HMAC signature.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

/**
 * Verify Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body with the
 * app secret). Documented + real, but only ENFORCED when WHATSAPP_APP_SECRET is
 * set — so the offline demo works without any secrets.
 */
export function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) return true; // not enforced in dev / offline mode
  if (!signatureHeader || !rawBody) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

/**
 * Normalize a WhatsApp Cloud API webhook body into an array of common-shape
 * inbound messages. Tolerant of statuses / non-text payloads.
 */
export function normalizeWhatsApp(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id;
      for (const m of value.messages || []) {
        const text =
          m.text?.body ??
          m.button?.text ??
          m.interactive?.list_reply?.title ??
          m.interactive?.button_reply?.title ??
          '';
        out.push({
          channel: 'whatsapp',
          from: m.from,
          text,
          phoneNumberId,
          messageId: m.id,
          timestamp: Number(m.timestamp) * 1000 || Date.now(),
        });
      }
    }
  }
  return out;
}

// Outbound: send via Graph API when a token is configured, otherwise log
// (offline demo). Never throws.
async function sendReply(inbound, out) {
  if (!config.whatsappToken || inbound.channel !== 'whatsapp') {
    console.log(`\n[→ ${inbound.from}] (${out.lang}/${out.clinicId})\n${out.reply}\n`);
    return;
  }
  try {
    await fetch(`https://graph.facebook.com/v20.0/${inbound.phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.whatsappToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: inbound.from,
        type: 'text',
        text: { body: out.reply },
      }),
    });
  } catch (err) {
    console.error('[send] failed:', err.message);
  }
}

// ── routes ──────────────────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.verifyToken) {
    return res.status(200).send(String(challenge));
  }
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'), config.appSecret)) {
    return res.sendStatus(401);
  }
  res.sendStatus(200); // acknowledge fast; process asynchronously
  try {
    for (const inbound of normalizeWhatsApp(req.body)) {
      if (!inbound.text) continue;
      const out = await engine.handleMessage(inbound);
      await sendReply(inbound, out);
    }
  } catch (err) {
    console.error('[webhook] processing error:', err);
  }
});

app.post('/simulate', async (req, res) => {
  try {
    const body = req.body || {};
    const inbound = {
      channel: 'simulate',
      from: body.from || 'sim-demo',
      text: body.text || '',
      phoneNumberId: body.phone_number_id || config.phoneNumberId,
      tenantId: body.tenantId,
      messageId: `sim_${Date.now()}`,
      timestamp: Date.now(),
    };
    const out = await engine.handleMessage(inbound, { now: body.now });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    provider: provider.name,
    clinics: store.listClinics().map((c) => ({
      id: c.id,
      name: c.name,
      phoneNumberId: c.whatsapp?.phoneNumberId,
    })),
  });
});

// Only listen when run directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(config.port, () => {
    console.log(`omen-clinic-agent listening on http://localhost:${config.port}`);
    console.log(`  provider: ${provider.name}   tenants: ${store.listClinics().length}`);
    console.log(`  try: curl -s localhost:${config.port}/health | jq`);
  });
}

export { app, engine, store, config };
