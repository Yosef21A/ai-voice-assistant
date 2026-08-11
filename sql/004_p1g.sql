-- P1-G — Postgres becomes primary for the ENGINE path.
--
-- 1. Engine conversation memory: the classic/humanize engine keeps its own
--    turn history ({role, text, ts}) and V2/V4 bookkeeping ON the conversation
--    record (the JSON adapter stored the whole record verbatim). These columns
--    give those fields a durable home so the legacy engine surface can be
--    bridged 1:1 over SQL.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS engine_messages     jsonb   NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS nudge               jsonb,
  ADD COLUMN IF NOT EXISTS nudge_opt_out       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_reminder       jsonb,
  ADD COLUMN IF NOT EXISTS facilitator_alerted boolean NOT NULL DEFAULT false,
  -- The engine's OWN clock (injectable in tests/demos) drives booking-flow
  -- staleness; the trigger-managed updated_at is wall-clock and would break
  -- that contract, so the engine timestamp gets its own column.
  ADD COLUMN IF NOT EXISTS engine_updated_at   timestamptz;

-- 2. Appointment reminders (V2). One row per (appointment, kind) is the dedupe
--    contract — enforced here at the database level, which also makes multiple
--    server instances safe once the JSON single-process constraint lifts.
CREATE TABLE IF NOT EXISTS reminders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  appt_id      uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  ref          text,
  kind         text NOT NULL CHECK (kind IN ('t48','t3')),
  status       text NOT NULL DEFAULT 'sent'
                 CHECK (status IN ('sent','failed','skipped_window','confirmed',
                                   'cancelled','reschedule','no_answer','closed')),
  appt_iso     timestamptz,
  "to"         text,
  lang         text,
  attempts     int  NOT NULL DEFAULT 1,
  error        text,
  sent_at      timestamptz,
  responded_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, appt_id, kind)
);
CREATE INDEX IF NOT EXISTS reminders_tenant_status_idx ON reminders (tenant_id, status);
CREATE TRIGGER trg_reminders_updated BEFORE UPDATE ON reminders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
