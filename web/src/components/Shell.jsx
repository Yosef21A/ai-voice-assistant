// Authenticated app shell: nav sidebar (desktop) + bottom tab bar (mobile),
// a header with the live-connection dot, language picker and user menu, and the
// routed screen outlet. Routing is hash-based (see router.js); the inbox uses a
// flush, full-height content area.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useI18n } from '../context/I18nContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useEventStream, useStreamEvent } from '../context/EventStreamContext.jsx';
import { useRoute } from '../router.js';
import { Inbox as InboxIcon, Calendar, Book, Chart, Plane, Settings as SettingsIcon, Logout, Wand, glyph } from './icons.jsx';
import { initials } from '../lib.js';
import { Inbox } from '../screens/Inbox.jsx';
import { Appointments } from '../screens/Appointments.jsx';
import { Leads } from '../screens/Leads.jsx';
import { Knowledge } from '../screens/Knowledge.jsx';
import { Stats } from '../screens/Stats.jsx';
import { Settings } from '../screens/Settings.jsx';
import { Wizard } from '../screens/Wizard.jsx';

const NAV = [
  { key: 'inbox', icon: InboxIcon },
  { key: 'leads', icon: Plane },
  { key: 'appointments', icon: Calendar },
  { key: 'stats', icon: Chart },
  { key: 'knowledge', icon: Book },
  { key: 'settings', icon: SettingsIcon },
];

function screenFor(top) {
  switch (top) {
    case 'leads': return <Leads />;
    case 'appointments': return <Appointments />;
    case 'stats': return <Stats />;
    case 'knowledge': return <Knowledge />;
    case 'settings': return <Settings />;
    case 'wizard': return <Wizard />;
    case 'inbox':
    default: return <Inbox />;
  }
}

export function Shell() {
  const { t, lang, setLang, langs } = useI18n();
  const { user, logout } = useAuth();
  const { connected } = useEventStream();
  const route = useRoute();
  const top = route.top || 'inbox';
  const [menuOpen, setMenuOpen] = useState(false);
  const [needsHuman, setNeedsHuman] = useState(0);
  const [unanswered, setUnanswered] = useState(0);
  const menuRef = useRef(null);
  const timerRef = useRef(null);
  const kbTimerRef = useRef(null);

  // Live "needs human" badge on the Inbox nav item.
  const refreshCount = useCallback(() => {
    api.listConversations({ needsHuman: 'true', limit: 200 })
      .then(({ total }) => setNeedsHuman(total || 0))
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshCount();
  }, [refreshCount]);
  const scheduleCount = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(refreshCount, 400);
  }, [refreshCount]);
  useStreamEvent('conversation.updated', scheduleCount);
  useStreamEvent('handoff.requested', scheduleCount);
  useStreamEvent('message.in', scheduleCount);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  // Live "to train" badge on the Knowledge nav item (P2-B).
  const refreshUnanswered = useCallback(() => {
    api.countUnanswered()
      .then(({ count }) => setUnanswered(count || 0))
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshUnanswered();
  }, [refreshUnanswered]);
  const scheduleUnanswered = useCallback(() => {
    clearTimeout(kbTimerRef.current);
    kbTimerRef.current = setTimeout(refreshUnanswered, 400);
  }, [refreshUnanswered]);
  useStreamEvent('kb.unanswered', scheduleUnanswered);
  useEffect(() => () => clearTimeout(kbTimerRef.current), []);

  // Close the user menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menuOpen]);

  const go = (key) => route.navigate(`/${key}`);
  const titleFor = (k) => (k === 'wizard' ? t('wizard.title') : t(`nav.${k}`));
  const flush = top === 'inbox';

  const langPicker = (
    <span className="langpick" role="group" aria-label={t('common.language')}>
      {langs.map((l) => (
        <button key={l} type="button" className={lang === l ? 'active' : ''} onClick={() => setLang(l)} aria-pressed={lang === l}>{l.toUpperCase()}</button>
      ))}
    </span>
  );

  return (
    <div className="app">
      <nav className="nav" aria-label="primary">
        <div className="nav-brand">
          <span className="brand">
            <span className="glyph">{glyph}</span>
            <span className="brand-name">Omen <b>Concierge</b></span>
          </span>
        </div>
        {NAV.map(({ key, icon: Icon }) => (
          <button key={key} className={`nav-item${top === key ? ' active' : ''}`} onClick={() => go(key)} aria-current={top === key ? 'page' : undefined}>
            <Icon />
            <span>{t(`nav.${key}`)}</span>
            {key === 'inbox' && needsHuman > 0 ? <span className="count">{needsHuman}</span> : null}
            {key === 'knowledge' && unanswered > 0 ? <span className="count">{unanswered}</span> : null}
          </button>
        ))}
        <span className="spacer" />
        <button className="nav-item" onClick={() => go('wizard')}><Wand /><span>{t('nav.wizard')}</span></button>
      </nav>

      <main className="main">
        <header className="header">
          <span className="title">{titleFor(top)}</span>
          <span className="spacer" />
          <span className={`conn${connected ? ' live' : ''}`} title={connected ? t('conn.live') : t('conn.offline')}>
            <span className="dot" />
            <span className="nowrap">{connected ? t('conn.live') : t('conn.offline')}</span>
          </span>
          {langPicker}
          <div className="usermenu" ref={menuRef}>
            <button className="avatar" onClick={() => setMenuOpen((v) => !v)} aria-haspopup="menu" aria-expanded={menuOpen} aria-label={user?.name || user?.email || 'account'}>
              {initials(user?.name || user?.email)}
            </button>
            {menuOpen ? (
              <div className="menu" role="menu">
                <div className="menu-head">
                  <div style={{ fontWeight: 600 }}>{user?.name || t('settings.tabAccount')}</div>
                  <div className="tiny muted" dir="ltr">{user?.email}</div>
                </div>
                <button role="menuitem" onClick={() => { setMenuOpen(false); go('settings'); }}><SettingsIcon />{t('nav.settings')}</button>
                <button role="menuitem" onClick={() => { setMenuOpen(false); logout(); }}><Logout />{t('nav.logout')}</button>
              </div>
            ) : null}
          </div>
        </header>

        <div className={`content${flush ? ' flush' : ''}`}>
          {screenFor(top)}
        </div>
      </main>

      <nav className="tabbar" aria-label="primary mobile">
        {NAV.map(({ key, icon: Icon }) => (
          <button key={key} className={top === key ? 'active' : ''} onClick={() => go(key)} aria-current={top === key ? 'page' : undefined}>
            <Icon />
            <span>{t(`nav.${key}`)}</span>
            {key === 'inbox' && needsHuman > 0 ? <span className="count">{needsHuman}</span> : null}
            {key === 'knowledge' && unanswered > 0 ? <span className="count">{unanswered}</span> : null}
          </button>
        ))}
      </nav>
    </div>
  );
}

export default Shell;
