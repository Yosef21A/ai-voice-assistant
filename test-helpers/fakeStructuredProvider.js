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
  /**
   * @param {object}  [opts]
   * @param {Array}   [opts.plans]        queue for generateStructured()
   * @param {Array}   [opts.transcripts]  queue for transcribeAudio() — same
   *   convention (object | function(req) | Error). Supplying this array is what
   *   turns STT on for a test: MockProvider has no transcribeAudio at all, and
   *   that absence is exactly what keeps classic mode unchanged, so a fake must
   *   opt in explicitly rather than fabricate speech by default.
   */
  constructor({ plans = [], transcripts = null, name = 'fake-structured' } = {}) {
    this.name = name;
    this.plans = [...plans];
    this.calls = [];
    this.audioCalls = [];
    if (transcripts) {
      this.transcripts = [...transcripts];
      this.transcribeAudio = async (req = {}) => {
        this.audioCalls.push(req);
        if (!this.transcripts.length) throw new Error('fake-structured: transcript queue exhausted');
        const next = this.transcripts.shift();
        if (next instanceof Error) throw next;
        return typeof next === 'function' ? next(req) : next;
      };
    }
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
