-- 002 — "bot didn't know" training queue (P2-B).
-- NOTE: no BEGIN/COMMIT here — scripts/db-migrate.js wraps each migration in
-- its own transaction and records it in schema_migrations (see 001_init.sql).

CREATE TABLE unanswered (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  norm            text NOT NULL,           -- normalizeQuestion() dedupe key
  question        text,                    -- last verbatim phrasing
  lang            text,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  count           integer NOT NULL DEFAULT 1,
  status          text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'answered', 'dismissed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, norm)
);

CREATE INDEX idx_unanswered_tenant_status ON unanswered (tenant_id, status);

CREATE TRIGGER trg_unanswered_updated
  BEFORE UPDATE ON unanswered
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
