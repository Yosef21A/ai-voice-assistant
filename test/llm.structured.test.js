// GeminiProvider.generateStructured (P2-HUMANIZE): structured output via
// responseSchema. Fully offline through the injected fetchImpl. Contract under
// test: schema + JSON mime type on the wire, key in the HEADER only, parsed
// object returned, and THROWS (never mock-degrades) on any failure so the
// engine falls back to the classic deterministic flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider } from '../src/llm/index.js';

const KEY = 'test-gemini-key';
const SCHEMA = {
  type: 'OBJECT',
  properties: { reply_text: { type: 'STRING' }, actions: { type: 'ARRAY', items: { type: 'STRING' } } },
  required: ['reply_text'],
};

function structuredResponse(obj) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }),
  };
}

test('generateStructured — posts responseSchema + JSON mime, key in header, parses the object', async () => {
  const calls = [];
  const p = new GeminiProvider({
    geminiApiKey: KEY,
    geminiModel: 'gemini-2.5-flash', // pinned to exercise the thinking-budget gate deterministically
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return structuredResponse({ reply_text: 'أهلا 👋', actions: ['none'] });
    },
  });

  const out = await p.generateStructured({
    system: 'You are a receptionist.',
    messages: [
      { role: 'user', text: 'مرحبا' },
      { role: 'model', text: 'أهلا بيك' },
      { role: 'user', text: 'نحب نحجز' },
    ],
    schema: SCHEMA,
  });

  assert.deepEqual(out, { reply_text: 'أهلا 👋', actions: ['none'] });
  const { url, opts } = calls[0];
  assert.ok(!url.includes(KEY), 'key never in the URL');
  assert.equal(opts.headers['x-goog-api-key'], KEY);
  const body = JSON.parse(opts.body);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.generationConfig.responseSchema, SCHEMA);
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 0 }, '2.5-flash gets zero thinking');
  assert.equal(body.contents.length, 3);
  assert.equal(body.contents[1].role, 'model');
  assert.equal(body.system_instruction.parts[0].text, 'You are a receptionist.');
});

test('generateStructured — thinkingConfig omitted for non-2.5-flash models', async () => {
  const calls = [];
  const p = new GeminiProvider({
    geminiApiKey: KEY,
    geminiModel: 'gemini-2.0-flash',
    fetchImpl: async (url, opts) => {
      calls.push({ opts });
      return structuredResponse({ reply_text: 'ok' });
    },
  });
  await p.generateStructured({ system: 's', messages: [{ role: 'user', text: 'x' }], schema: SCHEMA });
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.generationConfig.thinkingConfig, undefined);
});

test('generateStructured — THROWS on HTTP error (no mock degradation)', async () => {
  const p = new GeminiProvider({
    geminiApiKey: KEY,
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
  });
  await assert.rejects(
    () => p.generateStructured({ system: 's', messages: [{ role: 'user', text: 'x' }], schema: SCHEMA }),
    /gemini http 429/
  );
});

test('generateStructured — THROWS on empty candidates (safety block)', async () => {
  const p = new GeminiProvider({
    geminiApiKey: KEY,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ candidates: [] }) }),
  });
  await assert.rejects(
    () => p.generateStructured({ system: 's', messages: [{ role: 'user', text: 'x' }], schema: SCHEMA }),
    /empty structured/
  );
});

test('generateStructured — THROWS on malformed JSON payload', async () => {
  const p = new GeminiProvider({
    geminiApiKey: KEY,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'not json {' }] } }] }),
    }),
  });
  await assert.rejects(() =>
    p.generateStructured({ system: 's', messages: [{ role: 'user', text: 'x' }], schema: SCHEMA })
  );
});

test('generateStructured — THROWS on network rejection', async () => {
  const p = new GeminiProvider({
    geminiApiKey: KEY,
    fetchImpl: async () => {
      throw new Error('ECONNRESET');
    },
  });
  await assert.rejects(
    () => p.generateStructured({ system: 's', messages: [{ role: 'user', text: 'x' }], schema: SCHEMA }),
    /ECONNRESET/
  );
});

test('generateStructured — requires a schema', async () => {
  const p = new GeminiProvider({ geminiApiKey: KEY, fetchImpl: async () => structuredResponse({}) });
  await assert.rejects(() => p.generateStructured({ system: 's', messages: [] }), /schema is required/);
});
