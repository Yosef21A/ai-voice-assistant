// Inbound analysis pipeline — the ONE call the transport layer makes per turn
// to run the safety-critical + revenue-critical detectors and fan the verdicts
// out onto the event bus.
//
// It sits BESIDE the conversation engine, not inside it: the engine stays pure
// and transport-agnostic (it never touches the bus), while this module is the
// hook every transport (webhook, simulator, sandbox) calls with the engine's
// result to (a) alert staff and (b) — for emergencies — OVERRIDE the engine's
// reply so the bot steps back (PRODUCT-SPEC §5 / CLAUDE.md guardrail).
//
// Contract (see README.md for exact wiring):
//   const outcome = analyzeInbound({ tenant, text, lang, engineResult, waId, bus });
//   if (outcome.overrideReply) sendToPatient(outcome.overrideReply);   // emergency
//   else                       sendToPatient(engineReply);             // normal
//
// It NEVER throws — a classifier or bus error must not break a turn.
import { detectEmergency, isHotLead } from './detector.js';

// National / clinic emergency numbers by home country (fallbacks only; a tenant
// SHOULD configure its own via config.notifications.emergencyNumber). Tunisia:
// SAMU 190. Libya: ambulance 1515.
const EMERGENCY_DEFAULTS = { Tunisia: '190', Libya: '1515', Algeria: '14', Morocco: '15', Egypt: '123' };

// Patient-facing emergency reply. It does NOT diagnose, points to real emergency
// services, discloses the assistant is stepping back, and offers the clinic line.
const EMERGENCY_REPLY = {
  ar: (v) =>
    `🚨 هذي ممكن تكون حالة طوارئ طبية. اتصل بالإسعاف حالاً على ${v.emergency}${v.clinic ? ` أو بالعيادة على ${v.clinic}` : ''}.\nفريقنا تنبّه وباش يتواصل معاك. أنا مساعد آلي وما نجمش نتعامل مع الحالات الطارئة — السلامة أولاً. 🌿`,
  fr: (v) =>
    `🚨 Cela peut être une urgence médicale. Appelez immédiatement les secours au ${v.emergency}${v.clinic ? ` ou la clinique au ${v.clinic}` : ''}.\nNotre équipe est alertée et va vous contacter. Je suis un assistant automatique et je ne peux pas gérer les urgences — votre sécurité d'abord. 🌿`,
  en: (v) =>
    `🚨 This may be a medical emergency. Please call emergency services now at ${v.emergency}${v.clinic ? ` or the clinic at ${v.clinic}` : ''}.\nOur team has been alerted and will contact you. I'm an automated assistant and can't handle emergencies — your safety comes first. 🌿`,
};

function tenantConfig(tenant) {
  if (!tenant || typeof tenant !== 'object') return {};
  if (tenant.config && typeof tenant.config === 'object') return tenant.config;
  return tenant;
}

function tenantId(tenant) {
  return tenant?.id ?? tenant?.tenantId ?? tenantConfig(tenant)?.id ?? null;
}

/** Resolve the emergency number a patient should call. */
export function resolveEmergencyNumber(tenant) {
  const cfg = tenantConfig(tenant);
  return (
    cfg?.notifications?.emergencyNumber ||
    cfg?.emergency?.phone ||
    cfg?.emergencyNumber ||
    EMERGENCY_DEFAULTS[cfg?.country] ||
    cfg?.handoff?.phone ||
    '190'
  );
}

/** Clinic escalation line shown as a secondary contact in the emergency reply. */
function escalationNumber(tenant) {
  const cfg = tenantConfig(tenant);
  return cfg?.handoff?.phone || cfg?.notifications?.escalationPhone || null;
}

/** Build the localized patient-facing emergency message (the overrideReply). */
export function buildEmergencyReply(tenant, lang = 'fr') {
  const L = ['ar', 'fr', 'en'].includes(lang) ? lang : 'fr';
  const fn = EMERGENCY_REPLY[L] || EMERGENCY_REPLY.fr;
  const emergency = resolveEmergencyNumber(tenant);
  const clinic = escalationNumber(tenant);
  // Don't print the clinic line if it's identical to the emergency number.
  return fn({ emergency, clinic: clinic && clinic !== emergency ? clinic : '' });
}

function deriveConversationId({ conversationId, tenant, waId }) {
  if (conversationId) return conversationId;
  const id = tenantId(tenant);
  return id != null && waId != null ? `${id}:${waId}` : null;
}

function shortSnippet(text, max = 160) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Run the detectors for one inbound turn and emit any resulting bus events.
 *
 * @param {object}  args
 * @param {object}  args.tenant        tenant record ({config}) OR bare clinic
 * @param {string}  args.text          raw inbound patient text
 * @param {string}  [args.lang]        engine-resolved language ('ar'|'fr'|'en')
 * @param {object}  [args.engineResult] engine handleMessage() result
 * @param {string}  [args.waId]        patient WhatsApp id (E.164 digits)
 * @param {object}  [args.bus]         ClinicEventBus (optional; verdicts still returned)
 * @param {string}  [args.conversationId] override; else derived `${tenantId}:${waId}`
 * @returns {{emergency:object|null, overrideReply:string|null, lead:object|null, hot:boolean}}
 */
export function analyzeInbound({
  tenant,
  text = '',
  lang = 'fr',
  engineResult = {},
  waId,
  bus,
  conversationId,
} = {}) {
  const out = { emergency: null, overrideReply: null, lead: null, hot: false };
  try {
    const cfg = tenantConfig(tenant);
    const tid = tenantId(tenant);
    const convId = deriveConversationId({ conversationId, tenant, waId });

    // 1) EMERGENCY — highest priority. A hit steps the bot back: we emit the
    //    alert AND return an overrideReply the caller MUST send instead of the
    //    engine output. We do NOT also classify a lead on an emergency turn.
    const emg = detectEmergency(text, lang);
    if (emg.hit) {
      const emergency = {
        keyword: emg.keyword,
        category: emg.category,
        lang: emg.lang || lang,
        patientWaId: waId ?? null,
        conversationId: convId,
      };
      out.emergency = emergency;
      out.overrideReply = buildEmergencyReply(tenant, lang);
      publish(bus, 'emergency.detected', {
        tenantId: tid,
        conversationId: convId,
        keyword: emg.keyword,
        category: emg.category,
        lang: emergency.lang,
        waId: waId ?? null,
        patientWaId: waId ?? null,
      });
      return out;
    }

    // 2) HOT LEAD — revenue signal. Never fires on a completed booking turn
    //    (isHotLead guards that); the booking alert already covers those.
    const verdict = isHotLead(engineResult, cfg, text, { waId });
    if (verdict.hot) {
      const lead = {
        reason: verdict.reason,
        procedure: verdict.procedure ?? null,
        country: verdict.country ?? null,
        patientWaId: waId ?? null,
        conversationId: convId,
        snippet: shortSnippet(text),
      };
      out.lead = lead;
      out.hot = true;
      publish(bus, 'lead.hot', { tenantId: tid, conversationId: convId, lead });
    }
    return out;
  } catch {
    // A detector/bus failure must never break the turn.
    return out;
  }
}

// Publish defensively: prefer the bus's normalized publish(); tolerate a plain
// EventEmitter (emit) too. Swallow errors — alerts are best-effort.
function publish(bus, type, evt) {
  if (!bus) return;
  try {
    if (typeof bus.publish === 'function') bus.publish(type, evt);
    else if (typeof bus.emit === 'function') bus.emit(type, { at: new Date().toISOString(), ...evt, type });
  } catch {
    /* best-effort */
  }
}

export default analyzeInbound;
