// Reusable tenant-config form sections. Each is CONTROLLED: it renders from a
// normalized `value` (draft) and reports edits via onChange(nextDraft). The
// wizard and Settings both mount these, then persist the relevant slice through
// PUT /api/tenant using the *Patch() extractors below.
import React from 'react';
import { useI18n } from '../context/I18nContext.jsx';
import { Field, Switch, Segmented, ChipToggle } from './ui.jsx';
import { SPECIALTY_CATALOG, specialtyObject, specialtyLabel, csvList, parseList, dirOf } from '../lib.js';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DEFAULT_WH = {
  sun: null, mon: ['08:30', '17:30'], tue: ['08:30', '17:30'], wed: ['08:30', '17:30'],
  thu: ['08:30', '17:30'], fri: ['08:30', '13:00'], sat: ['09:00', '13:00'],
};

// doctorName is stored as a plain string or an {ar,fr,en} object (same
// convention as specialty labels); the form edits FR + optional AR fields.
function doctorNameToDraft(dn) {
  if (!dn) return { doctorNameFr: '', doctorNameAr: '' };
  if (typeof dn === 'string') return { doctorNameFr: dn, doctorNameAr: '' };
  return { doctorNameFr: dn.fr || dn.en || '', doctorNameAr: dn.ar || '' };
}

// Partners (D2 facilitator) edit as one line per clinic: "Name — City — procs".
export function partnersToText(partners) {
  return (Array.isArray(partners) ? partners : [])
    .map((p) => [p.name, p.city, (p.specialties || []).join(', ')].filter(Boolean).join(' — '))
    .join('\n');
}
export function textToPartners(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      let [name, city, procs] = l.split('—').map((s) => s.trim());
      // Two-segment line whose second part is a comma list is "Name — procs"
      // (a city-less partner must round-trip, not grow a bogus city).
      if (city && procs == null && city.includes(',')) {
        procs = city;
        city = null;
      }
      const p = { name: name || l };
      if (city) p.city = city;
      if (procs) p.specialties = procs.split(',').map((s) => s.trim()).filter(Boolean);
      return p;
    });
}

/** Canonical config → editable draft. Missing sections get sane defaults. */
export function configToDraft(config = {}) {
  const persona = config.persona || {};
  const tourism = config.tourism || {};
  const esc = config.escalation || {};
  const notif = config.notifications || {};
  return {
    // D1 cabinet mode: practice type + doctor persona name. doctorNameRaw keeps
    // the stored value verbatim so a profile save round-trips keys the form
    // doesn't edit (e.g. a seeded `en` label).
    type: ['clinic', 'cabinet', 'facilitator'].includes(config.type) ? config.type : 'clinic',
    doctorNameRaw: config.doctorName ?? null,
    ...doctorNameToDraft(config.doctorName),
    // D2 facilitator: destination cities + partner-clinic routing hints.
    destinations: Array.isArray(config.destinations) ? config.destinations : [],
    partnersText: partnersToText(config.partners),
    name: config.name || '', city: config.city || '', country: config.country || '',
    timezone: config.timezone || 'Africa/Tunis', currency: config.currency || 'EUR',
    address: config.address || '', googleMapsUrl: config.googleMapsUrl || '', phone: config.phone || '',
    languages: config.languages?.length ? config.languages : ['ar', 'fr', 'en'],
    specialties: Array.isArray(config.specialties) ? config.specialties : [],
    workingHours: { ...DEFAULT_WH, ...(config.workingHours || {}) },
    holidays: config.holidays || [],
    persona: {
      botName: persona.botName || '', tone: persona.tone || 'professional',
      greeting: persona.greeting || '', spoken: persona.spoken?.length ? persona.spoken : (config.languages || ['ar', 'fr', 'en']),
    },
    tourism: {
      enabled: tourism.enabled !== false, origins: tourism.origins || ['Libye'],
      media: tourism.media !== false, partners: tourism.partners || '', visa: tourism.visa || '',
      quoteFields: tourism.quoteFields || ['procédure', 'ville d’origine', 'dates'],
    },
    escalation: {
      handoff: { name: '', phone: '', ...(config.handoff || {}), ...(esc.handoff || {}) },
      triggers: { human: true, anger: true, emergency: true, unknown: true, ...(esc.triggers || {}) },
      emergencyMsg: esc.emergencyMsg || '', staffHours: esc.staffHours || '',
    },
    notifications: {
      events: {
        booking: true, lead: true, handoff: true, emergency: true, media: true,
        morning: false, weekly: true, ...(notif.events || {}),
      },
      recipients: notif.recipients || [],
      quietHours: { enabled: false, from: '21:00', to: '08:00', ...(notif.quietHours || {}) },
      // Money line (P2-A): average booking value; '' in the draft = not set.
      avgProcedureValue: notif.avgProcedureValue ?? '',
    },
    // V2 appointment reminders — default ON (the no-show killer is the pitch).
    reminders: {
      enabled: config.reminders?.enabled !== false,
      t48: config.reminders?.t48 !== false,
      t3: config.reminders?.t3 !== false,
    },
    // V4 smart follow-ups — one gentle nudge per conversation, ever.
    followups: {
      enabled: config.followups?.enabled !== false,
      leadSilent: config.followups?.leadSilent !== false,
      resumeFlow: config.followups?.resumeFlow !== false,
      postVisit: config.followups?.postVisit !== false,
    },
  };
}

// Slice extractors — a wizard step / settings tab saves only what it owns so
// concurrent edits never clobber unrelated config.
export const profilePatch = (d) => {
  const patch = {
    name: d.name, city: d.city, country: d.country, timezone: d.timezone, currency: d.currency,
    address: d.address, googleMapsUrl: d.googleMapsUrl, phone: d.phone,
    specialties: d.specialties, workingHours: d.workingHours, holidays: d.holidays,
    type: d.type || 'clinic',
  };
  // doctorName travels ONLY for cabinets — a clinic profile save must not write
  // (or clear) a field its form never shows. Editing merges over the stored
  // object so untouched keys (a seeded `en` label) survive the round-trip.
  if (d.type === 'cabinet') {
    const fr = (d.doctorNameFr || '').trim();
    const ar = (d.doctorNameAr || '').trim();
    const base = d.doctorNameRaw && typeof d.doctorNameRaw === 'object' ? d.doctorNameRaw : null;
    patch.doctorName = ar || base ? { ...(base || {}), fr, ar } : fr;
  }
  // Facilitator fields travel only for agencies, same principle.
  if (d.type === 'facilitator') {
    patch.destinations = d.destinations;
    patch.partners = textToPartners(d.partnersText);
  }
  return patch;
};
export const personaPatch = (d) => ({ languages: d.persona.spoken, persona: d.persona });
export const tourismPatch = (d) => ({ tourism: d.tourism });
export const escalationPatch = (d) => ({ escalation: d.escalation });
export const notificationsPatch = (d) => ({
  notifications: {
    ...d.notifications,
    // '' (unset) persists as null so the stats/digest money line stays hidden.
    avgProcedureValue:
      d.notifications.avgProcedureValue === '' || d.notifications.avgProcedureValue == null
        ? null
        : Number(d.notifications.avgProcedureValue),
  },
  reminders: d.reminders,
  followups: d.followups,
});

// ── Profile ─────────────────────────────────────────────────────────────────
export function ProfileForm({ value, onChange }) {
  const { t, lang } = useI18n();
  const set = (patch) => onChange({ ...value, ...patch });
  const isCabinet = value.type === 'cabinet';
  const isFacilitator = value.type === 'facilitator';
  const selectedIds = new Set((value.specialties || []).map((s) => s.id));
  const toggleSpec = (id) => {
    // Cabinet (D1): a doctor's practice has ONE specialty — radio semantics.
    // Clicking the active chip is a no-op: a radio never deselects to zero,
    // because a cabinet with no specialty would ask an unanswerable question.
    if (isCabinet) {
      if (!selectedIds.has(id)) set({ specialties: [specialtyObject(id)] });
      return;
    }
    const next = selectedIds.has(id)
      ? value.specialties.filter((s) => s.id !== id)
      : [...value.specialties, specialtyObject(id)];
    set({ specialties: next });
  };
  // Switching clinic→cabinet with several specialties keeps only the first so
  // the saved config always matches the single-specialty contract.
  const setType = (type) => {
    const patch = { type };
    if (type === 'cabinet' && (value.specialties || []).length > 1) {
      patch.specialties = [value.specialties[0]];
    }
    set(patch);
  };
  const setDay = (day, idx, v) => {
    const cur = value.workingHours[day] || ['09:00', '17:00'];
    const pair = [...cur];
    pair[idx] = v;
    set({ workingHours: { ...value.workingHours, [day]: pair } });
  };
  const toggleClosed = (day, closed) =>
    set({ workingHours: { ...value.workingHours, [day]: closed ? null : ['09:00', '17:00'] } });

  return (
    <div className="stack">
      <Field label={t('profile.type')}>
        <Segmented
          ariaLabel={t('profile.type')}
          value={value.type || 'clinic'}
          onChange={setType}
          options={[
            { value: 'clinic', label: t('profile.typeClinic') },
            { value: 'cabinet', label: t('profile.typeCabinet') },
            { value: 'facilitator', label: t('profile.typeFacilitator') },
          ]}
        />
      </Field>
      <div className="row-wrap" style={{ gap: 'var(--sp-3)' }}>
        <Field label={isCabinet ? t('profile.cabinetName') : isFacilitator ? t('profile.agencyName') : t('profile.clinicName')} htmlFor="f-name">
          <input id="f-name" className="control" value={value.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label={t('profile.phone')} htmlFor="f-phone">
          <input id="f-phone" className="control" value={value.phone} onChange={(e) => set({ phone: e.target.value })} />
        </Field>
      </div>
      {isCabinet ? (
        <div className="row-wrap" style={{ gap: 'var(--sp-3)' }}>
          <Field label={t('profile.doctorName')} hint={t('profile.doctorNameHint')} htmlFor="f-doc">
            <input id="f-doc" className="control" value={value.doctorNameFr} onChange={(e) => set({ doctorNameFr: e.target.value })} placeholder="Ben Salem" />
          </Field>
          <Field label={t('profile.doctorNameAr')} htmlFor="f-doc-ar" optional optionalText={t('common.optional')}>
            <input id="f-doc-ar" className="control" dir="rtl" value={value.doctorNameAr} onChange={(e) => set({ doctorNameAr: e.target.value })} placeholder="بن سالم" />
          </Field>
        </div>
      ) : null}
      <div className="row-wrap" style={{ gap: 'var(--sp-3)' }}>
        <Field label={t('profile.city')} htmlFor="f-city">
          <input id="f-city" className="control" value={value.city} onChange={(e) => set({ city: e.target.value })} />
        </Field>
        <Field label={t('profile.country')} htmlFor="f-country">
          <input id="f-country" className="control" value={value.country} onChange={(e) => set({ country: e.target.value })} />
        </Field>
        <Field label={t('profile.currency')} htmlFor="f-cur">
          <input id="f-cur" className="control" value={value.currency} onChange={(e) => set({ currency: e.target.value })} />
        </Field>
      </div>
      <Field label={t('profile.address')} htmlFor="f-addr">
        <input id="f-addr" className="control" value={value.address} onChange={(e) => set({ address: e.target.value })} />
      </Field>
      <Field label={t('profile.mapsUrl')} htmlFor="f-maps" optional optionalText={t('common.optional')}>
        <input id="f-maps" className="control" inputMode="url" value={value.googleMapsUrl} onChange={(e) => set({ googleMapsUrl: e.target.value })} />
      </Field>

      {isFacilitator ? (
        <>
          <Field label={t('profile.destinations')} hint={t('profile.destinationsHint')} htmlFor="f-dest">
            <input id="f-dest" className="control" dir={dirOf(csvList(value.destinations))} value={csvList(value.destinations)} onChange={(e) => set({ destinations: parseList(e.target.value) })} placeholder="Sousse, Sfax, Tunis" />
          </Field>
          <Field label={t('profile.partners')} hint={t('profile.partnersHint')} htmlFor="f-part">
            <textarea id="f-part" className="control" rows={3} value={value.partnersText} onChange={(e) => set({ partnersText: e.target.value })} placeholder={'Clinique El Amen — Sousse — dentaire, esthétique\nPolyclinique Ennour — Sfax — dentaire'} />
          </Field>
        </>
      ) : null}

      <Field
        label={isCabinet ? t('profile.specialtyCabinet') : isFacilitator ? t('profile.proceduresCovered') : t('profile.specialties')}
        hint={isCabinet ? t('profile.specialtyCabinetHint') : isFacilitator ? t('profile.proceduresCoveredHint') : t('profile.specialtiesHint')}
      >
        <div className="chips">
          {SPECIALTY_CATALOG.map((s) => (
            <ChipToggle key={s.id} active={selectedIds.has(s.id)} onClick={() => toggleSpec(s.id)}>
              {specialtyLabel(s.id, lang)}
            </ChipToggle>
          ))}
        </div>
      </Field>

      <Field label={t('profile.workingHours')}>
        <div className="stack-2">
          {DAYS.map((day) => {
            const wh = value.workingHours[day];
            const closed = !wh;
            return (
              <div key={day} className="row" style={{ gap: 'var(--sp-3)' }}>
                <span style={{ minWidth: 92 }} className="small dim">{t(`profile.days.${day}`)}</span>
                <Switch id={`wh-${day}`} checked={!closed} onChange={(on) => toggleClosed(day, !on)} />
                {closed ? (
                  <span className="small muted">{t('profile.closed')}</span>
                ) : (
                  <span className="row" style={{ gap: 6 }}>
                    <input type="time" className="control" style={{ width: 120 }} value={wh[0]} onChange={(e) => setDay(day, 0, e.target.value)} />
                    <span className="muted">–</span>
                    <input type="time" className="control" style={{ width: 120 }} value={wh[1]} onChange={(e) => setDay(day, 1, e.target.value)} />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </Field>

      <Field label={t('profile.holidays')} hint={t('profile.holidaysHint')} htmlFor="f-hol">
        <input id="f-hol" className="control" dir={dirOf(csvList(value.holidays))} value={csvList(value.holidays)} onChange={(e) => set({ holidays: parseList(e.target.value) })} placeholder="2026-08-15, 2026-12-25" />
      </Field>
    </div>
  );
}

// ── Persona ─────────────────────────────────────────────────────────────────
const LANG_ORDER = ['ar', 'fr', 'en'];
function defaultGreeting(lang, who, doctor) {
  // Cabinet (D1): the default persona is the DOCTOR'S assistant, by name.
  if (doctor) {
    return {
      ar: `أهلاً وسهلاً 👋 أنا مساعد عيادة الدكتور ${doctor} على واتساب. كيفاش ننجّم نعاونك اليوم؟`,
      fr: `Bonjour 👋 je suis l'assistant du Dr ${doctor} sur WhatsApp. Comment puis-je vous aider ?`,
      en: `Hello 👋 I'm Dr ${doctor}'s assistant on WhatsApp. How can I help you today?`,
    }[lang];
  }
  const name = who || { ar: 'المساعد', fr: "l'assistant", en: 'the assistant' }[lang];
  return {
    ar: `أهلاً وسهلاً 👋 أنا ${name}، مساعد العيادة على واتساب. كيفاش ننجّم نعاونك اليوم؟`,
    fr: `Bonjour 👋 je suis ${name} de la clinique sur WhatsApp. Comment puis-je vous aider ?`,
    en: `Hello 👋 I'm ${name} for the clinic on WhatsApp. How can I help you today?`,
  }[lang];
}

// Doctor display name for the greeting preview, per preview language.
function draftDoctor(value, lang) {
  if (value.type !== 'cabinet') return null;
  const fr = (value.doctorNameFr || '').trim();
  const ar = (value.doctorNameAr || '').trim();
  return (lang === 'ar' ? ar || fr : fr || ar) || null;
}

export function PersonaForm({ value, onChange, clinicName }) {
  const { t } = useI18n();
  const p = value.persona;
  const setP = (patch) => onChange({ ...value, persona: { ...p, ...patch } });
  const spoken = new Set(p.spoken || []);
  const [previewLang, setPreviewLang] = React.useState(p.spoken?.[0] || 'ar');
  const toggleSpoken = (l) => {
    const next = spoken.has(l) ? (p.spoken || []).filter((x) => x !== l) : [...(p.spoken || []), l];
    if (!next.length) return; // keep at least one language
    setP({ spoken: LANG_ORDER.filter((x) => next.includes(x)) });
  };
  const greetPreview =
    (p.greeting && p.greeting.trim()) ||
    defaultGreeting(previewLang, p.botName || clinicName, draftDoctor(value, previewLang));

  return (
    <div className="stack">
      <Field label={t('persona.botName')} hint={t('persona.botNameHint')} htmlFor="p-name">
        <input id="p-name" className="control" value={p.botName} onChange={(e) => setP({ botName: e.target.value })} placeholder={clinicName ? `${clinicName}` : ''} />
      </Field>
      <Field label={t('persona.spoken')}>
        <div className="chips">
          {LANG_ORDER.map((l) => (
            <ChipToggle key={l} active={spoken.has(l)} onClick={() => toggleSpoken(l)}>
              {t(`langName.${l}`)}
            </ChipToggle>
          ))}
        </div>
      </Field>
      <Field label={t('persona.tone')}>
        <Segmented
          ariaLabel={t('persona.tone')}
          value={p.tone}
          onChange={(v) => setP({ tone: v })}
          options={[
            { value: 'professional', label: t('persona.professional') },
            { value: 'warm', label: t('persona.warm') },
          ]}
        />
      </Field>
      <Field label={t('persona.greeting')} hint={t('persona.greetingHint')} htmlFor="p-greet">
        <textarea id="p-greet" className="control" dir={dirOf(p.greeting)} rows={3} value={p.greeting} onChange={(e) => setP({ greeting: e.target.value })} placeholder={defaultGreeting('fr', p.botName || clinicName, draftDoctor(value, 'fr'))} />
      </Field>

      <div className="card pad-sm" style={{ background: 'var(--bg-2)' }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--sp-3)' }}>
          <span className="section-label">{t('persona.preview')}</span>
          <span className="langpick">
            {(p.spoken || LANG_ORDER).map((l) => (
              <button key={l} type="button" className={previewLang === l ? 'active' : ''} onClick={() => setPreviewLang(l)}>
                {l.toUpperCase()}
              </button>
            ))}
          </span>
        </div>
        <div className="wa" style={{ height: 'auto', maxHeight: 'none' }}>
          <div className="wa-head">
            <span className="ava">{(p.botName || clinicName || 'C')[0]}</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.86rem' }}>{p.botName || clinicName || t('auth.brandTag')}</div>
              <div className="tiny" style={{ color: '#8696a0' }}>online</div>
            </div>
          </div>
          <div className="wa-body" style={{ minHeight: 90 }}>
            <div className="wa-msg bot" dir={dirOf(greetPreview)}>{greetPreview}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Medical-tourism module ──────────────────────────────────────────────────
export function TourismForm({ value, onChange }) {
  const { t } = useI18n();
  const tr = value.tourism;
  const set = (patch) => onChange({ ...value, tourism: { ...tr, ...patch } });
  return (
    <div className="stack">
      <p className="small dim">{t('tourism.intro')}</p>
      <Switch id="t-enabled" checked={tr.enabled} onChange={(v) => set({ enabled: v })} label={t('tourism.enabled')} />
      <fieldset disabled={!tr.enabled} style={{ border: 0, padding: 0, margin: 0, opacity: tr.enabled ? 1 : 0.5 }} className="stack">
        <Field label={t('tourism.origins')} hint={t('tourism.originsHint')} htmlFor="t-orig">
          <input id="t-orig" className="control" dir={dirOf(csvList(tr.origins))} value={csvList(tr.origins)} onChange={(e) => set({ origins: parseList(e.target.value) })} />
        </Field>
        <Switch id="t-media" checked={tr.media} onChange={(v) => set({ media: v })} label={t('tourism.media')} />
        <span className="hint">{t('tourism.mediaHint')}</span>
        <Field label={t('tourism.partners')} hint={t('tourism.partnersHint')} htmlFor="t-part">
          <textarea id="t-part" className="control" dir={dirOf(tr.partners)} rows={2} value={tr.partners} onChange={(e) => set({ partners: e.target.value })} />
        </Field>
        <Field label={t('tourism.visa')} hint={t('tourism.visaHint')} htmlFor="t-visa">
          <textarea id="t-visa" className="control" dir={dirOf(tr.visa)} rows={2} value={tr.visa} onChange={(e) => set({ visa: e.target.value })} />
        </Field>
        <Field label={t('tourism.quoteFields')} hint={t('tourism.quoteFieldsHint')} htmlFor="t-qf">
          <input id="t-qf" className="control" dir={dirOf(csvList(tr.quoteFields))} value={csvList(tr.quoteFields)} onChange={(e) => set({ quoteFields: parseList(e.target.value) })} />
        </Field>
      </fieldset>
    </div>
  );
}

// ── Escalation rules ────────────────────────────────────────────────────────
export function EscalationForm({ value, onChange }) {
  const { t } = useI18n();
  const e = value.escalation;
  const set = (patch) => onChange({ ...value, escalation: { ...e, ...patch } });
  const setHandoff = (patch) => set({ handoff: { ...e.handoff, ...patch } });
  const setTrigger = (k, v) => set({ triggers: { ...e.triggers, [k]: v } });
  const triggers = [
    ['human', t('escalation.tHuman')],
    ['anger', t('escalation.tAnger')],
    ['emergency', t('escalation.tEmergency')],
    ['unknown', t('escalation.tUnknown')],
  ];
  return (
    <div className="stack">
      <p className="small dim">{t('escalation.intro')}</p>
      <div className="row-wrap" style={{ gap: 'var(--sp-3)' }}>
        <Field label={t('escalation.handoffName')} htmlFor="e-hn">
          <input id="e-hn" className="control" value={e.handoff.name || ''} onChange={(ev) => setHandoff({ name: ev.target.value })} />
        </Field>
        <Field label={t('escalation.handoffPhone')} hint={t('escalation.handoffHint')} htmlFor="e-hp">
          <input id="e-hp" className="control" inputMode="tel" value={e.handoff.phone || ''} onChange={(ev) => setHandoff({ phone: ev.target.value })} placeholder="+216 …" />
        </Field>
      </div>
      <Field label={t('escalation.triggers')}>
        <div className="stack-2">
          {triggers.map(([k, label]) => (
            <Switch key={k} id={`e-tr-${k}`} checked={!!e.triggers[k]} onChange={(v) => setTrigger(k, v)} label={label} />
          ))}
        </div>
      </Field>
      <Field label={t('escalation.emergencyMsg')} hint={t('escalation.emergencyHint')} htmlFor="e-em">
        <textarea id="e-em" className="control" dir={dirOf(e.emergencyMsg)} rows={2} value={e.emergencyMsg} onChange={(ev) => set({ emergencyMsg: ev.target.value })} />
      </Field>
      <Field label={t('escalation.staffHours')} htmlFor="e-sh" optional optionalText={t('common.optional')}>
        <input id="e-sh" className="control" value={e.staffHours} onChange={(ev) => set({ staffHours: ev.target.value })} placeholder="Lun–Ven 09:00–17:00" />
      </Field>
    </div>
  );
}

// ── Notification preferences (persisted now, delivered by the P1-E service) ───
export function NotificationsForm({ value, onChange }) {
  const { t } = useI18n();
  const n = value.notifications;
  const set = (patch) => onChange({ ...value, notifications: { ...n, ...patch } });
  const setEvent = (k, v) => set({ events: { ...n.events, [k]: v } });
  const setQuiet = (patch) => set({ quietHours: { ...n.quietHours, ...patch } });
  const instant = [
    ['booking', t('settings.evBooking')],
    ['lead', t('settings.evLead')],
    ['handoff', t('settings.evHandoff')],
    ['emergency', t('settings.evEmergency')],
    ['media', t('settings.evMedia')],
  ];
  const digests = [
    ['morning', t('settings.evMorning')],
    ['weekly', t('settings.evWeekly')],
  ];
  return (
    <div className="stack">
      <p className="small dim">{t('settings.notifIntro')}</p>
      <Field label={t('settings.evInstant')}>
        <div className="stack-2">
          {instant.map(([k, label]) => (
            <Switch key={k} id={`n-${k}`} checked={!!n.events[k]} onChange={(v) => setEvent(k, v)} label={label} />
          ))}
        </div>
      </Field>
      <Field label={t('settings.evDigest')}>
        <div className="stack-2">
          {digests.map(([k, label]) => (
            <Switch key={k} id={`n-${k}`} checked={!!n.events[k]} onChange={(v) => setEvent(k, v)} label={label} />
          ))}
        </div>
      </Field>
      <Field label={t('settings.reminders')} hint={t('settings.remindersHint')}>
        <div className="stack-2">
          <Switch
            id="n-rem48"
            checked={!!value.reminders.t48}
            onChange={(v) => onChange({ ...value, reminders: { ...value.reminders, t48: v, enabled: v || value.reminders.t3 } })}
            label={t('settings.rem48')}
          />
          <Switch
            id="n-rem3"
            checked={!!value.reminders.t3}
            onChange={(v) => onChange({ ...value, reminders: { ...value.reminders, t3: v, enabled: v || value.reminders.t48 } })}
            label={t('settings.rem3')}
          />
        </div>
      </Field>
      <Field label={t('settings.followups')} hint={t('settings.followupsHint')}>
        <div className="stack-2">
          {[
            ['leadSilent', t('settings.fuLeadSilent')],
            ['resumeFlow', t('settings.fuResume')],
            ['postVisit', t('settings.fuPostVisit')],
          ].map(([k, label]) => (
            <Switch
              key={k}
              id={`fu-${k}`}
              checked={!!value.followups[k]}
              onChange={(v) => {
                const fu = { ...value.followups, [k]: v };
                fu.enabled = fu.leadSilent || fu.resumeFlow || fu.postVisit;
                onChange({ ...value, followups: fu });
              }}
              label={label}
            />
          ))}
        </div>
      </Field>
      <Field label={t('settings.recipients')} hint={t('settings.recipientsHint')} htmlFor="n-rcpt">
        <input id="n-rcpt" className="control" inputMode="tel" value={csvList(n.recipients)} onChange={(e) => set({ recipients: parseList(e.target.value) })} placeholder="+216 20 111 222, +216 …" />
      </Field>
      <Field label={t('settings.avgValue')} hint={t('settings.avgValueHint')} htmlFor="n-avg">
        <input id="n-avg" className="control" type="number" min="0" step="50" style={{ maxWidth: 200 }} dir="ltr" value={n.avgProcedureValue} onChange={(e) => set({ avgProcedureValue: e.target.value })} placeholder="3000" />
      </Field>
      <Field label={t('settings.quietHours')}>
        <div className="row-wrap" style={{ gap: 'var(--sp-4)' }}>
          <Switch id="n-quiet" checked={!!n.quietHours.enabled} onChange={(v) => setQuiet({ enabled: v })} label={t('common.apply')} />
          <span className="row" style={{ gap: 6, opacity: n.quietHours.enabled ? 1 : 0.5 }}>
            <span className="small muted">{t('settings.quietFrom')}</span>
            <input type="time" className="control" style={{ width: 120 }} disabled={!n.quietHours.enabled} value={n.quietHours.from} onChange={(e) => setQuiet({ from: e.target.value })} />
            <span className="small muted">{t('settings.quietTo')}</span>
            <input type="time" className="control" style={{ width: 120 }} disabled={!n.quietHours.enabled} value={n.quietHours.to} onChange={(e) => setQuiet({ to: e.target.value })} />
          </span>
        </div>
      </Field>
      <p className="tiny muted">{t('settings.sliceNote')}</p>
    </div>
  );
}
