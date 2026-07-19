// Public entrypoint for the owner-notification module (P1-E).
//
//   import { createNotificationService, analyzeInbound } from './notifications/index.js';
//
//   // once, at server startup (composed bus/sender/store):
//   const notifier = createNotificationService({ bus, sender, store });
//
//   // per inbound turn, beside the engine (see README §Wiring):
//   const analysis = analyzeInbound({ tenant, text, lang, engineResult, waId, bus });
//   if (analysis.overrideReply) sendToPatient(analysis.overrideReply); // emergency
//
// See ./README.md for the exact slice-F wiring contract.
export { createNotificationService, computeDigestStats } from './service.js';
export {
  resolveRecipients,
  isEventEnabled,
  inQuietHours,
  isAfterHours,
  minutesInTz,
  weekdayInTz,
  normalizeMsisdn,
} from './service.js';
export { analyzeInbound, buildEmergencyReply, resolveEmergencyNumber } from './pipeline.js';
export {
  formatBooking,
  formatHotLead,
  formatHandoff,
  formatEmergency,
  formatAlert,
  formatDailyDigest,
  formatWeeklyDigest,
  resolveOwnerLang,
} from './formatter.js';
export {
  detectEmergency,
  isHotLead,
  classifyOrigin,
  EMERGENCY_KEYWORDS,
  DEFAULT_HIGH_VALUE_SPECIALTIES,
} from './detector.js';

export { createNotificationService as default } from './service.js';
