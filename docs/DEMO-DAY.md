# DEMO-DAY.md — le rituel avant chaque visite (V8 D5)

**Pour Youssef.** Ce doc dit exactement quoi faire 30 min avant CHAQUE rendez-vous
avec une clinique, comment lire GO/NO-GO, et le script des 90 secondes à suivre
pendant la démo. Imprimable, pas de blabla. Détails techniques complets :
`docs/HANDOFF-STATE.md`. Ce que le système fait et pourquoi : `docs/VOICE-AGENT-SPEC.md` §V8.

**Identifiants (ne changent pas, sauf le token et le tunnel) :**
| Chose | Valeur |
|---|---|
| Clinique démo | El Amen — Sousse (`el-amen-sousse`) |
| Numéro test WhatsApp (le bot) | **+1 (555) 177-7574** |
| WABA id | `1038353382027655` |
| phone_number_id | `1153135121224452` |
| Ton numéro (allow-listé, reçoit les alertes) | +216 29 496 305 |
| Console Meta | developers.facebook.com → Mes Apps → `omen-clinic-agent` → WhatsApp → **Étape 1** (api-testing-v2) |

---

## §1 — Rituel pré-visite (30 min avant, TOUJOURS)

1. Si le token a plus de ~20h : régénère-le (fix manuel #1 ci-dessous) AVANT de lancer quoi que ce soit.
2. Démarre le serveur et le tunnel (deux terminaux) :
   ```
   npm start
   cloudflared tunnel --url http://localhost:3000
   ```
   Note l'URL `https://….trycloudflare.com` que `cloudflared` imprime.
3. Repointe le webhook dans la console (fix manuel #2 ci-dessous) avec cette URL.
4. Lance LA commande unique :
   ```
   npm run demo:preflight -- --tunnel https://<ton-url>.trycloudflare.com
   ```
   Elle fait tout seule en ~90s max : sanity `.env`, token vivant, serveur up,
   tunnel + webhook, ré-abonnement WABA (auto-réparé s'il a sauté), un VRAI
   message WhatsApp de test envoyé sur ton numéro, calling activé, heures
   d'ouverture d'El Amen en ce moment.

**Ce que veut dire le verdict :**
- **`GO ✅`** (exit code 0) → tout est vert (des `⚠️` sont possibles — lis-les
  quand même, ils ne bloquent rien : ex. une clé optionnelle absente, ou la
  clinique fermée en ce moment sur l'horloge). Tu peux démarrer la démo.
- **`NO-GO ❌`** (exit code 1) → au moins un `❌`. Le script imprime une liste
  numérotée "Fix, in order" — corrige dans cet ordre, puis relance la même
  commande. Ne démarre JAMAIS une démo sur un NO-GO.

### Les 3 fixes manuels (toujours dans la console, jamais automatisables)

**#1 — Token mort (`❌ (b) token alive`)**
Console → app → WhatsApp → **Étape 1** → bouton **"Générer un token"** (une
popup s'ouvre — autorise les popups) → copie le nouveau token → colle-le dans
`.env` (`WHATSAPP_TOKEN=...`) → **redémarre le serveur** (`npm start` doit
tourner sur le nouveau `.env`). Le token expire ~1h à 24h selon le run —
régénère systématiquement s'il a plus de 20h, même si le preflight n'a pas
encore gueulé.

**#2 — Webhook pas repointé / tunnel mort (`❌ (d) tunnel + webhook`)**
Console → app → WhatsApp → **Étape 1** → section **Webhook** → **Modifier** →
colle `https://<ton-url-actuelle>.trycloudflare.com/webhook` (l'URL CHANGE à
chaque redémarrage de `cloudflared`) + le verify token (`WHATSAPP_VERIFY_TOKEN`
dans `.env`) → **Vérifier et enregistrer**.

**#3 — Destinataire pas allow-listé (`❌ (f) delivery`)**
Console → app → WhatsApp → **Étape 1** → section **To** → ajoute le numéro
(max 5 numéros sur ce numéro test) → Meta envoie un code par WhatsApp au
numéro → entre le code. Le tien (+216 29 496 305) est déjà dedans normalement
— ce fix ne sert que si tu démos depuis un AUTRE téléphone.

*(Si `❌ (g) calling enabled` : ce n'est PAS un fix console — lance
`node scripts/probe-calling.js --enable` puis relance le preflight. Si
`❌ (e) WABA subscription` : le preflight tente déjà de le réparer tout seul
— s'il échoue quand même, le token est probablement mort, résous #1 d'abord.)*

---

## §2 — Le déroulé de la démo

**Ordre : CHAT d'abord, appel vocal ensuite, comme closer.** Ne JAMAIS inverser
— le chat est blindé et sans surprise ; l'appel a de la latence et de la vraie
voix, donc il ferme la vente une fois la confiance posée, pas avant.

### 2.1 — Le chat (l'ouverture, infaillible)

Sur TON téléphone (WhatsApp Web ou appli), envoie une note vocale au numéro
test avec une demande de rendez-vous en derja, ex. : *"مرحبا نحب نحجز موعد عند
دكتور القلب"*. Montre en direct sur ton écran :
1. Le bot répond en 3s, comprend la note vocale, enchaîne la réservation.
2. Une fois confirmée → **l'alerte WhatsApp arrive sur TON téléphone**
   ("nouvelle réservation") — montre-la, c'est le moment "wow" : le médecin
   voit ses rendez-vous arriver sans lever le doigt.
3. Ouvre le dashboard (`localhost:3000`) → Inbox + Appointments montrent la
   même conversation en direct.

### 2.2 — L'appel vocal (le closer)

**Toi qui passes l'appel, sur haut-parleur.** Ne tends JAMAIS le téléphone au
médecin pour un premier appel libre — le script est rodé, un appel improvisé
peut tomber sur une latence ou une reformulation imprévue devant le client.

**Script rodé (~90 secondes) :**

| t | Étape | Ce qui se passe |
|---|---|---|
| 0:00–0:05 | Appel connecté | La voix décroche INSTANTANÉMENT (greeting sur bande — pas de silence mort). Exemple : *"مرحبا، معك المساعد الآلي لعيادة الأمين، كيفاش نجم نعاونك؟"* (le greeting est FIXE par clinique — déterministe et mis en cache ; seules les réponses du modèle APRÈS l'accueil varient). |
| 0:05–0:20 | Demande | Toi (le "patient") : *"نحب نحجز عند دكتور أمراض القلب، نهار الخميس الصباح."* |
| 0:20–0:45 | Collecte | L'agent demande nom + numéro de téléphone si pas encore donnés, confirme le créneau disponible. Un filler avant chaque recherche ("ثانية برك نشوفلك…") — jamais de silence pendant que ça cherche. |
| 0:45–0:65 | **Spell-back (obligatoire, jamais sauté)** | L'agent relit le récapitulatif EXACT avant d'écrire quoi que ce soit : *"موعد أمراض القلب نهار الخميس الصباح، باسم [الاسم]، ورقم التلفون [الرقم]. صحيح؟"* — le texte du récap est déterministe et le modèle a pour consigne de le lire mot pour mot ; et surtout, **l'écriture du rendez-vous passe par une porte déterministe** (rien n'est réservé sans ce "oui"). |
| 0:65–0:75 | Confirmation | Toi : *"أيوا صحيح"* → l'agent écrit le rendez-vous SEULEMENT maintenant. |
| 0:75–0:90 | Clôture | Agent : référence du rendez-vous + **"بالسلامة"** → raccroche proprement (attend que le mot sorte avant de couper la ligne). |
| juste après | **Preuve live** | La notification WhatsApp du rendez-vous arrive sur le téléphone du médecin — montre-la à l'écran EXACTEMENT comme en 2.1, mais cette fois c'est arrivé par la voix, pas le texte. C'est le point de la démo : deux canaux, un seul cerveau. |

Backchannels à ignorer si le "patient" (toi) les glisse pendant que l'agent
parle — l'agent ne doit PAS s'arrêter : *أيوا · تمام · باهي · مم*. Utile à
savoir si le client pose une question pendant que l'agent répond à un autre —
ça ne casse pas la démo.

---

## §3 — Chaîne de secours (fallback)

L'appel vocal a plus de pièces mobiles qu'un message texte (latence réseau,
Gemini Live en direct, la voix elle-même) — s'il rate, ne panique pas et ne
répare pas en live devant le client :

1. **L'appel échoue ou tombe** → *"Laissez-moi vous montrer un enregistrement"*
   → lance la vidéo de secours (le meilleur appel de la veille, enregistré la
   nuit avant CHAQUE visite — voir §1, ce n'est pas optionnel).
2. **Même la vidéo pose problème** → reviens sur le chat (§2.1), qui a déjà
   été montré et a déjà convaincu. Le pitch, c'est **le SYSTÈME** (chat +
   voix + dashboard), pas un canal isolé. Un canal qui bug ne coule pas la
   vente si les deux autres tiennent.
3. Ne JAMAIS dire "ça marche d'habitude" ou déboguer du code à l'écran — ferme
   l'appel, enchaîne sur le fallback, garde le rythme.

---

## §4 — Journal des répétitions

Le founder fait tourner le déroulé complet (§1 preflight → §2.1 chat → §2.2
appel) **5 fois avant lundi**. Chaque échec nourrit un fix avant le run
suivant — ne pas avancer au run N+1 tant que le run N n'a pas au moins un GO
sur le preflight.

| # | Date | Résultat (GO / NO-GO) | Ce qui a cassé | Fix appliqué |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |

**Critère d'arrêt (dimanche soir, VOICE-AGENT-SPEC §V8 acceptance) :** 10
appels de répétition — zéro double-réponse, latence ressentie ≤1.3s médiane
(aucun tour >2s), l'agent survit aux backchannels أيوا/تمام sans s'arrêter,
la réservation atterrit avec le bon spell-back, **`npm run demo:preflight`
affiche GO**. Une fois ça tient → on arrête de coder et on dort.
