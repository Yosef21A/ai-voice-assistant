// Cerebras and Groq — the free rotation targets, behind one OpenAI-compatible
// adapter because they publish the same wire format.
//
// STATUS, and it is a doctrine point rather than a caveat: **neither is
// benchmarked on derja, and neither has a key on this machine.** The zero-budget
// doctrine says nothing unbenchmarked on derja ships as PRIMARY — so these are
// wired as rotation targets only, reached when Gemini's free tier walls
// (5 req/min on 3-flash) leave a caller waiting. A rotation that answers in
// stiff MSA is still better than the alternative it replaces, which is silence.
//
// CONTRACT (OpenAI Chat Completions, streaming):
//   POST <base>/chat/completions
//   Authorization: Bearer <key>
//   { model, messages, tools?, stream:true, stream_options:{include_usage:true} }
//   ← SSE frames: { choices:[{ delta:{ content?, tool_calls?[] }, finish_reason }],
//                   usage? }
//
// TWO THINGS THAT ARE NOT OBVIOUS:
//  1. TOOL CALLS ARRIVE IN PIECES. `delta.tool_calls[i].function.arguments` is
//     a JSON string streamed a few characters at a time, and the name may only
//     appear in the first fragment. They are accumulated by INDEX and emitted
//     when the turn finishes — emitting a half-parsed argument object would
//     hand the booking executor a partial date.
//  2. THE MODEL ID IS VERIFIED AT RUNTIME. Vendors rename free models without
//     notice, and a 404 mid-call is a mute agent. On the first use the models
//     list is fetched once per process; if our id is gone we take the closest
//     listed llama-3.3, and if the check itself fails we proceed anyway — a
//     flaky metadata endpoint must not bench a working brain.
import { postSse, LlmError, LLM_TIMEOUT_MS } from './http.js';
import { toOpenAiTools, parseToolArguments } from './tools.js';

/** Verified endpoints (OpenAI-compatible base paths). */
export const CEREBRAS_BASE = 'https://api.cerebras.ai/v1';
export const GROQ_BASE = 'https://api.groq.com/openai/v1';

export const OPENAI_COMPAT_PROVIDERS = Object.freeze({
  cerebras: { base: CEREBRAS_BASE, model: 'llama-3.3-70b' },
  groq: { base: GROQ_BASE, model: 'llama-3.3-70b-versatile' },
});

export const MAX_OUTPUT_TOKENS = 160;

/** Neutral history → OpenAI messages. */
export function toOpenAiMessages(system, messages = []) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.callId || m.name || 'tool',
        content: JSON.stringify(m.result ?? {}),
      });
      continue;
    }
    if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.text || '' };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c, i) => ({
          id: c.id || `call_${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
        }));
      }
      out.push(msg);
      continue;
    }
    out.push({ role: 'user', content: m.text || '' });
  }
  return out;
}

/**
 * Ask the vendor which models it actually serves. Best-effort by design.
 * @returns {Promise<string[]|null>} null ⇒ could not tell, proceed as-is
 */
export async function listModels({ fetchImpl, base, apiKey, timeoutMs = 3000 } = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('models list timed out')), timeoutMs);
  timer.unref?.();
  try {
    const res = await doFetch(`${base}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ac.signal,
    });
    if (!res || Number(res.status) < 200 || Number(res.status) >= 300) return null;
    const body = typeof res.json === 'function' ? await res.json() : null;
    const data = Array.isArray(body?.data) ? body.data : [];
    return data.map((m) => String(m?.id || '')).filter(Boolean);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} p
 * @param {string} p.provider  'cerebras' | 'groq'
 * @param {string} p.apiKey
 * @param {string} [p.model]
 * @param {string} [p.base]
 * @param {Array<object>} [p.tools]
 * @param {Function} [p.fetchImpl]
 * @param {Function} [p.logger]
 * @param {boolean} [p.verifyModel] default true; one models-list call per process
 */
export function createOpenAiCompatLlm({
  provider,
  apiKey,
  model,
  base,
  tools,
  temperature = 0.7,
  maxOutputTokens = MAX_OUTPUT_TOKENS,
  timeoutMs = LLM_TIMEOUT_MS,
  fetchImpl,
  logger,
  verifyModel = true,
} = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  const spec = OPENAI_COMPAT_PROVIDERS[provider];
  if (!spec) throw new LlmError(`unknown OpenAI-compatible provider ${provider}`, { provider, kind: 'config' });
  const key = String(apiKey || '');
  if (!key) throw new LlmError(`${provider} needs an API key`, { provider, kind: 'config' });
  const apiBase = String(base || spec.base);
  let modelId = String(model || spec.model);
  const toolBlock = toOpenAiTools(tools);
  /** One verification per adapter; the result is remembered for the process. */
  let verified = verifyModel ? null : Promise.resolve(true);

  async function ensureModel() {
    if (verified) return verified;
    verified = (async () => {
      const ids = await listModels({ fetchImpl, base: apiBase, apiKey: key });
      // Could not tell ⇒ proceed. A flaky metadata endpoint must never bench a
      // brain that would have answered perfectly well.
      if (!ids) return true;
      if (ids.includes(modelId)) return true;
      const alt = ids.find((id) => id.includes('llama-3.3')) || ids[0];
      if (alt) {
        log(`[voice-cascade] ${provider} does not list ${modelId} — using ${alt} instead`);
        modelId = alt;
        return true;
      }
      log(`[voice-cascade] ${provider} lists no usable model — skipping it this turn`);
      return false;
    })();
    return verified;
  }

  return {
    provider,
    get model() {
      return modelId;
    },

    async *stream({ system = '', messages = [], signal } = {}) {
      const ok = await ensureModel();
      if (!ok) {
        throw new LlmError(`${provider} has no usable model`, { provider, kind: 'config' });
      }
      const body = {
        model: modelId,
        messages: toOpenAiMessages(system, messages),
        stream: true,
        // Usage only arrives on the final frame, and only when asked for. It is
        // what turns "voice minutes cost money" into a per-call number.
        stream_options: { include_usage: true },
        temperature,
        max_tokens: maxOutputTokens,
      };
      if (toolBlock) body.tools = toolBlock;

      /** index → { id, name, args } accumulated across fragments. */
      const pending = new Map();
      let usage = { tokensIn: 0, tokensOut: 0 };

      for await (const frame of postSse({
        fetchImpl,
        url: `${apiBase}/chat/completions`,
        provider,
        signal,
        timeoutMs,
        init: {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      })) {
        if (frame?.usage) {
          usage = {
            tokensIn: Number(frame.usage.prompt_tokens) || usage.tokensIn,
            tokensOut: Number(frame.usage.completion_tokens) || usage.tokensOut,
          };
        }
        const choice = frame?.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) yield { type: 'text', delta: String(delta.content) };
        for (const tc of delta?.tool_calls || []) {
          const i = Number(tc?.index) || 0;
          const acc = pending.get(i) || { id: null, name: '', args: '' };
          if (tc?.id) acc.id = tc.id;
          if (tc?.function?.name) acc.name = tc.function.name;
          if (tc?.function?.arguments) acc.args += tc.function.arguments;
          pending.set(i, acc);
        }
      }

      for (const [i, acc] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
        if (!acc.name) continue;
        yield {
          type: 'toolCall',
          call: { id: acc.id || `call_${i}`, name: acc.name, args: parseToolArguments(acc.args) },
        };
      }
      yield { type: 'done', usage };
    },
  };
}

export default createOpenAiCompatLlm;
