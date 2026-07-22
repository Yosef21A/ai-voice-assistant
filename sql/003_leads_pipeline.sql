-- 003 — leads pipeline (P2-C): add the 'contacted' stage + staff-owned fields.
-- NOTE: no BEGIN/COMMIT — scripts/db-migrate.js wraps each migration in its own
-- transaction and records it in schema_migrations (see 001_init.sql / 002).

-- Widen the status check to the full kanban set (adds 'contacted').
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check
  CHECK (status IN ('new','contacted','quoted','negotiating','booked','arrived','lost'));

-- Staff-owned pipeline fields.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS assignee text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS notes    jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS value    numeric;  -- estimated deal value (money line)
