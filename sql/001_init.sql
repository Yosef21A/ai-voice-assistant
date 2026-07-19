-- 001_init.sql — Omen Clinic Concierge initial schema (Phase 1, Slice A)
-- Applied once by scripts/db-migrate.js (tracked in schema_migrations). The
-- migration runner wraps this file in a single transaction, so it contains NO
-- explicit BEGIN/COMMIT. This file is the canonical Postgres data model.
--
-- Conventions
--   * tenant_id is TEXT — the clinic slug (e.g. 'el-amen-sousse'), matching the
--     engine's clinic.id and data/clinics.json. Every tenant-owned row carries it.
--   * uuid primary keys via gen_random_uuid(); events use a bigint identity.
--   * timestamptz everywhere; created_at/updated_at on every mutable table.
--   * updated_at is maintained by the shared set_updated_at() trigger.
--   * jsonb for flexible/nested config (specialties, hours, languages, KB, ...).

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid() on servers < 13

-- Shared trigger: bump updated_at on every UPDATE.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

-- ── tenants (clinics / medical-tourism facilitators) ────────────────────────
CREATE TABLE tenants (
  id              text PRIMARY KEY,                          -- clinic slug
  phone_number_id text NOT NULL UNIQUE,                      -- WhatsApp routing key
  name            text NOT NULL,
  city            text,
  country         text,
  timezone        text,
  currency        text,
  languages       jsonb NOT NULL DEFAULT '[]'::jsonb,
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,        -- specialties/hours/pricing/travel/faq/kb...
  status          text  NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_tenants_updated BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── users (dashboard logins) ────────────────────────────────────────────────
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'owner'
                  CHECK (role IN ('owner','staff','reception','admin')),
  name          text,
  status        text NOT NULL DEFAULT 'active',
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uniq ON users (lower(email));
CREATE INDEX users_tenant_idx ON users (tenant_id);
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── patients ────────────────────────────────────────────────────────────────
CREATE TABLE patients (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wa_id          text NOT NULL,
  name           text,
  origin_city    text,
  origin_country text,
  contact        text,
  lang           text,
  meta           jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, wa_id)
);
CREATE INDEX patients_tenant_idx ON patients (tenant_id);
CREATE TRIGGER trg_patients_updated BEFORE UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── conversations (one per patient per tenant) ──────────────────────────────
CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_wa_id   text NOT NULL,
  patient_id      uuid REFERENCES patients(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','closed','needs_human','snoozed')),
  ai_paused       boolean NOT NULL DEFAULT false,
  lang            text,
  state           jsonb,                                     -- booking state-machine snapshot
  last_message_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, patient_wa_id)
);
CREATE INDEX conversations_tenant_wa_idx     ON conversations (tenant_id, patient_wa_id);
CREATE INDEX conversations_tenant_status_idx ON conversations (tenant_id, status);
CREATE TRIGGER trg_conversations_updated BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── messages (normalized transcript; append-heavy) ──────────────────────────
CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigint GENERATED ALWAYS AS IDENTITY,       -- deterministic tie-break
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tenant_id       text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  direction       text NOT NULL CHECK (direction IN ('inbound','outbound','system')),
  type            text NOT NULL DEFAULT 'text',
  body            jsonb NOT NULL DEFAULT '{}'::jsonb,
  wa_message_id   text,
  status          text,                                      -- sent/delivered/read/failed
  ts              timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_ts_idx ON messages (conversation_id, ts, seq);
CREATE INDEX messages_tenant_idx          ON messages (tenant_id);
CREATE UNIQUE INDEX messages_wa_id_uniq   ON messages (wa_message_id) WHERE wa_message_id IS NOT NULL;

-- ── appointments (holds every field the engine writes today) ────────────────
CREATE TABLE appointments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ref               text NOT NULL,                           -- human ref e.g. EAS-260802-001
  conversation_id   uuid REFERENCES conversations(id) ON DELETE SET NULL,
  patient_id        uuid REFERENCES patients(id) ON DELETE SET NULL,
  patient_wa_id     text,
  patient_name      text,
  specialty         text,
  specialty_label   text,
  datetime_iso      timestamptz,
  datetime_adjusted boolean NOT NULL DEFAULT false,
  origin_city       text,
  origin_country    text,
  origin_raw        text,
  contact           text,
  lang              text,
  channel           text NOT NULL DEFAULT 'whatsapp',
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','confirmed','done','no_show','cancelled')),
  created_by        text NOT NULL DEFAULT 'bot',             -- bot | staff
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, ref)
);
CREATE INDEX appointments_tenant_idx          ON appointments (tenant_id);
CREATE INDEX appointments_tenant_status_idx   ON appointments (tenant_id, status);
CREATE INDEX appointments_tenant_datetime_idx ON appointments (tenant_id, datetime_iso);
CREATE TRIGGER trg_appointments_updated BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── leads (medical-tourism pipeline) ────────────────────────────────────────
CREATE TABLE leads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  patient_id      uuid REFERENCES patients(id) ON DELETE SET NULL,
  patient_wa_id   text,
  procedure       text,
  origin_city     text,
  origin_country  text,
  budget_signal   text,
  status          text NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new','quoted','negotiating','booked','arrived','lost')),
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,        -- requested info, attachment refs
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_tenant_idx        ON leads (tenant_id);
CREATE INDEX leads_tenant_status_idx ON leads (tenant_id, status);
CREATE TRIGGER trg_leads_updated BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── kb_entries (knowledge base + "bot didn't know" training loop) ───────────
CREATE TABLE kb_entries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key        text NOT NULL,                                  -- stable id, e.g. 'visa_invitation'
  question   text,
  answer     jsonb NOT NULL DEFAULT '{}'::jsonb,             -- { ar, fr, en }
  keywords   jsonb NOT NULL DEFAULT '[]'::jsonb,
  lang       text,
  source     text NOT NULL DEFAULT 'manual'
               CHECK (source IN ('manual','template','didnt_know','import')),
  status     text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);
CREATE INDEX kb_entries_tenant_idx        ON kb_entries (tenant_id);
CREATE INDEX kb_entries_tenant_status_idx ON kb_entries (tenant_id, status);
CREATE TRIGGER trg_kb_entries_updated BEFORE UPDATE ON kb_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── events (append-only audit log) ──────────────────────────────────────────
CREATE TABLE events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       text REFERENCES tenants(id) ON DELETE CASCADE,
  type            text NOT NULL,                             -- e.g. appointment.created
  actor           text,                                      -- bot | staff:<uid> | patient | system
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_tenant_created_idx ON events (tenant_id, created_at);
CREATE INDEX events_tenant_type_idx    ON events (tenant_id, type);

-- ── notification_prefs (owner/reception alert routing) ──────────────────────
CREATE TABLE notification_prefs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recipient   text NOT NULL,                                 -- WhatsApp number or email
  channel     text NOT NULL DEFAULT 'whatsapp'
                CHECK (channel IN ('whatsapp','email','sms')),
  role        text,                                          -- owner | reception
  events      jsonb NOT NULL DEFAULT '{}'::jsonb,            -- per-event toggles
  quiet_hours jsonb,                                         -- { start, end, tz }
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, recipient, channel)
);
CREATE INDEX notification_prefs_tenant_idx ON notification_prefs (tenant_id);
CREATE TRIGGER trg_notification_prefs_updated BEFORE UPDATE ON notification_prefs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
