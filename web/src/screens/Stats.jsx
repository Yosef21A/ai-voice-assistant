// Statistics (P2-A) — the owner's "is it worth it" screen. Everything renders
// from ONE GET /api/stats call (same aggregation the WhatsApp digests use, so
// numbers always match). Zero chart dependencies: the 24h strip, donut and
// funnel are plain divs + one inline SVG, all token-styled, RTL-safe.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useI18n } from '../context/I18nContext.jsx';
import { useStreamEvent } from '../context/EventStreamContext.jsx';
import { EmptyState, Spinner } from '../components/ui.jsx';
import { Chart } from '../components/icons.jsx';

const RANGES = [7, 30, 90];
const LANG_COLORS = { ar: 'var(--brass)', fr: 'var(--info)', en: 'var(--ok)', other: 'var(--text-mute)' };

/** Hour → "typically closed" from the weekly schedule (closed ≥ 4 of 7 days). */
function typicallyClosed(workingHours) {
  const closed = Array.from({ length: 24 }, () => 0);
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  for (const d of days) {
    const wh = workingHours?.[d];
    const [open, close] = Array.isArray(wh) && wh.length >= 2
      ? wh.map((s) => Number(String(s).split(':')[0]))
      : [null, null];
    for (let h = 0; h < 24; h += 1) {
      const within = open != null && (open <= close ? h >= open && h < close : h >= open || h < close);
      if (!within) closed[h] += 1;
    }
  }
  return closed.map((n) => n >= 4);
}

function groupThousands(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function Stats() {
  const { t } = useI18n();
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(false);
  const timerRef = useRef(null);
  const reqRef = useRef(0); // request token: stale responses never win a race

  const reload = useCallback(async () => {
    const id = ++reqRef.current;
    try {
      const { stats: s } = await api.getStats({ days });
      if (reqRef.current !== id) return; // a newer range/request superseded us
      setStats(s);
      setError(false);
    } catch {
      if (reqRef.current !== id) return;
      setStats(null);
      setError(true);
    }
  }, [days]);

  useEffect(() => {
    clearTimeout(timerRef.current); // drop any pending refresh for the old range
    setStats(null);
    setError(false);
    reload();
  }, [reload]);

  // Live refresh: any new inbound / booking nudges the numbers (debounced).
  const scheduleReload = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(reload, 800);
  }, [reload]);
  useStreamEvent('message.in', scheduleReload);
  useStreamEvent('appointment.created', scheduleReload);
  useStreamEvent('appointment.updated', scheduleReload);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const closedHours = useMemo(() => typicallyClosed(stats?.workingHours), [stats]);
  const maxHour = useMemo(
    () => Math.max(1, ...(stats?.conversationsByHour || [0])),
    [stats]
  );

  const fmtResponse = (sec) => {
    if (sec == null) return '—';
    if (sec < 90) return t('stats.seconds', { n: Math.round(sec) });
    return t('stats.minutes', { n: Math.round(sec / 60) });
  };

  if (stats === null) {
    return (
      <div className="page">
        <div className="page-head"><div><h1>{t('stats.title')}</h1></div></div>
        {error ? (
          <EmptyState icon={Chart} title={t('toast.error')}>
            <button className="btn outline sm" onClick={reload}>{t('common.retry')}</button>
          </EmptyState>
        ) : (
          <div className="row" style={{ justifyContent: 'center', padding: 'var(--sp-7)' }}><Spinner /></div>
        )}
      </div>
    );
  }

  const fresh = stats.conversations === 0 && stats.messageCount === 0 && stats.bookings === 0;
  const langTotal = Object.values(stats.languageSplit || {}).reduce((a, b) => a + b, 0);
  const funnelMax = Math.max(1, stats.funnel.conversations, stats.funnel.bookingStarted, stats.funnel.bookingConfirmed);
  const funnelRows = [
    ['fConversations', stats.funnel.conversations],
    ['fStarted', stats.funnel.bookingStarted],
    ['fConfirmed', stats.funnel.bookingConfirmed],
  ];

  // Donut geometry: r=40 → circumference ≈ 251.33; segments via dash offsets.
  const C = 2 * Math.PI * 40;
  let acc = 0;
  const donutSegs = langTotal
    ? Object.entries(stats.languageSplit).filter(([, n]) => n > 0).map(([k, n]) => {
        const frac = n / langTotal;
        const seg = { k, n, dash: frac * C, offset: acc * C };
        acc += frac;
        return seg;
      })
    : [];

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>{t('stats.title')}</h1></div>
        <div className="chips">
          {RANGES.map((d) => (
            <button key={d} className={`chip${days === d ? ' active' : ''}`} onClick={() => setDays(d)}>
              {t(`stats.last${d}`)}
            </button>
          ))}
        </div>
      </div>

      {fresh ? (
        <EmptyState icon={Chart} title={t('stats.empty')} />
      ) : (
        <div className="stack">
          {/* Money line — LARGE, plus the after-hours sales callout. */}
          <div className="row-wrap" style={{ gap: 'var(--sp-3)', alignItems: 'stretch' }}>
            <div className="card grow money-line">
              <span className="section-label">{t('stats.money')}</span>
              {stats.money != null ? (
                <>
                  <div className="num">≈ {groupThousands(stats.money)} {stats.currency || ''}</div>
                  <div className="small muted">
                    {t('stats.moneyHint', { n: stats.bookings, v: groupThousands(stats.avgValue), cur: stats.currency || '' })}
                  </div>
                </>
              ) : (
                <div className="small dim" style={{ marginTop: 'var(--sp-2)' }}>{t('stats.moneySetup')}</div>
              )}
            </div>
            <div className="card grow money-line">
              <span className="section-label">{t('stats.afterHoursSub')}</span>
              <div className="num">{t('stats.afterHours', { pct: stats.afterHoursPct })}</div>
              <div className="small muted">{stats.afterHours} / {stats.conversations} · {t('stats.conversations').toLowerCase()}</div>
            </div>
          </div>

          {/* Metric cards. */}
          <div className="statgrid">
            {[
              [t('stats.conversations'), stats.conversations],
              [t('stats.bookings'), stats.bookings],
              [t('stats.responseTime'), fmtResponse(stats.responseTimeMedianSec)],
              [t('stats.messages'), stats.messageCount],
            ].map(([label, value]) => (
              <div key={label} className="card pad-sm stat">
                <div className="num">{value}</div>
                <div className="tiny muted">{label}</div>
              </div>
            ))}
          </div>

          {/* 24h strip with the closed-hours band. */}
          <div className="card">
            <span className="section-label">{t('stats.byHour')}</span>
            <div className="hourbars" role="img" aria-label={t('stats.byHour')}>
              {stats.conversationsByHour.map((n, h) => (
                <div key={h} className={`hb${closedHours[h] ? ' closed' : ''}`} title={`${String(h).padStart(2, '0')}:00 — ${n}${closedHours[h] ? ` · ${t('stats.closedHour')}` : ''}`}>
                  <div className="fill" style={{ height: `${Math.max(2, (n / maxHour) * 100)}%`, opacity: n === 0 ? 0.18 : 1 }} />
                  {h % 6 === 0 ? <span className="hlabel">{h}</span> : <span className="hlabel" />}
                </div>
              ))}
            </div>
            <div className="tiny muted row" style={{ gap: 6, marginTop: 'var(--sp-2)' }}>
              <span className="swatch" style={{ background: 'var(--warn)' }} /> {t('stats.closedHour')}
            </div>
          </div>

          <div className="row-wrap" style={{ gap: 'var(--sp-3)', alignItems: 'stretch' }}>
            {/* Language donut. */}
            <div className="card grow">
              <span className="section-label">{t('stats.languages')}</span>
              <div className="donut-wrap">
                <svg viewBox="0 0 100 100" width="120" height="120" role="img" aria-label={t('stats.languages')}>
                  <circle cx="50" cy="50" r="40" fill="none" stroke="var(--surface-3)" strokeWidth="14" />
                  {donutSegs.map((s) => (
                    <circle key={s.k} cx="50" cy="50" r="40" fill="none" stroke={LANG_COLORS[s.k]} strokeWidth="14"
                      strokeDasharray={`${s.dash} ${C - s.dash}`} strokeDashoffset={-s.offset} transform="rotate(-90 50 50)" />
                  ))}
                  <text x="50" y="55" textAnchor="middle" fill="var(--text)" fontSize="18" fontWeight="700">{langTotal}</text>
                </svg>
                <div className="stack-2">
                  {Object.entries(stats.languageSplit).map(([k, n]) => (
                    <div key={k} className="row" style={{ gap: 8 }}>
                      <span className="swatch" style={{ background: LANG_COLORS[k] }} />
                      <span className="small">{t(`stats.langNames.${k}`)}</span>
                      <span className="small muted">{n}{langTotal ? ` · ${Math.round((n / langTotal) * 100)}%` : ''}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Booking funnel. */}
            <div className="card grow funnel">
              <span className="section-label">{t('stats.funnel')}</span>
              <div className="stack-2" style={{ marginTop: 'var(--sp-3)' }}>
                {funnelRows.map(([key, n]) => (
                  <div key={key} className="frow">
                    <span className="small dim">{t(`stats.${key}`)}</span>
                    <div className="fbar"><div className="fill" style={{ width: `${(n / funnelMax) * 100}%` }} /></div>
                    <span className="small mono">{n}</span>
                  </div>
                ))}
              </div>
              <div className="tiny muted" style={{ marginTop: 'var(--sp-3)' }}>{t('stats.sinceTracking')}</div>
            </div>
          </div>

          {/* Reminders & no-shows (V2) — the renewal pitch in numbers. */}
          <div className="row-wrap" style={{ gap: 'var(--sp-3)', alignItems: 'stretch' }}>
            <div className="card grow">
              <span className="section-label">{t('stats.remTitle')}</span>
              {(stats.reminderOutcomes?.sent || 0) + (stats.reminderOutcomes?.skipped_window || 0) === 0 ? (
                <div className="small muted" style={{ marginTop: 'var(--sp-2)' }}>{t('stats.remEmpty')}</div>
              ) : (
                <>
                  <div className="statgrid" style={{ marginTop: 'var(--sp-2)' }}>
                    {[
                      [t('stats.remSent'), stats.reminderOutcomes.sent],
                      [t('stats.remConfirmed'), stats.reminderOutcomes.confirmed],
                      [t('stats.remCancelled'), stats.reminderOutcomes.cancelled + stats.reminderOutcomes.reschedule],
                      [t('stats.remNoAnswer'), stats.reminderOutcomes.no_answer],
                    ].map(([label, value]) => (
                      <div key={label} className="card pad-sm stat">
                        <div className="num">{value}</div>
                        <div className="tiny muted">{label}</div>
                      </div>
                    ))}
                  </div>
                  {stats.reminderOutcomes.skipped_window > 0 ? (
                    <div className="tiny muted" style={{ marginTop: 'var(--sp-2)' }}>
                      {t('stats.remSkipped', { n: stats.reminderOutcomes.skipped_window })}
                    </div>
                  ) : null}
                </>
              )}
            </div>
            <div className="card grow">
              <span className="section-label">{t('stats.noShowTrend')}</span>
              {(stats.noShowTrend || []).length === 0 ? (
                <div className="small muted" style={{ marginTop: 'var(--sp-2)' }}>{t('stats.sinceTracking')}</div>
              ) : (
                <div className="stack-2" style={{ marginTop: 'var(--sp-3)' }}>
                  {stats.noShowTrend.slice(-8).map((w) => (
                    <div key={w.week} className="frow">
                      <span className="small dim mono">{w.week.slice(5)}</span>
                      <div className="fbar">
                        <div className="fill" style={{ width: `${w.ratePct}%`, background: 'var(--warn)' }} />
                      </div>
                      <span className="small mono">{w.ratePct}% · {w.noShow}/{w.done + w.noShow}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="row-wrap" style={{ gap: 'var(--sp-3)', alignItems: 'stretch' }}>
            {/* Top questions. */}
            <div className="card grow">
              <span className="section-label">{t('stats.topQuestions')}</span>
              {stats.topQuestions.length === 0 ? (
                <div className="small muted" style={{ marginTop: 'var(--sp-2)' }}>{t('stats.sinceTracking')}</div>
              ) : (
                <ul className="qlist">
                  {stats.topQuestions.map((q) => (
                    <li key={q.text}>
                      <span className="truncate" dir="auto">{q.text}</span>
                      <span className="badge brass">{q.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Intents + appointment statuses. */}
            <div className="card grow">
              <span className="section-label">{t('stats.topIntents')}</span>
              <div className="chips" style={{ marginTop: 'var(--sp-2)' }}>
                {stats.topIntents.map((i) => (
                  <span key={i.intent} className="chip">{t(`stats.intent.${i.intent}`)} · {i.count}</span>
                ))}
                {stats.topIntents.length === 0 ? <span className="small muted">{t('stats.sinceTracking')}</span> : null}
              </div>
              <span className="section-label" style={{ marginTop: 'var(--sp-4)', display: 'block' }}>{t('stats.statuses')}</span>
              <div className="chips" style={{ marginTop: 'var(--sp-2)' }}>
                {Object.entries(stats.apptStatuses).map(([s, n]) => (
                  <span key={s} className="chip">{t(`apptStatus.${s}`)} · {n}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Stats;
