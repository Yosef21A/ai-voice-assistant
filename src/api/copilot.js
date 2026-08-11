// POST /api/copilot — "ask your clinic" (V6). The OWNER asks a question in
// plain language; the answer is grounded EXCLUSIVELY in a compact, tenant-
// scoped data digest built from the same stats module the dashboard and the
// digests read — so the copilot can never contradict the Stats screen.
//
// Privacy: the context carries AGGREGATES plus a few recent lead/appointment
// summaries WITHOUT names or phone numbers — no raw patient dumps ever reach
// the model. Honesty is a prompt LAW: data that isn't in the digest gets an
// explicit "I don't have that data", never an invention.
import express from 'express';
import { asyncHandler } from './http.js';
import { collectAnalytics } from '../stats/index.js';
import { detectLanguage } from '../engine/language.js';

const QUESTION_MAX = 500;
const WINDOW_DAYS = 30;
const RATE_MAX = 10; // questions/min/tenant — this is a paid LLM call
const RATE_WINDOW_MS = 60 * 1000;

function compactDigest(stats, { leads, appointments }) {
  return {
    windowDays: WINDOW_DAYS,
    conversations: stats.conversations,
    messages: stats.messageCount,
    bookings: stats.bookings,
    funnel: stats.funnel,
    appointmentStatuses: stats.apptStatuses,
    reminderOutcomes: stats.reminderOutcomes,
    nudges: stats.nudges,
    noShowTrend: (stats.noShowTrend || []).slice(-4),
    languageSplit: stats.languageSplit,
    afterHoursPct: stats.afterHoursPct ?? null,
    estimatedValue: stats.money ?? null,
    currency: stats.currency ?? null,
    leadsByStatus: stats.leadsByStatus,
    pipelineValue: stats.pipelineValue,
    topQuestions: (stats.topQuestions || []).slice(0, 3).map((q) => q.text),
    unknownRate: stats.unknownRate,
    // Recent rows, aggressively anonymized: no names, no phone numbers.
    recentLeads: leads.slice(0, 5).map((l) => ({
      procedure: l.procedure ?? null,
      status: l.status,
      country: l.originCountry ?? null,
      reason: l.details?.reason ?? null,
    })),
    upcomingAppointments: appointments
      .filter((a) => {
        const iso = a.datetimeISO ?? a.datetimeIso;
        const t = iso ? new Date(iso).getTime() : NaN;
        return !Number.isNaN(t) && t > Date.now() && ['pending', 'confirmed'].includes(a.status);
      })
      .slice(0, 10)
      .map((a) => ({ specialty: a.specialty, status: a.status, when: a.datetimeISO ?? a.datetimeIso })),
  };
}

function buildSystem(clinic, digest) {
  const facilitator = clinic.type === 'facilitator';
  const persona = facilitator
    ? `You are the analytics copilot of "${clinic.name}", a medical-travel facilitator AGENCY. Its business is LEADS and QUOTES — speak of qualified files, offers and conversions, never of a local calendar.`
    : `You are the analytics copilot of "${clinic.name}", a medical practice. Its business is conversations, bookings, no-shows and revived leads.`;
  return `${persona}
The OWNER is asking. Answer ONLY from the DATA below (a ${digest.windowDays}-day window unless a field says otherwise).

LAWS:
1. Every number you state must appear in the DATA, verbatim. Never estimate, extrapolate or invent.
2. If the DATA cannot answer the question, say so plainly ("ما عنديش المعطيات على هذا" / "Je n'ai pas cette donnée") and suggest what IS available.
3. Reply in the language of the question (Arabic → warm Tunisian derja, not MSA). 2-5 sentences, ≤120 words, no markdown tables.
4. Patient privacy: the data is aggregate — never speculate about identifiable individuals.

DATA:
${JSON.stringify(digest)}`;
}

export function copilotRouter({ store, provider, requireRole }) {
  const router = express.Router();
  const rate = new Map(); // tenantId -> { count, windowStart }

  router.post(
    '/',
    requireRole('owner'),
    asyncHandler(async (req, res) => {
      const question = String(req.body?.question ?? '').trim().slice(0, QUESTION_MAX);
      if (!question) return res.status(400).json({ error: 'question required' });

      const now = Date.now();
      const r = rate.get(req.tenantId);
      if (!r || now - r.windowStart >= RATE_WINDOW_MS) {
        rate.set(req.tenantId, { count: 1, windowStart: now });
      } else if (++r.count > RATE_MAX) {
        return res.status(429).json({ error: 'too many questions — try again in a minute' });
      }

      const tenant = await store.tenants.getById(req.tenantId);
      if (!tenant) return res.status(404).json({ error: 'tenant not found' });
      const clinic = (typeof store.getClinicById === 'function' && store.getClinicById(req.tenantId)) || {
        ...tenant.config,
        id: tenant.id,
        name: tenant.name,
      };

      const to = new Date();
      const from = new Date(to.getTime() - WINDOW_DAYS * 24 * 3600 * 1000);
      const [stats, leads, appointments] = await Promise.all([
        collectAnalytics(store, tenant, { from, to }),
        store.leads.list(req.tenantId, {}),
        store.appointments.list(req.tenantId, {}),
      ]);
      const digest = compactDigest(stats, {
        leads: leads.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
        appointments,
      });

      const lang = detectLanguage(question) || tenant.languages?.[0] || 'fr';
      const out = await provider.generate({
        system: buildSystem(clinic, digest),
        userText: question,
        lang,
        clinic,
        task: 'copilot',
      });

      try {
        await store.events.append(req.tenantId, {
          type: 'copilot.asked',
          actor: `staff:${req.user.id}`,
          payload: { question: question.slice(0, 200) },
        });
      } catch {
        /* audit is best-effort */
      }

      res.json({ answer: out?.text || '', provider: out?.provider || provider.name });
    })
  );

  return router;
}
