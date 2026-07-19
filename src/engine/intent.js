// Rule-based intent detection across AR / FR / EN. Keywords are checked in a
// fixed priority order so that specific intents (handoff, cancel, pricing,
// booking) win over generic ones (faq, greeting).
const KEYWORDS = {
  human_handoff: {
    ar: ['موظف', 'انسان', 'إنسان', 'بشري', 'مسؤول', 'سكرتير', 'اتصلوا بيا', 'نحكي مع', 'مع شخص', 'مع واحد'],
    fr: ['humain', 'conseiller', 'agent', 'secretaire', 'secrétaire', 'une personne', 'quelquun', "quelqu'un", 'appelez', 'rappeler', 'operateur'],
    en: ['human', 'agent', 'representative', 'real person', 'someone', 'staff', 'call me', 'operator'],
  },
  cancel: {
    ar: ['الغاء', 'إلغاء', 'ألغي', 'الغي', 'نلغي', 'نلغيو', 'بطل', 'نبطل', 'ما نحبش', 'سامحني'],
    fr: ['annuler', 'annulation', 'arreter', 'arrêter', 'laisse tomber', 'oublie'],
    en: ['cancel', 'stop', 'abort', 'nevermind', 'never mind', 'forget it'],
  },
  pricing_quote: {
    ar: ['سعر', 'ثمن', 'بقداش', 'قداش', 'كم يكلف', 'تكلفة', 'أسعار', 'اسعار', 'كم سعر', 'التكلفة'],
    fr: ['prix', 'tarif', 'tarifs', 'cout', 'coût', 'combien', 'devis', 'estimation'],
    en: ['price', 'cost', 'quote', 'how much', 'pricing', 'estimate', 'estimation'],
  },
  book_appointment: {
    ar: ['حجز', 'نحجز', 'احجز', 'اححز', 'موعد', 'رنديفو', 'نحب نحجز', 'نأخذ موعد', 'ناخذ موعد'],
    fr: ['rendez-vous', 'rendez vous', 'rdv', 'prendre rendez', 'reserver', 'réserver', 'reservation'],
    en: ['appointment', 'book', 'booking', 'schedule', 'reserve', 'reservation'],
  },
  travel_help: {
    ar: ['سفر', 'طيران', 'طيارة', 'فندق', 'إقامة', 'اقامة', 'تأشيرة', 'فيزا', 'مطار', 'نقل', 'مبيت'],
    fr: ['voyage', 'vol', 'hotel', 'hôtel', 'hebergement', 'hébergement', 'transfert', 'aeroport', 'aéroport', 'sejour', 'séjour', 'visa'],
    en: ['travel', 'flight', 'hotel', 'accommodation', 'transfer', 'airport', 'stay', 'lodging', 'visa'],
  },
  faq: {
    ar: ['سؤال', 'وين', 'فين', 'عنوان', 'ساعات العمل', 'وقت العمل', 'الدفع', 'خلاص', 'لغة', 'كيفاش', 'واش'],
    fr: ['horaires', 'adresse', 'paiement', 'payer', 'langue', 'question', 'est-ce que', 'est ce que', 'ou etes', 'où êtes'],
    en: ['hours', 'address', 'location', 'payment', 'language', 'question', 'do you', 'where are', 'what time'],
  },
  greeting: {
    ar: ['سلام', 'السلام', 'صباح الخير', 'مساء الخير', 'اهلا', 'أهلا', 'مرحبا', 'يعطيك الصحة'],
    fr: ['bonjour', 'salut', 'bonsoir', 'coucou', 'cc'],
    en: ['hello', 'hi', 'hey', 'good morning', 'good evening', 'good afternoon'],
  },
};

const ORDER = [
  'human_handoff',
  'cancel',
  'pricing_quote',
  'book_appointment',
  'travel_help',
  'faq',
  'greeting',
];

/**
 * @param {string} text
 * @returns {{intent:string, keyword?:string}}
 */
export function detectIntent(text = '') {
  const t = ' ' + String(text).toLowerCase().replace(/[.,!؟?\n\r]/g, ' ') + ' ';
  for (const intent of ORDER) {
    const groups = KEYWORDS[intent];
    for (const lang of ['ar', 'fr', 'en']) {
      for (const kw of groups[lang]) {
        if (t.includes(kw)) return { intent, keyword: kw };
      }
    }
  }
  return { intent: 'unknown' };
}

export { KEYWORDS, ORDER };
