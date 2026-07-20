// LLM provider factory + Gemini provider. Fully offline: fetch is injected, so
// no test ever touches generativelanguage.googleapis.com. Covers:
//   • selection order gemini → anthropic → mock, including the real-world case
//     of a stray machine-global ANTHROPIC_API_KEY that must NOT win
//   • success path: model in URL, key ONLY in the x-goog-api-key header, text
//     assembled from candidate parts
//   • error paths (HTTP error, network reject, empty candidates) degrade to the
//     deterministic MockProvider reply — conversations never break
//   • faq_answer + context.answer survives the fallback (KB answer passthrough)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProvider, GeminiProvider, MockProvider } from '../src/llm/index.js';

const KEY = 'test-gemini-key';

function geminiResponse(text) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
    }),
  };
}

// ── selection order ────────────────────────────────────────────────────────────
test('getProvider — gemini wins over a stray anthropic key; anthropic next; mock default', () => {
  assert.equal(getProvider({ geminiApiKey: KEY, anthropicApiKey: 'stray-openrouter-key' }).name, 'gemini');
  assert.equal(getProvider({ geminiApiKey: KEY }).name, 'gemini');
  assert.equal(getProvider({ anthropicApiKey: 'k' }).name, 'anthropic');
  assert.equal(getProvider({}).name, 'mock');
  assert.equal(getProvider().name, 'mock');
});

test('getProvider — gemini model/timeout come from config with safe defaults', () => {
  const p = getProvider({ geminiApiKey: KEY });
  assert.equal(p.model, 'gemini-2.5-flash');
  assert.equal(p.timeoutMs, 8000);
  const q = getProvider({ geminiApiKey: KEY, geminiModel: 'gemini-2.0-flash', geminiTimeoutMs: 3000 });
  assert.equal(q.model, 'gemini-2.0-flash');
  assert.equal(q.timeoutMs, 3000);
});

// ── success path ───────────────────────────────────────────────────────────────
test('gemini — posts to generateContent with the key in the HEADER, never the URL', async () => {
  const calls = [];
  const p = new GeminiProvider({
    geminiApiKey: KEY,
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return geminiResponse('أهلا بيك في مصحة الأمان 🌟');
    },
  });
  const out = await p.generate({ lang: 'ar', userText: 'مرحبا', clinic: { name: 'El Amen' } });

  assert.equal(out.provider, 'gemini');
  assert.equal(out.text, 'أهلا بيك في مصحة الأمان 🌟');
  assert.equal(calls.length, 1);
  const { url, opts } = calls[0];
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.ok(!url.includes(KEY), 'API key must never appear in the URL');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.headers['x-goog-api-key'], KEY);

  const body = JSON.parse(opts.body);
  assert.equal(body.contents[0].parts[0].text, 'مرحبا');
  assert.match(body.system_instruction.parts[0].text, /El Amen/);
  assert.match(body.system_instruction.parts[0].text, /Arabic/);
  // 2.5-flash family: thinking disabled for receptionist latency.
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
});

test('gemini — KB context is passed through into the system instruction', async () => {
  let body = null;
  const p = new GeminiProvider({
    geminiApiKey: KEY,
    fetchImpl: async (_url, opts) => {
      body = JSON.parse(opts.body);
      return geminiResponse('Nos horaires : lundi–jeudi 8h30–17h30.');
    },
  });
  const kb = 'Horaires : lundi à jeudi 8h30–17h30, vendredi 8h30–13h00.';
  const out = await p.generate({ lang: 'fr', task: 'faq_answer', userText: 'horaires ?', context: { answer: kb } });
  assert.equal(out.provider, 'gemini');
  assert.ok(body.system_instruction.parts[0].text.includes(kb), 'KB answer grounds the prompt');
});

test('gemini — non-2.5-flash models do not send thinkingConfig', async () => {
  let body = null;
  const p = new GeminiProvider({
    geminiApiKey: KEY,
    geminiModel: 'gemini-2.0-flash',
    fetchImpl: async (_url, opts) => {
      body = JSON.parse(opts.body);
      return geminiResponse('ok');
    },
  });
  await p.generate({ lang: 'en', userText: 'hi' });
  assert.equal(body.generationConfig.thinkingConfig, undefined);
});

// ── error paths → deterministic fallback ───────────────────────────────────────
test('gemini — HTTP error degrades to the deterministic mock reply', async () => {
  const p = new GeminiProvider({
    geminiApiKey: KEY,
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
  });
  const out = await p.generate({ lang: 'ar', userText: 'مرحبا' });
  const mock = await new MockProvider().generate({ lang: 'ar' });
  assert.equal(out.provider, 'gemini:fallback');
  assert.equal(out.text, mock.text);
  assert.match(out.error, /http 429/);
});

test('gemini — network reject degrades to the deterministic mock reply', async () => {
  const p = new GeminiProvider({
    geminiApiKey: KEY,
    fetchImpl: async () => {
      throw new Error('socket hang up');
    },
  });
  const out = await p.generate({ lang: 'fr', userText: 'bonjour' });
  const mock = await new MockProvider().generate({ lang: 'fr' });
  assert.equal(out.provider, 'gemini:fallback');
  assert.equal(out.text, mock.text);
});

test('gemini — empty/blocked candidates degrade to fallback; KB answer survives', async () => {
  const p = new GeminiProvider({
    geminiApiKey: KEY,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ candidates: [] }) }),
  });
  const kb = 'We accept cash, card and wire transfer.';
  const out = await p.generate({ lang: 'en', task: 'faq_answer', userText: 'payment?', context: { answer: kb } });
  assert.equal(out.provider, 'gemini:fallback');
  assert.equal(out.text, kb); // MockProvider passes the KB answer through
});
