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

export async function ingestInbound({ store, engine, sender, bus }, inbound) {
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

  // Persist inbound + fan out (staff see the patient even while the bot is paused).
  const inMsg = await store.conversations.appendMessage(tenantId, conversationId, {
    direction: 'inbound',
    type: 'text',
    body: { text: inbound.text, by: 'patient' },
    waMessageId: inbound.messageId ?? null,
    ts: new Date(inbound.timestamp || Date.now()).toISOString(),
  });
  bus.publish('message.in', { tenantId, conversationId, actor: 'patient', message: publicMessage(inMsg) });
  bus.publish('conversation.updated', { tenantId, conversationId, patch: { lastMessageAt: inMsg.ts } });

  // Human takeover: the bot stays silent while a staff member is driving.
  if (convo.aiPaused) return { tenantId, conversationId, paused: true };

  const out = await engine.handleMessage(inbound);

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
    return { tenantId, conversationId, emergency: analysis.emergency };
  }

  if (out.replies && out.replies.length) {
    await sendAs('bot', conversationId, () => sender.sendEngineReply(clinic, inbound.from, out));
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
