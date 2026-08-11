// Leads pipeline (P2-C) — the medical-tourism money board. Hot leads captured
// at ingest are shown as kanban lanes (new → … → lost). Each card carries the
// "waiting on you" timer (red past 30 min), a one-tap WhatsApp open, a stage
// selector, an estimated value, an owner, and a note log.
//
// Draft state (typed note + value) lives in THIS parent, keyed by lead id, so a
// stage change (which remounts the card into another lane) or a background
// reload never wipes half-typed input. Live via lead.hot + lead.updated SSE
// plus a bounded poll; a display ticker keeps the relative timers advancing
// WITHOUT re-fetching (no per-inbound reload amplification).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useI18n } from '../context/I18nContext.jsx';
import { useTenant } from '../context/TenantContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useStreamEvent } from '../context/EventStreamContext.jsx';
import { EmptyState, Spinner, Badge } from '../components/ui.jsx';
import { Plane, Send } from '../components/icons.jsx';
import { fmtAgo, dirOf, specialtyLabel } from '../lib.js';

const STAGES = ['new', 'contacted', 'quoted', 'negotiating', 'booked', 'arrived', 'lost'];
const TERMINAL = new Set(['booked', 'arrived', 'lost']);
const WAITING_RED_MS = 30 * 60 * 1000;
const RELOAD_MS = 60000; // bounded background refresh (O(1) requests, not per-message)
const TICK_MS = 30000; // re-render relative timers without a fetch

function groupThousands(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// D2: informational routing hint — which partner clinics could take this
// lead's procedure. Display only; the bot never messages a partner.
function partnerCandidates(config, procedure) {
  if (config?.type !== 'facilitator' || !procedure) return null;
  const partners = Array.isArray(config.partners) ? config.partners : [];
  const names = partners
    .filter((p) => !Array.isArray(p.specialties) || !p.specialties.length || p.specialties.includes(procedure))
    .map((p) => p.name)
    .filter(Boolean);
  return names.length ? names.join(', ') : null;
}

function LeadCard({ lead, lang, currency, note, value, savingNote, savingValue, on, tenantConfig }) {
  const { t } = useI18n();
  const waitingMs = lead.waitingSince ? Date.now() - new Date(lead.waitingSince).getTime() : null;
  const proc = lead.procedure ? specialtyLabel(lead.procedure, lang) : t('leads.unknownProcedure');
  const reason = lead.reason ? t(`leads.reason.${lead.reason}`) : null;
  const waNumber = String(lead.patientWaId || '').replace(/[^\d]/g, '');
  const candidates = partnerCandidates(tenantConfig, lead.procedure);

  return (
    <div className="lead-card">
      <div className="row" style={{ justifyContent: 'space-between', gap: 'var(--sp-2)' }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }} className="truncate">{proc}</div>
          {reason ? <div className="tiny muted">{reason}</div> : null}
        </div>
        {lead.originCountry ? <Badge kind="brass">{lead.originCountry}</Badge> : null}
      </div>

      {lead.travelWindow ? (
        <div className="tiny muted" dir={dirOf(lead.travelWindow)}>✈️ {lead.travelWindow}{lead.originCity ? ` · ${lead.originCity}` : ''}</div>
      ) : null}
      {candidates ? (
        <div className="tiny" style={{ color: 'var(--brass, #c9a86a)' }}>🏥 {t('leads.partnersHint')}: {candidates}</div>
      ) : null}

      {lead.snippet ? <div className="small dim lead-snippet" dir={dirOf(lead.snippet)}>“{lead.snippet}”</div> : null}

      {waitingMs != null ? (
        <div className={`waiting-chip${waitingMs > WAITING_RED_MS ? ' hot' : ''}`}>
          ⏱ {t('leads.waitingChip', { ago: fmtAgo(lead.waitingSince, lang) })}
        </div>
      ) : null}

      <div className="row" style={{ gap: 'var(--sp-2)', flexWrap: 'wrap', marginTop: 'var(--sp-2)' }}>
        <input
          className="control" type="number" min="0" inputMode="numeric" dir="ltr"
          style={{ width: 96 }} placeholder={t('leads.value')} value={value}
          onChange={(e) => on.valueChange(lead.id, e.target.value)}
          onBlur={() => on.saveValue(lead)}
        />
        {lead.value ? <span className="small mono">{groupThousands(lead.value)} {currency}</span> : null}
        {waNumber ? (
          <a className="btn ghost sm" href={`https://wa.me/${waNumber}`} target="_blank" rel="noreferrer">
            <Send /> {t('leads.openWhatsapp')}
          </a>
        ) : null}
      </div>

      <select
        className="control" style={{ marginTop: 'var(--sp-2)' }} value={lead.status}
        aria-label={t('leads.move')} onChange={(e) => on.status(lead.id, e.target.value)}
      >
        {STAGES.map((s) => <option key={s} value={s}>{t(`leads.status.${s}`)}</option>)}
      </select>

      {lead.notes?.length ? (
        <ul className="lead-notes">
          {lead.notes.slice(-3).map((n, i) => (
            <li key={i} dir={dirOf(n.text)}><span className="tiny muted">{n.by}</span> {n.text}</li>
          ))}
        </ul>
      ) : null}
      <div className="row" style={{ gap: 'var(--sp-2)', marginTop: 'var(--sp-2)' }}>
        <input
          className="control grow" placeholder={t('leads.addNote')} value={note} dir={dirOf(note)}
          onChange={(e) => on.noteChange(lead.id, e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') on.saveNote(lead); }}
        />
        <button className="btn outline sm" onClick={() => on.saveNote(lead)} disabled={savingNote || !note.trim()}>+</button>
      </div>
    </div>
  );
}

export function Leads() {
  const { t, lang } = useI18n();
  const { config } = useTenant();
  const toast = useToast();
  const currency = config?.currency || 'EUR';
  const [leads, setLeads] = useState(null);
  const [notes, setNotes] = useState({}); // id -> draft note
  const [values, setValues] = useState({}); // id -> draft value (string)
  const [saving, setSaving] = useState({}); // id -> { note?:bool, value?:bool }
  const [, setTick] = useState(0);
  const reloadTimer = useRef(null);

  const reload = useCallback(async () => {
    try {
      const { leads: rows } = await api.listLeads();
      setLeads(rows);
      // Seed value drafts for leads we haven't seen (don't clobber active edits).
      setValues((v) => {
        const next = { ...v };
        for (const l of rows) if (!(l.id in next)) next[l.id] = l.value ?? '';
        return next;
      });
    } catch {
      setLeads((cur) => cur ?? []);
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  // Immediate on lead events; bounded background poll for freshness; a display
  // tick advances the relative timers between fetches (no request).
  const schedule = useCallback(() => {
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(reload, 400);
  }, [reload]);
  useStreamEvent('lead.hot', schedule);
  useStreamEvent('lead.updated', schedule);
  useEffect(() => {
    const poll = setInterval(reload, RELOAD_MS);
    const tick = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => { clearInterval(poll); clearInterval(tick); clearTimeout(reloadTimer.current); };
  }, [reload]);

  const setSave = (id, key, val) => setSaving((s) => ({ ...s, [id]: { ...(s[id] || {}), [key]: val } }));

  const on = useMemo(
    () => ({
      noteChange: (id, v) => setNotes((n) => ({ ...n, [id]: v })),
      valueChange: (id, v) => setValues((m) => ({ ...m, [id]: v })),
      status: async (id, status) => {
        try {
          const { lead } = await api.setLeadStatus(id, status);
          setLeads((rows) => (rows || []).map((l) => (l.id === id ? lead : l)));
        } catch {
          toast.err(t('toast.error'));
        }
      },
      saveValue: async (lead) => {
        const raw = values[lead.id];
        if (raw === undefined || String(raw) === String(lead.value ?? '')) return;
        setSave(lead.id, 'value', true);
        try {
          const { lead: updated } = await api.updateLead(lead.id, { value: raw === '' ? null : Number(raw) });
          setLeads((rows) => (rows || []).map((l) => (l.id === lead.id ? updated : l)));
          setValues((m) => ({ ...m, [lead.id]: updated.value ?? '' }));
        } catch {
          toast.err(t('toast.error'));
        } finally {
          setSave(lead.id, 'value', false);
        }
      },
      saveNote: async (lead) => {
        const text = (notes[lead.id] || '').trim();
        if (!text || saving[lead.id]?.note) return;
        setSave(lead.id, 'note', true);
        try {
          const { lead: updated } = await api.updateLead(lead.id, { note: text });
          setLeads((rows) => (rows || []).map((l) => (l.id === lead.id ? updated : l)));
          setNotes((n) => ({ ...n, [lead.id]: '' }));
        } catch {
          toast.err(t('toast.error'));
        } finally {
          setSave(lead.id, 'note', false);
        }
      },
    }),
    [values, notes, saving, toast, t]
  );

  const { lanes, pipelineValue, openCount } = useMemo(() => {
    const byStatus = Object.fromEntries(STAGES.map((s) => [s, []]));
    let value = 0;
    let open = 0;
    for (const l of leads || []) {
      (byStatus[l.status] || (byStatus[l.status] = [])).push(l);
      if (Number.isFinite(Number(l.value))) value += Number(l.value);
      if (!TERMINAL.has(l.status)) open += 1;
    }
    for (const s of STAGES) byStatus[s].sort((a, b) => (b.waitingSince ? 1 : 0) - (a.waitingSince ? 1 : 0));
    return { lanes: byStatus, pipelineValue: value, openCount: open };
  }, [leads]);

  if (leads === null) {
    return (
      <div className="page">
        <div className="page-head"><div><h1>{t('leads.title')}</h1></div></div>
        <div className="row" style={{ justifyContent: 'center', padding: 'var(--sp-7)' }}><Spinner /></div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('leads.title')}</h1>
          <p className="dim small">{t('leads.intro')}</p>
        </div>
        <div className="row" style={{ gap: 'var(--sp-3)' }}>
          <span className="small muted">{t('leads.openCount', { n: openCount })}</span>
          {pipelineValue > 0 ? (
            <Badge kind="brass">{t('leads.pipelineValue')}: {groupThousands(pipelineValue)} {currency}</Badge>
          ) : null}
        </div>
      </div>

      {leads.length === 0 ? (
        <EmptyState icon={Plane} title={t('leads.empty')} />
      ) : (
        <div className="kanban">
          {STAGES.map((s) => (
            <div key={s} className="lane">
              <div className="lane-head">
                <span>{t(`leads.status.${s}`)}</span>
                <span className="count">{lanes[s].length}</span>
              </div>
              <div className="lane-body">
                {lanes[s].map((l) => (
                  <LeadCard
                    key={l.id} lead={l} lang={lang} currency={currency} tenantConfig={config}
                    note={notes[l.id] || ''} value={values[l.id] ?? (l.value ?? '')}
                    savingNote={!!saving[l.id]?.note} savingValue={!!saving[l.id]?.value} on={on}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default Leads;
