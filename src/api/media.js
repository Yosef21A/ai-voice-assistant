// GET /api/media/:id — auth-gated binary serving for inbound patient media
// (P2-D). `:id` is the MESSAGE id (a server-generated UUID), never a filename:
// the on-disk path comes from the tenant-scoped message record, so a foreign
// tenant's id yields 404 and no client string ever reaches the filesystem.
// data/ is NEVER served statically (guardrail — X-rays are patient data).
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { asyncHandler } from './http.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function mediaRouter({ store, config }) {
  const router = express.Router();

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id || '');
      if (!UUID_RE.test(id)) return res.status(404).json({ error: 'not found' });

      const msg = await store.conversations.getMessage(req.tenantId, id);
      const media = msg?.body?.media;
      if (!media || !media.file) return res.status(404).json({ error: 'not found' });

      // Belt and braces: the stored path is server-generated, but resolve +
      // prefix-check anyway so a corrupted record can never escape mediaDir.
      const rootDir = path.resolve(config.mediaDir);
      const abs = path.resolve(rootDir, media.file);
      if (!abs.startsWith(rootDir + path.sep)) return res.status(404).json({ error: 'not found' });
      if (!fs.existsSync(abs)) return res.status(404).json({ error: 'gone' }); // retention purge

      const asciiName =
        String(media.filename || path.basename(abs)).replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '') ||
        path.basename(abs);
      res.setHeader('Content-Type', media.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${asciiName}"`);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      fs.createReadStream(abs).pipe(res);
    })
  );

  return router;
}

export default mediaRouter;
