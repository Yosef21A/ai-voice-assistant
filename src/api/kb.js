// KB CRUD — per-tenant knowledge base, per-language answer fields.
// GET /api/kb  POST /api/kb  PUT /api/kb/:key  DELETE /api/kb/:key
// The dashboard "bot didn't know" training loop (P2) writes here too; this slice
// ships the manual editor surface. Every call is tenant-scoped by req.tenantId.
import express from 'express';
import { asyncHandler } from './http.js';

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

const publicKb = (e) =>
  e && {
    id: e.id,
    key: e.key,
    question: e.question ?? null,
    answer: e.answer ?? {}, // { ar, fr, en }
    keywords: e.keywords ?? [],
    lang: e.lang ?? null,
    source: e.source ?? 'manual',
    status: e.status ?? 'active',
    updatedAt: e.updatedAt ?? null,
  };

export function kbRouter({ store }) {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const status = req.query.status ? String(req.query.status) : undefined;
      const rows = await store.kbEntries.list(req.tenantId, status ? { status } : {});
      res.json({ entries: rows.map(publicKb) });
    })
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const b = req.body || {};
      const key =
        String(b.key || slugify(b.question) || '').trim() || `kb_${Date.now().toString(36)}`;
      const entry = await store.kbEntries.upsert(req.tenantId, {
        key,
        question: b.question ?? null,
        answer: b.answer && typeof b.answer === 'object' ? b.answer : {},
        keywords: Array.isArray(b.keywords) ? b.keywords : [],
        lang: b.lang ?? null,
        source: b.source || 'manual',
        status: b.status || 'active',
      });
      res.status(201).json({ entry: publicKb(entry) });
    })
  );

  router.put(
    '/:key',
    asyncHandler(async (req, res) => {
      const b = req.body || {};
      const key = req.params.key;
      const existing = await store.kbEntries.get(req.tenantId, key);
      const entry = await store.kbEntries.upsert(req.tenantId, {
        key,
        question: b.question ?? existing?.question ?? null,
        answer: b.answer && typeof b.answer === 'object' ? b.answer : existing?.answer ?? {},
        keywords: Array.isArray(b.keywords) ? b.keywords : existing?.keywords ?? [],
        lang: b.lang ?? existing?.lang ?? null,
        source: b.source ?? existing?.source ?? 'manual',
        status: b.status ?? existing?.status ?? 'active',
      });
      res.json({ entry: publicKb(entry) });
    })
  );

  router.delete(
    '/:key',
    asyncHandler(async (req, res) => {
      const removed = await store.kbEntries.remove(req.tenantId, req.params.key);
      if (!removed) return res.status(404).json({ error: 'kb entry not found' });
      res.json({ entry: publicKb(removed) });
    })
  );

  return router;
}
