// Sandbox test-drive (wizard step 8) — the SAME engine, the caller's tenant, a
// synthetic patient id `sandbox:<userId>` so it never collides with real WhatsApp
// threads and is easy to reset. Replies are returned to the caller (no real send
// and no bus events — this is a private preview, hidden from the live inbox).
//
// The safety detectors still run so an owner test-driving an emergency phrase
// sees the exact guardrail behavior (bot steps back, emergency number shown) —
// but WITHOUT a bus, so a test drive never fires an owner alert or leaks a
// lead.hot / emergency.detected event into the live inbox.
import express from 'express';
import { asyncHandler } from './http.js';
import { analyzeInbound } from '../notifications/index.js';

export function sandboxRouter({ store, engine }) {
  const router = express.Router();

  router.post(
    '/message',
    asyncHandler(async (req, res) => {
      const text = String(req.body?.text ?? '').trim();
      if (!text) return res.status(400).json({ error: 'text required' });
      const waId = `sandbox:${req.user.id}`;
      const out = await engine.handleMessage({
        channel: 'sandbox',
        from: waId,
        text,
        tenantId: req.tenantId, // resolves to the caller's clinic
        phoneNumberId: undefined,
        messageId: `sbx_${Date.now()}`,
        timestamp: Date.now(),
      });

      // Detectors beside the engine — NO bus (private preview). On an emergency,
      // return the localized override so the test drive shows the real guardrail.
      const clinic =
        typeof store.getClinicById === 'function'
          ? store.getClinicById(req.tenantId)
          : await store.tenants.getById(req.tenantId);
      const analysis = analyzeInbound({
        tenant: clinic,
        text,
        lang: out.lang,
        engineResult: out,
        waId,
      });

      res.json({
        reply: analysis.overrideReply || out.reply,
        replies: analysis.overrideReply ? [analysis.overrideReply] : out.replies,
        intent: out.intent,
        lang: out.lang,
        appointment: analysis.overrideReply ? null : out.appointment,
        state: out.state,
        emergency: analysis.emergency || undefined,
        hotLead: analysis.hot || undefined,
      });
    })
  );

  router.delete(
    '/',
    asyncHandler(async (req, res) => {
      const id = `${req.tenantId}:sandbox:${req.user.id}`;
      const removed =
        typeof store.conversations.remove === 'function'
          ? await store.conversations.remove(req.tenantId, id)
          : null;
      res.json({ ok: true, reset: !!removed });
    })
  );

  return router;
}
