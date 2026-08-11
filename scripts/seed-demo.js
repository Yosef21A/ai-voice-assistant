#!/usr/bin/env node
// scripts/seed-demo.js — seed a small, clearly demo-tagged conversation set so a
// fresh dashboard opens looking alive (Live Inbox + Appointments populated).
//
//   npm run demo
//
// GUARDED + NON-DESTRUCTIVE: it never wipes runtime data and is idempotent — if
// the demo threads already exist it exits without touching anything. Every demo
// patient uses the obvious +216 90 000 00xx range so they are easy to spot and
// delete. Runs fully offline through the SAME ingest pipeline the webhook uses
// (mock sender), so the transcripts, the appointment and the events are real.
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { createStore } from '../src/store/index.js';
import { createEngine } from '../src/engine/index.js';
import { getProvider } from '../src/llm/index.js';
import { createSender } from '../src/whatsapp/index.js';
import { createBus } from '../src/events/bus.js';
import { createOutboundRecorder } from '../src/api/outbound.js';
import { ingestInbound } from '../src/api/ingest.js';

const DEMO_TENANT = process.env.DEMO_TENANT || 'el-amen-sousse';
const DEMO_PNID = process.env.DEMO_PNID || '1000000001'; // el-amen-sousse phone_number_id

// Four scripted threads = the four things that light up an owner's dashboard:
// a completed booking, a hot lead, a human-handoff request, and an emergency.
const THREADS = [
  {
    from: '21690000010',
    script: [
      'السلام عليكم',
      'نحب نحجز موعد',
      'أمراض القلب',
      'نهار الاثنين الساعة 10 صباحاً',
      'اسمي سالم الهمالي',
      'من طرابلس، ليبيا',
      'رقمي +218 91 000 0010',
      'نعم أكد الحجز',
    ],
  },
  { from: '21690000011', script: ['Bonjour, combien coûte une chirurgie esthétique ?'] },
  { from: '21690000012', script: ['Can I talk to a human please?'] },
  { from: '21690000013', script: ['صدري يوجعني برشا وما نجمّش نتنفّس'] },
];

async function main() {
  const config = getConfig();
  const store = createStore({ clinicsFile: config.clinicsFile, runtimeDir: config.runtimeDir });

  // Idempotency guard: if the first demo thread exists, we already seeded.
  const marker = await store.conversations.get(DEMO_TENANT, THREADS[0].from);
  if (marker) {
    console.log('[demo] demo threads already present — nothing to do (non-destructive).');
    return;
  }

  const provider = getProvider(config);
  const engine = createEngine({ store, provider, config });
  const bus = createBus();
  const sender = createSender({
    onOutbound: createOutboundRecorder({ store, bus }),
    outboxFile: path.join(config.runtimeDir, 'outbox.json'),
  });

  for (const th of THREADS) {
    for (const text of th.script) {
      // eslint-disable-next-line no-await-in-loop
      await ingestInbound(
        { store, engine, sender, bus },
        {
          channel: 'whatsapp',
          from: th.from,
          text,
          phoneNumberId: DEMO_PNID,
          messageId: `demo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          timestamp: Date.now(),
        }
      );
    }
  }

  const appts = await store.appointments.list(DEMO_TENANT);
  const convos = (await store.conversations.list(DEMO_TENANT)).filter((c) =>
    String(c.patientWaId ?? c.waId).startsWith('216900000')
  );
  console.log(
    `[demo] seeded ${convos.length} demo conversation(s) and ${appts.length} appointment(s) for ${DEMO_TENANT}.`
  );
  console.log('[demo] start the server (npm start) and sign in to see them live in the Inbox.');
}

main().catch((err) => {
  console.error('[demo] failed:', err);
  process.exit(1);
});
