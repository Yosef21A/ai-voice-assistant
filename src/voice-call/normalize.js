// WhatsApp Business Calling API → one normalized call-event shape (V1).
//
// Calling rides the SAME webhook endpoint and the SAME X-Hub-Signature-256 as
// messages: Meta just sets `change.field === "calls"` and puts the payload in
// `change.value.calls[]`. So this module is the exact sibling of
// normalizeWhatsApp() in src/server.js — deliberately tolerant, never throws on
// a partial/unknown body, and keeps the transport contract in ONE place so the
// voice-call service stays transport-agnostic (webhook today, the local call
// harness in scripts/call-harness.js today too, SIP/other tomorrow).
//
// Verified inbound shapes (Meta docs, G0 2026-07-31):
//
//   connect (an inbound call is ringing — we have ~30-60s to accept):
//     { id: "wacid.…", from: "<caller waId>", to: "<business number>",
//       event: "connect", direction: "USER_INITIATED", timestamp: "1671644824",
//       session: { sdp_type: "offer", sdp: "<RFC 8866 SDP>" } }
//
//   terminate (arrives whichever side hangs up, and also when nobody answered):
//     { id, event: "terminate", direction, status: "Completed"|"Failed",
//       start_time, end_time, duration }
//
// `change.value.metadata.phone_number_id` identifies the tenant — the same key
// messages use, so tenant resolution never forks.
const KNOWN_EVENTS = new Set(['connect', 'terminate']);

// Meta sends epoch SECONDS as strings. Anything unparseable falls back to "now"
// so a malformed timestamp can never produce NaN latencies downstream.
function toMillis(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  // Tolerate a millisecond timestamp too (some test/harness payloads use them).
  return n > 1e11 ? Math.round(n) : Math.round(n * 1000);
}

function toSeconds(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Normalize a Cloud API webhook body into an array of call events.
 * Message-only bodies yield []; mixed bodies yield only the call half.
 * @param {object} body raw webhook JSON
 * @returns {Array<object>} { channel, kind, callId, from, to, phoneNumberId,
 *   direction, timestamp, sdpOffer, sdpType, status, startTime, endTime, durationSec }
 */
export function normalizeCallEvents(body) {
  const out = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value || {};
      const calls = Array.isArray(value.calls) ? value.calls : null;
      if (!calls) continue; // messages / statuses / anything else: not ours
      const phoneNumberId = value.metadata?.phone_number_id ?? null;
      const now = Date.now();
      for (const c of calls) {
        if (!c || typeof c !== 'object') continue;
        const event = typeof c.event === 'string' ? c.event : '';
        const session = c.session && typeof c.session === 'object' ? c.session : null;
        out.push({
          channel: 'whatsapp-call',
          // Unknown events are surfaced (not dropped) so the service can log
          // exactly what Meta sent when they add one — silence would be worse.
          kind: KNOWN_EVENTS.has(event) ? event : 'other',
          event: event || null,
          callId: c.id != null ? String(c.id) : null,
          from: c.from != null ? String(c.from) : null,
          to: c.to != null ? String(c.to) : null,
          phoneNumberId: phoneNumberId != null ? String(phoneNumberId) : null,
          direction: c.direction || null,
          timestamp: toMillis(c.timestamp, now),
          sdpOffer: typeof session?.sdp === 'string' && session.sdp ? session.sdp : null,
          sdpType: session?.sdp_type ?? null,
          status: c.status || null,
          startTime: toMillis(c.start_time, null) ?? null,
          endTime: toMillis(c.end_time, null) ?? null,
          durationSec: toSeconds(c.duration),
        });
      }
    }
  }
  return out;
}

export default normalizeCallEvents;
