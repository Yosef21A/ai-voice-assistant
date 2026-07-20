// GET /api/stats — the owner's ROI numbers (P2-A). Tenant-scoped like every
// /api route (requireAuth upstream supplies req.tenantId). The aggregation
// itself lives in src/stats so the daily/weekly digests report the SAME
// numbers — this route only parses the window and delegates.
//
//   GET /api/stats?days=30            → rolling window ending now (7|30|90…)
//   GET /api/stats?from=ISO&to=ISO    → explicit window (from inclusive, to exclusive)
import express from 'express';
import { asyncHandler, intParam } from './http.js';
import { collectAnalytics } from '../stats/index.js';

export function statsRouter({ store }) {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const tenant = await store.tenants.getById(req.tenantId);
      if (!tenant) return res.status(404).json({ error: 'tenant not found' });

      const to = req.query.to ? new Date(String(req.query.to)) : new Date();
      const days = intParam(req.query.days, 30, 365);
      const from = req.query.from
        ? new Date(String(req.query.from))
        : new Date(to.getTime() - days * 24 * 3600 * 1000);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
        return res.status(400).json({ error: 'invalid date range' });
      }

      const stats = await collectAnalytics(store, tenant, { from, to });
      res.json({ stats });
    })
  );

  return router;
}

export default statsRouter;
