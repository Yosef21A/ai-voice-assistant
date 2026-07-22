// Process-wide event bus (P1-C).
//
// One in-process EventEmitter that every subsystem publishes to and that the
// SSE endpoint (and, from P1-E, the owner-notification worker) subscribes to.
// It is deliberately tiny and dependency-free: `emit`/`on` from node:events plus
// a documented catalog and a normalized envelope so consumers can filter by
// tenant without re-parsing payloads.
//
// Envelope (what every subscriber receives):
//   { type, tenantId, at, conversationId?, actor?, ...payload }
//
// ── Event catalog ────────────────────────────────────────────────────────────
// Emitted TODAY (wired in this slice):
//   message.in            a patient message was received + persisted
//                         { conversationId, actor:'patient', message }
//   message.out           an outbound message was sent + persisted (bot OR staff)
//                         { conversationId, actor:'bot'|'staff:<uid>', message }
//   conversation.updated  status / ai_paused / lastMessageAt changed
//                         { conversationId, patch }
//   appointment.created   the engine booked an appointment
//                         { conversationId?, appointment }
//   appointment.updated   an appointment status changed from the dashboard
//                         { appointmentId, status, appointment }
//   handoff.requested     the engine detected a human-handoff intent (bot steps back)
//                         { conversationId, handoff }
// Reserved — emitted from P1-E once detection lands (documented now so consumers
// and the notification worker can code against a stable contract):
//   lead.hot              a high-value procedure / quote request was detected
//                         { conversationId, lead }
//   emergency.detected    an emergency keyword tripped; bot steps back, staff alerted
//                         { conversationId, keyword }
import { EventEmitter } from 'node:events';

export const EVENT_TYPES = Object.freeze([
  'message.in',
  'message.out',
  'conversation.updated',
  'appointment.created',
  'appointment.updated',
  'handoff.requested',
  'lead.hot',
  'lead.updated',
  'emergency.detected',
  'media.received',
  'kb.unanswered',
  // P2-HUMANIZE: the assistant flagged a conversation for the owner without
  // pausing itself (llm notify_admin action) → owner WhatsApp alert.
  'admin.notify',
  // P2-HUMANIZE: audit-only — an LLM turn failed and classic answered instead.
  'llm.fallback',
]);

const FIREHOSE = 'event'; // single channel the SSE layer listens on

export class ClinicEventBus extends EventEmitter {
  constructor() {
    super();
    // SSE opens one listener per connected dashboard; lift the default cap so a
    // busy clinic never trips Node's MaxListenersExceededWarning.
    this.setMaxListeners(0);
  }

  /**
   * Publish a domain event. Emits on the firehose ('event') for the SSE fan-out
   * AND on the specific type channel for targeted consumers (P1-E notifications).
   * @param {string} type   one of EVENT_TYPES
   * @param {object} evt    must carry { tenantId }, plus event-specific payload
   * @returns {object} the normalized envelope that was emitted
   */
  publish(type, evt = {}) {
    if (!EVENT_TYPES.includes(type)) {
      // Never throw from the hot path — a mistyped event must not break a turn.
      // Surface it loudly in logs so it is caught in dev.
      // eslint-disable-next-line no-console
      console.warn(`[bus] publish() unknown event type: ${type}`);
    }
    const envelope = { at: new Date().toISOString(), ...evt, type };
    this.emit(FIREHOSE, envelope);
    this.emit(type, envelope);
    return envelope;
  }

  /**
   * Subscribe to the firehose. Returns an unsubscribe function.
   * @param {(envelope:object)=>void} handler
   */
  subscribe(handler) {
    this.on(FIREHOSE, handler);
    return () => this.off(FIREHOSE, handler);
  }
}

/** Factory — each composed app owns one bus (see src/server.js createApp). */
export function createBus() {
  return new ClinicEventBus();
}

export default createBus;
