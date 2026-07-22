// KB CRUD + the "bot didn't know" training loop (P2-B).
//   GET /api/kb                      POST /api/kb
//   PUT /api/kb/:key                 DELETE /api/kb/:key
//   GET /api/kb/unanswered           POST /api/kb/unanswered/:id/answer
//   POST /api/kb/unanswered/:id/dismiss   POST /api/kb/draft
// Every call is tenant-scoped by req.tenantId. Every KB WRITE re-merges the
// tenant's entries into the live clinic object (src/store/kbLive.js) so the
// engine serves new answers on the very next message — no restart.
import express from 'express';
import { asyncHandler } from './http.js';
import { mergeTenantKb, deriveKeywords } from '../store/kbLive.js';

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

const publicUnanswered = (u) =>
  u && {
    id: u.id,
    question: u.question ?? null,
    lang: u.lang ?? null,
    count: u.count ?? 1,
    status: u.status ?? 'new',
    conversationId: u.conversationId ?? null,
    createdAt: u.createdAt ?? null,
    updatedAt: u.updatedAt ?? null,
  };

const LANGS = ['ar', 'fr', 'en'];

export function kbRouter({ store, provider }) {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const status = req.query.status ? String(req.query.status) : undefined;
      const rows = await store.kbEntries.list(req.tenantId, status ? { status } : {});
      res.json({ entries: rows.map(publicKb) });
    })
  );

  // ── training queue (P2-B) ──────────────────────────────────────────────────
  router.get(
    '/unanswered',
    asyncHandler(async (req, res) => {
      const status = req.query.status ? String(req.query.status) : 'new';
      const rows = await store.unanswered.list(req.tenantId, status === 'all' ? {} : { status });
      rows.sort(
        (a, b) => (b.count || 0) - (a.count || 0) || String(b.updatedAt).localeCompare(String(a.updatedAt))
      );
      res.json({ unanswered: rows.map(publicUnanswered) });
    })
  );

  // Owner answers an unknown question → KB entry (source 'didnt_know'),
  // queue row marked answered, live clinic re-merged: the bot knows it NOW.
  router.post(
    '/unanswered/:id/answer',
    asyncHandler(async (req, res) => {
      const row = await store.unanswered.get(req.tenantId, req.params.id);
      if (!row) return res.status(404).json({ error: 'unanswered item not found' });
      const b = req.body || {};
      const answer = b.answer && typeof b.answer === 'object' ? b.answer : {};
      if (!LANGS.some((l) => answer[l] && String(answer[l]).trim())) {
        return res.status(400).json({ error: 'answer required in at least one language' });
      }
      const question = String(b.question || row.question || '').trim();
      const key = slugify(question) || `kb_${Date.now().toString(36)}`;
      const entry = await store.kbEntries.upsert(req.tenantId, {
        key,
        question,
        answer,
        keywords:
          Array.isArray(b.keywords) && b.keywords.length ? b.keywords : deriveKeywords(question),
        lang: row.lang ?? null,
        source: 'didnt_know',
        status: 'active',
      });
      const updated = await store.unanswered.setStatus(req.tenantId, row.id, 'answered');
      await mergeTenantKb(store, req.tenantId);
      res.json({ entry: publicKb(entry), unanswered: publicUnanswered(updated) });
    })
  );

  router.post(
    '/unanswered/:id/dismiss',
    asyncHandler(async (req, res) => {
      const updated = await store.unanswered.setStatus(req.tenantId, req.params.id, 'dismissed');
      if (!updated) return res.status(404).json({ error: 'unanswered item not found' });
      res.json({ unanswered: publicUnanswered(updated) });
    })
  );

  // Auto-draft the missing languages from the one the owner wrote. Reuses the
  // provider's faq_answer grounding (Gemini rephrases in the target language;
  // the mock provider passes the source answer through — deterministic offline).
  router.post(
    '/draft',
    asyncHandler(async (req, res) => {
      const b = req.body || {};
      const question = String(b.question || '').trim();
      const source = b.answer && typeof b.answer === 'object' ? b.answer : {};
      const sourceLang = LANGS.find((l) => source[l] && String(source[l]).trim());
      if (!question || !sourceLang) {
        return res.status(400).json({ error: 'question and an answer in one language required' });
      }
      const clinic =
        (typeof store.getClinicById === 'function' && store.getClinicById(req.tenantId)) || {};
      const draft = {};
      for (const target of LANGS) {
        if (source[target] && String(source[target]).trim()) {
          draft[target] = source[target];
          continue;
        }
        const out = await provider.generate({
          lang: target,
          task: 'faq_answer',
          userText: question,
          clinic,
          context: { answer: source[sourceLang] },
        });
        draft[target] = (out && out.text) || source[sourceLang];
      }
      res.json({ draft });
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
      await mergeTenantKb(store, req.tenantId);
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
      await mergeTenantKb(store, req.tenantId);
      res.json({ entry: publicKb(entry) });
    })
  );

  router.delete(
    '/:key',
    asyncHandler(async (req, res) => {
      const removed = await store.kbEntries.remove(req.tenantId, req.params.key);
      if (!removed) return res.status(404).json({ error: 'kb entry not found' });
      await mergeTenantKb(store, req.tenantId);
      res.json({ entry: publicKb(removed) });
    })
  );

  return router;
}
