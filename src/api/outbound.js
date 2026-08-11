// Outbound message persistence — the SINGLE writer of outbound transcript rows.
//
// Every send (bot reply, staff message, later owner notification) flows through
// one sender whose onOutbound hook lands here. To attribute the row to the right
// actor WITHOUT threading a parameter through the sender, the caller wraps the
// send in sendAs(actor, conversationId, fn); AsyncLocalStorage carries that
// context across the awaited send so the recorder can read it. This keeps
// message logging in one place (no double-writes) and correctly tags bot vs
// staff for the inbox 🤖/👤 badge.
import { AsyncLocalStorage } from 'node:async_hooks';

const outboundCtx = new AsyncLocalStorage();

/** Run a send with an attributed actor + known conversation. */
export function sendAs(actor, conversationId, fn) {
  return outboundCtx.run({ actor, conversationId }, fn);
}

/** Normalize a stored message record into the API / SSE shape. */
export function publicMessage(m) {
  if (!m) return null;
  const body = m.body || {};
  // Media metadata (P2-D): expose display fields + a fetch URL keyed by the
  // MESSAGE id — the on-disk path never leaves the server.
  const media = body.media
    ? {
        kind: body.media.kind,
        mimeType: body.media.mimeType ?? null,
        filename: body.media.filename ?? null,
        size: body.media.size ?? null,
        available: !!body.media.file,
        url: body.media.file ? `/api/media/${encodeURIComponent(m.id)}` : null,
        // Voice transcript (V1) — staff gold. Flagged with its grade so the
        // inbox can say "low-confidence" rather than presenting a machine guess
        // as fact. publicMessage is the single normalization point for BOTH the
        // REST thread route and every SSE frame, so the live stream gets it free.
        transcript: body.media.transcript
          ? {
              text: body.media.transcript.text,
              lang: body.media.transcript.lang ?? null,
              grade: body.media.transcript.grade ?? null,
              durationSec: body.media.transcript.durationSec ?? null,
            }
          : null,
      }
    : null;
  return {
    id: m.id,
    conversationId: m.conversationId,
    direction: m.direction,
    type: m.type,
    text: body.text ?? '',
    by: body.by ?? (m.direction === 'inbound' ? 'patient' : 'bot'),
    media,
    waMessageId: m.waMessageId ?? null,
    status: m.status ?? null,
    ts: m.ts,
  };
}

// Extract a human-readable text from the exact Graph payload the sender built.
function outboundText(record) {
  const p = record.payload || {};
  switch (record.kind) {
    case 'text':
      return p.text?.body ?? '';
    case 'buttons':
      return p.interactive?.body?.text ?? '';
    case 'template':
      return `[template:${p.template?.name ?? ''}]`;
    case 'media':
      return `[media:${p.type ?? ''}]`;
    default:
      return '';
  }
}

/**
 * Build the sender's onOutbound hook: persist the outbound message + emit
 * message.out. Never throws (the sender also guards it).
 * @param {object} deps { store, bus }
 */
export function createOutboundRecorder({ store, bus }) {
  return async function onOutbound(record) {
    if (!record || !record.ok) return; // only successful sends become rows
    if (record.kind === 'read') return; // read receipts are not transcript rows
    const tenantId = record.tenantId;
    const to = record.to;
    if (!tenantId || !to) return;

    const ctx = outboundCtx.getStore() || {};
    const actor = ctx.actor || 'bot';
    let conversationId = ctx.conversationId;
    if (!conversationId) {
      const convo = await store.conversations.get(tenantId, to);
      if (!convo) return; // e.g. an owner notification to a non-patient number (P1-E)
      conversationId = convo.id;
    }

    const msg = await store.conversations.appendMessage(tenantId, conversationId, {
      direction: 'outbound',
      type: record.kind === 'buttons' ? 'buttons' : record.kind || 'text',
      body: { text: outboundText(record), by: actor },
      waMessageId: record.waMessageId || null,
      status: 'sent',
      ts: record.at,
    });
    bus.publish('message.out', { tenantId, conversationId, actor, message: publicMessage(msg) });
  };
}
