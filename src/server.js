// Express transport for the agent + dashboard.
//   GET  /webhook      Meta verification handshake (echo hub.challenge)
//   POST /webhook      receive WhatsApp Cloud API messages (persist + reply + emit)
//   POST /simulate     local JSON testing endpoint (no WhatsApp needed)
//   GET  /health       liveness + loaded tenants
//   /api/auth/*        setup / login / logout / me   (setup + login are public)
//   /api/*             tenant-scoped dashboard API + SSE  (auth required)
//
// The engine stays transport-agnostic: webhook, /simulate and /api/sandbox all
// feed the SAME normalized inbound shape. ONE store instance is created from
// config and shared by the engine and the API (see createApp) — swapping the
// JSON store for Postgres is a config change, not a code change (P1-G).
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { getConfig } from './config.js';
import { createStore } from './store/index.js';
import { createEngine } from './engine/index.js';
import { getProvider } from './llm/index.js';
import { createSender } from './whatsapp/index.js';
import { createMediaClient } from './whatsapp/media.js';
import { hydrateAllClinicsKb } from './store/kbLive.js';
import { createBus } from './events/bus.js';
import { createAuth } from './auth/index.js';
import { createApiRouter } from './api/index.js';
import { createOutboundRecorder } from './api/outbound.js';
import { ingestInbound } from './api/ingest.js';
import { analyzeInbound, createNotificationService } from './notifications/index.js';

/**
 * Verify Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body with the
 * app secret). Only ENFORCED when WHATSAPP_APP_SECRET is set — so the offline
 * demo works without any secrets.
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
        // Media (P2-D): image / document / audio (voice notes). The caption
        // doubles as the turn's text so guardrails/intents still see it.
        const mediaObj = ['image', 'document', 'audio'].includes(m.type) ? m[m.type] : null;
        const media = mediaObj
          ? {
              kind: m.type,
              id: mediaObj.id,
              mimeType: mediaObj.mime_type || null,
              sha256: mediaObj.sha256 || null,
              caption: mediaObj.caption || '',
              filename: mediaObj.filename || null,
            }
          : null;
        out.push({
          channel: 'whatsapp',
          from: m.from,
          text: text || media?.caption || '',
          media,
          phoneNumberId,
          messageId: m.id,
          timestamp: Number(m.timestamp) * 1000 || Date.now(),
        });
      }
    }
  }
  return out;
}

// Build the store from config. Until P1-G async-ifies the engine, the pilot uses
// the JSON adapter's legacy synchronous surface — keep DATABASE_URL unset there.
function storeFromConfig(config) {
  if (config.databaseUrl || config.store === 'postgres') {
    return createStore({ store: config.store || undefined, databaseUrl: config.databaseUrl || undefined });
  }
  return createStore({ clinicsFile: config.clinicsFile, runtimeDir: config.runtimeDir });
}

/**
 * Compose the whole app: ONE store, engine, bus and sender, wired to the webhook
 * ingest pipeline and the dashboard API. Everything is injectable so tests can
 * run against an isolated store/bus on an ephemeral port.
 * @param {object} [opts] { config, store, provider, engine, bus, sender }
 */
export function createApp(opts = {}) {
  const config = opts.config || getConfig();
  if (process.env.NODE_ENV === 'production' && !process.env.APP_SECRET) {
    console.warn(
      '[auth] WARNING: APP_SECRET is unset — session cookies use the insecure dev default. Set APP_SECRET before going live.'
    );
  }
  const store = opts.store || storeFromConfig(config);
  const provider = opts.provider || getProvider(config);
  const engine = opts.engine || createEngine({ store, provider, config });
  const bus = opts.bus || createBus();
  const sender =
    opts.sender ||
    createSender({
      transport: config.whatsappTransport || undefined,
      onOutbound: createOutboundRecorder({ store, bus }),
      outboxFile: path.join(config.runtimeDir, 'outbox.json'),
    });
  // Inbound media downloader (P2-D) — same transport gating as the sender, so
  // tests/simulate stay offline while production pulls real bytes from Graph.
  const mediaClient =
    opts.mediaClient ||
    createMediaClient({
      transport: config.whatsappTransport || undefined,
      mediaDir: config.mediaDir,
      maxBytes: config.mediaMaxBytes,
    });
  const auth = createAuth({ store, config });

  // KB → live engine (P2-B): merge each tenant's saved kb_entries into its
  // in-memory clinic on boot so wizard KB + trained answers survive restarts.
  // Fire-and-forget (createApp stays sync) — converges in ms; tests that need
  // determinism can `await composed.kbReady`.
  const kbReady = hydrateAllClinicsKb(store).catch(() => {});

  // Owner-notification worker (P1-E, wired here in P1-F): one subscriber on the
  // shared bus turns appointment.created / lead.hot / handoff.requested /
  // emergency.detected into WhatsApp alerts on the owner's phone. It never throws
  // back into a bus handler. Stopped on shutdown; tests await notifier.settled().
  const notifier = opts.notifier || createNotificationService({ bus, sender, store });

  const app = express();
  // Capture the raw body so we can verify Meta's HMAC signature.
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

  // ── webhook (Meta) ──────────────────────────────────────────────────────────
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
        if (!inbound.text && !inbound.media) continue; // statuses / unsupported types
        // Persist + reply via the ONE sender + emit bus events; respects ai_paused.
        await ingestInbound({ store, engine, sender, bus, mediaClient }, inbound);
      }
    } catch (err) {
      console.error('[webhook] processing error:', err);
    }
  });

  // ── /simulate (dev probe: raw engine result) ─────────────────────────────────
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

      // Same detectors as the webhook path, so /simulate honors emergencies and
      // hot-leads identically (it feeds the same normalized shape). Resolve the
      // tenant the engine used so the override + owner alert localize correctly.
      const clinic =
        store.getClinicByPhoneNumberId(inbound.phoneNumberId) ||
        store.getClinicById(inbound.tenantId) ||
        store.getDefaultClinic();
      const analysis = analyzeInbound({
        tenant: clinic,
        text: inbound.text,
        lang: out.lang,
        engineResult: out,
        waId: inbound.from,
        bus,
      });
      if (analysis.overrideReply) {
        return res.json({
          ...out,
          reply: analysis.overrideReply,
          replies: [analysis.overrideReply],
          appointment: null,
          emergency: analysis.emergency,
        });
      }
      res.json({ ...out, hotLead: analysis.hot, lead: analysis.lead || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── /health ───────────────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    const clinics =
      typeof store.listClinics === 'function'
        ? store.listClinics().map((c) => ({
            id: c.id,
            name: c.name,
            phoneNumberId: c.whatsapp?.phoneNumberId,
          }))
        : [];
    res.json({ ok: true, provider: provider.name, store: store.name, clinics });
  });

  // ── dashboard API (public auth bootstrap, then the gated tenant-scoped API) ───
  app.use('/api/auth', auth.router);
  app.use('/api', createApiRouter({ store, engine, sender, bus, config, auth, mediaClient, provider }));

  // ── dashboard SPA (web/dist) ──────────────────────────────────────────────────
  // Serve the built Vite bundle at / with an SPA fallback so client-side (hash)
  // routes resolve on a hard refresh. /api, /webhook, /simulate and /health are
  // registered ABOVE and always win; this only catches other GET/HEAD requests.
  // Tests can point webDistDir at a fixture via getConfig({ webDistDir }).
  const webDistDir =
    config.webDistDir ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
  const indexHtmlPath = path.join(webDistDir, 'index.html');
  const hasWebBuild = fs.existsSync(indexHtmlPath);
  if (hasWebBuild) {
    app.use(express.static(webDistDir, { index: false, maxAge: '1h' }));
  }
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const p = req.path;
    if (
      p.startsWith('/api') ||
      p.startsWith('/webhook') ||
      p.startsWith('/simulate') ||
      p.startsWith('/health')
    ) {
      return next(); // never let the SPA shadow the API / webhook surfaces
    }
    if (!hasWebBuild) {
      return res
        .status(503)
        .type('html')
        .send(
          '<!doctype html><meta charset="utf-8"><title>Omen Clinic Concierge</title>' +
            '<body style="font-family:system-ui;background:#0d0f12;color:#edeef1;padding:3rem;line-height:1.7">' +
            '<h1 style="color:#c9a86a">Dashboard not built yet</h1>' +
            '<p>Run <code>npm run web:build</code> to generate <code>web/dist</code>, then reload.</p>' +
            '<p>For development, run <code>npm run web:dev</code> (Vite on :5173, proxying the API here on :' +
            config.port +
            ').</p></body>'
        );
    }
    return res.sendFile(indexHtmlPath);
  });

  // Central JSON error handler — asyncHandler funnels rejected promises here.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('[api] error:', err?.message || err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal error' });
  });

  return { app, config, store, provider, engine, bus, sender, mediaClient, auth, notifier, kbReady };
}

// Default composition (production / `npm start`): ONE store+bus+sender per process.
const composed = createApp();
export const { app, config, store, provider, engine, bus, sender, mediaClient, auth, notifier } = composed;

// Only listen when run directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = app.listen(config.port, () => {
    console.log(`omen-clinic-agent listening on http://localhost:${config.port}`);
    console.log(`  provider: ${provider.name}   store: ${store.name}   tenants: ${
      typeof store.listClinics === 'function' ? store.listClinics().length : '?'
    }`);
    console.log(`  try: curl -s localhost:${config.port}/health | jq`);
  });

  // Graceful shutdown: unsubscribe the notification worker and drain the socket
  // so PM2 reloads (deploy/RUNBOOK §C) don't drop in-flight alerts or SSE clients.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[server] ${signal} received — shutting down`);
    try {
      notifier.stop();
    } catch {
      /* best-effort */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
