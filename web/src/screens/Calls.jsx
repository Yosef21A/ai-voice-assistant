// Calls (V3) — the owner's "who called and what happened" screen. Four stat
// tiles read from the SAME GET /api/stats the Stats screen uses (so the
// numbers never disagree), plus a live recent-calls list from GET /api/calls.
// Each row links into the Inbox thread — every call already lives on the
// patient's conversation as a transcript row (src/voice-call/index.js).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useI18n } from '../context/I18nContext.jsx';
import { useRoute, routeTo } from '../router.js';
import { useStreamEvent } from '../context/EventStreamContext.jsx';
import { Badge, EmptyState, Spinner } from '../components/ui.jsx';
import { Phone } from '../components/icons.jsx';
import { fmtDay, fmtTime, fmtAgo } from '../lib.js';

// Same default window the Stats screen opens on (RANGES[1] there) — the tiles
// and the Stats screen must never look like they disagree at a glance.
const CALLS_STATS_DAYS = 30;
const CALLS_LIST_LIMIT = 50;

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * answered / missed / closed. `outcome` alone is ambiguous — a call that
 * connects and then fails mid-way is call.ended (the patient DID hold it)
 * with outcome:'failed', while a call that fails before ever connecting is
 * call.missed, ALSO outcome:'failed'. The source event type is the real
 * discriminator; `reason === 'closed'` then splits "clinic was shut" from
 * every other kind of miss.
 */
function outcomeOf(row) {
  if (row.type === 'call.ended') return 'answered';
  if (row.reason === 'closed') return 'closed';
  return 'missed';
}

const BADGE_KIND = { answered: 'ok', missed: 'danger', closed: 'warn' };

export function Calls() {
  const { t, lang } = useI18n();
  const route = useRoute();
  const [stats, setStats] = useState(null); // the `calls` block, or false on error
  const [list, setList] = useState(null); // null = loading, [] = loaded empty
  const timerRef = useRef(null);

  const reloadStats = useCallback(async () => {
    try {
      const { stats: s } = await api.getStats({ days: CALLS_STATS_DAYS });
      setStats(s?.calls || null);
    } catch {
      setStats(null);
    }
  }, []);

  const reloadList = useCallback(async () => {
    try {
      const { calls } = await api.listCalls({ limit: CALLS_LIST_LIMIT });
      setList(calls);
    } catch {
      // `false` = load failure. Rendering the affirmative "no calls yet" empty
      // state on a transient 5xx would be a lie on the screen whose job is
      // surfacing missed calls.
      setList(false);
    }
  }, []);

  useEffect(() => {
    reloadStats();
    reloadList();
  }, [reloadStats, reloadList]);

  // Live refresh on any call lifecycle event (debounced like every other
  // screen's SSE wiring). call.started also nudges the list so an in-progress
  // call doesn't feel invisible even though it has no terminal row yet.
  const scheduleReload = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      reloadStats();
      reloadList();
    }, 500);
  }, [reloadStats, reloadList]);
  useStreamEvent('call.started', scheduleReload);
  useStreamEvent('call.missed', scheduleReload);
  useStreamEvent('call.ended', scheduleReload);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const openConversation = (conversationId) => {
    if (conversationId) route.navigate(routeTo('inbox', conversationId));
  };

  const tiles = [
    [t('calls.total'), stats ? stats.total : '—'],
    [t('calls.answered'), stats ? stats.answered : '—'],
    [t('calls.missed'), stats ? stats.missed : '—'],
    [t('calls.avgDuration'), stats ? fmtDuration(stats.avgDurationSec) : '—'],
  ];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('calls.title')}</h1>
          {/* The tiles are a 30-day window; the list below is "most recent 50"
              regardless of age — say so, or the screen contradicts itself. */}
          <div className="tiny muted">{t('calls.window30')}</div>
        </div>
      </div>

      <div className="statgrid">
        {tiles.map(([label, value]) => (
          <div key={label} className="card pad-sm stat">
            <div className="num">{value}</div>
            <div className="tiny muted">{label}</div>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginTop: 'var(--sp-3)' }}>
        <span className="section-label">{t('calls.recent')}</span>
        {list === null ? (
          <div className="row" style={{ justifyContent: 'center', padding: 'var(--sp-6)' }}><Spinner /></div>
        ) : list === false ? (
          <EmptyState icon={Phone} title={t('calls.loadError')}>
            <button type="button" className="btn" onClick={reloadList}>{t('calls.retry')}</button>
          </EmptyState>
        ) : list.length === 0 ? (
          <EmptyState icon={Phone} title={t('calls.empty')} />
        ) : (
          <div className="call-list">
            {list.map((c) => {
              const outcome = outcomeOf(c);
              return (
                <button
                  key={`${c.callId || ''}-${c.at}`}
                  type="button"
                  className="call-row"
                  disabled={!c.conversationId}
                  onClick={() => openConversation(c.conversationId)}
                  title={`${fmtDay(c.at, lang)} ${fmtTime(c.at, lang)}`}
                >
                  <span className="tiny muted" dir="ltr" style={{ minWidth: 40 }}>{fmtAgo(c.at, lang)}</span>
                  <span className="grow truncate" dir="ltr">{c.from || t('calls.unknownCaller')}</span>
                  <Badge kind={BADGE_KIND[outcome]}>{t(`calls.outcome.${outcome}`)}</Badge>
                  <span className="tiny mono" dir="ltr">{fmtDuration(c.durationSec)}</span>
                  <span className="flags">
                    {c.booked ? <span className="tiny" title={t('calls.booked', { ref: c.booked })}>✅ {c.booked}</span> : null}
                    {c.emergency ? <span className="tiny" title={t('calls.emergencyFlag')}>🚨</span> : null}
                    {c.handoff ? <span className="tiny" title={t('calls.handoffFlag')}>🤝</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default Calls;
