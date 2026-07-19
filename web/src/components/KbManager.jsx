// Knowledge-base manager: "from" price rows + free Q&A, both via /api/kb CRUD.
// A price row is a KB entry with source:'price' and a structured answer
// { from, currency, notes }; a Q&A is source manual/template with a per-language
// answer { ar, fr, en }. Specialty templates one-click pre-load real Q&As.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useI18n } from '../context/I18nContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { Field, EmptyState, Spinner } from './ui.jsx';
import { Plus, Trash, Book, Sparkle } from './icons.jsx';
import { templateEntries, hasTemplate, specialtyLabel, dirOf } from '../lib.js';

export function KbManager({ specialties = [], currency = 'EUR' }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [entries, setEntries] = useState(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const { entries: rows } = await api.listKb();
      setEntries(rows.filter((e) => e.status !== 'archived'));
    } catch {
      setEntries([]);
    }
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);

  const prices = (entries || []).filter((e) => e.source === 'price');
  const qas = (entries || []).filter((e) => e.source !== 'price');

  // ── local edit + persist-on-blur ───────────────────────────────────────────
  const patchLocal = (key, patch) =>
    setEntries((list) => list.map((e) => (e.key === key ? { ...e, ...patch } : e)));

  const persist = async (key, body) => {
    try {
      await api.updateKb(key, body);
      toast.ok(t('toast.kbSaved'));
    } catch {
      toast.err(t('toast.error'));
      reload();
    }
  };
  const remove = async (key) => {
    if (!window.confirm(t('knowledge.deleteConfirm'))) return;
    setEntries((list) => list.filter((e) => e.key !== key));
    try {
      await api.deleteKb(key);
      toast.ok(t('toast.kbDeleted'));
    } catch {
      toast.err(t('toast.error'));
      reload();
    }
  };

  // ── price rows ─────────────────────────────────────────────────────────────
  const addPrice = async () => {
    setBusy(true);
    try {
      const { entry } = await api.createKb({
        question: '', source: 'price', answer: { from: '', currency, notes: '' },
      });
      setEntries((list) => [...(list || []), entry]);
    } finally {
      setBusy(false);
    }
  };
  const setPriceField = (e, field, val) => {
    if (field === 'question') patchLocal(e.key, { question: val });
    else patchLocal(e.key, { answer: { ...e.answer, [field]: val } });
  };
  const savePrice = (e) =>
    persist(e.key, { question: e.question, source: 'price', answer: e.answer });

  return (
    <div className="stack">
      {/* Prices */}
      <div className="card pad-sm">
        <div className="card-title"><Book /><h3>{t('knowledge.priceTitle')}</h3></div>
        <p className="small muted" style={{ marginBottom: 'var(--sp-3)' }}>{t('knowledge.priceHint')}</p>
        {prices.length ? (
          <table className="kb-table">
            <thead>
              <tr>
                <th style={{ width: '40%' }}>{t('knowledge.procedure')}</th>
                <th>{t('knowledge.priceFrom')}</th>
                <th>{t('knowledge.currency')}</th>
                <th>{t('knowledge.notes')}</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {prices.map((e) => (
                <tr key={e.key}>
                  <td><input className="control" dir={dirOf(e.question)} value={e.question || ''} onChange={(ev) => setPriceField(e, 'question', ev.target.value)} onBlur={() => savePrice(e)} /></td>
                  <td><input className="control" inputMode="decimal" style={{ width: 90 }} value={e.answer?.from ?? ''} onChange={(ev) => setPriceField(e, 'from', ev.target.value)} onBlur={() => savePrice(e)} /></td>
                  <td><input className="control" style={{ width: 74 }} value={e.answer?.currency ?? ''} onChange={(ev) => setPriceField(e, 'currency', ev.target.value)} onBlur={() => savePrice(e)} /></td>
                  <td><input className="control" value={e.answer?.notes ?? ''} onChange={(ev) => setPriceField(e, 'notes', ev.target.value)} onBlur={() => savePrice(e)} /></td>
                  <td><button className="btn ghost icon sm" aria-label={t('common.delete')} onClick={() => remove(e.key)}><Trash /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="small muted">{t('knowledge.noPrices')}</p>
        )}
        <div style={{ marginTop: 'var(--sp-3)' }}>
          <button className="btn sm" onClick={addPrice} disabled={busy}><Plus />{t('knowledge.addRow')}</button>
        </div>
      </div>

      {/* Specialty templates */}
      {specialties.some((s) => hasTemplate(s.id)) ? (
        <div className="card pad-sm">
          <div className="card-title"><Sparkle /><h3>{t('knowledge.templatesTitle')}</h3></div>
          <p className="small muted" style={{ marginBottom: 'var(--sp-3)' }}>{t('knowledge.templatesHint')}</p>
          <div className="template-grid">
            {specialties.filter((s) => hasTemplate(s.id)).map((s) => {
              const tpl = templateEntries(s.id);
              return (
                <button
                  key={s.id}
                  className="template-btn"
                  onClick={async () => {
                    setBusy(true);
                    try {
                      for (const e of tpl) await api.createKb(e);
                      await reload();
                      toast.ok(t('toast.templateAdded', { name: specialtyLabel(s, lang) }));
                    } finally {
                      setBusy(false);
                    }
                  }}
                  disabled={busy}
                >
                  <span className="n">{specialtyLabel(s, lang)}</span>
                  <span className="c">{t('knowledge.entriesCount', { n: tpl.length })}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Free Q&A */}
      <div className="card pad-sm">
        <div className="card-title"><Book /><h3>{t('knowledge.qaTitle')}</h3></div>
        <p className="small muted" style={{ marginBottom: 'var(--sp-3)' }}>{t('knowledge.qaHint')}</p>
        {entries === null ? (
          <div className="row" style={{ justifyContent: 'center', padding: 'var(--sp-5)' }}><Spinner /></div>
        ) : qas.length === 0 ? (
          <p className="small muted">{t('knowledge.noQa')}</p>
        ) : (
          <div className="stack-3">
            {qas.map((e) => (
              <div key={e.key} className="kb-entry">
                <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--sp-2)' }}>
                  <input
                    className="control"
                    dir={dirOf(e.question)}
                    placeholder={t('knowledge.question')}
                    value={e.question || ''}
                    onChange={(ev) => patchLocal(e.key, { question: ev.target.value })}
                    onBlur={() => persist(e.key, { question: e.question, answer: e.answer, source: e.source })}
                  />
                  <button className="btn ghost icon sm" aria-label={t('common.delete')} onClick={() => remove(e.key)}><Trash /></button>
                </div>
                <div className="stack-2" style={{ marginTop: 'var(--sp-2)' }}>
                  {['ar', 'fr', 'en'].map((l) => (
                    <Field key={l} label={t('knowledge.answerFor', { lang: t(`langName.${l}`) })} htmlFor={`${e.key}-${l}`}>
                      <textarea
                        id={`${e.key}-${l}`}
                        className="control"
                        dir={l === 'ar' ? 'rtl' : 'ltr'}
                        rows={2}
                        value={(e.answer && e.answer[l]) || ''}
                        onChange={(ev) => patchLocal(e.key, { answer: { ...e.answer, [l]: ev.target.value } })}
                        onBlur={() => persist(e.key, { question: e.question, answer: e.answer, source: e.source })}
                      />
                    </Field>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: 'var(--sp-3)' }}>
          <button
            className="btn sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const { entry } = await api.createKb({ question: '', source: 'manual', answer: { ar: '', fr: '', en: '' } });
                setEntries((list) => [...(list || []), entry]);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Plus />{t('knowledge.addQa')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default KbManager;
