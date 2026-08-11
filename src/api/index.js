// The tenant-scoped dashboard API router (P1-C). Mounted at /api by server.js,
// AFTER the public /api/auth router. Every route here is behind requireAuth, so
// each handler runs with { req.user, req.tenantId } and scopes every store call.
import express from 'express';
import { tenantRouter } from './tenant.js';
import { kbRouter } from './kb.js';
import { conversationsRouter } from './conversations.js';
import { appointmentsRouter } from './appointments.js';
import { leadsRouter } from './leads.js';
import { sandboxRouter } from './sandbox.js';
import { statsRouter } from './stats.js';
import { copilotRouter } from './copilot.js';
import { exportRouter } from './export.js';
import { mediaRouter } from './media.js';
import { callsRouter } from './calls.js';
import { streamHandler } from './stream.js';

export function createApiRouter({ store, engine, sender, bus, config, auth, provider }) {
  const { requireAuth, requireRole } = auth;
  const router = express.Router();

  // Gate the whole surface. /api/auth/{setup,login} stay public (mounted apart).
  router.use(requireAuth);

  router.get('/stream', streamHandler({ bus, config }));
  router.use('/tenant', tenantRouter({ store, requireRole }));
  router.use('/kb', kbRouter({ store, provider, bus }));
  router.use('/conversations', conversationsRouter({ store, sender, bus }));
  router.use('/appointments', appointmentsRouter({ store, bus }));
  router.use('/leads', leadsRouter({ store, bus }));
  router.use('/sandbox', sandboxRouter({ store, engine }));
  router.use('/stats', statsRouter({ store }));
  router.use('/copilot', copilotRouter({ store, provider, requireRole }));
  router.use('/export', exportRouter({ store, requireRole }));
  router.use('/media', mediaRouter({ store, config }));
  router.use('/calls', callsRouter({ store }));

  return router;
}

export default createApiRouter;
