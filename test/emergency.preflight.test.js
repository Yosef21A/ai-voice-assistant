// Emergency PREFLIGHT (V1 prerequisite) — the deterministic safety override must
// not sit behind the LLM.
//
// Before this change `analyzeInbound` ran only AFTER `await engine.handleMessage`,
// so a patient typing "صدري يوجعني" waited out the whole Gemini budget
// (geminiTimeoutMs 8000 + retry backoff + a second 8000ms attempt ≈ 17s) before
// being told to call an ambulance — and a 429 could starve the reply entirely.
// Emergency detection is a regex pass costing ~0ms and cannot rate-limit, so it
// now runs first and the model never gates it.
//
// These tests pin the two properties that matter and one regression:
//   · the override is produced with the engine NEVER consulted;
//   · it is localized from the patient's own text (buildEmergencyReply defaults
//     to FRENCH for an unknown lang — an Arabic speaker in crisis must not get
//     a French message, and the existing e2e only asserted 🚨 + "190", which are
//     identical in all three languages and would have stayed green through it);
//   · emergency.detected is emitted exactly ONCE per turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from '../test-helpers/client.js';
import { ingestInbound } from '../src/api/ingest.js';

const A = 'el-amen-sousse';
const EL = JSON.parse(fs.readFileSync(new URL('../data/clinics.json', import.meta.url), 'utf8'))
  .clinics.find((c) => c.id === A);
const PNID = EL.whatsapp.phoneNumberId;

const inboundOf = (from, text) => ({
  channel: 'whatsapp',
  from,
  text,
  phoneNumberId: PNID,
  messageId: `wamid.${randomUUID()}`,
  timestamp: Date.now(),
});

/** An engine that fails the test if the pipeline ever consults it. */
function forbiddenEngine() {
  const calls = [];
  return {
    calls,
    async handleMessage(inbound) {
      calls.push(inbound);
      throw new Error('engine must not be reached on an emergency turn');
    },
  };
}

function collectBusEvents(bus, type) {
  const seen = [];
  bus.subscribe?.(() => {}); // no-op if the bus has no filter API
  const orig = bus.publish.bind(bus);
  bus.publish = (t, evt) => {
    if (t === type) seen.push(evt);
    return orig(t, evt);
  };
  return seen;
}

test('emergency preflight: the override is produced WITHOUT consulting the engine', async () => {
  const app = makeTestApp();
  const engine = forbiddenEngine();
  const from = '218930000901';

  const res = await ingestInbound(
    { store: app.store, engine, sender: app.sender, bus: app.bus, mediaClient: app.mediaClient },
    inboundOf(from, 'صدري يوجعني برشا وما نجمّش نتنفّس')
  );

  assert.ok(res.emergency, 'an emergency verdict was returned');
  assert.equal(engine.calls.length, 0, 'the engine was never called — the LLM cannot gate safety');

  const conversationId = `${A}:${from}`;
  const convo = await app.store.conversations.getById(A, conversationId);
  assert.equal(convo.aiPaused, true, 'bot paused');
  assert.equal(convo.status, 'needs_human', 'flagged for a human');

  const msgs = await app.store.conversations.listMessages(A, conversationId, {});
  const bot = msgs.find((m) => m.direction === 'outbound' && m.body.by === 'bot');
  assert.ok(bot, 'the override was persisted as a bot bubble');
  assert.ok(bot.body.text.includes('🚨') && bot.body.text.includes('190'));
  app.notifier?.stop?.();
});

test('emergency preflight: the reply is localized from the patient text, not defaulted to French', async () => {
  const cases = [
    // [text, a phrase that appears ONLY in that language's template]
    ['صدري يوجعني برشا وما نجمّش نتنفّس', 'حالة طوارئ طبية'],
    ["j'ai une forte douleur thoracique", 'urgence médicale'],
    ['I have really bad chest pain', 'medical emergency'],
  ];
  for (const [text, marker] of cases) {
    const app = makeTestApp();
    const from = `21893000${Math.floor(1000 + Math.random() * 8999)}`;
    await ingestInbound(
      { store: app.store, engine: forbiddenEngine(), sender: app.sender, bus: app.bus, mediaClient: app.mediaClient },
      inboundOf(from, text)
    );
    const msgs = await app.store.conversations.listMessages(A, `${A}:${from}`, {});
    const bot = msgs.find((m) => m.direction === 'outbound' && m.body.by === 'bot');
    assert.ok(bot, `override sent for ${JSON.stringify(text)}`);
    assert.ok(
      bot.body.text.includes(marker),
      `expected the reply to ${JSON.stringify(text)} to be localized (looking for ${JSON.stringify(marker)}), got ${JSON.stringify(bot.body.text.slice(0, 90))}`
    );
    app.notifier?.stop?.();
  }
});

test('emergency preflight: an Arabizi voice-style emergency is caught before the engine too', async () => {
  const app = makeTestApp();
  const engine = forbiddenEngine();
  const from = '218930000902';
  const res = await ingestInbound(
    { store: app.store, engine, sender: app.sender, bus: app.bus, mediaClient: app.mediaClient },
    inboundOf(from, '3andi wja3 kbir barcha fi sadri w ma najjamtsh ntnaffes')
  );
  assert.ok(res.emergency, 'Arabizi emergency detected');
  assert.equal(res.emergency.category, 'chest_pain');
  assert.equal(engine.calls.length, 0, 'still never reaches the engine');
  app.notifier?.stop?.();
});

test('emergency preflight: emergency.detected is emitted exactly once per turn', async () => {
  const app = makeTestApp();
  const seen = collectBusEvents(app.bus, 'emergency.detected');
  await ingestInbound(
    { store: app.store, engine: forbiddenEngine(), sender: app.sender, bus: app.bus, mediaClient: app.mediaClient },
    inboundOf('218930000903', 'ما ينجمش يتنفس، عاونونا')
  );
  assert.equal(seen.length, 1, `expected one emergency.detected, got ${seen.length}`);
  app.notifier?.stop?.();
});

test('a NON-emergency turn is unaffected: the engine runs and the lead verdict still fires', async () => {
  const app = makeTestApp();
  const seenLeads = collectBusEvents(app.bus, 'lead.hot');
  // +218 (Libya) asking a cosmetic-surgery price is the canonical hot lead.
  const res = await ingestInbound(
    { store: app.store, engine: app.engine, sender: app.sender, bus: app.bus, mediaClient: app.mediaClient },
    inboundOf('218930000904', 'نحب نعرف قداش تكلف عملية تجميل الأنف')
  );
  assert.ok(res.out, 'the engine ran normally');
  assert.equal(seenLeads.length, 1, 'the lead verdict still fires with skipEmergency');
  app.notifier?.stop?.();
});
