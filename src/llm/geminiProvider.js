// Google Gemini provider. Activated when GEMINI_API_KEY is set (it takes
// precedence over Anthropic — see getProvider in ./index.js). Uses the global
// fetch (Node 18+) — no SDK. The key travels ONLY in the x-goog-api-key header,
// never in the URL (URLs end up in logs/proxies). Any error — network, quota,
// bad key, safety block, timeout — degrades gracefully to the deterministic
// MockProvider so the conversation never breaks.
import { MockProvider } from './mockProvider.js';

const LANG_NAME = { ar: 'Arabic', fr: 'French', en: 'English' };
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiProvider {
  constructor(config = {}) {
    this.name = 'gemini';
    this.apiKey = config.geminiApiKey;
    this.model = config.geminiModel || 'gemini-2.5-flash';
    this.timeoutMs = Number(config.geminiTimeoutMs) || 8000;
    this._fetch =
      typeof config.fetchImpl === 'function'
        ? config.fetchImpl
        : (url, opts) => globalThis.fetch(url, opts);
    this._fallback = new MockProvider();
  }

  async generate(req = {}) {
    const { lang = 'fr', userText = '', clinic, context = {} } = req;
    const langName = LANG_NAME[lang] || 'French';
    const arabicHint =
      lang === 'ar' ? ' Use warm, natural Arabic as spoken in Tunisia/Libya (not stiff MSA).' : '';
    const system =
      `You are the multilingual WhatsApp concierge for the medical-tourism clinic ` +
      `"${clinic?.name || 'the clinic'}" in Tunisia. Reply ONLY in ${langName}, ` +
      `warm and concise (max ~60 words), WhatsApp style.${arabicHint} ` +
      `Never invent prices, availability, or medical advice — for those, say a human ` +
      `coordinator will follow up. Offer to book an appointment when relevant.` +
      (context.answer
        ? ` Ground your reply on this clinic knowledge-base answer and do not contradict it: "${context.answer}"`
        : '');

    const generationConfig = { maxOutputTokens: 1024, temperature: 0.4 };
    // A receptionist must answer in ~3s: disable thinking where the API allows
    // a zero budget (2.5 flash family only — other models reject the field).
    if (/^gemini-2\.5-flash/.test(this.model)) {
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await this._fetch(
        `${API_BASE}/models/${encodeURIComponent(this.model)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'x-goog-api-key': this.apiKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: userText || '...' }] }],
            generationConfig,
          }),
          signal: controller.signal,
        }
      );
      if (!res.ok) throw new Error(`gemini http ${res.status}`);
      const json = await res.json();
      const parts = json?.candidates?.[0]?.content?.parts || [];
      const text = parts
        .map((p) => p.text || '')
        .join('')
        .trim();
      if (!text) throw new Error('gemini empty response'); // incl. safety blocks
      return { text, provider: this.name };
    } catch (err) {
      // Graceful degradation — never break the flow.
      const out = await this._fallback.generate(req);
      return { ...out, provider: `${this.name}:fallback`, error: err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Structured-output call for the LLM-led dialogue (P2-HUMANIZE): the model is
   * forced onto a JSON responseSchema and the parsed object is returned.
   *
   * DELIBERATELY THROWS on any failure (HTTP error, timeout, safety block,
   * unparseable JSON) instead of degrading to mock text: the caller must fall
   * back to the CLASSIC deterministic engine, never to decorative prose that
   * would bypass the executor.
   *
   * @param {object} req
   * @param {string} req.system              system instruction
   * @param {Array<{role:'user'|'model', text:string}>} req.messages  turn history, oldest first
   * @param {object} req.schema              Gemini responseSchema (OpenAPI subset)
   * @param {number} [req.temperature]
   * @returns {Promise<object>} the parsed JSON object
   */
  async generateStructured(req = {}) {
    const { system = '', messages = [], schema, temperature = 0.4 } = req;
    if (!schema) throw new Error('generateStructured: schema is required');

    const generationConfig = {
      maxOutputTokens: 1024,
      temperature,
      responseMimeType: 'application/json',
      responseSchema: schema,
    };
    // Same latency rule as generate(): a receptionist answers in ~3s, and only
    // the 2.5-flash family accepts a zero thinking budget.
    if (/^gemini-2\.5-flash/.test(this.model)) {
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    const contents = messages
      .filter((m) => m && m.text)
      .map((m) => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: m.text }] }));
    if (!contents.length) contents.push({ role: 'user', parts: [{ text: '...' }] });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await this._fetch(
        `${API_BASE}/models/${encodeURIComponent(this.model)}:generateContent`,
        {
          method: 'POST',
          headers: {
            // Key travels ONLY in the header, never the URL (logs/proxies).
            'x-goog-api-key': this.apiKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: system }] },
            contents,
            generationConfig,
          }),
          signal: controller.signal,
        }
      );
      if (!res.ok) throw new Error(`gemini http ${res.status}`);
      const json = await res.json();
      const parts = json?.candidates?.[0]?.content?.parts || [];
      const text = parts.map((p) => p.text || '').join('').trim();
      if (!text) throw new Error('gemini empty structured response'); // incl. safety blocks
      return JSON.parse(text); // throws on malformed JSON — caller falls back
    } finally {
      clearTimeout(timer);
    }
  }
}
