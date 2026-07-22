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

export async function ingestInbound({ store, engine, sender, bus, mediaClient }, inbound) {
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
  if (inbound.media) {
    const dl = mediaClient
      ? await mediaClient.fetchMedia(clinic, inbound.media)
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
  }

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

  // Captionless media: nothing for the engine to parse — acknowledge receipt
  // and stop. GUARDRAIL: media is routed to a human, never interpreted.
  if (mediaMeta && !inbound.text) {
    const lang = ['ar', 'fr', 'en'].includes(convo.lang) ? convo.lang : 'ar';
    await sendAs('bot', conversationId, () => sender.sendText(clinic, inbound.from, MEDIA_ACK[lang]));
    return { tenantId, conversationId, media: mediaMeta };
  }
  // A caption rides along: fall through — the engine and the emergency/lead
  // detectors treat it as the turn's text (guardrails stay active).

  const out = await engine.handleMessage(inbound);

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

  // Detectors run BESIDE the engine (which never touches the bus). analyzeInbound
  // emits lead.hot / emergency.detected for the notification service and returns
  // an overrideReply on emergencies so the bot steps back.
  const analysis = analyzeInbound({
    tenant: clinic,
    text: inbound.text,
    lang: out.lang,
    engineResult: out,
    waId: inbound.from,
    bus,
    conversationId,
  });

  if (analysis.overrideReply) {
    // EMERGENCY: replace the engine reply with the safety message, persist it as
    // a bot bubble, pause the bot, and flag the conversation for a human. The
    // 🚨 owner alert is fired by the notification service off emergency.detected.
    await sendAs('bot', conversationId, () =>
      sender.sendText(clinic, inbound.from, analysis.overrideReply)
    );
    await store.conversations.update(tenantId, conversationId, { status: 'needs_human', aiPaused: true });
    bus.publish('conversation.updated', {
      tenantId,
      conversationId,
      patch: { status: 'needs_human', aiPaused: true },
    });
    await logAnalyzed();
    return { tenantId, conversationId, emergency: analysis.emergency };
  }

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
      const row = await store.unanswered.upsertByNorm(tenantId, {
        norm: normalizeQuestion(inbound.text),
        question: String(inbound.text).slice(0, 300),
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

  if (out.appointment) {
    bus.publish('appointment.created', { tenantId, conversationId, appointment: out.appointment });
  }

  if (out.handoff) {
    // Bot steps back: flag for a human and pause until staff hand control back.
    await store.conversations.update(tenantId, conversationId, { status: 'needs_human', aiPaused: true });
    bus.publish('handoff.requested', {
      tenantId,
      conversationId,
      handoff: out.handoff,
      lastMessage: inbound.text,
      patientWaId: inbound.from,
    });
    bus.publish('conversation.updated', {
      tenantId,
      conversationId,
      patch: { status: 'needs_human', aiPaused: true },
    });
  }

  return { tenantId, conversationId, out, lead: analysis.lead || null };
}
