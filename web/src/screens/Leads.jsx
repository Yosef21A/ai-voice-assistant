// Leads pipeline (P2-C) — the medical-tourism money board. Hot leads captured
// at ingest are shown as kanban lanes (new → … → lost). Each card carries the
// "waiting on you" timer (red past 30 min), a one-tap WhatsApp open, a stage
// selector, an estimated value, an owner, and a note log. Live via lead.hot +
// lead.updated SSE. RTL-safe (logical CSS + dir=auto on patient text).
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
const WAITING_RED_MS = 30 * 60 * 1000;

function groupThousands(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function LeadCard({ lead, lang, currency, onStatus, onPatch }) {
  const { t } = useI18n();
  const [note, setNote] = useState('');
  const [value, setValue] = useState(lead.value ?? '');
  const [busy, setBusy] = useState(false);

  const waitingMs = lead.waitingSince ? Date.now() - new Date(lead.waitingSince).getTime() : null;
  const proc = lead.procedure ? specialtyLabel(lead.procedure, lang) : t('leads.unknownProcedure');
  const reason = lead.reason ? t(`leads.reason.${lead.reason}`) : null;
  const waNumber = String(lead.patientWaId || '').replace(/[^\d]/g, '');

  const saveNote = async () => {
    if (!note.trim() || busy) return;
    setBusy(true);
    try {
      await onPatch(lead.id, { note });
      setNote('');
    } finally {
      setBusy(false);
    }
  };
  const saveValue = async () => {
    if (busy || String(value) === String(lead.value ?? '')) return;
    setBusy(true);
    try {
      await onPatch(lead.id, { value: value === '' ? null : Number(value) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lead-card">
      <div className="row" style={{ justifyContent: 'space-between', gap: 'var(--sp-2)' }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }} className="truncate">{proc}</div>
          {reason ? <div className="tiny muted">{reason}</div> : null}
        </div>
        {lead.originCountry ? <Badge kind="brass">{lead.originCountry}</Badge> : null}
      </div>

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
          onChange={(e) => setValue(e.target.value)} onBlur={saveValue}
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
        aria-label={t('leads.move')} disabled={busy}
        onChange={(e) => onStatus(lead.id, e.target.value)}
      >
        {STAGES.map((s) => <option key={s} value={s}>{t(`leads.status.${s}`)}</option>)}
      </select>

      {lead.notes?.length ? (
        <ul className="lead-notes">
          {lead.notes.slice(-3).map((n, i) => (
            <li key={i}><span className="tiny muted">{n.by}</span> {n.text}</li>
          ))}
        </ul>
      ) : null}
      <div className="row" style={{ gap: 'var(--sp-2)', marginTop: 'var(--sp-2)' }}>
        <input
          className="control grow" placeholder={t('leads.addNote')} value={note}
          dir={dirOf(note)} onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') saveNote(); }}
        />
        <button className="btn outline sm" onClick={saveNote} disabled={busy || !note.trim()}>+</button>
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
  const timerRef = useRef(null);

  const reload = useCallback(async () => {
    try {
      const { leads: rows } = await api.listLeads();
      setLeads(rows);
    } catch {
      setLeads([]);
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const schedule = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(reload, 400);
  }, [reload]);
  useStreamEvent('lead.hot', schedule);
  useStreamEvent('lead.updated', schedule);
  useStreamEvent('message.in', schedule); // refreshes the waiting timers
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const onStatus = async (id, status) => {
    try {
      const { lead } = await api.setLeadStatus(id, status);
      setLeads((rows) => (rows || []).map((l) => (l.id === id ? lead : l)));
    } catch {
      toast.err(t('toast.error'));
    }
  };
  const onPatch = async (id, patch) => {
    try {
      const { lead } = await api.updateLead(id, patch);
      setLeads((rows) => (rows || []).map((l) => (l.id === id ? lead : l)));
    } catch {
      toast.err(t('toast.error'));
      throw new Error('patch failed');
    }
  };

  const { lanes, pipelineValue, openCount } = useMemo(() => {
    const byStatus = Object.fromEntries(STAGES.map((s) => [s, []]));
    let value = 0;
    let open = 0;
    for (const l of leads || []) {
      (byStatus[l.status] || (byStatus[l.status] = [])).push(l);
      if (Number.isFinite(Number(l.value))) value += Number(l.value);
      if (!['booked', 'arrived', 'lost'].includes(l.status)) open += 1;
    }
    // Waiting-first within each lane.
    for (const s of STAGES) {
      byStatus[s].sort((a, b) => (b.waitingSince ? 1 : 0) - (a.waitingSince ? 1 : 0));
    }
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
                  <LeadCard key={l.id} lead={l} lang={lang} currency={currency} onStatus={onStatus} onPatch={onPatch} />
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
