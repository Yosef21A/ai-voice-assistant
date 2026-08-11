// Deterministic, rule-based provider. This is the DEFAULT and requires no key
// and no network. It returns fixed, localized phrasings so the whole system is
// reproducible in tests and demos.
export class MockProvider {
  constructor() {
    this.name = 'mock';
  }

  /**
   * @param {object} req
   * @param {'ar'|'fr'|'en'} [req.lang]
   * @param {string} [req.task]
   * @param {object} [req.context]
   * @returns {Promise<{text:string, provider:string}>}
   */
  async generate({ lang = 'fr', task = 'fallback', context = {} } = {}) {
    // If a knowledge-base answer was supplied, just pass it through in-voice.
    if (task === 'faq_answer' && context.answer) {
      return { text: context.answer, provider: this.name };
    }

    const fallback = {
      ar: 'ما فهمتش قصدك بالضبط 🙏. ننجم نعاونك في: حجز موعد، الأسعار، السفر والإقامة، أو أي سؤال عام. اكتب "موظف" باش تحكي مع إنسان.',
      fr: "Je n'ai pas bien saisi 🙏. Je peux vous aider pour : prendre un rendez-vous, les tarifs, le voyage/hébergement, ou toute question. Écrivez « conseiller » pour parler à une personne.",
      en: 'I didn\'t quite catch that 🙏. I can help with: booking an appointment, pricing, travel/accommodation, or any question. Type "agent" to reach a human.',
    };

    return { text: fallback[lang] || fallback.fr, provider: this.name };
  }
}
