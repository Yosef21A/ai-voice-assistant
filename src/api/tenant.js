// GET/PUT /api/tenant — clinic profile, languages, persona, escalation, tourism
// module and notification prefs. PUT validates and persists into the SAME
// clinic-shaped config data/clinics.json uses, and mutates the live in-memory
// clinic so the running engine reflects the change immediately (same store).
import express from 'express';
import { asyncHandler } from './http.js';
import { mergeTenantKb } from '../store/kbLive.js';

const LANGS = new Set(['ar', 'fr', 'en']);
const TONES = new Set(['professional', 'warm']);
const TENANT_TYPES = new Set(['clinic', 'cabinet', 'facilitator']);

// Redact any per-tenant secrets before returning config to the dashboard.
function publicTenant(t) {
  if (!t) return null;
  const config = { ...(t.config || {}) };
  if (config.whatsapp) {
    const { token, accessToken, ...safe } = config.whatsapp;
    config.whatsapp = safe;
  }
  return {
    id: t.id,
    phoneNumberId: t.phoneNumberId ?? null,
    name: t.name,
    city: t.city ?? null,
    country: t.country ?? null,
    timezone: t.timezone ?? null,
    currency: t.currency ?? null,
    languages: t.languages ?? [],
    status: t.status ?? 'active',
    config,
  };
}

function validate(body) {
  const errs = [];
  if (body.languages != null) {
    if (!Array.isArray(body.languages) || body.languages.some((l) => !LANGS.has(l))) {
      errs.push('languages must be an array of ar|fr|en');
    }
  }
  if (body.persona?.tone != null && !TONES.has(body.persona.tone)) {
    errs.push('persona.tone must be professional|warm');
  }
  if (body.workingHours != null && typeof body.workingHours !== 'object') {
    errs.push('workingHours must be an object');
  }
  if (body.escalation?.handoff != null && typeof body.escalation.handoff !== 'object') {
    errs.push('escalation.handoff must be an object { name, phone }');
  }
  if (body.type != null && !TENANT_TYPES.has(body.type)) {
    errs.push('type must be clinic|cabinet|facilitator');
  }
  if (body.partners != null) {
    const ok =
      Array.isArray(body.partners) &&
      body.partners.every(
        (p) =>
          p &&
          typeof p === 'object' &&
          typeof p.name === 'string' &&
          p.name.length <= 120 &&
          (p.city == null || (typeof p.city === 'string' && p.city.length <= 80)) &&
          (p.specialties == null ||
            (Array.isArray(p.specialties) && p.specialties.every((s) => typeof s === 'string' && s.length <= 60)))
      );
    if (!ok) errs.push('partners must be an array of { name, city?, specialties?[] }');
  }
  if (
    body.destinations != null &&
    (!Array.isArray(body.destinations) || body.destinations.some((d) => typeof d !== 'string' || d.length > 80))
  ) {
    errs.push('destinations must be an array of strings');
  }
  if (body.doctorName != null) {
    const dn = body.doctorName;
    const isLabelString = (v) => typeof v === 'string' && v.length <= 120;
    const isLabelObject =
      typeof dn === 'object' &&
      !Array.isArray(dn) &&
      Object.entries(dn).every(([k, v]) => LANGS.has(k) && isLabelString(v));
    // Values are rendered verbatim into patient-facing messages ("Dr {name}"),
    // so anything non-string would literally read "Dr [object Object]".
    if (!isLabelString(dn) && !isLabelObject) {
      errs.push('doctorName must be a string or an {ar,fr,en} object of strings');
    }
  }
  return errs;
}

export function tenantRouter({ store, requireRole }) {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const t = await store.tenants.getById(req.tenantId);
      if (!t) return res.status(404).json({ error: 'tenant not found' });
      res.json({ tenant: publicTenant(t) });
    })
  );

  router.put(
    '/',
    requireRole('owner'),
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      const current = await store.tenants.getById(req.tenantId);
      if (!current) return res.status(404).json({ error: 'tenant not found' });
      const errs = validate(body);
      // A cabinet must keep its one specialty: saving an empty list would leave
      // the booking flow asking a specialty question no patient can answer.
      const effectiveType = body.type ?? current.config?.type;
      if (effectiveType === 'cabinet' && Array.isArray(body.specialties) && body.specialties.length === 0) {
        errs.push('a cabinet needs exactly one specialty');
      }
      if (errs.length) return res.status(400).json({ error: 'validation', details: errs });

      const config = { ...(current.config || {}) };
      const top = {};
      const setTop = (k, v) => {
        top[k] = v;
        config[k] = v;
      };
      if (body.name != null) setTop('name', String(body.name));
      if (body.city != null) setTop('city', String(body.city));
      if (body.country != null) setTop('country', String(body.country));
      if (body.timezone != null) setTop('timezone', String(body.timezone));
      if (body.currency != null) setTop('currency', String(body.currency));
      if (Array.isArray(body.languages)) setTop('languages', body.languages.map(String));
      if (body.address != null) config.address = String(body.address);
      if (body.googleMapsUrl != null) config.googleMapsUrl = String(body.googleMapsUrl);
      if (body.phone != null) config.phone = String(body.phone);
      // D1 cabinet mode: tenant type + doctor persona name (engine reads both
      // off the clinic object — tenantProfile.js).
      if (body.type != null) config.type = body.type;
      // D2 facilitator: informational partner list (lead-card routing hint —
      // never messaged) + destination cities.
      if (Array.isArray(body.partners)) config.partners = body.partners;
      if (Array.isArray(body.destinations)) config.destinations = body.destinations.map(String);
      if (body.doctorName != null) {
        config.doctorName =
          typeof body.doctorName === 'string' ? body.doctorName.trim() : body.doctorName;
      }
      if (Array.isArray(body.specialties)) config.specialties = body.specialties;
      if (body.workingHours && typeof body.workingHours === 'object') config.workingHours = body.workingHours;
      if (Array.isArray(body.holidays)) config.holidays = body.holidays.map(String);
      if (body.persona && typeof body.persona === 'object') {
        config.persona = { ...(config.persona || {}), ...body.persona };
      }
      if (body.escalation && typeof body.escalation === 'object') {
        config.escalation = { ...(config.escalation || {}), ...body.escalation };
        if (body.escalation.handoff && typeof body.escalation.handoff === 'object') {
          config.handoff = { ...(config.handoff || {}), ...body.escalation.handoff };
        }
      }
      if (body.tourism && typeof body.tourism === 'object') {
        config.tourism = { ...(config.tourism || {}), ...body.tourism };
      }
      if (body.notifications && typeof body.notifications === 'object') {
        config.notifications = { ...(config.notifications || {}), ...body.notifications };
      }
      // V2 reminder toggles — booleans only, so a malformed body can't smuggle
      // arbitrary structure into the scheduler's config.
      if (body.reminders && typeof body.reminders === 'object') {
        const r = body.reminders;
        config.reminders = {
          ...(config.reminders || {}),
          ...(r.enabled != null ? { enabled: !!r.enabled } : {}),
          ...(r.t48 != null ? { t48: !!r.t48 } : {}),
          ...(r.t3 != null ? { t3: !!r.t3 } : {}),
        };
      }

      // The engine's merged FAQ state must NEVER be persisted or restored via
      // Settings: kbLive rebuilds clinic.faq from _baseFaq + active kb_entries.
      // A stale snapshot here would revert trained answers and resurrect
      // deleted ones on every save (and permanently bloat tenants.json).
      delete config.faq;
      delete config._baseFaq;

      const saved = await store.tenants.upsert({
        id: req.tenantId,
        phoneNumberId: current.phoneNumberId,
        name: top.name ?? current.name,
        city: top.city ?? current.city,
        country: top.country ?? current.country,
        timezone: top.timezone ?? current.timezone,
        currency: top.currency ?? current.currency,
        languages: top.languages ?? current.languages,
        status: current.status,
        config,
      });

      // Live update for the engine, which still reads the legacy clinic object.
      // Re-merge the KB afterwards so the served FAQ always reflects base seed
      // + current active entries, whatever this save touched.
      if (typeof store.getClinicById === 'function') {
        const live = store.getClinicById(req.tenantId);
        if (live) Object.assign(live, config);
        await mergeTenantKb(store, req.tenantId);
      }

      res.json({ tenant: publicTenant(saved) });
    })
  );

  return router;
}

export { publicTenant };
