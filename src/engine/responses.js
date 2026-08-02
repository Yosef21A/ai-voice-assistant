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

  // Cabinet persona (D1): the bot is THE DOCTOR'S assistant, by name. No travel
  // bullet — a cabinet is a local practice, not a medical-tourism desk. The
  // handoff trigger words stay IDENTICAL to the clinic greeting so intent
  // detection keeps working («موظف» / « conseiller » / "agent").
  greetingCabinet: {
    ar: (v) =>
      `👋 أهلاً بيك في ${v.cabinet}. أنا مساعد الدكتور ${v.doctor} الآلي.\nننجم نعاونك في:\n• 📅 حجز موعد مع الدكتور\n• 💶 الأسعار\n• ❓ أسئلة عامة\nإذا تحب تحكي مع موظف اكتب «موظف».`,
    fr: (v) =>
      `👋 Bienvenue au ${v.cabinet}. Je suis l'assistant virtuel du Dr ${v.doctor}.\nJe peux vous aider pour :\n• 📅 Prendre rendez-vous avec le Dr ${v.doctor}\n• 💶 Les tarifs\n• ❓ Vos questions\nPour parler à un conseiller, écrivez « conseiller ».`,
    en: (v) =>
      `👋 Welcome to ${v.cabinet}. I'm Dr ${v.doctor}'s virtual assistant.\nI can help you with:\n• 📅 Booking an appointment with Dr ${v.doctor}\n• 💶 Pricing\n• ❓ Your questions\nTo reach a human, type "agent".`,
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

  // v.doctor is OPTIONAL (cabinet persona, D1): when present the recap names the
  // doctor; when absent the rendered text is byte-identical to pre-D1 output.
  confirmSummary: {
    ar: (v) =>
      `📝 نراجعو الحجز:${v.doctor ? `\n• الطبيب: الدكتور ${v.doctor}` : ''}\n• الاختصاص: ${v.specialty}\n• الموعد: ${v.when}\n• الاسم: ${v.name}\n• المدينة: ${v.origin}\n• الهاتف: ${v.contact}\n\nنأكدو؟ اكتب «نعم» للتأكيد أو «لا» للإلغاء.`,
    fr: (v) =>
      `📝 Récapitulatif :${v.doctor ? `\n• Médecin : Dr ${v.doctor}` : ''}\n• Spécialité : ${v.specialty}\n• Rendez-vous : ${v.when}\n• Nom : ${v.name}\n• Ville : ${v.origin}\n• Téléphone : ${v.contact}\n\nJe confirme ? Écrivez « oui » pour valider ou « non » pour annuler.`,
    en: (v) =>
      `📝 Let's confirm:${v.doctor ? `\n• Doctor: Dr ${v.doctor}` : ''}\n• Specialty: ${v.specialty}\n• Appointment: ${v.when}\n• Name: ${v.name}\n• City: ${v.origin}\n• Phone: ${v.contact}\n\nConfirm? Type "yes" to book or "no" to cancel.`,
  },
  confirmRetry: {
    ar: () => `جاوبني بـ «نعم» للتأكيد أو «لا» للإلغاء من فضلك.`,
    fr: () => `Merci de répondre par « oui » (valider) ou « non » (annuler).`,
    en: () => `Please answer "yes" to confirm or "no" to cancel.`,
  },

  // ── voice notes (V1) ──────────────────────────────────────────────────────
  // Every patient-facing voice line is a TEMPLATE, rendered by the executor from
  // its own re-derived values. No LLM prose ever states back a captured fact —
  // the same discipline that makes the booking recap trustworthy.

  // Transcription failed or was ungradeable. Never silent, never pretending.
  voiceUnclear: {
    ar: () => `سمعت الرسالة أما ما فهمتش مليح 🙏 تنجم تعاودها ولا تكتبلي؟`,
    fr: () =>
      `J'ai bien reçu votre vocal, mais je n'ai pas bien compris 🙏 Pouvez-vous le refaire ou m'écrire ?`,
    en: () => `I got your voice note but couldn't make it out 🙏 Could you resend it or type it?`,
  },
  // The transcript is doubtful — read the WHOLE thing back before acting on it.
  voiceConfirmTranscript: {
    ar: (v) => `سمعتك تقول: «${v.transcript}» — صحيح ولا تعاودها؟`,
    fr: (v) => `J'ai entendu : « ${v.transcript} » — c'est bien ça ?`,
    en: (v) => `I heard: "${v.transcript}" — is that right?`,
  },
  // Over the byte cap: honest, and a human is pinged. The bot stays available.
  voiceTooLong: {
    ar: () =>
      `وصلتني الرسالة الصوتية 🎙️ طويلة شوية — واحد من الفريق باش يسمعها ويردّ عليك هنا. تنجم في نفس الوقت تكتبلي.`,
    fr: () =>
      `J'ai bien reçu votre vocal 🎙️ il est un peu long — un membre de l'équipe va l'écouter et vous répondre ici. Vous pouvez aussi m'écrire en attendant.`,
    en: () =>
      `Got your voice note 🎙️ it's a bit long — someone from the team will listen and reply here. You can also type it to me meanwhile.`,
  },
  // A phone number heard in speech is read back, never committed silently.
  voiceContactHeard: {
    ar: (v) => `سمعت الرقم: ${v.digits} — صحيح؟ 🙌`,
    fr: (v) => `J'ai noté le numéro : ${v.digits} — c'est correct ?`,
    en: (v) => `I heard the number: ${v.digits} — is that correct?`,
  },

  booked: {
    ar: (v) =>
      `✅ تأكد الحجز! رقم الحجز: *${v.ref}*\n\n🏥 ${v.clinic}\n• ${v.specialty}\n• 📅 ${v.when}\n• 👤 ${v.name} (${v.origin})\n• 📞 ${v.contact}\n\nفريق المرضى الدوليين باش يتواصل معاك لتفاصيل السفر والدعوة. للاستعجال: ${v.handoff}. شكراً وسلامتك! 🌿`,
    fr: (v) =>
      `✅ Rendez-vous confirmé ! Référence : *${v.ref}*\n\n🏥 ${v.clinic}\n• ${v.specialty}\n• 📅 ${v.when}\n• 👤 ${v.name} (${v.origin})\n• 📞 ${v.contact}\n\nNotre équipe patients internationaux vous contactera pour le voyage et la lettre d'invitation. Urgence : ${v.handoff}. Merci et bon rétablissement ! 🌿`,
    en: (v) =>
      `✅ Appointment confirmed! Reference: *${v.ref}*\n\n🏥 ${v.clinic}\n• ${v.specialty}\n• 📅 ${v.when}\n• 👤 ${v.name} (${v.origin})\n• 📞 ${v.contact}\n\nOur international-patients team will contact you about travel and the invitation letter. Urgent: ${v.handoff}. Thank you and get well soon! 🌿`,
  },

  // Cabinet confirmation (D1): names the doctor and closes like a local
  // practice (the secretariat follows up) — never the international-patients /
  // invitation-letter closing, which would be nonsense for a cabinet.
  bookedCabinet: {
    ar: (v) =>
      `✅ تأكد الموعد مع الدكتور ${v.doctor}! رقم الحجز: *${v.ref}*\n\n🩺 ${v.clinic}\n• 📅 ${v.when}\n• 👤 ${v.name}\n• 📞 ${v.contact}\n\nإذا لزم أي تبديل، الكاتبة باش تتواصل معاك. للاستعجال: ${v.handoff}. سلامتك! 🌿`,
    fr: (v) =>
      `✅ Rendez-vous confirmé avec le Dr ${v.doctor} ! Référence : *${v.ref}*\n\n🩺 ${v.clinic}\n• 📅 ${v.when}\n• 👤 ${v.name}\n• 📞 ${v.contact}\n\nLe secrétariat vous contactera si besoin. Urgence : ${v.handoff}. Bon rétablissement ! 🌿`,
    en: (v) =>
      `✅ Appointment confirmed with Dr ${v.doctor}! Reference: *${v.ref}*\n\n🩺 ${v.clinic}\n• 📅 ${v.when}\n• 👤 ${v.name}\n• 📞 ${v.contact}\n\nThe office will contact you if anything changes. Urgent: ${v.handoff}. Get well soon! 🌿`,
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

  // ── smart follow-ups (V4) — ONE gentle nudge, never a campaign ───────────
  // v.doctor optional (cabinet persona); v.procedure optional.
  nudgeLead: {
    ar: (v) =>
      `🙌 نحب نطمن عليك${v.procedure ? ` بخصوص ${v.procedure}` : ''} — تحب نحجزولك${v.doctor ? ` مع الدكتور ${v.doctor}` : ''} ولا عندك سؤال؟ نحن هنا 🤍`,
    fr: (v) =>
      `🙌 On pense à vous${v.procedure ? ` au sujet de ${v.procedure}` : ''} — on vous réserve un rendez-vous${v.doctor ? ` avec le Dr ${v.doctor}` : ''}, ou vous avez une question ? On est là 🤍`,
    en: (v) =>
      `🙌 Just checking in${v.procedure ? ` about ${v.procedure}` : ''} — shall we book you in${v.doctor ? ` with Dr ${v.doctor}` : ''}, or do you have a question? We're here 🤍`,
  },
  nudgeLeadFacilitator: {
    ar: (v) => `🤝 ${v.agency} في الخدمة${v.procedure ? ` — بخصوص ${v.procedure}` : ''}: ملفك عندنا وموجودين نكملو في أي وقت. تحب نكملو؟`,
    fr: (v) => `🤝 ${v.agency} à votre service${v.procedure ? ` — au sujet de ${v.procedure}` : ''} : votre dossier est chez nous, on peut continuer quand vous voulez. On reprend ?`,
    en: (v) => `🤝 ${v.agency} at your service${v.procedure ? ` — about ${v.procedure}` : ''}: your file is with us and we can continue any time. Shall we?`,
  },
  nudgeResume: {
    ar: (v) => `👋 كنا في نص الحجز${v.doctor ? ` مع الدكتور ${v.doctor}` : ''} — كل شيء محفوظ، نكملو؟`,
    fr: (v) => `👋 On était en pleine réservation${v.doctor ? ` avec le Dr ${v.doctor}` : ''} — tout est gardé, on continue ?`,
    en: (v) => `👋 We were mid-booking${v.doctor ? ` with Dr ${v.doctor}` : ''} — everything's saved, shall we continue?`,
  },
  nudgeResumeFacilitator: {
    ar: () => `👋 كنا ناخذو في تفاصيل ملفك — كل شيء محفوظ، نكملو؟`,
    fr: () => `👋 On prenait les détails de votre dossier — tout est gardé, on continue ?`,
    en: () => `👋 We were taking your file details — everything's saved, shall we continue?`,
  },
  nudgePostVisit: {
    ar: (v) => `🌿 نتمناو تكون بخير${v.name ? ` سي ${v.name}` : ''} بعد زيارتك${v.doctor ? ` للدكتور ${v.doctor}` : ''}. إذا عندك أي سؤال بعد الزيارة نحن هنا — وإذا الخدمة عجبتك، كلمة منك تفرحنا 🙏`,
    fr: (v) => `🌿 On espère que vous allez bien${v.name ? `, ${v.name},` : ''} après votre visite${v.doctor ? ` chez le Dr ${v.doctor}` : ''}. Une question post-visite ? On est là — et si tout s'est bien passé, un petit avis nous ferait plaisir 🙏`,
    en: (v) => `🌿 We hope you're feeling well${v.name ? `, ${v.name},` : ''} after your visit${v.doctor ? ` with Dr ${v.doctor}` : ''}. Any post-visit questions? We're here — and if you were happy, a quick review would mean a lot 🙏`,
  },
  nudgeOptOutAck: {
    ar: () => `ماشي مشكل 🙏 ما نعاودوش نزعجوك. نبقاو هنا وقت ما تحتاجنا.`,
    fr: () => `Pas de souci 🙏 On ne vous relancera plus. On reste là quand vous aurez besoin.`,
    en: () => `No problem 🙏 We won't nudge you again. We're here whenever you need us.`,
  },

  // ── facilitator mode (D2) — agency concierge qualification ───────────────
  // An agency books nothing locally; it QUALIFIES and promises a same-day
  // offer. The promise line is the product's spec wording.
  greetingFacilitator: {
    ar: (v) =>
      `👋 أهلاً بيك في ${v.agency}. أنا المساعد الآلي متاع الوكالة.\nنرافقوك من أول سؤال حتى للعلاج في تونس:\n• 🏥 نلقاولك أحسن عيادة\n• 💶 نجيبولك عروض أسعار\n• ✈️ نرتبولك السفر والإقامة\nإذا تحب تحكي مع موظف اكتب «موظف».`,
    fr: (v) =>
      `👋 Bienvenue chez ${v.agency}. Je suis l'assistant virtuel de l'agence.\nOn vous accompagne jusqu'aux soins en Tunisie :\n• 🏥 On vous trouve la meilleure clinique\n• 💶 On vous ramène des devis\n• ✈️ On organise voyage et séjour\nPour parler à un conseiller, écrivez « conseiller ».`,
    en: (v) =>
      `👋 Welcome to ${v.agency}. I'm the agency's virtual assistant.\nWe guide you all the way to treatment in Tunisia:\n• 🏥 We find you the best clinic\n• 💶 We bring you quotes\n• ✈️ We arrange travel & stay\nTo reach a human, type "agent".`,
  },
  qualifyIntro: {
    ar: () => `🤝 باهي، خلينا ناخذو التفاصيل باش نلقاولك أحسن عيادة ونرجعولك بعرض اليوم إن شاء الله.`,
    fr: () => `🤝 Parfait, prenons quelques détails — on vous trouve la meilleure clinique et on revient avec une offre aujourd'hui.`,
    en: () => `🤝 Great — a few details and we'll find you the best clinic and come back with an offer today.`,
  },
  qualifyAskProcedure: {
    ar: () => `🩺 شنية العملية ولا العلاج اللي تحب عليه؟ (تجميل، أسنان، عظام، قلب…)`,
    fr: () => `🩺 Quelle intervention ou quel traitement recherchez-vous ? (esthétique, dentaire, orthopédie…)`,
    en: () => `🩺 What procedure or treatment are you looking for? (cosmetic, dental, orthopedic…)`,
  },
  qualifyAskOrigin: {
    ar: () => `📍 من أي مدينة وبلاد جاي؟ (مثال: طرابلس، ليبيا)`,
    fr: () => `📍 De quelle ville et quel pays venez-vous ? (ex. : Tripoli, Libye)`,
    en: () => `📍 Which city and country are you travelling from? (e.g. Tripoli, Libya)`,
  },
  qualifyAskWindow: {
    ar: () => `📅 وقتاش تحب تسافر تقريباً؟ (الأسبوع الجاي، الشهر الجاي، الصيف…)`,
    fr: () => `📅 Quand souhaitez-vous voyager, à peu près ? (la semaine prochaine, le mois prochain…)`,
    en: () => `📅 Roughly when would you like to travel? (next week, next month, this summer…)`,
  },
  qualifyAskContact: {
    ar: () => `📞 أعطيني رقم للتواصل، وإذا عندك تقرير طبي ولا صورة أشعة ابعثهملنا هنا 📎`,
    fr: () => `📞 Un numéro pour vous joindre ? Et si vous avez un rapport médical ou une radio, envoyez-les ici 📎`,
    en: () => `📞 A number to reach you on? And if you have a medical report or X-ray, send them here 📎`,
  },
  qualifyDone: {
    ar: (v) => `يعطيك الصحة 🙏 ${v.agency} توّا تتحرك: نلقاولك أحسن عيادة ونرجعولك بعرض اليوم إن شاء الله. تنجم تبعتلنا تقرير طبي ولا أشعة في أي وقت 📎`,
    fr: (v) => `Merci 🙏 ${v.agency} s'en occupe : on vous trouve la meilleure clinique et on revient avec une offre aujourd'hui. Vous pouvez envoyer rapport médical ou radios à tout moment 📎`,
    en: (v) => `Thank you 🙏 ${v.agency} is on it: we'll find you the best clinic and come back with an offer today. You can send a medical report or X-rays any time 📎`,
  },
  qualifyFollowup: {
    ar: () => `الفريق يخدم على ملفك 🙌 نرجعولك بالعرض في أقرب وقت. عندك سؤال آخر؟`,
    fr: () => `L'équipe travaille sur votre dossier 🙌 On revient très vite avec l'offre. Une autre question ?`,
    en: () => `The team is working on your file 🙌 We'll be back with the offer very soon. Anything else?`,
  },
  qualifyBudgetNote: {
    ar: () => `💶 الأسعار تتفاوت حسب العيادة والحالة — باش نجيبولك عروض مفصلة بأسعار «تبدأ من» من أحسن العيادات، والرقم النهائي بعد تقييم الملف الطبي.`,
    fr: () => `💶 Les prix varient selon la clinique et le dossier — on vous ramène des devis détaillés « à partir de » des meilleures cliniques ; le montant final vient après l'évaluation médicale.`,
    en: () => `💶 Prices vary by clinic and case — we'll bring you detailed "from" quotes from the best clinics; the final figure comes after the medical review.`,
  },

  // ── appointment reminders (V2 no-show killer) ────────────────────────────
  // Sent with interactive confirm/cancel/reschedule buttons; the bodies are
  // deterministic templates (never LLM prose). v.doctor is the optional cabinet
  // persona, same convention as confirmSummary.
  reminder48: {
    ar: (v) =>
      `📅 تذكير من ${v.clinic}: عندك موعد ${v.when}${v.doctor ? ` مع الدكتور ${v.doctor}` : ''}.\nرقم الحجز: *${v.ref}*.\nتنجم تأكد، تلغي، ولا تبدل الوقت 👇`,
    fr: (v) =>
      `📅 Rappel de ${v.clinic} : vous avez rendez-vous ${v.when}${v.doctor ? ` avec le Dr ${v.doctor}` : ''}.\nRéférence : *${v.ref}*.\nConfirmez, annulez ou changez l'horaire 👇`,
    en: (v) =>
      `📅 Reminder from ${v.clinic}: you have an appointment ${v.when}${v.doctor ? ` with Dr ${v.doctor}` : ''}.\nReference: *${v.ref}*.\nConfirm, cancel or reschedule 👇`,
  },
  reminder3: {
    ar: (v) =>
      `🕒 موعدك اليوم ${v.when}${v.doctor ? ` مع الدكتور ${v.doctor}` : ` في ${v.clinic}`}. جاي في الطريق؟ 🙌`,
    fr: (v) =>
      `🕒 Votre rendez-vous est aujourd'hui ${v.when}${v.doctor ? ` avec le Dr ${v.doctor}` : ` à ${v.clinic}`}. Vous êtes en route ? 🙌`,
    en: (v) =>
      `🕒 Your appointment is today ${v.when}${v.doctor ? ` with Dr ${v.doctor}` : ` at ${v.clinic}`}. On your way? 🙌`,
  },
  // Button titles (WhatsApp caps reply-button titles at 20 chars).
  btnReminderConfirm: {
    ar: () => `نأكد ✅`,
    fr: () => `Je confirme ✅`,
    en: () => `Confirm ✅`,
  },
  btnReminderCancel: {
    ar: () => `نلغي ❌`,
    fr: () => `Annuler ❌`,
    en: () => `Cancel ❌`,
  },
  btnReminderResched: {
    ar: () => `نبدل الوقت 🔄`,
    fr: () => `Changer l'heure 🔄`,
    en: () => `Reschedule 🔄`,
  },
  reminderConfirmedAck: {
    ar: (v) => `تمام، موعدك مأكد ✅ نستناوك ${v.when}. سلامتك!`,
    fr: (v) => `Parfait, votre rendez-vous est confirmé ✅ On vous attend ${v.when}. À bientôt !`,
    en: (v) => `Great, your appointment is confirmed ✅ See you ${v.when}!`,
  },
  reminderCancelledAck: {
    ar: () => `تم إلغاء الموعد ❌ إذا تحب وقت آخر اكتبلي «موعد» ونحجزولك من جديد. 🙏`,
    fr: () => `Rendez-vous annulé ❌ Pour un autre créneau, écrivez « rendez-vous » et on vous en trouve un. 🙏`,
    en: () => `Appointment cancelled ❌ Want another time? Type "appointment" and we'll rebook you. 🙏`,
  },
  reminderReschedAsk: {
    ar: () => `باهي، نبدلولك الوقت 🔄 أي نهار وأي ساعة يناسبوك؟`,
    fr: () => `D'accord, on change l'horaire 🔄 Quel jour et quelle heure vous conviennent ?`,
    en: () => `Sure, let's reschedule 🔄 What day and time suit you?`,
  },

  // ── WhatsApp calls (V1 voice tier) ────────────────────────────────────────
  // A patient CALLED the clinic's WhatsApp number. Three strings only, and none
  // of them says anything medical — V1 answers the phone, it does not consult.
  //
  // callClosed is the voicemail replacement: we reject a closed-hours call fast
  // (better than 45s of ringing), then say so IN WRITING on the same thread the
  // patient already has open, with the hours and an invitation to type instead.
  callClosed: {
    ar: (v) =>
      `📞 سامحنا، ${v.clinic} توّا مسكّرة وما نجّمناش نردّو على مكالمتك.${
        v.hours ? ` أوقات العمل: ${v.hours}.` : ''
      }\nاكتبلنا هنا شنوّة تحتاج ونجاوبوك أول ما نفتحو 🙏`,
    fr: (v) =>
      `📞 Désolé, ${v.clinic} est fermée et nous n'avons pas pu prendre votre appel.${
        v.hours ? ` Horaires : ${v.hours}.` : ''
      }\nÉcrivez-nous ici et nous vous répondons dès l'ouverture 🙏`,
    en: (v) =>
      `📞 Sorry, ${v.clinic} is closed and we couldn't take your call.${
        v.hours ? ` Opening hours: ${v.hours}.` : ''
      }\nWrite to us here and we'll reply as soon as we open 🙏`,
  },
  // Transcript lines (inbox + audit), never sent to the patient. v.duration is
  // pre-formatted "m:ss" so the templates stay pure string interpolation.
  callSummary: {
    ar: (v) => `📞 مكالمة واتساب — ${v.duration}`,
    fr: (v) => `📞 Appel WhatsApp — ${v.duration}`,
    en: (v) => `📞 WhatsApp call — ${v.duration}`,
  },
  callMissed: {
    ar: (v) =>
      `📞 مكالمة واتساب فايتة${
        v.reason === 'closed'
          ? ' — العيادة كانت مسكّرة'
          : v.reason === 'failed'
            ? ' — المكالمة ما كملتش'
            : ' — ما جاوبناش'
      }`,
    fr: (v) =>
      `📞 Appel WhatsApp manqué${
        v.reason === 'closed'
          ? ' — clinique fermée'
          : v.reason === 'failed'
            ? ' — échec de la connexion'
            : ' — sans réponse'
      }`,
    en: (v) =>
      `📞 Missed WhatsApp call${
        v.reason === 'closed'
          ? ' — clinic closed'
          : v.reason === 'failed'
            ? ' — connection failed'
            : ' — no answer'
      }`,
  },

  // ── WhatsApp calls (V2 — the talking brain) ───────────────────────────────
  // The agent now speaks, so three more strings exist. None of them is written
  // by the model: callRecap is rendered from DETERMINISTICALLY validated slots
  // and read aloud verbatim before anything is written to the database, which
  // is the whole point of the two-phase booking gate (src/voice-call/brain/
  // tools.js). If a value never reached the recap, it can never reach the
  // appointments table.
  callRecap: {
    ar: (v) =>
      `${v.doctor ? `موعد مع الدكتور ${v.doctor}` : `موعد ${v.specialty}`} نهار ${v.when}، باسم ${v.name}، ورقم التلفون ${v.contact}. صحيح؟`,
    fr: (v) =>
      `${v.doctor ? `Rendez-vous avec le Dr ${v.doctor}` : `Rendez-vous en ${v.specialty}`} le ${v.when}, au nom de ${v.name}, numéro ${v.contact}. C'est correct ?`,
    en: (v) =>
      `${v.doctor ? `Appointment with Dr ${v.doctor}` : `${v.specialty} appointment`} on ${v.when}, for ${v.name}, phone ${v.contact}. Is that correct?`,
  },
  // THE SPOKEN CONFIRMATION (V8). Said out loud the instant confirm_booking
  // returns a reference, by the ORCHESTRATOR rather than by the model — because
  // a reference the model paraphrases is a reference the caller cannot use, and
  // on a scored self-test run the model answered a word-perfect «نعم صحيح» with
  // «ثانية برك نأكدلك الحجز…» and never called the tool at all. The values here
  // come from the appointment that was just written, never from a generation.
  callConfirmed: {
    ar: (v) => `تم الحجز. رقم الحجز متاعك ${v.ref}، نهار ${v.when}. يعطيك الصحة.`,
    fr: (v) => `C'est confirmé. Votre référence est ${v.ref}, le ${v.when}. Merci à vous.`,
    en: (v) => `You're booked. Your reference is ${v.ref}, on ${v.when}. Thank you.`,
  },
  // Spoken twin of adjustedInRecap: same transparency rule (a silently shifted
  // time is a lie), but no emoji and no "reply «no»" — this is read out loud.
  callAdjusted: {
    ar: (v) => `الوقت اللي طلبتو ما كانش فاضي، أقرب موعد متاح هو ${v.when}.`,
    fr: (v) => `L'horaire demandé n'était pas libre ; le créneau le plus proche est ${v.when}.`,
    en: (v) => `The time you asked for wasn't free; the nearest slot is ${v.when}.`,
  },
  // Transcript lines for what a call ACTUALLY produced. The inbox row is the
  // only thing most staff will ever read about a call, so the outcome that
  // matters belongs in the first line, not buried in the payload.
  callBookedSummary: {
    ar: (v) => `📞 مكالمة واتساب — ${v.duration} · حجز ${v.ref} ✅`,
    fr: (v) => `📞 Appel WhatsApp — ${v.duration} · RDV ${v.ref} ✅`,
    en: (v) => `📞 WhatsApp call — ${v.duration} · booking ${v.ref} ✅`,
  },
  callEmergencySummary: {
    ar: (v) => `📞🚨 مكالمة واتساب — ${v.duration} · حالة طوارئ — تواصل مع المريض حالاً`,
    fr: (v) => `📞🚨 Appel WhatsApp — ${v.duration} · URGENCE — contactez le patient immédiatement`,
    en: (v) => `📞🚨 WhatsApp call — ${v.duration} · EMERGENCY — contact the patient now`,
  },
  callHandoffSummary: {
    ar: (v) => `📞👩‍⚕️ مكالمة واتساب — ${v.duration} · المريض طلب موظف`,
    fr: (v) => `📞👩‍⚕️ Appel WhatsApp — ${v.duration} · le patient demande un conseiller`,
    en: (v) => `📞👩‍⚕️ WhatsApp call — ${v.duration} · the patient asked for a human`,
  },
  // THE DEGRADE PATH, and the reason a brain outage is not a lost patient: the
  // call could not continue, so we say so in writing on the same thread and the
  // existing chat engine picks the conversation up from their next message.
  callBrainLost: {
    ar: () =>
      `📞 سامحنا، ما نجّمناش نكمّلو المكالمة. اكتبلنا هنا شنوّة تحتاج (موعد، أسعار، أي سؤال) ونكمّلو معاك من غادي طول 🙏`,
    fr: () =>
      `📞 Désolé, nous n'avons pas pu poursuivre l'appel. Écrivez-nous ici ce dont vous avez besoin (rendez-vous, tarifs, question) et on continue tout de suite 🙏`,
    en: () =>
      `📞 Sorry, we couldn't continue the call. Write here what you need (appointment, pricing, a question) and we'll pick it up right away 🙏`,
  },

  // Cabinet handoff (D1): the human behind a cabinet is the doctor's
  // secretariat, and the line names the doctor.
  handoffCabinet: {
    ar: (v) => `👩‍⚕️ باش نوصلك بسكرتارية عيادة الدكتور ${v.doctor}. تنجم تتواصل مباشرة على: ${v.phone}. باش يردو عليك في أقرب وقت.`,
    fr: (v) => `👩‍⚕️ Je vous mets en relation avec le secrétariat du Dr ${v.doctor}. Contact direct : ${v.phone}. On vous répond au plus vite.`,
    en: (v) => `👩‍⚕️ I'm connecting you with Dr ${v.doctor}'s office. Direct line: ${v.phone}. They'll reply shortly.`,
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
