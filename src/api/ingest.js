// Inbound ingestion pipeline — shared by the webhook and reusable by any future
// transport. Keeps the engine transport-agnostic: it just consumes the same
// normalized inbound shape server.js already builds. Responsibilities:
//   1. resolve the tenant (still keyed on phone_number_id),
//   2. persist the inbound message to the normalized transcript + emit,
//   3. respect ai_paused (bot silent during human takeover),
//   4. run the engine, dispatch replies through the ONE sender (onOutbound
//      persists + emits each bubble), and emit appointment.created /
//      handoff.requested derived from the engine result.
import { sendAs, publicMessage } from './outbound.js';

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

  if (out.replies && out.replies.length) {
    await sendAs('bot', conversationId, () => sender.sendEngineReply(clinic, inbound.from, out));
  }

  if (out.appointment) {
    bus.publish('appointment.created', { tenantId, conversationId, appointment: out.appointment });
  }

  if (out.handoff) {
    // Bot steps back: flag for a human and pause until staff hand control back.
    await store.conversations.update(tenantId, conversationId, { status: 'needs_human', aiPaused: true });
    bus.publish('handoff.requested', { tenantId, conversationId, handoff: out.handoff });
    bus.publish('conversation.updated', {
      tenantId,
      conversationId,
      patch: { status: 'needs_human', aiPaused: true },
    });
  }

  return { tenantId, conversationId, out };
}
