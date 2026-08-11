// ONE tool list, three wire formats. The declarations themselves are NOT forked.
//
// brain/tools.js `buildToolDeclarations()` is the single source of truth for
// what the agent may do — and it is a guardrail, not a config: there is
// deliberately no pricing tool, and a facilitator gets no booking tools at all.
// Forking it per vendor would mean a rotation to Groq could quietly hand a
// facilitator a `confirm_booking` it must never have.
//
// So this module TRANSLATES the same declarations:
//   • Gemini wants them as-is (they are already the Gemini schema subset, with
//     SCREAMING type names) under `tools:[{ functionDeclarations }]`.
//   • OpenAI-compatible vendors (Cerebras, Groq) want
//     `tools:[{ type:'function', function:{ name, description, parameters } }]`
//     with JSON-Schema lower-case types.
//
// The type mapping is the whole of the difference, and it is done recursively
// because a nested object/array schema is one refactor away from existing.
// Anything unrecognized is passed through lower-cased rather than dropped: a
// vendor rejecting a type it does not know is a loud, diagnosable failure; a
// silently dropped property is a tool that books with a missing field.

const TYPE_MAP = Object.freeze({
  OBJECT: 'object',
  STRING: 'string',
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
});

/** Recursively lower-case a Gemini schema into JSON Schema. */
export function toJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(toJsonSchema);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type' && typeof value === 'string') {
      out.type = TYPE_MAP[value] || String(value).toLowerCase();
      continue;
    }
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSchema(v)]));
      continue;
    }
    if (key === 'items') {
      out.items = toJsonSchema(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Gemini format. The declarations are already in it — this exists so both call
 * sites read the same and so a malformed entry is dropped in ONE place.
 * @param {Array<object>} declarations
 * @returns {Array<object>|undefined} undefined ⇒ send no `tools` field at all
 */
export function toGeminiTools(declarations) {
  const list = (Array.isArray(declarations) ? declarations : []).filter((d) => d && typeof d.name === 'string');
  if (!list.length) return undefined;
  return [{ functionDeclarations: list }];
}

/**
 * OpenAI format (Cerebras, Groq, and anything else that copied the shape).
 * @param {Array<object>} declarations
 * @returns {Array<object>|undefined}
 */
export function toOpenAiTools(declarations) {
  const list = (Array.isArray(declarations) ? declarations : []).filter((d) => d && typeof d.name === 'string');
  if (!list.length) return undefined;
  return list.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description || '',
      // A tool with no parameters still needs a schema: several vendors reject
      // a missing one outright, and `end_call` is exactly that tool.
      parameters: toJsonSchema(d.parameters || { type: 'OBJECT', properties: {} }),
    },
  }));
}

/** Arguments come back as a JSON STRING on the OpenAI shape. Never throw. */
export function parseToolArguments(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  const s = String(raw).trim();
  if (!s) return {};
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A model that streams malformed arguments has told us nothing usable. An
    // empty object reaches the executor, which refuses it on its own terms —
    // that refusal is data the model can talk its way out of, unlike a throw.
    return {};
  }
}

export default toOpenAiTools;
