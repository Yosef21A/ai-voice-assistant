// Live Inbox (PRODUCT-SPEC §3.1): conversation list with filters + live reorder,
// a WhatsApp-style thread with per-message RTL + day separators, one-tap human
// takeover (🤖/👤), a staff composer that auto-pauses the bot, and a side panel
// with patient info + the linked appointment. SSE keeps everything live.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useI18n } from '../context/I18nContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useStreamEvent } from '../context/EventStreamContext.jsx';
import { useRoute, routeTo } from '../router.js';
import { Badge, EmptyState, Spinner, CONV_STATUS_KIND } from '../components/ui.jsx';
import { Inbox as InboxIcon, Bot, User, Send, ChevronLeft, Calendar, Info } from '../components/icons.jsx';
import { fmtAgo, fmtTime, fmtDay, dayKey, dirOf, specialtyLabel } from '../lib.js';

const authorOf = (m) =>
  m.direction === 'inbound' ? 'patient' : String(m.by || '').startsWith('staff') ? 'staff' : 'bot';

function ThreadBody({ messages, lang }) {
  const scrollRef = useRef(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);
  let lastDay = null;
  return (
    <div className="msgs" ref={scrollRef}>
      {messages.map((m) => {
        const dk = dayKey(m.ts);
        const sep = dk !== lastDay ? ((lastDay = dk), fmtDay(m.ts, lang)) : null;
        const who = authorOf(m);
        const out = m.direction === 'outbound';
        return (
          <React.Fragment key={m.id}>
            {sep ? <div className="day-sep"><span>{sep}</span></div> : null}
            <div className={`bubble-row ${out ? 'out' : 'in'}${who === 'staff' ? ' staff' : ''}`}>
              <div className={`bubble author-${who}`} dir={dirOf(m.text)}>
                {who !== 'patient' ? <span className={`by ${who}`}>{who === 'bot' ? '🤖' : '👤'} </span> : null}
                {m.text}
                <span className="meta"><span>{fmtTime(m.ts, lang)}</span></span>
              </div>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

export function Inbox() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const route = useRoute();
  const activeId = route.segments[1] || null;

  const [filters, setFilters] = useState({ bucket: 'all', language: '' });
  const [list, setList] = useState(null);
  const [thread, setThread] = useState(null); // { conversation, messages }
  const [appt, setAppt] = useState(null);
  const [sending, setSending] = useState(false);
  const [text, setText] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  const [flags, setFlags] = useState({}); // conversationId -> 'emergency' | 'lead'
  const timerRef = useRef(null);

  const queryFor = useCallback((f) => {
    const q = {};
    if (f.bucket === 'open') q.status = 'open';
    else if (f.bucket === 'closed') q.status = 'closed';
    else if (f.bucket === 'needsHuman') q.needsHuman = 'true';
    if (f.language) q.language = f.language;
    return q;
  }, []);

  const reloadList = useCallback(async () => {
    try {
      const { conversations } = await api.listConversations(queryFor(filters));
      setList(conversations);
    } catch {
      setList([]);
    }
  }, [filters, queryFor]);

  useEffect(() => {
    setList(null);
    reloadList();
  }, [reloadList]);

  const scheduleReload = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(reloadList, 350);
  }, [reloadList]);

  // Load the open thread + its linked appointment when the route id changes.
  useEffect(() => {
    let alive = true;
    if (!activeId) {
      setThread(null);
      setAppt(null);
      return undefined;
    }
    setThread(null);
    api.getConversation(activeId).then((res) => alive && setThread(res)).catch(() => alive && setThread({ error: true }));
    return () => {
      alive = false;
    };
  }, [activeId]);

  // Resolve the linked appointment from the conversation's patient number.
  useEffect(() => {
    let alive = true;
    const waId = thread?.conversation?.patientWaId;
    if (!waId) {
      setAppt(null);
      return undefined;
    }
    api.listAppointments().then(({ appointments }) => {
      if (!alive) return;
      const mine = appointments
        .filter((a) => a.patientWaId === waId && a.status !== 'cancelled')
        .sort((a, b) => String(a.datetimeIso).localeCompare(String(b.datetimeIso)));
      setAppt(mine[0] || null);
    }).catch(() => alive && setAppt(null));
    return () => {
      alive = false;
    };
  }, [thread?.conversation?.patientWaId]);

  // ── live wiring ─────────────────────────────────────────────────────────────
  const onMsg = (data) => {
    scheduleReload();
    if (data && data.conversationId === activeId && data.message) {
      setThread((cur) => {
        if (!cur || !cur.conversation) return cur;
        if (cur.messages.some((m) => m.id === data.message.id)) return cur;
        return { ...cur, messages: [...cur.messages, data.message] };
      });
    }
  };
  useStreamEvent('message.in', onMsg);
  useStreamEvent('message.out', onMsg);
  useStreamEvent('conversation.updated', (data) => {
    scheduleReload();
    if (data && data.conversationId === activeId && data.patch) {
      setThread((cur) => (cur && cur.conversation ? { ...cur, conversation: { ...cur.conversation, ...data.patch } } : cur));
    }
  });

  // Safety + revenue events: flash the conversation row and pop a toast so staff
  // never miss them. Emergency wins over a lead flag on the same row.
  useStreamEvent('emergency.detected', (data) => {
    scheduleReload();
    if (data?.conversationId) setFlags((f) => ({ ...f, [data.conversationId]: 'emergency' }));
    toast.err(t('toast.emergencyAlert'), 8000);
  });
  useStreamEvent('lead.hot', (data) => {
    scheduleReload();
    if (data?.conversationId) {
      setFlags((f) => (f[data.conversationId] === 'emergency' ? f : { ...f, [data.conversationId]: 'lead' }));
    }
    toast.warn(t('toast.leadAlert'), 6000);
  });

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // ── actions ─────────────────────────────────────────────────────────────────
  const select = (id) => {
    setPanelOpen(false);
    // Opening a flagged conversation acknowledges it (clears the row highlight).
    if (id) {
      setFlags((f) => {
        if (!f[id]) return f;
        const next = { ...f };
        delete next[id];
        return next;
      });
    }
    route.navigate(routeTo('inbox', id));
  };
  const convo = thread?.conversation;
  const paused = !!convo?.aiPaused;

  const doTakeover = async (nextPaused) => {
    if (!convo) return;
    setThread((cur) => (cur ? { ...cur, conversation: { ...cur.conversation, aiPaused: nextPaused } } : cur));
    try {
      await api.takeover(convo.id, nextPaused);
      toast.info(nextPaused ? t('toast.takenOver') : t('toast.handedBack'));
    } catch {
      toast.err(t('toast.error'));
      reloadList();
    }
  };

  const send = async () => {
    const value = text.trim();
    if (!value || !convo || sending) return;
    setText('');
    setSending(true);
    try {
      await api.sendMessage(convo.id, value);
    } catch {
      toast.err(t('toast.sendFailed'));
      setText(value);
    } finally {
      setSending(false);
    }
  };

  const buckets = [
    ['all', t('inbox.all')],
    ['open', t('inbox.open')],
    ['needsHuman', t('inbox.needsHuman')],
    ['closed', t('inbox.closed')],
  ];

  const listCol = (
    <div className="convo-list">
      <div className="filters">
        <div className="chips">
          {buckets.map(([k, label]) => (
            <button key={k} className={`chip${filters.bucket === k ? ' active' : ''}`} onClick={() => setFilters((f) => ({ ...f, bucket: k }))}>{label}</button>
          ))}
        </div>
        <select className="control" aria-label={t('inbox.filterLang')} value={filters.language} onChange={(e) => setFilters((f) => ({ ...f, language: e.target.value }))}>
          <option value="">{t('inbox.filterLang')}: {t('common.all')}</option>
          <option value="ar">{t('langName.ar')}</option>
          <option value="fr">{t('langName.fr')}</option>
          <option value="en">{t('langName.en')}</option>
        </select>
      </div>
      <div className="convo-scroll">
        {list === null ? (
          <div className="row" style={{ justifyContent: 'center', padding: 'var(--sp-6)' }}><Spinner /></div>
        ) : list.length === 0 ? (
          <EmptyState icon={InboxIcon} title={t('inbox.empty')} />
        ) : (
          list.map((c) => (
            <button key={c.id} className={`convo-item${c.id === activeId ? ' active' : ''}${flags[c.id] ? ` flag-${flags[c.id]}` : ''}`} onClick={() => select(c.id)}>
              <div className="grow">
                <div className="who">
                  <span className="name" dir="ltr">{c.patientWaId || t('inbox.patient')}</span>
                  <span className="time">{fmtAgo(c.lastMessageAt || c.createdAt, lang)}</span>
                </div>
                <div className="preview row" style={{ gap: 6 }}>
                  <Badge kind={CONV_STATUS_KIND[c.status]}>{t(`convStatus.${c.status}`)}</Badge>
                  {flags[c.id] === 'emergency' ? (
                    <span className="tiny" title={t('inbox.flagEmergency')}>🚨</span>
                  ) : flags[c.id] === 'lead' ? (
                    <span className="tiny" title={t('inbox.flagLead')}>🔥</span>
                  ) : null}
                  {c.lang ? <span className="tiny muted">{c.lang.toUpperCase()}</span> : null}
                  <span className="tiny" aria-hidden="true">{c.aiPaused ? '👤' : '🤖'}</span>
                </div>
              </div>
              {c.status === 'needs_human' ? <span className="unread" aria-label={t('inbox.needsHuman')} /> : null}
            </button>
          ))
        )}
      </div>
    </div>
  );

  const threadCol = (
    <div className="thread">
      {!activeId ? (
        <EmptyState icon={InboxIcon} title={t('inbox.selectHint')} />
      ) : thread === null ? (
        <div className="empty"><Spinner /></div>
      ) : thread.error || !convo ? (
        <EmptyState icon={InboxIcon} title={t('inbox.empty')} />
      ) : (
        <>
          <div className="thread-head">
            <button className="btn ghost icon back-btn" aria-label={t('inbox.backList')} onClick={() => select('')}><ChevronLeft /></button>
            <div className="grow">
              <div style={{ fontWeight: 600 }} dir="ltr">{convo.patientWaId}</div>
              <div className="tiny muted">{convo.lang ? t(`langName.${convo.lang}`) : ''}</div>
            </div>
            <button className="btn ghost icon panel-toggle" aria-label={t('inbox.details')} onClick={() => setPanelOpen((v) => !v)}><Info /></button>
          </div>
          <div className={`takeover-banner ${paused ? 'human' : 'bot'}`}>
            <span>{paused ? t('inbox.youReplying') : t('inbox.botActive')}</span>
            <span className="spacer" />
            <button className={`btn sm ${paused ? 'ok' : 'outline'}`} onClick={() => doTakeover(!paused)}>
              {paused ? <><Bot />{t('inbox.handBack')}</> : <><User />{t('inbox.takeControl')}</>}
            </button>
          </div>
          <ThreadBody messages={thread.messages} lang={lang} />
          <div className="composer">
            <div className="comp-row">
              <textarea
                className="control"
                rows={1}
                placeholder={t('inbox.composer')}
                value={text}
                dir={dirOf(text)}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                aria-label={t('inbox.composer')}
              />
              <button className="btn primary icon" onClick={send} disabled={sending || !text.trim()} aria-label={t('common.send')}><Send /></button>
            </div>
            {!paused ? <div className="comp-note"><Info />{t('inbox.botPauseNote')}</div> : null}
          </div>
        </>
      )}
    </div>
  );

  const panelCol = (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--sp-3)' }}>
        <span className="section-label">{t('inbox.panelPatient')}</span>
        <button className="btn ghost icon sm panel-toggle" aria-label={t('common.close')} onClick={() => setPanelOpen(false)}><ChevronLeft /></button>
      </div>
      {convo ? (
        <>
          <div className="prow"><span className="k">{t('inbox.waId')}</span><span className="v" dir="ltr">{convo.patientWaId}</span></div>
          <div className="prow"><span className="k">{t('inbox.lang')}</span><span className="v">{convo.lang ? t(`langName.${convo.lang}`) : '—'}</span></div>
          <div className="prow"><span className="k">{t('inbox.status')}</span><span className="v"><Badge kind={CONV_STATUS_KIND[convo.status]}>{t(`convStatus.${convo.status}`)}</Badge></span></div>
          <div className="prow"><span className="k">{t('inbox.started')}</span><span className="v">{fmtDay(convo.createdAt, lang)}</span></div>
          <div className="section-label" style={{ margin: 'var(--sp-4) 0 var(--sp-2)' }}>{t('inbox.panelAppt')}</div>
          {appt ? (
            <button className="appt" style={{ width: '100%' }} onClick={() => route.navigate('/appointments')}>
              <Calendar />
              <div className="grow" style={{ textAlign: 'start' }}>
                <div className="small" style={{ fontWeight: 600 }}>{appt.specialtyLabel || specialtyLabel(appt.specialty, lang) || t('appt.patient')}</div>
                <div className="tiny muted">{fmtDay(appt.datetimeIso, lang)} · {fmtTime(appt.datetimeIso, lang)}</div>
              </div>
              <Badge kind="info">{t(`apptStatus.${appt.status}`)}</Badge>
            </button>
          ) : (
            <p className="small muted">{t('inbox.noAppt')}</p>
          )}
        </>
      ) : (
        <p className="small muted">{t('inbox.selectHint')}</p>
      )}
    </div>
  );

  return (
    <div className={`inbox${activeId ? ' viewing' : ''}${panelOpen ? ' panel-open' : ''}`}>
      {listCol}
      {threadCol}
      {panelCol}
    </div>
  );
}

export default Inbox;
