// Small presentational primitives shared across screens. They lean entirely on
// the class names already defined in styles.css so markup stays consistent.
import React from 'react';

export function Spinner() {
  return <span className="spinner" role="progressbar" aria-label="loading" />;
}

export function LoadingFull() {
  return (
    <div className="loading-full">
      <Spinner />
    </div>
  );
}

export function EmptyState({ icon: Icon, title, hint, children }) {
  return (
    <div className="empty">
      {Icon ? <Icon className="ico" /> : null}
      {title ? <div className="dim">{title}</div> : null}
      {hint ? <div className="small">{hint}</div> : null}
      {children}
    </div>
  );
}

/** Labelled form field wrapper: <Field label hint error><input className="control"/></Field> */
export function Field({ label, hint, error, htmlFor, children, optional, optionalText }) {
  return (
    <div className="field">
      {label ? (
        <label htmlFor={htmlFor}>
          {label}
          {optional ? <span className="muted"> · {optionalText}</span> : null}
        </label>
      ) : null}
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
      {error ? <span className="err">{error}</span> : null}
    </div>
  );
}

/** Accessible toggle switch bound to a boolean. */
export function Switch({ checked, onChange, label, id }) {
  return (
    <label className="switch" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="track" aria-hidden="true" />
      <span className="thumb" aria-hidden="true" />
      {label ? <span className="label">{label}</span> : null}
    </label>
  );
}

/** Segmented single-choice control (e.g. tone professional/warm). */
export function Segmented({ options, value, onChange, ariaLabel }) {
  return (
    <div className="chips" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={`chip${value === o.value ? ' active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Multi-select chip toggle (e.g. spoken languages, specialties). */
export function ChipToggle({ active, onClick, children }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`chip${active ? ' active' : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function Badge({ kind, children }) {
  return <span className={`badge${kind ? ` ${kind}` : ''}`}>{children}</span>;
}

// Status → badge tone maps, reused by inbox + appointments.
export const CONV_STATUS_KIND = { open: 'info', needs_human: 'warn', closed: '' };
export const APPT_STATUS_KIND = {
  pending: 'warn',
  confirmed: 'info',
  done: 'ok',
  no_show: 'danger',
  cancelled: 'danger',
};
