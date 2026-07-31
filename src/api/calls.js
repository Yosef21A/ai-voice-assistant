// GET /api/calls (V3) — recent-calls list for the dashboard Calls tab.
// Tenant-scoped like every /api route (requireAuth upstream supplies
// req.tenantId). Rows are sourced from the events audit log the voice-call
// service appends (src/voice-call/index.js): EXACTLY one terminal event per
// call — 'call.ended' (patient held it) or 'call.missed' (never carried
// audio). We never read 'call.started' or 'call.rejected' here — those are
// non-terminal/informational rows, not one-row-per-call.
import express from 'express';
import { asyncHandler, intParam } from './http.js';

/**
 * Merge a terminal call event row into the flat shape the Calls screen reads.
 *
 * `type` ('call.ended' | 'call.missed') rides along even though it duplicates
 * which query this row came from: `outcome` alone is NOT enough to tell
 * "answered" from "missed" on the dashboard — a call that connects and then
 * fails mid-way is call.ended with outcome:'failed' (the patient DID hold it),
 * while a call that never connects because of a Graph error is call.missed,
 * ALSO with outcome:'failed'. Only the source event type disambiguates them.
 */
function publicCall(e) {
  const p = e.payload || {};
  const brain = p.brain || {};
  return {
    at: e.createdAt ?? null,
    type: e.type,
    callId: p.callId ?? null,
    from: p.from ?? null,
    // Session outcome ('completed'|'failed' for call.ended, 'missed'|'rejected'|
    // 'failed' for call.missed) + the human reason ('closed'|'no_answer'|…).
    outcome: p.outcome ?? null,
    reason: p.reason ?? null,
    durationSec: Number(p.durationSec) || 0,
    booked: brain.booked ?? null,
    emergency: !!brain.emergency,
    handoff: !!brain.handoff,
    conversationId: e.conversationId ?? null,
  };
}

export function callsRouter({ store }) {
  const router = express.Router();

  // GET /api/calls?limit=  -> { calls: [...], total } most recent first.
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      // `|| 50`: a zero page size is meaningless here AND both adapters treat
      // a falsy limit as "no limit" — ?limit=0 would trigger an unbounded
      // Postgres fetch just to return an empty page.
      const limit = intParam(req.query.limit, 50, 200) || 50;
      // Each type is fetched up to `limit` rows (most recent of ITS type) so the
      // merged, re-sorted, re-sliced top `limit` overall can never miss a row
      // that should have made the cut — store.events.list() only filters by a
      // single `type` (no OR support in either adapter), hence two calls.
      const [ended, missed] = await Promise.all([
        store.events.list(req.tenantId, { type: 'call.ended', limit }),
        store.events.list(req.tenantId, { type: 'call.missed', limit }),
      ]);
      const rows = [...ended, ...missed]
        .sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0))
        .slice(0, limit)
        .map(publicCall);
      res.json({ calls: rows, total: rows.length });
    })
  );

  return router;
}

export default callsRouter;
