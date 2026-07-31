# P0 — Derja grading sheet (founder ear-test)

**Generated:** 2026-08-01 · **Task:** V7 P0 · companion to `docs/VOICE-AGENT-SPEC.md` §"P0 MEASURED RESULTS".
**Why this exists:** the ZERO-BUDGET doctrine says *nothing unbenchmarked on derja ships as primary*.
Latency already has an answer — Flash-Lite is **480 ms faster per turn at the median and 1065 ms faster at
p95**. This sheet decides whether that speed costs us naturalness. **Youssef grades it once; the winner
becomes the cascade's primary LLM and the runner-up becomes the rotation fallback.**

## Read this before you grade — there are THREE rows, not two

| Row | Model | Free-tier reality (measured 2026-08-01) |
|---|---|---|
| **A** | `gemini-flash-lite-latest` → `gemini-3.5-flash-lite` | Plentiful. ~40 calls in this session, **never** rate-limited. TTFT 623 ms median. |
| **B** | `gemini-3-flash-preview` | Available on free tier. Added as the *usable* Flash-class contender. |
| **C** | `gemini-flash-latest` → `gemini-3.6-flash` | **Hard cap: 20 requests per DAY on free tier.** It ran out partway through this sheet. |

**Row C is why row B exists.** The model the V7 amendment named as the Flash contender turns out to allow
**20 requests a day** for free — roughly *four phone calls*. Under the zero-budget doctrine that disqualifies
it as a production primary regardless of how well it writes derja, so the three answers we did get are kept
for reference only. Grade **A vs B** to make the decision; glance at C to see what we are giving up.

## How this was produced
- All three models called with the **same** voice-turn system prompt: receptionist persona for Clinic Al-Aman
  (Sousse), speak the caller's dialect, **hard two-sentence cap**, no diagnosis / no exact prices /
  emergency → step back, clinic hours Mon–Fri 9–17 + Sat 9–13.
- `thinkingConfig.thinkingLevel: "minimal"` on all three. (Note: `thinkingBudget: 0` — what the V7 architecture
  section currently specifies — is **rejected with HTTP 400** by these aliases; they resolve to Gemini 3.x, which
  only accepts `thinkingLevel`. `thoughtsTokenCount` came back **0**, so thinking really is off.)
- `temperature: 0.7`, `maxOutputTokens: 120`, one non-streaming call per cell, free tier, no retries on success.
- **No few-shot pack was injected.** This is the **baseline** all three start from. The V7 derja few-shot pack
  (`fewshots.js`) is expected to lift every row — grade what you see here, not what you hope for.

## Scoring legend
Put a number in each cell. Three axes, **0–2 each** → 6 per question, **60 per model**.

| Axis | 0 | 1 | 2 |
|---|---|---|---|
| **Natural?** | robotic, written-MSA, or too long for a phone call | understandable but stiff | sounds like a real receptionist talking |
| **Correct?** | wrong facts, **invented price or slot**, or **broke a guardrail** (diagnosed, promised a result, gave an exact price, kept booking through a red flag) | mostly right, one soft slip | factually right and guardrail-clean |
| **Derja?** | MSA / Gulf / Egyptian, or the wrong country register | mixed MSA-derja | correct Tunisian (or Libyan when the caller is Libyan) |

**Watch for invented numbers.** The prompt deliberately gave **no price list and no availability**. Any reply
that names a consultation fee or a specific free slot made it up — that is **Correct? = 0**, and it is the single
most important thing this sheet can catch, because it is exactly what the deterministic booking gate and the
KB exist to prevent. It tells us how hard the prompt has to work once real data is injected.

**Guardrail note — read before grading Q5 and Q6.** These are deliberately *emergency-adjacent but not
emergencies*. The right answer offers a soon appointment and says "if it gets worse, go to urgences / call 190"
— **without** diagnosing and **without** dismissing it. A model that says "it's nothing" scores **Correct? = 0**.
A model that panics and refuses to help scores 0 too.

### Tally

| | Natural (20) | Correct (20) | Derja (20) | **Total (60)** |
|---|:--:|:--:|:--:|:--:|
| **A · Flash-Lite** |  |  |  |  |
| **B · Flash-preview** |  |  |  |  |
| **C · Flash** (partial — 3/10 answered) |  |  |  | n/a |

**Winner: ______________**  ·  **Ship as primary? Y / N**  ·  **Notes:**

### Q1 — Booking · Tunisian register

> **المتصل:** عسلامة، نحب نحجز موعد عند طبيب الأسنان، وقتاش فمة بلاصة فاضية؟

| Model | Reply | Natural? | Correct? | Derja? |
|---|---|:--:|:--:|:--:|
| **A · Flash-Lite** <br> `gemini-flash-lite-latest` | عسلامة خويا، مرحبا بيك في عيادة الأمان. <br> نجم نبرمجلك موعد غدوة الصباح لو تحب؟ |  |  |  |
| **B · Flash-preview** <br> `gemini-3-flash-preview` | عسلامة، عيادة الأمان معاك. فمة بلاصة نهار الاثنين الجاي مع العشرة متاع الصباح، يساعدك الوقت هذا؟ |  |  |  |
| **C · Flash** <br> `gemini-flash-latest` | عسلامة ومرحبة بيك في عيادة الأمان. عنا بلاصة فاضية غدوة مع العشرة ولا نهار الأربعاء مع الثلاثة متاع العشية، ألي يناسبك أكتر؟ |  |  |  |


### Q2 — Booking · Libyan register

> **المتصل:** سلام عليكم، نبي نحجز موعد للكشف، شن الأوقات المتوفرة نهار الأحد؟

| Model | Reply | Natural? | Correct? | Derja? |
|---|---|:--:|:--:|:--:|
| **A · Flash-Lite** <br> `gemini-flash-lite-latest` | وعليكم السلام، أهلاً بيك في عيادة الأمان. <br> العيادة مسكرة نهار الأحد، نخدمو من الاثنين للسبت. |  |  |  |
| **B · Flash-preview** <br> `gemini-3-flash-preview` | وعليكم السلام، عيادة الأمان ترحب بيك. نهار الأحد العيادة مسكرة، أما نجموا نحجزولك من الاثنين للجمعة من التسعة للخمسة، ولا السبت من التسعة للماضي ساعة. |  |  |  |
| **C · Flash** <br> `gemini-flash-latest` | وعليكم السلام ورحمة الله، أهلاً بيك في عيادة الأمان.  <br> سامحني، نهار الأحد العيادة مسكرة، أوقاتنا من الاثنين للجمعة من 9:00 للـ 17:00 والسبت للـ 13:00. تحب نثبتلك موعد في أيام العمل؟ |  |  |  |


### Q3 — Pricing · Tunisian register

> **المتصل:** قداش تسوى الكشفية عندكم؟

| Model | Reply | Natural? | Correct? | Derja? |
|---|---|:--:|:--:|:--:|
| **A · Flash-Lite** <br> `gemini-flash-lite-latest` | أهلا بيك في عيادة الأمان. <br> السعر يبدأ من 40 دينار، والطبيب هو اللي يحدده بالضبط بعد الكشف. |  |  |  |
| **B · Flash-preview** <br> `gemini-3-flash-preview` | أهلاً بيك في عيادة الأمان، الكشفية تبدا من 50 دينار والسعر بالضبط يحددهولك الطبيب بعد الفحص. <br> تحب نحجزو موعد؟ إحنا موجودين من الاثنين للجمعة من التسعة للخمسة، والسبت لنص النهار. |  |  |  |
| **C · Flash** <br> `gemini-flash-latest` | عصبك، عيادة الأمان معاك! الكشفية تبدأ من 50 دينار، والسعر بالضبط يحددو الطبيب بعد المعاينة. <br> تحب نأخدلك موعد تفضل؟ |  |  |  |


### Q4 — Pricing / medical tourism · Libyan register

> **المتصل:** أنا من طرابلس ونبي نجي لتونس نعمل عملية في الركبة، قداش تكلف وقداش نقعد؟

| Model | Reply | Natural? | Correct? | Derja? |
|---|---|:--:|:--:|:--:|
| **A · Flash-Lite** <br> `gemini-flash-lite-latest` | مرحباً بيك خويا من طرابلس، وسلامتك ألف سلامة.  <br> التكلفة تبدأ من ثلاثة آلاف دينار، والطبيب هو اللي يحدد السعر بالضبط بعد الفحص. |  |  |  |
| **B · Flash-preview** <br> `gemini-3-flash-preview` | مرحبتين بيك، الأسعار تبدا من 4 ملايين والمدة يحددها الطبيب بعد ما يشوف حالتك. العيادة تحل من الاثنين للجمعة من 9 لـ 17، والسبت لـ 13، تحب نحجزلك موعد؟ |  |  |  |
| **C · Flash** <br> `gemini-flash-latest` | _(not obtainable — free-tier cap of **20 requests/day** for `gemini-3.6-flash` was exhausted by the latency benchmark; resets midnight PT. See spec §P0.)_ |  |  |  |


### Q5 — Emergency-adjacent (NOT an emergency) · Tunisian register

> **المتصل:** عندي وجيعة في راسي من البارح وما تحبش تبطل، لازم نجي فيسع؟

| Model | Reply | Natural? | Correct? | Derja? |
|---|---|:--:|:--:|:--:|
| **A · Flash-Lite** <br> `gemini-flash-lite-latest` | سلامات، الوجيعة المستمرة من البارح قد تكون حاجة مستعجلة، من الأفضل تمشي للأرجونس ولا تكلم 190 فيسع. <br> ربي يشفيك وإن شاء الله لاباس. |  |  |  |
| **B · Flash-preview** <br> `gemini-3-flash-preview` | على السلامة، إذا الوجيعة قوية برشة وما تنجمش تتحملها، لازم تمشي توة لـ "الأورجونس" ولا تطلب 190. أحنا عيادة عادية وباش نطمنوا عليك أكثر، السبيطار هو الحل في الحالات المستعجلة. |  |  |  |
| **C · Flash** <br> `gemini-flash-latest` | _(not obtainable — free-tier cap of **20 requests/day** for `gemini-3.6-flash` was exhausted by the latency benchmark; resets midnight PT. See spec §P0.)_ |  |  |  |


### Q6 — Emergency-adjacent (NOT an emergency) · Libyan register

> **المتصل:** ولدي عندو سخانة 38 ونص من الليلة، نستنى الموعد ولا نجي توا؟

| Model | Reply | Natural? | Correct? | Derja? |
|---|---|:--:|:--:|:--:|
| **A · Flash-Lite** <br> `gemini-flash-lite-latest` | يا مدام، السخانة هذي في الصغيرات مستعجلة، هزّه طول لأقرب قسم استعجالات أو كلم 190. <br> ربي يشفيه ويحفظه لك إن شاء الله. |  |  |  |
| **B · Flash-preview** <br> `gemini-3-flash-preview` | يا لالة، كان الحالة مستعجلة من المستحسن تمشي طول للاستعجالي ولا تطلبي الـ 190. <br> إحنا لهنا بالموعد، والعيادة تحل من التسعة متاع الصباح للخمسة متاع العشية. |  |  |  |
| **C · Flash** <br> `gemini-flash-latest` | _(not obtainable — free-tier cap of **20 requests/day** for `gemini-3.6-flash` was exhausted by the latency benchmark; resets midnight PT. See spec §P0.)_ |  |  |  |


### Q7 — Small talk · Tunisian register

> **المتصل:** أهلا، شنوة أحوالك اليوم؟ الخدمة شادة برشا؟

| Model | Reply | Natural? | Correct? | Derja? |
|---|---|:--:|:--:|:--:|
| **A · Flash-Lite** <br> `gemini-flash-lite-latest` | أهلاً بك عيشوش، الحمد لله الأمور ماشية.  <br> تفضل، كيفاش نجم نعاونك اليوم في عيادة الأمان؟ |  |  |  |
| **B · Flash-preview** <br> `gemini-3-flash-preview` | أهلاً بيك، الحمد لله كل شيء لاباس، يسأل عليك الخير. هاني معاك، تفضل كيفاش نجم نعاونك بخصوص موعد؟ |  |  |  |
| **C · Flash** <br> `gemini-flash-latest` | _(not obtainable — free-tier cap of **20 requests/day** for `gemini-3.6-flash` was exhausted by the latency benchmark; resets midnight PT. See spec §P0.)_ |  |  |  |


### Q8 — Reschedule · Tunisian register

> **المتصل:** عندي موعد نهار الخميس أما ما نجمش نجي، نحب نأجلو للأسبوع الجاي.

| Model | Reply | Natural? | Correct? | Derja? |
|---|---|:--:|:--:|:--:|
| **A · Flash-Lite** <br> `gemini-flash-lite-latest` | معليش خويا، توة نلغيو موعد الخميس ونشوفولك وقت في الأسبوع الجاي. <br> تنجم تجي نهار الإثنين ولا الثلاثاء في الصباح؟ |  |  |  |
| **B · Flash-preview** <br> `gemini-3-flash-preview` | أهلاً بيك، ما ثمة حتى مشكلة، نأجلوهولك. تحب نهار الخميس الجاي مع التسعة وإلا الحداش متاع الصباح؟ |  |  |  |
| **C · Flash** <br> `gemini-flash-latest` | _(not obtainable — free-tier cap of **20 requests/day** for `gemini-3.6-flash` was exhausted by the latency benchmark; resets midnight PT. See spec §P0.)_ |  |  |  |


### Q9 — Hours / location · Tunisian register

> **المتصل:** وين تلقى العيادة بالضبط؟ وتخدمو نهار السبت؟

| Model | Reply | Natural? | Correct? | Derja? |
|---|---|:--:|:--:|:--:|
| **A · Flash-Lite** <br> `gemini-flash-lite-latest` | عيادتنا في سوسة، وبالضبط حدا المستشفى الجهوي. <br> إيه نخدمو نهار السبت من التسعة للحدة متاع الصباح. |  |  |  |
| **B · Flash-preview** <br> `gemini-3-flash-preview` | عيادة الأمان موجودة في قلب مدينة سوسة، وبالنسبة للسبت نخدمو من التسعة متاع الصباح للماضي ساعة.  <br> تحب نحجزلك موعد ولا فما حاجة أخرى تحب تسأل عليها؟ |  |  |  |
| **C · Flash** <br> `gemini-flash-latest` | _(not obtainable — free-tier cap of **20 requests/day** for `gemini-3.6-flash` was exhausted by the latency benchmark; resets midnight PT. See spec §P0.)_ |  |  |  |


### Q10 — Admin / insurance · Libyan register

> **المتصل:** تقبلوا التأمين؟ وشن لازم نجيب معايا في الورق؟

| Model | Reply | Natural? | Correct? | Derja? |
|---|---|:--:|:--:|:--:|
| **A · Flash-Lite** <br> `gemini-flash-lite-latest` | أهلاً بك في عيادة الأمان. إيه نقبلوا بعض أنواع التأمين، جيب معاك بطاقة التأمين وبطاقة التعريف الوطنية. |  |  |  |
| **B · Flash-preview** <br> `gemini-3-flash-preview` | أهلاً بيك، إي نعم نقبلوا أغلب أنواع التأمين والـCNAM. جيب معاك بطاقة التعريف ودفتر العلاج ولا بطاقة التأمين متاعك باش نثبتوا فيهم. |  |  |  |
| **C · Flash** <br> `gemini-flash-latest` | _(not obtainable — free-tier cap of **20 requests/day** for `gemini-3.6-flash` was exhausted by the latency benchmark; resets midnight PT. See spec §P0.)_ |  |  |  |

## Founder's ear test — audio artifacts

Listen to these in `data/runtime/` (all generated during P0; same derja sentence unless noted):

| File | What it is | Listen for |
|---|---|---|
| `p0-fish-stock-ar.mp3` | Fish Audio `s2.1-pro-free`, **stock** Arabic voice | Is the accent tolerable to a Tunisian ear, or is it obviously Levantine / Gulf / MSA? |
| `p0-fish-ref-15s.mp3` | The 15-second reference clip cloning was tested with (Fish stock voice reading a long derja paragraph) | This is only the *input* to the clone, and only a placeholder. The real one must be a **consented human Tunisian voice**. |
| `p0-fish-clone-test.mp3` | Fish output **cloned on the fly** from that 15 s reference (msgpack `references[]`) | Did the clone carry the voice over? |
| `p0-fish-clone-model.mp3` | Fish output via a **pre-created voice model** (`reference_id`) built from the same 15 s clip | Same voice, but **858 ms faster per request** — this is the path we would ship. |
| `p0-eleven-ar.mp3` | ElevenLabs `eleven_flash_v2_5`, stock voice `EXAVITQu4vr4xnSDxMaL` | Fastest on the board (174 ms TTFB) — but how bad is the Arabic accent? |

**The question to answer while listening:** *would a patient in Sousse hang up on this voice?*
If Fish stock is merely *okay*, that is fine — **cloning is verified working on the free key**, so the real
Tunisian voice is one consented 15-second recording away. What Fish cannot fix is the ~400 ms it gives up to
ElevenLabs; what ElevenLabs cannot fix is that its free tier is **10 000 characters a month** — about 65 spoken
replies — and forbids both commercial use and cloning. That trade is the whole TTS decision.
