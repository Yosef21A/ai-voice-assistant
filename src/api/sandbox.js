// Sandbox test-drive (wizard step 8) — the SAME engine, the caller's tenant, a
// synthetic patient id `sandbox:<userId>` so it never collides with real WhatsApp
// threads and is easy to reset. Replies are returned to the caller (no real send
// and no bus events — this is a private preview, hidden from the live inbox).
import express from 'express';
import { asyncHandler } from './http.js';

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
      res.json({
        reply: out.reply,
        replies: out.replies,
        intent: out.intent,
        lang: out.lang,
        appointment: out.appointment,
        state: out.state,
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
