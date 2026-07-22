# PROMPT-NOTES — how the LLM-led dialogue is prompted, and how to tune it per tenant

> Companion to `docs/P2-HUMANIZE.md`. The system prompt lives in
> `src/engine/humanize/prompt.js`; everything tenant-specific is injected from
> the LIVE clinic object each turn, so owner edits (KB, specialties, hours)
> apply on the very next message with zero prompt changes.

## Design rationale

**The prompt persuades; the executor enforces.** Every rule that matters for
correctness is duplicated as code:

| Rule | Prompt line | Executor enforcement |
|---|---|---|
| No invented datetimes | "datetimeText = the patient's words VERBATIM" | `parseDateTimeRequest` + `resolveSlot` re-parse; LLM values never touch the store |
| Adjustment transparency | (none needed) | `slotAdjusted` ⇒ ⚠️ note bubble / recap warning, always |
| No invented prices | "the ONLY figures you may ever mention" | `guardrails.js` money filter vs. the tenant number allow-list |
| No diagnosis / promises | rule 9 | `guardrails.js` sentence filter (AR/FR/EN patterns) |
| Refusal is sacred | rule 3 | `cancel_flow` honored before anything else; "no" at recap cancels |
| Consent before booking | rule 6 | `confirm_booking` requires complete slots + a yes (or an open recap and not-no) |
| Recap numbers | "the system renders the recap" | `buildSummary`/`finalizeBooking` templates render every recap/booked message |
| Never repeat | STYLE paragraph | `isRepeat` → one vary-hint regenerate → variation bank |

**Why structured output (responseSchema) instead of free text + parsing:** the
model cannot skip the contract — `reply_text`, `detected_lang` and `actions`
are schema-required, and `coercePlan()` re-validates so even a hallucinated
field arrives bounded. A failed/timed-out call THROWS and the classic engine
answers (`llm.fallback` audit event) — the bot never goes silent.

**Why the whole turn history (last 12 messages) goes in as contents:** the
model needs the dialogue to mirror language switches (F2), understand
corrections (§2.2), and avoid re-asking (KNOWN SLOTS block is the belt, the
history is the suspenders).

**Why KB top-3 instead of the full dump:** keyword-scored (`topKbEntries`) —
keeps the prompt small and stops one long KB from drowning the policies. The
KB block is served from the live merged `clinic.faq`, so P2-B trained answers
are included automatically.

## Per-tenant tuning knobs (all in `data/clinics.json`)

| Field | Effect on the prompt |
|---|---|
| `dialect` | Replaces the default "Tunisian/Libyan colloquial (Derja)" instruction — e.g. `"Libyan colloquial Arabic"` for a Benghazi-facing clinic |
| `conversationMode` | Per-tenant override of `CONVERSATION_MODE` (`"classic"` opts a tenant out of LLM dialogue) |
| `specialties[].synonyms` | Directly extends the matcher AND the prompt's suggest-don't-gate-keep list — add colloquial terms here first when patients use words the bot misses |
| `faq[]` / KB entries | The grounding block; owner-trained answers (P2-B) win ties |
| `pricing` | The ONLY money figures the model may repeat (guardrail-enforced) |
| `handoff.phone` | Offered as the urgent-case EXTRA — never as the main path (F6: the chat stays in WhatsApp) |
| `notifications.recipients` | Owner alert numbers (F8 — must be reachable/allow-listed in test-number mode) |

## Tuning workflow

1. Reproduce the weak reply in the dashboard **sandbox** (same engine, no side
   effects on leads/stats).
2. Prefer data fixes (synonyms, KB entries) over prompt edits — they're
   per-tenant and owner-editable.
3. If a policy line changes in `prompt.js`, re-run the goldens:
   `node --test test/humanize.replay.test.js test/humanize.executor.test.js`.
   The F1–F7 scenarios are the acceptance bar; keep them green.
4. Live-verify on the test number per `docs/HANDOFF-STATE.md` §live-loop.

## Failure modes & how they degrade

- **Gemini timeout (8s) / quota / safety block** → classic deterministic flow,
  `llm.fallback` event logged. Patients see the scripted wizard, never silence.
- **Model repeats itself** → one regenerate with `VARY_HINT`, then the
  per-language variation bank (different angle + human offer).
- **Model invents a price/diagnosis** → sentence stripped, safe line appended,
  `guardrailViolations` on the engine result (visible in events for tuning).
- **Model picks a bogus specialty id** → executor fails to match → specialty
  gap protocol (lead + owner alert) instead of a wrong booking.
