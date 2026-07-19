// Live Inbox API. Read conversations + transcript, human takeover, and staff
// send. All tenant-scoped via req.tenantId; a cross-tenant :id resolves to null
// (-> 404) because getById is scoped. Sandbox test-drive threads are hidden.
import express from 'express';
import { asyncHandler, intParam, isSandbox } from './http.js';
import { sendAs, publicMessage } from './outbound.js';

const publicConversation = (c) =>
  c && {
    id: c.id,
    patientWaId: c.patientWaId ?? c.waId ?? null,
    lang: c.lang ?? null,
    status: c.status ?? 'open',
    aiPaused: !!c.aiPaused,
    lastMessageAt: c.lastMessageAt ?? null,
    createdAt: c.createdAt ?? null,
    updatedAt: c.updatedAt ?? null,
  };

function tsOf(c) {
  const v = c.lastMessageAt ?? c.updatedAt ?? c.createdAt;
  const t = v ? new Date(v).getTime() : 0;
  return Number.isNaN(t) ? 0 : t;
}

export function conversationsRouter({ store, sender, bus }) {
  const router = express.Router();

  // GET /api/conversations?status=&needsHuman=&language=&limit=&offset=
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { status, needsHuman, language } = req.query;
      const limit = intParam(req.query.limit, 50, 200);
      const offset = intParam(req.query.offset, 0);
      let rows = await store.conversations.list(
        req.tenantId,
        status ? { status: String(status) } : {}
      );
      rows = rows.filter((c) => !isSandbox(c.patientWaId ?? c.waId));
      if (needsHuman === 'true' || needsHuman === '1') {
        rows = rows.filter((c) => c.status === 'needs_human');
      }
      if (language) rows = rows.filter((c) => c.lang === String(language));
      rows.sort((a, b) => tsOf(b) - tsOf(a));
      const total = rows.length;
      const page = rows.slice(offset, offset + limit).map(publicConversation);
      res.json({ conversations: page, total, limit, offset });
    })
  );

  // GET /api/conversations/:id  (with messages)
  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const convo = await store.conversations.getById(req.tenantId, req.params.id);
      if (!convo) return res.status(404).json({ error: 'conversation not found' });
      const messages = await store.conversations.listMessages(req.tenantId, convo.id, {});
      res.json({ conversation: publicConversation(convo), messages: messages.map(publicMessage) });
    })
  );

  // POST /api/conversations/:id/takeover { paused }  -> set ai_paused + emit
  router.post(
    '/:id/takeover',
    asyncHandler(async (req, res) => {
      const convo = await store.conversations.getById(req.tenantId, req.params.id);
      if (!convo) return res.status(404).json({ error: 'conversation not found' });
      const paused = req.body?.paused !== false; // default: take over (pause bot)
      const patch = { aiPaused: paused, status: paused ? 'needs_human' : 'open' };
      const updated = await store.conversations.update(req.tenantId, convo.id, patch);
      bus.publish('conversation.updated', {
        tenantId: req.tenantId,
        conversationId: convo.id,
        actor: `staff:${req.user.id}`,
        patch,
      });
      res.json({ conversation: publicConversation(updated) });
    })
  );

  // POST /api/conversations/:id/send { text }  -> staff message (auto-pauses bot)
  router.post(
    '/:id/send',
    asyncHandler(async (req, res) => {
      const text = String(req.body?.text ?? '').trim();
      if (!text) return res.status(400).json({ error: 'text required' });
      const convo = await store.conversations.getById(req.tenantId, req.params.id);
      if (!convo) return res.status(404).json({ error: 'conversation not found' });
      const toWaId = convo.patientWaId ?? convo.waId;

      // Staff typing auto-pauses the bot so the two never talk over each other.
      if (!convo.aiPaused) {
        await store.conversations.update(req.tenantId, convo.id, {
          aiPaused: true,
          status: 'needs_human',
        });
        bus.publish('conversation.updated', {
          tenantId: req.tenantId,
          conversationId: convo.id,
          actor: `staff:${req.user.id}`,
          patch: { aiPaused: true, status: 'needs_human' },
        });
      }

      const clinic =
        typeof store.getClinicById === 'function'
          ? store.getClinicById(req.tenantId)
          : await store.tenants.getById(req.tenantId);

      // ONE gateway; onOutbound persists the row + emits message.out (actor staff).
      const result = await sendAs(`staff:${req.user.id}`, convo.id, () =>
        sender.sendText(clinic, toWaId, text)
      );
      if (!result.ok) return res.status(502).json({ error: 'send failed', detail: result.error });
      res.status(201).json({ ok: true, waMessageId: result.waMessageId ?? null });
    })
  );

  return router;
}

export { publicConversation };
