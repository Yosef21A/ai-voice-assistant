// Localized response templates (AR / FR / EN). Each key maps to a function that
// interpolates a small vars object, so copy stays in one place and the engine
// stays logic-only. Falls back FR -> EN when a language is missing.
const DICT = {
  greeting: {
    ar: (v) =>
      `👋 أهلاً بيك في ${v.clinic}. أنا المساعد الآلي متاع العيادة.\nننجم نعاونك في:\n• 📅 حجز موعد\n• 💶 الأسعار\n• ✈️ السفر والإقامة\n• ❓ أسئلة عامة\nإذا تحب تحكي مع موظف اكتب «موظف».`,
    fr: (v) =>
      `👋 Bienvenue à ${v.clinic}. Je suis l'assistant virtuel de la clinique.\nJe peux vous aider pour :\n• 📅 Prendre un rendez-vous\n• 💶 Les tarifs\n• ✈️ Le voyage et l'hébergement\n• ❓ Vos questions\nPour parler à un conseiller, écrivez « conseiller ».`,
    en: (v) =>
      `👋 Welcome to ${v.clinic}. I'm the clinic's virtual assistant.\nI can help you with:\n• 📅 Booking an appointment\n• 💶 Pricing\n• ✈️ Travel & accommodation\n• ❓ Your questions\nTo reach a human, type "agent".`,
  },

  bookingIntro: {
    ar: () => `📅 بالباهي، نبداو حجز الموعد. باش نسقسيك على شوية معلومات.`,
    fr: () => `📅 Très bien, commençons la prise de rendez-vous. Quelques informations à réunir.`,
    en: () => `📅 Great, let's book your appointment. I'll ask you a few details.`,
  },

  askSpecialty: {
    ar: (v) => `1️⃣ أي اختصاص تحب؟\nالمتوفر: ${v.list}`,
    fr: (v) => `1️⃣ Quelle spécialité souhaitez-vous ?\nDisponibles : ${v.list}`,
    en: (v) => `1️⃣ Which specialty do you need?\nAvailable: ${v.list}`,
  },
  specialtyUnknown: {
    ar: (v) => `ما فهمتش الاختصاص. اختار من هاذي: ${v.list}`,
    fr: (v) => `Je n'ai pas reconnu la spécialité. Choisissez parmi : ${v.list}`,
    en: (v) => `I didn't recognize that specialty. Please choose from: ${v.list}`,
  },

  askDatetime: {
    ar: () => `2️⃣ أي نهار وأي ساعة تناسبك؟ (مثال: نهار الاثنين الساعة 10 صباحاً)`,
    fr: () => `2️⃣ Quel jour et quelle heure vous conviennent ? (ex. : vendredi à 11h)`,
    en: () => `2️⃣ What day and time suit you? (e.g. Monday at 10am)`,
  },
  datetimeUnknown: {
    ar: () => `ما فهمتش الوقت. اكتبلي نهار وساعة، مثال: «نهار الأربعاء 11:00».`,
    fr: () => `Je n'ai pas compris la date. Indiquez un jour et une heure, ex. : « mercredi 11:00 ».`,
    en: () => `I couldn't read the time. Please give a day and time, e.g. "Wednesday 11:00".`,
  },
  datetimeAdjusted: {
    ar: (v) => `⚠️ الوقت اللي طلبتو ما هوش متوفر. أقرب موعد متاح: ${v.when}. باش نأكدوه في الآخر.`,
    fr: (v) => `⚠️ Le créneau demandé n'est pas disponible. Le plus proche : ${v.when}. Nous le confirmerons à la fin.`,
    en: (v) => `⚠️ That exact time isn't available. The nearest slot is ${v.when}. We'll confirm it at the end.`,
  },

  askName: {
    ar: () => `3️⃣ شنوة اسمك الكامل من فضلك؟`,
    fr: () => `3️⃣ Quel est votre nom complet, s'il vous plaît ?`,
    en: () => `3️⃣ What is your full name, please?`,
  },

  askOrigin: {
    ar: () => `4️⃣ من أي مدينة وبلد جاي؟ (مثال: طرابلس، ليبيا)`,
    fr: () => `4️⃣ De quelle ville et pays venez-vous ? (ex. : Benghazi, Libye)`,
    en: () => `4️⃣ Which city and country are you travelling from? (e.g. Tripoli, Libya)`,
  },

  askContact: {
    ar: () => `5️⃣ أعطيني رقم هاتف للتواصل (واتساب أو مكالمة).`,
    fr: () => `5️⃣ Un numéro de téléphone pour vous joindre (WhatsApp ou appel) ?`,
    en: () => `5️⃣ A phone number we can reach you on (WhatsApp or call)?`,
  },
  contactUnknown: {
    ar: () => `ما لقيتش رقم صحيح. اكتب الرقم مع رمز البلد، مثال: +21891234567.`,
    fr: () => `Numéro non valide. Indiquez-le avec l'indicatif, ex. : +21891234567.`,
    en: () => `That number looks invalid. Please include the country code, e.g. +21891234567.`,
  },

  adjustedInRecap: {
    ar: (v) => `⚠️ ملاحظة: الوقت اللي طلبتو ما كانش متاح، حطّينالك أقرب موعد: ${v.when}. إذا ما يمشيش، قلّي «لا» ونلقاولك وقت آخر.`,
    fr: (v) => `⚠️ Note : l'horaire demandé n'était pas disponible, nous avons retenu le plus proche : ${v.when}. S'il ne convient pas, répondez « non » et on cherche un autre créneau.`,
    en: (v) => `⚠️ Note: the time you asked for wasn't available, so we set the nearest slot: ${v.when}. If it doesn't suit you, reply "no" and we'll find another.`,
  },

  confirmSummary: {
    ar: (v) =>
      `📝 نراجعو الحجز:\n• الاختصاص: ${v.specialty}\n• الموعد: ${v.when}\n• الاسم: ${v.name}\n• المدينة: ${v.origin}\n• الهاتف: ${v.contact}\n\nنأكدو؟ اكتب «نعم» للتأكيد أو «لا» للإلغاء.`,
    fr: (v) =>
      `📝 Récapitulatif :\n• Spécialité : ${v.specialty}\n• Rendez-vous : ${v.when}\n• Nom : ${v.name}\n• Ville : ${v.origin}\n• Téléphone : ${v.contact}\n\nJe confirme ? Écrivez « oui » pour valider ou « non » pour annuler.`,
    en: (v) =>
      `📝 Let's confirm:\n• Specialty: ${v.specialty}\n• Appointment: ${v.when}\n• Name: ${v.name}\n• City: ${v.origin}\n• Phone: ${v.contact}\n\nConfirm? Type "yes" to book or "no" to cancel.`,
  },
  confirmRetry: {
    ar: () => `جاوبني بـ «نعم» للتأكيد أو «لا» للإلغاء من فضلك.`,
    fr: () => `Merci de répondre par « oui » (valider) ou « non » (annuler).`,
    en: () => `Please answer "yes" to confirm or "no" to cancel.`,
  },

  booked: {
    ar: (v) =>
      `✅ تأكد الحجز! رقم الحجز: *${v.ref}*\n\n🏥 ${v.clinic}\n• ${v.specialty}\n• 📅 ${v.when}\n• 👤 ${v.name} (${v.origin})\n• 📞 ${v.contact}\n\nفريق المرضى الدوليين باش يتواصل معاك لتفاصيل السفر والدعوة. للاستعجال: ${v.handoff}. شكراً وسلامتك! 🌿`,
    fr: (v) =>
      `✅ Rendez-vous confirmé ! Référence : *${v.ref}*\n\n🏥 ${v.clinic}\n• ${v.specialty}\n• 📅 ${v.when}\n• 👤 ${v.name} (${v.origin})\n• 📞 ${v.contact}\n\nNotre équipe patients internationaux vous contactera pour le voyage et la lettre d'invitation. Urgence : ${v.handoff}. Merci et bon rétablissement ! 🌿`,
    en: (v) =>
      `✅ Appointment confirmed! Reference: *${v.ref}*\n\n🏥 ${v.clinic}\n• ${v.specialty}\n• 📅 ${v.when}\n• 👤 ${v.name} (${v.origin})\n• 📞 ${v.contact}\n\nOur international-patients team will contact you about travel and the invitation letter. Urgent: ${v.handoff}. Thank you and get well soon! 🌿`,
  },

  cancelled: {
    ar: () => `تم إلغاء الحجز. إذا بديت تحب تحجز من جديد اكتب «موعد». 🙏`,
    fr: () => `Rendez-vous annulé. Pour recommencer, écrivez « rendez-vous ». 🙏`,
    en: () => `Booking cancelled. To start again, type "appointment". 🙏`,
  },
  nothingToCancel: {
    ar: () => `ما فماش حجز جاري باش نلغيوه. تحب نبداو حجز جديد؟ اكتب «موعد».`,
    fr: () => `Aucun rendez-vous en cours à annuler. Voulez-vous en prendre un ? Écrivez « rendez-vous ».`,
    en: () => `There's no booking in progress to cancel. Want to make one? Type "appointment".`,
  },

  handoff: {
    ar: (v) => `👩‍⚕️ باش نوصلك بفريق ${v.name}. تنجم تتواصل مباشرة على: ${v.phone}. الفريق باش يرد عليك في أقرب وقت.`,
    fr: (v) => `👩‍⚕️ Je vous mets en relation avec ${v.name}. Contact direct : ${v.phone}. L'équipe vous répondra au plus vite.`,
    en: (v) => `👩‍⚕️ I'm connecting you with ${v.name}. Direct line: ${v.phone}. The team will reply shortly.`,
  },

  pricingList: {
    ar: (v) => `💶 أسعار تقريبية في ${v.clinic} (الفاتورة النهائية بعد الفحص):\n${v.lines}\n\nتحب تحجز موعد؟ اكتب «موعد».`,
    fr: (v) => `💶 Tarifs indicatifs à ${v.clinic} (montant final après examen) :\n${v.lines}\n\nSouhaitez-vous prendre rendez-vous ? Écrivez « rendez-vous ».`,
    en: (v) => `💶 Indicative pricing at ${v.clinic} (final amount after assessment):\n${v.lines}\n\nWant to book? Type "appointment".`,
  },
  pricingOne: {
    ar: (v) => `💶 ${v.specialty} في ${v.clinic}: الاستشارة حوالي ${v.consult}€، والتقدير الإجمالي بين ${v.low}€ و${v.high}€ (يتحدد بعد الفحص). تحب تحجز؟ اكتب «موعد».`,
    fr: (v) => `💶 ${v.specialty} à ${v.clinic} : consultation ~${v.consult}€, estimation globale ${v.low}€–${v.high}€ (fixée après examen). Réserver ? Écrivez « rendez-vous ».`,
    en: (v) => `💶 ${v.specialty} at ${v.clinic}: consultation ~€${v.consult}, overall estimate €${v.low}–€${v.high} (set after assessment). Book? Type "appointment".`,
  },

  travel: {
    ar: (v) =>
      `✈️ السفر والإقامة مع ${v.clinic}:\n• المطارات: ${v.airports}\n• النقل: ${v.transfer}\n• الإقامة: ${v.accommodation}\n• المرافق: ${v.companion}\n• التأشيرة: ${v.visa}\n\nتحب تحجز موعد؟ اكتب «موعد».`,
    fr: (v) =>
      `✈️ Voyage & hébergement avec ${v.clinic} :\n• Aéroports : ${v.airports}\n• Transfert : ${v.transfer}\n• Hébergement : ${v.accommodation}\n• Accompagnant : ${v.companion}\n• Visa : ${v.visa}\n\nRéserver un rendez-vous ? Écrivez « rendez-vous ».`,
    en: (v) =>
      `✈️ Travel & accommodation with ${v.clinic}:\n• Airports: ${v.airports}\n• Transfer: ${v.transfer}\n• Accommodation: ${v.accommodation}\n• Companion: ${v.companion}\n• Visa: ${v.visa}\n\nWant to book an appointment? Type "appointment".`,
  },

  faqFallback: {
    ar: () => `سؤال مهم! ما عنديش إجابة جاهزة عليه، أما نجم نوصلك بموظف. اكتب «موظف» أو اسألني على المواعيد، الأسعار، أو السفر.`,
    fr: () => `Bonne question ! Je n'ai pas de réponse toute prête, mais un conseiller peut vous aider. Écrivez « conseiller », ou demandez-moi rendez-vous, tarifs ou voyage.`,
    en: () => `Good question! I don't have a ready answer, but a human can help. Type "agent", or ask me about appointments, pricing, or travel.`,
  },
};

/**
 * @param {'ar'|'fr'|'en'} lang
 * @param {string} key
 * @param {object} [vars]
 */
export function t(lang, key, vars = {}) {
  const group = DICT[key];
  if (!group) return '';
  const fn = group[lang] || group.fr || group.en;
  return fn ? fn(vars) : '';
}

export { DICT };
