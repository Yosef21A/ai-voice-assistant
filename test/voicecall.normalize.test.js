// Calling-API webhook normalization (V1).
//
// The payloads below are the shapes Meta documents for `change.field === 'calls'`
// (verified 2026-07-31). The contract this suite locks down: message webhooks
// stay untouched, mixed bodies split cleanly, and NOTHING here ever throws —
// a malformed webhook must degrade to "no call events", never to a 500 that
// makes Meta retry forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCallEvents } from '../src/voice-call/normalize.js';
import { normalizeWhatsApp } from '../src/server.js';

const PNID = '1153135121224452';
const SDP =
  'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=candidate:1 1 udp 2130706431 10.0.0.1 51234 typ host\r\n';

const callsBody = (calls) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA',
      changes: [
        {
          field: 'calls',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '+216 73 000 111', phone_number_id: PNID },
            calls,
          },
        },
      ],
    },
  ],
});

const CONNECT = {
  id: 'wacid.HBgLM…',
  from: '21690000001',
  to: PNID,
  event: 'connect',
  direction: 'USER_INITIATED',
  timestamp: '1671644824',
  session: { sdp_type: 'offer', sdp: SDP },
};

const TERMINATE = {
  id: 'wacid.HBgLM…',
  to: PNID,
  from: '21690000001',
  event: 'terminate',
  direction: 'USER_INITIATED',
  status: 'Completed',
  start_time: '1671644824',
  end_time: '1671644871',
  duration: 47,
};

test('connect: SDP offer, tenant, caller and timestamp are all carried through', () => {
  const [ev, ...rest] = normalizeCallEvents(callsBody([CONNECT]));
  assert.equal(rest.length, 0);
  assert.equal(ev.channel, 'whatsapp-call');
  assert.equal(ev.kind, 'connect');
  assert.equal(ev.callId, 'wacid.HBgLM…');
  assert.equal(ev.from, '21690000001');
  assert.equal(ev.to, PNID);
  assert.equal(ev.phoneNumberId, PNID, 'tenant resolution keys on the same field as messages');
  assert.equal(ev.direction, 'USER_INITIATED');
  assert.equal(ev.sdpOffer, SDP);
  assert.equal(ev.sdpType, 'offer');
  assert.equal(ev.timestamp, 1671644824 * 1000, 'Meta sends epoch SECONDS');
  assert.equal(ev.status, null);
});

test('terminate: status + duration + start/end times', () => {
  const [ev] = normalizeCallEvents(callsBody([TERMINATE]));
  assert.equal(ev.kind, 'terminate');
  assert.equal(ev.status, 'Completed');
  assert.equal(ev.durationSec, 47);
  assert.equal(ev.startTime, 1671644824 * 1000);
  assert.equal(ev.endTime, 1671644871 * 1000);
  assert.equal(ev.sdpOffer, null);
});

test('a mixed messages+calls body splits cleanly between the two normalizers', () => {
  const body = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: PNID },
              messages: [
                { from: '21690000002', id: 'wamid.X', timestamp: '1671644800', type: 'text', text: { body: 'salut' } },
              ],
            },
          },
          {
            field: 'calls',
            value: { metadata: { phone_number_id: PNID }, calls: [CONNECT] },
          },
        ],
      },
    ],
  };
  const calls = normalizeCallEvents(body);
  const messages = normalizeWhatsApp(body);
  assert.equal(calls.length, 1, 'only the calls change becomes a call event');
  assert.equal(calls[0].kind, 'connect');
  assert.equal(messages.length, 1, 'the message half is untouched');
  assert.equal(messages[0].text, 'salut');
});

test('message-only bodies produce no call events (and vice versa)', () => {
  const msgBody = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: PNID },
              statuses: [{ id: 'wamid.Y', status: 'delivered' }],
            },
          },
        ],
      },
    ],
  };
  assert.deepEqual(normalizeCallEvents(msgBody), []);
  assert.deepEqual(normalizeWhatsApp(callsBody([CONNECT])), []);
});

test('multiple calls in one change all come through, in order', () => {
  const evs = normalizeCallEvents(
    callsBody([CONNECT, { ...TERMINATE, id: 'wacid.SECOND' }])
  );
  assert.equal(evs.length, 2);
  assert.deepEqual(evs.map((e) => e.kind), ['connect', 'terminate']);
  assert.equal(evs[1].callId, 'wacid.SECOND');
});

test('an unknown event value is surfaced as kind:"other", never dropped silently', () => {
  const [ev] = normalizeCallEvents(callsBody([{ id: 'wacid.Z', event: 'ringing' }]));
  assert.equal(ev.kind, 'other');
  assert.equal(ev.event, 'ringing', 'the raw event name survives for the log line');
});

test('garbage tolerance: nothing throws, everything degrades to []', () => {
  const junk = [
    undefined,
    null,
    {},
    { entry: null },
    { entry: 'nope' },
    { entry: [null, 3, 'x'] },
    { entry: [{ changes: null }] },
    { entry: [{ changes: [null, { value: null }] }] },
    { entry: [{ changes: [{ field: 'calls', value: { calls: 'not-an-array' } }] }] },
    { entry: [{ changes: [{ field: 'calls', value: { calls: [null, 7] } }] }] },
  ];
  for (const b of junk) {
    assert.deepEqual(normalizeCallEvents(b), [], JSON.stringify(b));
  }
});

test('partial call objects still normalize (missing session / timestamp / metadata)', () => {
  const body = {
    entry: [{ changes: [{ field: 'calls', value: { calls: [{ id: 'wacid.P', event: 'connect' }] } }] }],
  };
  const [ev] = normalizeCallEvents(body);
  assert.equal(ev.callId, 'wacid.P');
  assert.equal(ev.phoneNumberId, null);
  assert.equal(ev.from, null);
  assert.equal(ev.sdpOffer, null);
  assert.ok(Number.isFinite(ev.timestamp), 'a missing timestamp falls back to now, never NaN');
  assert.equal(ev.durationSec, null);
});

test('a millisecond timestamp (harness payloads) is not multiplied again', () => {
  const nowMs = Date.now();
  const [ev] = normalizeCallEvents(callsBody([{ ...CONNECT, timestamp: String(nowMs) }]));
  assert.equal(ev.timestamp, nowMs);
});
