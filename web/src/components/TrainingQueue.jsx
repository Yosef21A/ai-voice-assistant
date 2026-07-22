// "À entraîner" queue (P2-B): the questions the bot couldn't answer, most-asked
// first. The owner writes the answer once (✨ auto-drafts the other languages
// via the provider), saves — and the bot serves it on the very next message.
// Live: kb.unanswered SSE events refresh the list while it's open.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useI18n } from '../context/I18nContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useStreamEvent } from '../context/EventStreamContext.jsx';
import { Field, EmptyState, Spinner, Badge } from './ui.jsx';
import { Sparkle, Check, X } from './icons.jsx';
import { dirOf } from '../lib.js';

const LANGS = ['ar', 'fr', 'en'];

export function TrainingQueue({ onTrained }) {
  const { t } = useI18n();
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [drafts, setDrafts] = useState({}); // id -> {ar,fr,en}
  const [busy, setBusy] = useState({}); // id -> 'saving' | 'drafting' | null
  const timerRef = useRef(null);

  const reload = useCallback(async () => {
    try {
      const { unanswered } = await api.listUnanswered();
      setRows(unanswered);
    } catch {
      setRows([]);
    }
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  const schedule = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(reload, 400);
  }, [reload]);
  useStreamEvent('kb.unanswered', schedule);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const setDraft = (id, langKey, v) =>
    setDrafts((d) => ({ ...d, [id]: { ...(d[id] || {}), [langKey]: v } }));
  const setRowBusy = (id, v) => setBusy((b) => ({ ...b, [id]: v }));

  const draftLangs = async (row) => {
    setRowBusy(row.id, 'drafting');
    try {
      const { draft } = await api.draftKb({ question: row.question, answer: drafts[row.id] || {} });
      setDrafts((d) => ({ ...d, [row.id]: draft }));
    } catch (e) {
      toast.err(e?.status === 400 ? t('knowledge.trainAnswerRequired') : t('toast.error'));
    } finally {
      setRowBusy(row.id, null);
    }
  };

  const answer = async (row) => {
    const cur = drafts[row.id] || {};
    if (!LANGS.some((l) => (cur[l] || '').trim())) {
      toast.warn(t('knowledge.trainAnswerRequired'));
      return;
    }
    setRowBusy(row.id, 'saving');
    try {
      await api.answerUnanswered(row.id, { answer: cur });
      toast.ok(t('toast.kbTrained'));
      setRows((r) => (r || []).filter((x) => x.id !== row.id));
      onTrained?.();
    } catch {
      toast.err(t('toast.error'));
    } finally {
      setRowBusy(row.id, null);
    }
  };

  const ignore = async (row) => {
    try {
      await api.dismissUnanswered(row.id);
      setRows((r) => (r || []).filter((x) => x.id !== row.id));
      onTrained?.();
    } catch {
      toast.err(t('toast.error'));
    }
  };

  if (rows === null) {
    return (
      <div className="row" style={{ justifyContent: 'center', padding: 'var(--sp-7)' }}>
        <Spinner />
      </div>
    );
  }
  if (rows.length === 0) return <EmptyState icon={Sparkle} title={t('knowledge.trainEmpty')} />;

  return (
    <div className="stack">
      <p className="small dim">{t('knowledge.trainIntro')}</p>
      {rows.map((row) => (
        <div key={row.id} className="card">
          <div className="row" style={{ justifyContent: 'space-between', gap: 'var(--sp-3)' }}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }} dir={dirOf(row.question)}>{row.question}</div>
              <div className="tiny muted">
                {t('knowledge.trainAsked', { n: row.count })}
                {row.lang ? ` · ${t(`langName.${row.lang}`)}` : ''}
              </div>
            </div>
            <Badge kind="warn">{row.count}×</Badge>
          </div>
          <div className="stack-2" style={{ marginTop: 'var(--sp-3)' }}>
            {LANGS.map((l) => (
              <Field key={l} label={t('knowledge.answerFor', { lang: t(`langName.${l}`) })} htmlFor={`tq-${row.id}-${l}`}>
                <textarea
                  id={`tq-${row.id}-${l}`}
                  className="control"
                  dir={l === 'ar' ? 'rtl' : 'ltr'}
                  rows={2}
                  value={(drafts[row.id] && drafts[row.id][l]) || ''}
                  onChange={(e) => setDraft(row.id, l, e.target.value)}
                />
              </Field>
            ))}
          </div>
          <div className="row" style={{ gap: 'var(--sp-2)', marginTop: 'var(--sp-3)' }}>
            <button className="btn outline sm" onClick={() => draftLangs(row)} disabled={!!busy[row.id]}>
              <Sparkle />
              {busy[row.id] === 'drafting' ? t('knowledge.trainDrafting') : t('knowledge.trainDraft')}
            </button>
            <span className="spacer" />
            <button className="btn ghost sm" onClick={() => ignore(row)} disabled={!!busy[row.id]}>
              <X />
              {t('knowledge.trainIgnore')}
            </button>
            <button className="btn primary sm" onClick={() => answer(row)} disabled={!!busy[row.id]}>
              <Check />
              {t('knowledge.trainAnswer')}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default TrainingQueue;
