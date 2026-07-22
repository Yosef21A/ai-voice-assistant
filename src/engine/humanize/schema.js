// Structured-output contract between the LLM planner and the deterministic
// executor (P2-HUMANIZE §1). The schema is the Gemini responseSchema (OpenAPI
// subset); coercePlan() re-validates everything defensively because a parsed
// JSON object is still untrusted input — the executor only ever sees a clean,
// bounded plan.

export const ACTIONS = [
  'none',
  'propose_summary',
  'confirm_booking',
  'cancel_flow',
  'answer_faq',
  'handoff_request',
  'notify_admin',
  'kb_gap',
  'specialty_gap',
];

export const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    reply_text: {
      type: 'STRING',
      description:
        "The WhatsApp reply to the patient, in the patient's language and script. Warm, short (1-3 sentences unless recapping).",
    },
    detected_lang: {
      type: 'STRING',
      enum: ['ar', 'fr', 'en', 'ar-Latn'],
      description: "Language AND script of the patient's LAST message. ar-Latn = Arabic in Latin letters (Arabizi).",
    },
    slots_patch: {
      type: 'OBJECT',
      description: 'Booking facts learned THIS message, any subset, any order.',
      properties: {
        specialty: { type: 'STRING', description: 'One of the clinic specialty ids listed in the system prompt.' },
        datetimeText: {
          type: 'STRING',
          description: "The patient's own words for the date/time, verbatim. NEVER compute or format dates yourself.",
        },
        name: { type: 'STRING' },
        origin: { type: 'STRING', description: 'City/country the patient travels from, as stated.' },
        contact: { type: 'STRING', description: 'Phone number as stated.' },
      },
    },
    actions: { type: 'ARRAY', items: { type: 'STRING', enum: ACTIONS } },
    action_reason: { type: 'STRING', description: 'Short reason for notify_admin / handoff_request.' },
    kb_question: { type: 'STRING', description: 'For kb_gap: the question the clinic could not answer, cleaned.' },
    requested_specialty: { type: 'STRING', description: 'For specialty_gap: the treatment the patient asked for.' },
    confidence: { type: 'NUMBER' },
  },
  required: ['reply_text', 'detected_lang', 'actions'],
};

const LANGS = new Set(['ar', 'fr', 'en', 'ar-Latn']);

const str = (v, max) => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
};

/**
 * Defensive validation of the parsed LLM output. Never throws; anything
 * malformed degrades to a safe empty value the executor knows how to handle.
 */
export function coercePlan(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const patch = o.slots_patch && typeof o.slots_patch === 'object' ? o.slots_patch : {};
  const actions = Array.isArray(o.actions)
    ? [...new Set(o.actions.filter((a) => ACTIONS.includes(a)))]
    : [];
  return {
    reply_text: str(o.reply_text, 1200) || '',
    detected_lang: LANGS.has(o.detected_lang) ? o.detected_lang : null,
    slots_patch: {
      specialty: str(patch.specialty, 60),
      datetimeText: str(patch.datetimeText, 120),
      name: str(patch.name, 80),
      origin: str(patch.origin, 80),
      contact: str(patch.contact, 40),
    },
    actions,
    action_reason: str(o.action_reason, 200),
    kb_question: str(o.kb_question, 300),
    requested_specialty: str(o.requested_specialty, 80),
    confidence: typeof o.confidence === 'number' && o.confidence >= 0 && o.confidence <= 1 ? o.confidence : null,
  };
}
