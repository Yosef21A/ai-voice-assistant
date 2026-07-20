// LLM provider factory.
//
// Provider interface (duck-typed):
//   async generate({ lang, task, userText, clinic, context }) -> { text, provider }
//
//   lang     : 'ar' | 'fr' | 'en'
//   task     : 'fallback' | 'smalltalk' | 'faq_answer'  (free-form phrasing only)
//   userText : the raw patient message
//   clinic   : the resolved tenant record
//   context  : optional extra data (e.g. a knowledge-base answer to rephrase)
//
// The deterministic booking engine NEVER depends on the provider — it is used
// only for free-form phrasing (fallbacks / smalltalk). This keeps the demo
// fully offline and reproducible.
import { MockProvider } from './mockProvider.js';
import { AnthropicProvider } from './anthropicProvider.js';
import { GeminiProvider } from './geminiProvider.js';

/**
 * Selection order: Gemini → Anthropic → deterministic MockProvider.
 * Gemini deliberately wins over Anthropic: dev machines may export a global
 * ANTHROPIC_API_KEY (e.g. an OpenRouter key with the wrong base URL) that must
 * not hijack the provider when GEMINI_API_KEY is configured for this app.
 */
export function getProvider(config = {}) {
  if (config.geminiApiKey) return new GeminiProvider(config);
  if (config.anthropicApiKey) return new AnthropicProvider(config);
  return new MockProvider();
}

export { MockProvider, AnthropicProvider, GeminiProvider };
