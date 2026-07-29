// Tenant profile helpers (D1 cabinet mode). A tenant is one of three types:
//
//   'clinic'      — multi-specialty clinic with a switchboard persona (default;
//                   every pre-D1 tenant record has no `type` field and lands
//                   here, so the migration cost is zero).
//   'cabinet'     — a single doctor's private practice. The bot speaks as THE
//                   DOCTOR'S assistant ("مساعد عيادة الدكتور X"), and the
//                   specialty question must never be asked — there is one.
//   'facilitator' — medical-tourism agency (D2): no local booking, the
//                   conversation goal is lead qualification.
//
// Leaf module: imports nothing from the engine, so responses/booking/prompt can
// all use it without cycles.

const TYPES = new Set(['clinic', 'cabinet', 'facilitator']);

/** @returns {'clinic'|'cabinet'|'facilitator'} */
export function tenantType(clinic) {
  const t = clinic?.type;
  return TYPES.has(t) ? t : 'clinic';
}

export function isCabinet(clinic) {
  return tenantType(clinic) === 'cabinet';
}

export function isFacilitator(clinic) {
  return tenantType(clinic) === 'facilitator';
}

/**
 * The specialty a booking may assume WITHOUT asking. Non-null when the tenant
 * has exactly one specialty (any type), or is a cabinet (a doctor's practice
 * has one discipline — the wizard enforces a single entry, but a misconfigured
 * multi-entry cabinet still books under its primary rather than interrogating
 * the patient about a choice that isn't theirs to make).
 */
export function defaultSpecialtyId(clinic) {
  const sps = Array.isArray(clinic?.specialties) ? clinic.specialties : [];
  if (sps.length === 1) return sps[0].id || null;
  if (isCabinet(clinic) && sps.length > 0) return sps[0].id || null;
  return null;
}

/**
 * Localized doctor display name (WITHOUT the "Dr" honorific — templates add it
 * in their own language). Accepts a plain string or an {ar,fr,en} object, same
 * convention as specialty labels. Null when unset — callers must degrade to the
 * clinic-style persona rather than rendering "Dr null".
 */
export function doctorName(clinic, lang) {
  const dn = clinic?.doctorName;
  if (!dn) return null;
  if (typeof dn === 'string') return dn.trim() || null;
  if (typeof dn === 'object') {
    return dn[lang] || dn.fr || dn.en || dn.ar || null;
  }
  return null;
}

/**
 * True when the doctor persona should speak: a cabinet WITH a configured
 * doctor name. A cabinet missing its doctorName keeps the neutral clinic
 * persona (never "Dr undefined").
 */
export function hasDoctorPersona(clinic) {
  return isCabinet(clinic) && !!doctorName(clinic, 'fr');
}
