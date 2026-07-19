// Optional Anthropic provider. Activated only when ANTHROPIC_API_KEY is set.
// Uses the global fetch (Node 18+) — no SDK, no compiled dependency. Any error
// (network, quota, bad key) degrades gracefully back to the MockProvider so the
// conversation never breaks.
import { MockProvider } from './mockProvider.js';

const LANG_NAME = { ar: 'Arabic', fr: 'French', en: 'English' };

export class AnthropicProvider {
  constructor(config = {}) {
    this.name = 'anthropic';
    this.apiKey = config.anthropicApiKey;
    this.model = config.anthropicModel || 'claude-3-5-haiku-latest';
    this._fallback = new MockProvider();
  }

  async generate(req = {}) {
    const { lang = 'fr', userText = '', clinic } = req;
    const system =
      `You are the multilingual WhatsApp concierge for the medical-tourism clinic ` +
      `"${clinic?.name || 'the clinic'}" in Tunisia. Reply ONLY in ` +
      `${LANG_NAME[lang] || 'French'}, warm and concise (max ~60 words), WhatsApp style. ` +
      `Never invent prices, availability, or medical advice — for those, say a human ` +
      `coordinator will follow up. Offer to book an appointment when relevant.`;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 300,
          system,
          messages: [{ role: 'user', content: userText || '...' }],
        }),
      });
      if (!res.ok) throw new Error(`anthropic http ${res.status}`);
      const json = await res.json();
      const text = (json?.content || [])
        .map((c) => c.text || '')
        .join('')
        .trim();
      if (!text) throw new Error('anthropic empty response');
      return { text, provider: this.name };
    } catch (err) {
      // Graceful degradation — never break the flow.
      const out = await this._fallback.generate(req);
      return { ...out, provider: `${this.name}:fallback`, error: err.message };
    }
  }
}
