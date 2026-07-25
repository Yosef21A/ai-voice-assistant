// Inbound ingestion pipeline — shared by the webhook and reusable by any future
// transport. Keeps the engine transport-agnostic: it just consumes the same
// normalized inbound shape server.js already builds. Responsibilities:
//   1. resolve the tenant (still keyed on phone_number_id),
//   2. persist the inbound message to the normalized transcript + emit,
//   3. respect ai_paused (bot silent during human takeover),
//   4. run the engine, then run the detectors BESIDE it (analyzeInbound) so the
//      engine stays transport-agnostic and never touches the bus,
//   5. on an EMERGENCY, send the localized overrideReply INSTEAD of the engine
//      output, pause the bot, and let the notification service alert staff
//      (guardrail: PRODUCT-SPEC §5 / CLAUDE.md — the bot steps back),
//   6. otherwise dispatch replies through the ONE sender (onOutbound persists +
//      emits each bubble) and emit appointment.created / handoff.requested.
//
// lead.hot / emergency.detected are emitted by analyzeInbound itself (it holds
// the classifiers); appointment.created / handoff.requested are emitted here
// from the engine result. Both land on the shared bus → SSE + notifications.
import { sendAs, publicMessage } from './outbound.js';
import { analyzeInbound } from '../notifications/index.js';
import { normalizeQuestion, isSandboxWaId } from '../stats/index.js';
import { detectLanguage, resolveLanguage } from '../engine/language.js';
import { t } from '../engine/responses.js';
import { estimateMaxBytes } from '../voice/policy.js';

// Localized acknowledgment for received media (P2-D). GUARDRAIL: the bot never
// interprets media medically — it confirms receipt and promises a human.
const MEDIA_ACK = {
  ar: 'وصلتنا 📎 الطبيب يطّلع عليها ويردّ عليك في أقرب وقت.',
  fr: 'Bien reçu 📎 Le médecin va l’examiner et revient vers vous rapidement.',
  en: 'Received 📎 The doctor will review it and get back to you shortly.',
};

// Display-only filename: never used for paths, stripped of anything path-like.
const safeFilename = (name) =>
  String(name || '').replace(/[\\/\u0000-\u001f]/g, '').slice(0, 120) || null;

export async function ingestInbound(
  { store, engine, sender, bus, mediaClient, transcriber, config = {} },
  inbound
) {
  const clinic =
    store.getClinicByPhoneNumberId(inbound.phoneNumberId) ||
    store.getClinicById(inbound.tenantId) ||
    store.getDefaultClinic();
  if (!clinic) return { skipped: 'no-tenant' };
  const tenantId = clinic.id;

  // Ensure the conversation row exists; the engine shares this exact record.
  let convo = await store.conversations.get(tenantId, inbound.from);
  if (!convo) {
    convo = await store.conversations.create(tenantId, { patientWaId: inbound.from, status: 'open' });
  }
  const conversationId = convo.id;

  // Media turn (P2-D): download the bytes BEFORE persisting — Graph's lookaside
  // URL expires in minutes, so intake is synchronous. A failed download still
  // persists the metadata (available:false) so staff see that something arrived.
  let mediaMeta = null;
  // Voice (V1): the transcript, when we produced one. Computed BEFORE the
  // message is persisted so it rides the single existing appendMessage write —
  // neither store adapter has an updateMessage, and adding a second write would
  // mean a second SSE frame and a race with the inbox.
  let voice = null;
  if (inbound.media) {
    const isVoice = inbound.media.kind === 'audio';
    // Byte cap stands in for the "≤ 2 min" rule (the webhook carries no
    // duration). Applied at the pre-download metadata check, so an over-cap note
    // costs zero CDN bytes and zero STT calls.
    const sttOn =
      isVoice && !!transcriber && config.voiceStt !== false && !inbound.media.caption;
    const opts = sttOn
      ? {
          keepBytes: true,
          maxBytes: estimateMaxBytes(inbound.media.mimeType, config.voiceMaxSeconds || 120),
        }
      : {};
    const dl = mediaClient
      ? await mediaClient.fetchMedia(clinic, inbound.media, opts)
      : { ok: false, error: { message: 'no media client configured' } };
    mediaMeta = {
      kind: inbound.media.kind,
      mediaId: inbound.media.id ?? null,
      mimeType: dl.ok ? dl.mimeType : inbound.media.mimeType ?? null,
      filename: safeFilename(inbound.media.filename),
      caption: inbound.media.caption || '',
      size: dl.ok ? dl.size : null,
      file: dl.ok ? dl.file : null,
      error: dl.ok ? null : dl.error?.message || 'download failed',
    };

    if (sttOn) {
      if (dl.ok && dl.bytes?.length) {
        const r = await transcriber.transcribe({ bytes: dl.bytes, mimeType: dl.mimeType });
        voice = r;
        if (r.transcript) {
          mediaMeta.transcript = {
            text: r.transcript,
            lang: r.lang ?? null,
            grade: r.grade,
            durationSec: Math.round(r.durationSec || 0),
          };
        }
      } else if (dl.error?.code === 'media_too_large') {
        voice = { ok: false, grade: 'failed', reason: 'too_long', transcript: '' };
      }
    }
  }

  // THE TURN. A voice note we successfully transcribed has words, so from here
  // on it IS the turn's text and flows through the SAME pipeline as if typed —
  // emergency preflight, engine, detectors, everything. `source:'voice'` travels
  // with it so the humility guardrail (engine/voiceSlots.js) knows the values
  // came from speech and must be read back before they can book anything.
  // Images and documents are untouched: we never interpret an X-ray.
  const turn = voice?.transcript
    ? { ...inbound, text: voice.transcript, source: 'voice', voice: { grade: voice.grade } }
    : inbound;

  // Persist inbound + fan out (staff see the patient even while the bot is paused).
  const inMsg = await store.conversations.appendMessage(tenantId, conversationId, {
    direction: 'inbound',
    type: mediaMeta ? mediaMeta.kind : 'text',
    body: mediaMeta
      ? { text: inbound.text, by: 'patient', media: mediaMeta }
      : { text: inbound.text, by: 'patient' },
    waMessageId: inbound.messageId ?? null,
    ts: new Date(inbound.timestamp || Date.now()).toISOString(),
  });
  bus.publish('message.in', { tenantId, conversationId, actor: 'patient', message: publicMessage(inMsg) });
  bus.publish('conversation.updated', { tenantId, conversationId, patch: { lastMessageAt: inMsg.ts } });

  // WhatsApp niceties (P2-HUMANIZE §3): blue ticks always (the message was
  // seen), but the typing bubble ONLY when the bot will actually reply — never
  // on a paused (human-takeover) conversation, where "typing…" then silence is
  // worse than nothing. Fire-and-forget: a Graph hiccup must not delay the turn.
  if (inbound.channel === 'whatsapp' && inbound.messageId) {
    Promise.resolve(sender.markRead(clinic, inbound.messageId, { typing: !convo.aiPaused })).catch(
      () => {}
    );
  }

  // Media turn (P2-D): the 📎 owner alert + SSE fire for EVERY stored media —
  // INCLUDING paused conversations (a post-emergency X-ray is exactly when
  // staff must be pinged). Only the bot's own replies respect the pause.
  if (mediaMeta) {
    bus.publish('media.received', {
      tenantId,
      conversationId,
      patientWaId: inbound.from,
      media: {
        kind: mediaMeta.kind,
        mimeType: mediaMeta.mimeType,
        filename: mediaMeta.filename,
        caption: mediaMeta.caption,
      },
    });
  }

  // Human takeover: the bot stays silent while a staff member is driving.
  if (convo.aiPaused) return { tenantId, conversationId, paused: true };

  // ── EMERGENCY PREFLIGHT ────────────────────────────────────────────────────
  // Runs BEFORE the engine, deliberately. Emergency detection is a deterministic
  // regex pass costing ~0 ms; the engine is an LLM round trip that can take
  // seconds and can be starved outright by a 429. Detecting a chest-pain message
  // only after that budget is spent is not acceptable in a medical product, so
  // the safety reply goes out first and the model never gates it.
  //
  // The language is resolved HERE rather than borrowed from the engine result
  // (which doesn't exist yet): buildEmergencyReply falls back to French for an
  // unknown lang, and an Arabic speaker in crisis must not get a French message.
  const preLang = resolveLanguage(detectLanguage(turn.text), convo.lang, clinic);
  const preflight = analyzeInbound({
    tenant: clinic,
    text: turn.text,
    lang: preLang,
    waId: inbound.from,
    bus,
    conversationId,
    emergencyOnly: true,
  });
  if (preflight.overrideReply) {
    await sendAs('bot', conversationId, () =>
      sender.sendText(clinic, inbound.from, preflight.overrideReply)
    );
    await store.conversations.update(tenantId, conversationId, {
      status: 'needs_human',
      aiPaused: true,
    });
    bus.publish('conversation.updated', {
      tenantId,
      conversationId,
      patch: { status: 'needs_human', aiPaused: true },
    });
    try {
      await store.events.append(tenantId, {
        type: 'message.analyzed',
        actor: 'engine',
        conversationId,
        payload: {
          intent: 'emergency',
          lang: preLang,
          snippet: String(turn.text || '').slice(0, 160),
        },
      });
    } catch {
      /* best-effort audit trail */
    }
    return { tenantId, conversationId, emergency: preflight.emergency };
  }

  if (mediaMeta && !turn.text) {
    const lang = ['ar', 'fr', 'en'].includes(convo.lang) ? convo.lang : 'ar';
    // A voice note we heard but could not understand gets the warm fallback,
    // never the generic 📎 ack — "the doctor will review it" is the wrong
    // promise for audio, and silence is the one thing we refuse.
    let text = MEDIA_ACK[lang];
    if (voice && !voice.ok) text = t(lang, voice.reason === 'too_long' ? 'voiceTooLong' : 'voiceUnclear');
    await sendAs('bot', conversationId, () => sender.sendText(clinic, inbound.from, text));
    return { tenantId, conversationId, media: mediaMeta, voice: voice || undefined };
  }
  // A caption rides along: fall through — the engine and the emergency/lead
  // detectors treat it as the turn's text (guardrails stay active).

  const out = await engine.handleMessage(turn);

  // Per-turn analysis event (P2-A): intent + language + a short snippet power
  // the analytics screen (topIntents / topQuestions / funnel) and the P2-B
  // training loop. Called only AFTER the patient-facing send in each branch so
  // the audit write can never delay a reply — least of all the emergency
  // override (medical guardrail: the override goes out first).
  const logAnalyzed = async () => {
    try {
      await store.events.append(tenantId, {
        type: 'message.analyzed',
        actor: 'engine',
        conversationId,
        payload: {
          intent: out.intent || 'unknown',
          lang: out.lang || null,
          snippet: String(inbound.text || '').slice(0, 160),
        },
      });
    } catch {
      /* best-effort audit trail */
    }
  };

  // Detectors run BESIDE the engine (which never touches the bus). The EMERGENCY
  // half already ran in the preflight above — this call takes the lead verdict
  // only (it needs the engineResult), and `skipEmergency` guarantees
  // `emergency.detected` can never be emitted twice for one turn.
  const analysis = analyzeInbound({
    tenant: clinic,
    text: inbound.text,
    lang: out.lang,
    engineResult: out,
    waId: inbound.from,
    bus,
    conversationId,
    skipEmergency: true,
  });

  if (out.replies && out.replies.length) {
    await sendAs('bot', conversationId, () => sender.sendEngineReply(clinic, inbound.from, out));
  }
  await logAnalyzed();

  // "Bot didn't know" capture (P2-B) — AFTER the reply, best-effort, deduped by
  // normalized question. Uses a dedicated collection (the events log is a ring
  // buffer on the JSON store; unknowns must not age out). Triaged rows keep
  // their status; only genuinely NEW questions ping the dashboard badge.
  if (out.knew === false && inbound.text && !isSandboxWaId(inbound.from)) {
    try {
      // The llm executor may pass a cleaned question (kb_gap action); the raw
      // inbound text stays the dedupe fallback.
      const question = out.kbQuestion || inbound.text;
      const row = await store.unanswered.upsertByNorm(tenantId, {
        norm: normalizeQuestion(question),
        question: String(question).slice(0, 300),
        lang: out.lang || null,
        conversationId,
      });
      if (row && row.status === 'new') {
        bus.publish('kb.unanswered', {
          tenantId,
          conversationId,
          unanswered: { id: row.id, question: row.question, lang: row.lang, count: row.count },
        });
      }
    } catch {
      /* the training queue must never break the turn */
    }
  }

  // Persist the hot lead (P2-C) — the money pipeline. analyzeInbound emits
  // lead.hot every hot turn AND already deduped the alert; here we upsert ONE
  // open lead per conversation so the dashboard kanban has a durable row.
  // Field-map deliberately: bus `country` → originCountry column; reason +
  // snippet have no column so they ride in `details`. Best-effort — a store
  // failure must never break the patient's turn.
  if (analysis.lead) {
    try {
      await store.leads.upsertOpen(tenantId, {
        conversationId,
        patientWaId: analysis.lead.patientWaId ?? inbound.from,
        procedure: analysis.lead.procedure ?? null,
        originCountry: analysis.lead.country ?? null,
        details: { reason: analysis.lead.reason ?? null, snippet: analysis.lead.snippet ?? null },
      });
    } catch {
      /* the leads pipeline must never break the turn */
    }
  }

  // Specialty gap (P2-HUMANIZE §2.5): the patient asked for a treatment we
  // don't list — that's a LEAD, not a dead end. One open lead per conversation
  // (upsertOpen dedupes/merges) + a hot-lead owner alert so the clinic answers
  // TODAY. Sandbox test-drives never leak into the pipeline.
  if (out.gap && out.gap.type === 'specialty' && !isSandboxWaId(inbound.from)) {
    const snippet = String(inbound.text || '').slice(0, 160);
    try {
      await store.leads.upsertOpen(tenantId, {
        conversationId,
        patientWaId: inbound.from,
        procedure: out.gap.requested || null,
        originCountry: null,
        details: { reason: 'specialty_gap', snippet, requested: out.gap.requested || null },
      });
    } catch {
      /* the leads pipeline must never break the turn */
    }
    bus.publish('lead.hot', {
      tenantId,
      conversationId,
      lead: {
        reason: 'specialty_gap',
        procedure: out.gap.requested || null,
        country: null,
        patientWaId: inbound.from,
        conversationId,
        snippet,
      },
    });
  }

  // notify_admin (P2-HUMANIZE): the assistant flagged something for the owner
  // without pausing the bot — a dedicated owner alert, dashboard-visible too.
  if (out.adminNotify && !isSandboxWaId(inbound.from)) {
    bus.publish('admin.notify', {
      tenantId,
      conversationId,
      patientWaId: inbound.from,
      reason: out.adminNotify.reason || null,
      lastMessage: inbound.text,
    });
  }

  if (out.appointment) {
    bus.publish('appointment.created', { tenantId, conversationId, appointment: out.appointment });
  }

  if (out.handoff) {
    // Flag for a human + alert the owner. Classic handoff PAUSES the bot (it
    // pointed the patient off WhatsApp). The llm handoff sets keepActive: the
    // patient was told the team will reply HERE and the bot can keep helping in
    // the meantime (§2.6), so we flag needs_human WITHOUT pausing — takeover
    // pauses the bot when staff actually sends the first message.
    const keepActive = out.handoff.keepActive === true;
    const patch = keepActive ? { status: 'needs_human' } : { status: 'needs_human', aiPaused: true };
    await store.conversations.update(tenantId, conversationId, patch);
    bus.publish('handoff.requested', {
      tenantId,
      conversationId,
      handoff: out.handoff,
      lastMessage: inbound.text,
      patientWaId: inbound.from,
    });
    bus.publish('conversation.updated', { tenantId, conversationId, patch });
  }

  return { tenantId, conversationId, out, lead: analysis.lead || null };
}
