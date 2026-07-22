// Scripted structured-output provider for P2-HUMANIZE tests. Lives OUTSIDE
// test/ so the node:test glob never runs it.
//
// Usage:
//   const fake = new FakeStructuredProvider({ plans: [
//     { reply_text: '...', detected_lang: 'ar', actions: ['none'] },
//     (req) => ({ ... }),                       // computed from the request
//     new Error('boom'),                        // simulate an LLM failure
//   ]});
//   makeTestApp({ conversationMode: 'llm' }, { provider: fake });
//
// Each generateStructured() call shifts the next plan off the queue and records
// the request in .calls for assertions. An exhausted queue throws (the engine
// must fall back to classic — asserting on that IS the test).
export class FakeStructuredProvider {
  constructor({ plans = [], name = 'fake-structured' } = {}) {
    this.name = name;
    this.plans = [...plans];
    this.calls = [];
  }

  /** Classic-path decoration (faq_answer passthrough), mirroring MockProvider. */
  async generate(req = {}) {
    if (req.task === 'faq_answer' && req.context?.answer) {
      return { text: req.context.answer, provider: this.name };
    }
    return { text: 'fake fallback', provider: this.name };
  }

  async generateStructured(req = {}) {
    this.calls.push(req);
    if (!this.plans.length) throw new Error('fake-structured: plan queue exhausted');
    const next = this.plans.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(req);
    return next;
  }
}
