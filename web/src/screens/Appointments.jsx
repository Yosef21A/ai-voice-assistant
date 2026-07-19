// Appointments (PRODUCT-SPEC §3.2): grouped-by-day list, range + status filters,
// one-tap status actions (POST /api/appointments/:id/status), live insert/update
// on the appointment.created / appointment.updated SSE events.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useI18n } from '../context/I18nContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useStreamEvent } from '../context/EventStreamContext.jsx';
import { Badge, EmptyState, Spinner, APPT_STATUS_KIND } from '../components/ui.jsx';
import { Calendar, Check, X, Bot, User } from '../components/icons.jsx';
import { fmtTime, fmtDay, dayKey, specialtyLabel } from '../lib.js';

function rangeBounds(range) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const days = { today: 1, next7: 7, next30: 30 }[range];
  if (!days) return {};
  const end = new Date(start);
  end.setDate(end.getDate() + days);
  return { from: start.toISOString(), to: end.toISOString() };
}

// Which status transitions each row offers.
const ACTIONS = {
  pending: [['confirmed', 'confirm', 'ok'], ['cancelled', 'cancel', 'danger']],
  confirmed: [['done', 'done', 'ok'], ['no_show', 'noShow', 'danger'], ['cancelled', 'cancel', 'outline']],
  done: [],
  no_show: [['confirmed', 'confirm', 'outline']],
  cancelled: [['confirmed', 'confirm', 'outline']],
};

export function Appointments() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [filters, setFilters] = useState({ range: 'next7', status: '' });
  const [list, setList] = useState(null);
  const timerRef = useRef(null);

  const reload = useCallback(async () => {
    try {
      const { from, to } = rangeBounds(filters.range);
      const { appointments } = await api.listAppointments({ status: filters.status, from, to });
      setList(appointments);
    } catch {
      setList([]);
    }
  }, [filters]);

  useEffect(() => {
    setList(null);
    reload();
  }, [reload]);

  const scheduleReload = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(reload, 300);
  }, [reload]);
  useStreamEvent('appointment.created', scheduleReload);
  useStreamEvent('appointment.updated', scheduleReload);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const setStatus = async (id, status) => {
    try {
      await api.setAppointmentStatus(id, status);
      toast.ok(t('toast.statusUpdated'));
      reload();
    } catch {
      toast.err(t('toast.error'));
    }
  };

  // Group by calendar day, days ascending, times ascending within a day.
  const groups = useMemo(() => {
    const map = new Map();
    for (const a of list || []) {
      const k = dayKey(a.datetimeIso);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(a);
    }
    const keys = [...map.keys()].sort();
    for (const k of keys) map.get(k).sort((a, b) => String(a.datetimeIso).localeCompare(String(b.datetimeIso)));
    return keys.map((k) => [k, map.get(k)]);
  }, [list]);

  const ranges = [['today', t('appt.today')], ['next7', t('appt.next7')], ['next30', t('appt.next30')], ['all', t('appt.all')]];
  const statuses = ['', 'pending', 'confirmed', 'done', 'no_show', 'cancelled'];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('appt.title')}</h1>
        </div>
        <div className="row-wrap">
          <div className="chips">
            {ranges.map(([k, label]) => (
              <button key={k} className={`chip${filters.range === k ? ' active' : ''}`} onClick={() => setFilters((f) => ({ ...f, range: k }))}>{label}</button>
            ))}
          </div>
          <select className="control" style={{ width: 'auto' }} aria-label={t('appt.filterStatus')} value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
            {statuses.map((s) => (
              <option key={s || 'all'} value={s}>{s ? t(`apptStatus.${s}`) : `${t('appt.filterStatus')}: ${t('common.all')}`}</option>
            ))}
          </select>
        </div>
      </div>

      {list === null ? (
        <div className="row" style={{ justifyContent: 'center', padding: 'var(--sp-7)' }}><Spinner /></div>
      ) : groups.length === 0 ? (
        <EmptyState icon={Calendar} title={t('appt.empty')} />
      ) : (
        groups.map(([k, rows]) => (
          <div key={k} className="day-group">
            <div className="day-title">{fmtDay(rows[0].datetimeIso, lang)}</div>
            {rows.map((a) => (
              <div key={a.id} className={`appt status-${a.status}`}>
                <span className="clock">{fmtTime(a.datetimeIso, lang)}</span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="who truncate" dir="auto">{a.patientName || a.patientWaId || t('appt.unknownPatient')}</div>
                  <div className="tiny muted row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    {a.specialty ? <span>{a.specialtyLabel || specialtyLabel(a.specialty, lang)}</span> : null}
                    <span className="row" style={{ gap: 3 }}>
                      {a.createdBy === 'staff' ? <User style={{ width: 12, height: 12 }} /> : <Bot style={{ width: 12, height: 12 }} />}
                      {a.createdBy === 'staff' ? t('appt.byStaff') : t('appt.byBot')}
                    </span>
                    {a.ref ? <span className="mono">{t('appt.ref')} {a.ref}</span> : null}
                  </div>
                </div>
                <Badge kind={APPT_STATUS_KIND[a.status]}>{t(`apptStatus.${a.status}`)}</Badge>
                <div className="actions">
                  {(ACTIONS[a.status] || []).map(([to, labelKey, kind]) => (
                    <button key={to} className={`btn sm ${kind}`} onClick={() => setStatus(a.id, to)}>
                      {to === 'confirmed' || to === 'done' ? <Check /> : to === 'cancelled' || to === 'no_show' ? <X /> : null}
                      {t(`appt.${labelKey}`)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

export default Appointments;
