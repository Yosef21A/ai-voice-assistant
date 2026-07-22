// GET /api/leads, POST /api/leads/:id/status, PATCH /api/leads/:id (P2-C).
// The medical-tourism money pipeline: hot leads captured at ingest (upsertOpen)
// surfaced as a kanban. "Waiting on you" is DERIVED live from the conversation's
// last message direction (inbound ⇒ a human owes a reply) rather than stored, so
// it stays correct no matter how the reply was sent. Sandbox leads excluded.
import express from 'express';
import { asyncHandler, isSandbox } from './http.js';
import { LEAD_STATUSES, LEAD_OPEN, isValidLeadStatus } from '../leads/status.js';

const publicLead = (l, waitingSince = null) =>
  l && {
    id: l.id,
    conversationId: l.conversationId ?? null,
    patientWaId: l.patientWaId ?? null,
    procedure: l.procedure ?? null,
    originCountry: l.originCountry ?? null,
    status: l.status ?? 'new',
    assignee: l.assignee ?? null,
    value: l.value ?? null,
    notes: Array.isArray(l.notes) ? l.notes : [],
    reason: l.details?.reason ?? null,
    snippet: l.details?.snippet ?? null,
    waitingSince, // ISO string when the patient is waiting on a human, else null
    createdAt: l.createdAt ?? null,
    updatedAt: l.updatedAt ?? null,
  };

export function leadsRouter({ store, bus }) {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const rows = (await store.leads.list(req.tenantId, {})).filter((l) => !isSandbox(l.patientWaId));
      const out = [];
      for (const l of rows) {
        let waitingSince = null;
        // Only OPEN leads show a timer — bound the per-lead message read to them.
        if (LEAD_OPEN.has(l.status) && l.conversationId) {
          const msgs = await store.conversations.listMessages(req.tenantId, l.conversationId, { limit: 1 });
          const last = msgs[msgs.length - 1];
          if (last && last.direction === 'inbound') waitingSince = last.ts;
        }
        out.push(publicLead(l, waitingSince));
      }
      res.json({ leads: out });
    })
  );

  router.post(
    '/:id/status',
    asyncHandler(async (req, res) => {
      const status = String(req.body?.status || '');
      if (!isValidLeadStatus(status)) {
        return res.status(400).json({ error: 'invalid status', allowed: LEAD_STATUSES });
      }
      const updated = await store.leads.updateStatus(req.tenantId, req.params.id, status);
      if (!updated) return res.status(404).json({ error: 'lead not found' });
      bus.publish('lead.updated', {
        tenantId: req.tenantId,
        leadId: updated.id,
        status,
        lead: publicLead(updated),
      });
      res.json({ lead: publicLead(updated) });
    })
  );

  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const cur = await store.leads.get(req.tenantId, req.params.id);
      if (!cur) return res.status(404).json({ error: 'lead not found' });
      const b = req.body || {};
      const patch = {};
      if ('assignee' in b) patch.assignee = b.assignee ? String(b.assignee).slice(0, 80) : null;
      if ('value' in b) {
        const v = Number(b.value);
        patch.value = b.value === null || b.value === '' ? null : Number.isFinite(v) && v >= 0 ? v : null;
      }
      if (b.note && String(b.note).trim()) {
        const notes = Array.isArray(cur.notes) ? cur.notes.slice() : [];
        notes.push({
          text: String(b.note).slice(0, 500),
          at: new Date().toISOString(),
          by: req.user?.email ?? 'staff',
        });
        patch.notes = notes;
      }
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to update' });
      const updated = await store.leads.update(req.tenantId, req.params.id, patch);
      bus.publish('lead.updated', { tenantId: req.tenantId, leadId: updated.id, lead: publicLead(updated) });
      res.json({ lead: publicLead(updated) });
    })
  );

  return router;
}

export { publicLead };
export default leadsRouter;
