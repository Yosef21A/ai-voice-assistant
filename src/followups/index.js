// Smart follow-ups (V4) — never let a lead die. A deterministic sibling of the
// V2 reminder scheduler: every tick derives which conversations deserve ONE
// gentle nudge, sends it inside Meta's 24h service window only, honors quiet
// hours, and hard-caps at ONE nudge per conversation forever. An opt-out
// ("لا شكراً" right after a nudge) is respected instantly and permanently
// (handled in ingest via resolveNudgeReply below).
//
// Trigger types (per-tenant toggles in config.followups):
//   leadSilent   — an OPEN lead whose conversation went silent ≥ N hours after
//                  the bot spoke last (default 4h). The money on the floor.
//   resumeFlow   — a booking (or facilitator qualification) abandoned mid-flow
//                  ≥ 2h: resume with everything kept, re-asking the pending
//                  question (sending the nudge refreshes the conversation, so
//                  the patient's answer lands on the right step again).
//   postVisit    — appointment done + date passed: a care message + review ask.
//
// Personas: cabinets nudge in the doctor's-assistant voice, facilitators in
// the agency concierge voice — same t() convention as everywhere else.
import { t } from '../engine/responses.js';
import { inQuietHours } from '../notifications/service.js';
import { isSandboxWaId } from '../stats/index.js';
import { hasDoctorPersona, doctorName, isFacilitator } from '../engine/tenantProfile.js';
import { specialtyLabel, specialtyList, buildSummary } from '../engine/booking.js';

const HOUR = 3600 * 1000;
const RESUME_AFTER_MS = 2 * HOUR;
const POST_VISIT_MAX_AGE_MS = 7 * 24 * HOUR; // don't dig up ancient visits

const followupCfg = (clinic) => {
  const c = clinic?.followups && typeof clinic.followups === 'object' ? clinic.followups : {};
  return {
    enabled: c.enabled !== false,
    leadSilent: c.leadSilent !== false,
    resumeFlow: c.resumeFlow !== false,
    postVisit: c.postVisit !== false,
    leadSilentHours: Number(c.leadSilentHours) > 0 ? Number(c.leadSilentHours) : 4,
  };
};

const langOf = (convo, clinic) =>
  ['ar', 'fr', 'en'].includes(convo?.lang) ? convo.lang : clinic?.languages?.[0] || 'ar';

// The pending booking-step question, re-asked by a resume nudge.
const STEP_KEYS = { datetime: 'askDatetime', name: 'askName', origin: 'askOrigin', contact: 'askContact' };
function pendingQuestion(clinic, state, lang) {
  const step = state?.step;
  if (state?.flow === 'qualify') return t(lang, 'qualifyAskProcedure'); // safe generic re-entry
  if (step === 'specialty') return t(lang, 'askSpecialty', { list: specialtyList(clinic, lang) });
  if (step === 'confirm') {
    // The hottest resume of all: everything is collected, one «نعم» books it.
    // Re-render the recap from the kept slots (template-rendered, never prose).
    try {
      return `${t(lang, 'confirmRetry')}\n${buildSummary({ clinic, lang, convo: { state } })}`;
    } catch {
      return t(lang, 'confirmRetry');
    }
  }
  const key = STEP_KEYS[step];
  return key ? t(lang, key) : null;
}

/**
 * Build the nudge text for a conversation, or null when nothing applies.
 * Pure — the service and tests share it.
 */
export function buildNudge({ clinic, convo, lead, appointment, type, lang }) {
  const doctor = hasDoctorPersona(clinic) ? doctorName(clinic, lang) : null;
  if (type === 'leadSilent') {
    const procedure =
      (lead?.procedure && specialtyLabel(clinic, lead.procedure, lang)) ||
      lead?.details?.procedureLabel ||
      null;
    if (isFacilitator(clinic)) {
      return t(lang, 'nudgeLeadFacilitator', { agency: clinic.name, procedure });
    }
    return t(lang, 'nudgeLead', { procedure, doctor });
  }
  if (type === 'resumeFlow') {
    const question = pendingQuestion(clinic, convo.state, lang);
    if (!question) return null;
    const intro = isFacilitator(clinic)
      ? t(lang, 'nudgeResumeFacilitator')
      : t(lang, 'nudgeResume', { doctor });
    return `${intro}\n${question}`;
  }
  if (type === 'postVisit') {
    return t(lang, 'nudgePostVisit', { name: appointment?.patientName || '', doctor, clinic: clinic.name });
  }
  return null;
}

/**
 * Opt-out / reply bookkeeping for the turn AFTER a nudge (called from ingest).
 * A decline right after a nudge is an instant, permanent opt-out with ONE warm
 * ack; any other reply just marks the nudge as answered (stats).
 * @returns {{handled:boolean, replyText?:string}}
 */
export async function resolveNudgeReply({ store, clinic, convo, yn }) {
  const n = convo.nudge;
  if (!n || n.replied) return { handled: false };
  const patch = { nudge: { ...n, replied: true, repliedAt: new Date().toISOString() } };
  if (yn === 'no') {
    patch.nudgeOptOut = true;
    await store.conversations.update(clinic.id, convo.id, patch).catch(() => {});
    return { handled: true, replyText: t(langOf(convo, clinic), 'nudgeOptOutAck') };
  }
  await store.conversations.update(clinic.id, convo.id, patch).catch(() => {});
  return { handled: false }; // engine still answers the actual message
}

/**
 * @param {object} deps { store, sender, bus, config, now?, logger? }
 */
export function createFollowupService({ store, sender, bus, config = {}, now, logger } = {}) {
  if (!store) throw new Error('createFollowupService: store is required');
  if (!sender) throw new Error('createFollowupService: sender is required');
  const clock = typeof now === 'function' ? now : () => new Date();
  const log = typeof logger === 'function' ? logger : () => {};
  let timer = null;
  let ticking = false;

  const audit = (tenantId, payload) =>
    store.events?.append?.(tenantId, { type: 'nudge.sent', actor: 'followup', ...payload })?.catch?.(() => {});

  async function windowOpen(tenantId, convo, nowMs) {
    try {
      const msgs = await store.conversations.listMessages(tenantId, convo.id, {});
      let lastIn = null;
      let lastAny = null;
      let lastDir = null;
      for (const m of msgs) {
        if (m.direction === 'inbound') lastIn = m.ts;
        lastAny = m.ts;
        lastDir = m.direction;
      }
      return {
        open: !!lastIn && nowMs - new Date(lastIn).getTime() < 24 * HOUR,
        lastTs: lastAny,
        botSpokeLast: lastDir === 'outbound',
      };
    } catch {
      return { open: false, lastTs: null, botSpokeLast: false };
    }
  }

  async function nudge(clinic, convo, type, extras, nowDate) {
    const lang = langOf(convo, clinic);
    const text = buildNudge({ clinic, convo, lang, type, ...extras });
    if (!text) return false;
    // Re-check the LIVE row just before sending: a takeover/emergency (or a
    // competing nudge) may have landed while this tick was iterating.
    const fresh = await store.conversations.get(clinic.id, convo.waId).catch(() => null);
    if (!fresh || fresh.aiPaused || fresh.status === 'needs_human' || fresh.nudge || fresh.nudgeOptOut) {
      return false;
    }
    const res = await sender.sendText(clinic, convo.waId, text);
    if (!res?.ok) {
      log('nudge send failed', clinic.id, convo.id, res?.error?.message);
      return false;
    }
    // ONE nudge per conversation, forever — the record IS the cap.
    await store.conversations
      .update(clinic.id, convo.id, { nudge: { type, at: nowDate.toISOString() } })
      .catch(() => {});
    await audit(clinic.id, { conversationId: convo.id, payload: { type } });
    bus?.publish?.('nudge.sent', { tenantId: clinic.id, conversationId: convo.id, type });
    return true;
  }

  async function tickOnce(nowArg) {
    if (typeof store.listClinics !== 'function') return { sent: 0 };
    const nowDate = nowArg ? new Date(nowArg) : clock();
    const nowMs = nowDate.getTime();
    const counts = { sent: 0, skipped_window: 0 };

    for (const clinic of store.listClinics()) {
      const cfg = followupCfg(clinic);
      if (!cfg.enabled) continue;
      const quiet = clinic.notifications?.quietHours?.enabled ? clinic.notifications.quietHours : null;
      const tz = clinic.timezone || 'Africa/Tunis';
      if (quiet && inQuietHours(nowDate, { start: quiet.from, end: quiet.to }, tz)) continue;

      let convos = [];
      try {
        convos = await store.conversations.list(clinic.id, {});
      } catch {
        continue;
      }
      const leadsByConvo = new Map();
      try {
        for (const l of await store.leads.list(clinic.id, {})) {
          if (l.conversationId && ['new', 'contacted'].includes(l.status)) leadsByConvo.set(l.conversationId, l);
        }
      } catch {
        /* leads optional */
      }
      let allAppts = [];
      try {
        allAppts = await store.appointments.list(clinic.id, {});
      } catch {
        /* ignore */
      }
      const doneAppts = cfg.postVisit
        ? allAppts.filter((a) => {
            if (a.status !== 'done') return false;
            const iso = a.datetimeISO ?? a.datetimeIso;
            const ms = iso ? new Date(iso).getTime() : NaN;
            return !Number.isNaN(ms) && ms <= nowMs && nowMs - ms < POST_VISIT_MAX_AGE_MS;
          })
        : [];
      const doneByWaId = new Map(doneAppts.map((a) => [a.patientWaId, a]));
      // A patient who already ACTED (booked, came, or is booked) must never get
      // the "shall we book you in?" lead nudge — the lead did not die.
      const actedWaIds = new Set(
        allAppts
          .filter((a) => ['pending', 'confirmed', 'done'].includes(a.status))
          .map((a) => a.patientWaId)
      );

      for (const convo of convos) {
        if (!convo.waId || isSandboxWaId(convo.waId)) continue;
        if (convo.nudge || convo.nudgeOptOut) continue; // hard cap: one, ever
        if (convo.aiPaused || convo.status === 'needs_human') continue; // humans own it

        const { open, lastTs, botSpokeLast } = await windowOpen(clinic.id, convo, nowMs);
        const idleMs = lastTs ? nowMs - new Date(lastTs).getTime() : null;
        if (idleMs == null) continue;
        // If the PATIENT spoke last, the bot owes a reply — a "just checking
        // in" nudge on top of an unanswered message would be tone-deaf (and
        // hides a real failure). Humans triage those via the inbox.
        if (!botSpokeLast) continue;

        // Pick the ONE trigger that applies (priority: resume > lead > visit).
        let type = null;
        const extras = {};
        const midFlow =
          (convo.state?.flow === 'booking' || convo.state?.flow === 'qualify') && convo.state.step !== 'done';
        if (cfg.resumeFlow && midFlow && idleMs >= RESUME_AFTER_MS) {
          type = 'resumeFlow';
        } else if (
          cfg.leadSilent &&
          leadsByConvo.has(convo.id) &&
          !actedWaIds.has(convo.waId) &&
          idleMs >= cfg.leadSilentHours * HOUR
        ) {
          type = 'leadSilent';
          extras.lead = leadsByConvo.get(convo.id);
        } else if (cfg.postVisit && !convo.state?.flow && doneByWaId.has(convo.waId) && idleMs >= 4 * HOUR) {
          type = 'postVisit';
          extras.appointment = doneByWaId.get(convo.waId);
        }
        if (!type) continue;

        if (!open) {
          // Outside the 24h window a free-form nudge is forbidden (Meta) — log
          // honestly; the template path arrives with the production number.
          counts.skipped_window += 1;
          await store.events
            ?.append?.(clinic.id, {
              type: 'nudge.skipped',
              actor: 'followup',
              conversationId: convo.id,
              payload: { type, reason: 'service_window_closed' },
            })
            ?.catch?.(() => {});
          // Record the attempt as the conversation's one nudge? NO — the
          // window may reopen (patient writes again), and then the nudge is
          // moot anyway (they came back). Leave unrecorded.
          continue;
        }

        try {
          if (await nudge(clinic, convo, type, extras, nowDate)) counts.sent += 1;
        } catch (e) {
          log('nudge failed', clinic.id, convo.id, e?.message);
        }
      }
    }
    return counts;
  }

  async function tick(nowArg) {
    if (ticking) return { sent: 0, skipped: 'reentrant' };
    ticking = true;
    try {
      return await tickOnce(nowArg);
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    start() {
      const interval = Number(config.followupsIntervalMs) || 0;
      if (interval <= 0 || timer) return;
      timer = setInterval(() => {
        tick().catch((e) => log('followup tick failed', e?.message));
      }, interval);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export default createFollowupService;
