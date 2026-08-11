# P2-HUMANIZE — make the bot feel human (priority slice, do BEFORE resuming the workplan order)
> Goal: a patient should never feel a form. The bot adapts to any language/script, never gets stuck on one question, suggests but never gate-keeps specialties, keeps every conversation alive, and hands leads/gaps to the owner instead of dead-ending. Grounded in the REAL conversation log of `el-amen-sousse:21629496305` (data/runtime/) — replay targets below.

## 0. Observed failures (from the live log — these are the acceptance targets)
| # | What happened | Why it's fatal |
|---|---|---|
| F1 | Patient: "I dont wanna book" → bot: "I didn't recognize that specialty" ×3 identical | Ignores explicit refusal; loops; repeats verbatim |
| F2 | "aslema" (Tunisian, Latin script) and "الو/هالو" → "didn't understand" | No Arabizi/colloquial greeting handling |
| F3 | Mid-specialty, patient restates "مرحبا نحب نحجز موعد" → treated as bad specialty answer | State tunnel vision; can't recognize restated intent |
| F4 | Patient asked "اثنين ١٠" (Mon 10:00) → recap booked 08:30 silently | Arabic-Indic digits (٠-٩) unparsed → silent wrong time. CORRECTNESS BUG |
| F5 | "Alo" during confirm → "جاوبني بـ نعم أو لا" + full recap re-pasted | Drill-sergeant tone |
| F6 | "موظف" → "call +216 20 111 222" and chat effectively ends | Bounces patient OFF WhatsApp = letting the client go (takeover feature exists and is unused!) |
| F7 | After confirmation, "نعم" again → generic "didn't understand" menu | No post-booking conversational memory |
| F8 | Every owner alert fails `(#131030) recipient not in allowed list` (see events.json) | Seed notify number is fake — alerts never reach the owner |
| F9 | Booking state stuck on "specialty" for days across sessions | No state decay; stale flows imprison future messages |

## 1. Architecture change — LLM-led dialogue, deterministic guardrails
Replace "state machine asks, LLM decorates" with:

```
inbound → PRE-GUARDS (emergency/abuse → override reply, bot steps back [unchanged])
        → CONTEXT BUILDER: tenant persona+dialect, specialties+synonyms, working hours,
          KB top-k (keyword-matched, not full dump), known slots, patient memory
          (name/origin from prior bookings), state summary, last ~12 messages
        → LLM (Gemini, structured output via responseSchema):
          { reply_text, detected_lang, slots_patch{specialty?,datetimeText?,name?,origin?,contact?},
            actions[], confidence }
          actions ∈ none | propose_summary | confirm_booking | cancel_flow | answer_faq
                  | handoff_request | notify_admin{reason} | kb_gap{question} | specialty_gap{requested}
        → EXECUTOR (deterministic — the only writer):
          · datetime: parse slots.datetimeText itself (never trust LLM datetimes);
            if parsed ≠ patient's words or adjusted → reply MUST state the adjustment and ask OK
          · availability check, appointment creation, store writes, events, notifications
          · guardrails: no diagnosis, no prices beyond KB "from" values, no promises — post-filter reply_text
          · never-repeat policy: if reply_text ≈ last bot message → regenerate once, else vary via fallback set
        → SENDER: mark-as-read + typing indicator, humanized delay min(1.2 + chars/60, 4)s,
          split >2-sentence replies into ≤2 bubbles
```

Feature flag: `CONVERSATION_MODE=llm|classic` (env default: llm when GEMINI_API_KEY set; per-tenant override in config). `classic` = current deterministic flow — stays for offline demo (`npm run simulate` unchanged) and as the automatic fallback when the LLM times out (8s) or errors. THE BOT NEVER GOES SILENT.

## 2. Conversation policies (encode in the system prompt + executor tests)
1. **Language mirroring:** reply in the language AND script of the LAST patient message — AR (Libyan/Tunisian colloquial per tenant dialect), FR, EN, or Arabizi (Arabic in Latin letters → reply in Arabic script unless patient consistently writes Latin). Mid-conversation switches follow the patient instantly.
2. **No tunnel vision:** every message is re-understood fresh. Slots fill in ANY order, several per message ("نحب نحجز أسنان الخميس العشية، اسمي X من بنغازي" = 4 slots at once). Never re-ask a known slot; confirm corrections gracefully ("actually Thursday" → updated, said so).
3. **Digressions welcome:** price/travel/FAQ question mid-booking → answer it, then bridge back with exactly ONE missing item ("و باش نكمّلولك الحجز، شنوة النهار اللي يريحك؟").
4. **Refusal is sacred:** cancel/decline/"not now" in any phrasing → instant warm exit, door open, no menu ("ما فيها باس 🙏 وقتاش ما تحب رجعلي. تحب نخليلك رقمك عند الفريق يتواصلو معاك؟"). Optional single soft ask to keep contact — then stop.
5. **Specialty = suggest, never gate-keep:** free-text always. Layered matching: synonym/colloquial map (أسنان/سنين/ضروس/dentiste→dental · قلب/coeur→cardiology · تجميل/نحافة/anf/rhino/nez→cosmetic · مفاصل/ركبة/genou→ortho · إنجاب/أطفال أنابيب→IVF — extend per tenant) → LLM semantic match → RELATE if adjacent ("جراحة الأنف تدخل تحت جراحة التجميل عندنا ✅") → if genuinely absent: **gap protocol** — never "we don't have that, choose from the list"; instead: "سؤال مليح — نتأكدلك مع الفريق الطبي ونرجعلك اليوم إن شاء الله", capture request + name + contact as a LEAD, emit `specialty_gap` → owner WhatsApp alert + dashboard "waiting on you", keep chatting. **Never let the client go.**
6. **Handoff keeps the chat:** "موظف/agent/humain" → stay IN WhatsApp: "طلبتلك واحد من الفريق توّا 👌 يجاوبك هنا في نفس المحادثة. أما إذا تحب، نجم نعاونك أنا في الأثناء —" + set needsHuman + owner alert + inbox flag (takeover screen already exists). Phone number offered only as an EXTRA for urgent cases.
7. **Post-booking sanity:** after confirmation the bot remembers it just booked: extra "نعم"/"thanks" → warm micro-reply, not a menu. Modify/cancel requests understood against the existing booking.
8. **Two-strike confusion rule:** never send the same clarification twice; second confusion → different angle + offer human. Fallback text bank with variations per language.
9. **State decay:** flow idle >2h → keep slots, drop the "expected answer" lock; next message evaluated fresh (fixes F9).
10. **Returning patients:** greet by name when known ("أهلا بيك مرة أخرى سي {name} 👋").

## 3. Correctness fixes bundled here (non-negotiable)
- **Arabic-Indic + Eastern digits normalization** (٠١٢٣٤٥٦٧٨٩ / ۰-۹ → 0-9) at ingest, before any parsing (fixes F4).
- **Adjustment transparency:** any auto-shift of requested time (outside hours, rounding) must be SAID: "طلبت 10:00 — أقرب موعد متاح 10:30، يمشي؟". `datetimeAdjusted` exists; surface it. Executor rejects LLM-proposed times that don't match its own parse.
- **Seed data:** set El Amen `handoffNumber`/notification recipients to the allow-listed test owner number (Youssef's) so alerts actually deliver during testing (fixes F8/#131030). Document that real clinics use their own (allow-listed via production number).
- **WhatsApp niceties:** send mark-as-read on inbound; typing indicator during generation (Cloud API supports it — degrade silently if the call fails).

## 4. Tests (suite must stay green; add these)
- **Replay goldens (FakeStructuredProvider, scripted):** each F1–F7 scenario from §0 with the EXPECTED new behavior asserted end-to-end through the executor.
- Executor safety: rejects invented/mismatched datetime; rejects unavailable slot with alternative-offer reply; refuses reply_text containing diagnosis/price-invention patterns; cancel_flow always honored; specialty_gap emits lead + notification + keeps conversation open.
- Digit normalization property tests; Arabizi detection ("aslema","na7eb na7jez","chhal soum" → AR intent paths).
- Never-repeat: consecutive identical bot texts impossible.
- Classic mode: full existing suite untouched (simulate offline books both refs as before).
- Guardrail regressions: emergency override, no-diagnosis, "from" prices only.

## 5. Deliverables
`src/engine/humanize/` (context builder, prompt, schema, executor, policies), sender niceties in `src/whatsapp/`, digit normalization in engine utils, updated seed `data/clinics.json`, feature flag in config + .env.example, tests per §4, README section "Conversation modes", and a short `docs/PROMPT-NOTES.md` (system-prompt rationale + how to tune per tenant). Commit per coherent step; never commit .env.

## 6. Kickoff prompt (paste into Claude Code)
```
Read CLAUDE.md, docs/HANDOFF-STATE.md, then docs/P2-HUMANIZE.md fully — it is
the priority slice and supersedes the workplan order. Also read the real
failure log it references (data/runtime/conversations.json + events.json).
Plan first: pipeline design, file layout, test list. Then implement
P2-HUMANIZE end-to-end per the spec: LLM-led dialogue with the deterministic
executor and guardrails, structured output via Gemini responseSchema,
CONVERSATION_MODE flag with classic fallback, digit-normalization and
adjustment-transparency fixes, seed notify-number fix, WhatsApp
read/typing/delay niceties, and ALL §4 tests. Keep npm test green (97+ pass),
keep npm run simulate working offline in classic mode, run the servers in the
background yourself, and verify live on the real WhatsApp line per
HANDOFF-STATE.md — including replaying the F1–F7 scenarios by hand with me.
Commit per step.
```
