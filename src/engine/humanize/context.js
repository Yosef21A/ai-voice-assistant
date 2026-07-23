// Context builder (P2-HUMANIZE §1): assembles the system prompt + turn history
// for the structured LLM call. Read-only — every store access is best-effort
// and failure degrades to a smaller context, never a thrown turn.
import { normalize } from '../slots.js';
import { faqAnswer } from '../faq.js';
import { isArabizi } from '../language.js';
import { buildSystemPrompt } from './prompt.js';
import { buildResponseSchema } from './schema.js';

const HISTORY_TURNS = 12;
const MSG_CAP = 500;
const KB_TOP_K = 3;
const KB_ANSWER_CAP = 350;

/** Keyword-scored top-K KB entries for this message (same scoring family as
 *  matchFaq, but returning several so the LLM can answer digressions). */
export function topKbEntries(text, clinic, lang, k = KB_TOP_K) {
  const t = normalize(text);
  if (!t) return [];
  const scored = [];
  for (const entry of clinic.faq || []) {
    let score = 0;
    for (const kw of entry.keywords || []) {
      if (t.includes(normalize(kw))) score += 1;
    }
    if (score > 0) scored.push({ score, entry });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map(({ entry }) => ({
    id: entry.id,
    answer: String(faqAnswer(entry, lang) || '').slice(0, KB_ANSWER_CAP),
  }));
}

function historyMessages(convo) {
  const msgs = (convo.messages || []).slice(-HISTORY_TURNS);
  return msgs.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    text: String(m.text || '').slice(0, MSG_CAP),
  }));
}

function nowString(now) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const pad = (n) => String(n).padStart(2, '0');
  return `${days[now.getDay()]} ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} (clinic local time)`;
}

async function patientMemory(ctx) {
  try {
    const p = await ctx.store.patients?.get?.(ctx.clinic.id, ctx.inbound.from);
    return p || null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{system: string, messages: Array<{role, text}>}>}
 */
export async function buildLlmRequest(ctx) {
  const { clinic, convo, text, lang, now } = ctx;
  const state = convo.state || {};
  const data = state.data || {};
  const h = state.h || {};
  const patient = await patientMemory(ctx);
  const system = buildSystemPrompt({
    clinic,
    data,
    h,
    kbTop: topKbEntries(text, clinic, lang),
    patient,
    nowStr: nowString(now),
    arabizi: isArabizi(text),
  });
  const schema = buildResponseSchema((clinic.specialties || []).map((s) => s.id));
  return { system, messages: historyMessages(convo), schema };
}
