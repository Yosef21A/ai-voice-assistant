// Wizard step 8 "test drive": chat with the tenant's OWN bot through the same
// engine (POST /api/sandbox/message), WhatsApp-style, RTL per message, reset via
// DELETE /api/sandbox. This is the take-my-money moment — their clinic answering.
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useI18n } from '../context/I18nContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { Send, Refresh } from './icons.jsx';
import { dirOf } from '../lib.js';

let seq = 0;

export function Sandbox({ botName }) {
  const { t } = useI18n();
  const toast = useToast();
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState(false);
  const bodyRef = useRef(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, thinking]);

  const push = (from, body) => setMsgs((m) => [...m, { id: ++seq, from, text: body }]);

  const send = async () => {
    const value = text.trim();
    if (!value || thinking) return;
    setText('');
    push('user', value);
    setThinking(true);
    try {
      const out = await api.sandboxMessage(value);
      const replies = out.replies && out.replies.length ? out.replies : [out.reply].filter(Boolean);
      if (!replies.length) replies.push('…');
      for (const r of replies) push('bot', r);
    } catch {
      toast.err(t('toast.sendFailed'));
    } finally {
      setThinking(false);
    }
  };

  const reset = async () => {
    try {
      await api.sandboxReset();
    } catch {
      /* best effort */
    }
    setMsgs([]);
    toast.info(t('testdrive.resetDone'));
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <p className="small dim">{t('testdrive.intro')}</p>
        <button className="btn ghost sm" onClick={reset}><Refresh />{t('testdrive.reset')}</button>
      </div>
      <div className="wa">
        <div className="wa-head">
          <span className="ava">{(botName || 'C')[0]}</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: '0.86rem' }}>{botName || t('auth.brandTag')}</div>
            <div className="tiny" style={{ color: '#8696a0' }}>{thinking ? t('testdrive.thinking') : 'online'}</div>
          </div>
        </div>
        <div className="wa-body" ref={bodyRef}>
          {msgs.length === 0 ? (
            <div className="wa-msg bot" dir="auto">{t('testdrive.hello')}</div>
          ) : (
            msgs.map((m) => (
              <div key={m.id} className={`wa-msg ${m.from}`} dir={dirOf(m.text)}>{m.text}</div>
            ))
          )}
          {thinking ? <div className="wa-msg bot" aria-live="polite">…</div> : null}
        </div>
        <div className="wa-foot">
          <textarea
            className="control"
            rows={1}
            style={{ minHeight: 40, resize: 'none' }}
            placeholder={t('testdrive.placeholder')}
            value={text}
            dir={dirOf(text)}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            aria-label={t('testdrive.placeholder')}
          />
          <button className="btn primary icon" onClick={send} disabled={thinking || !text.trim()} aria-label={t('common.send')}><Send /></button>
        </div>
      </div>
    </div>
  );
}

export default Sandbox;
