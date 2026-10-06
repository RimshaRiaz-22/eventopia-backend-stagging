-- ============================================
-- SINGLE MIGRATION FILE — run this once after init.sql
-- Creates all core tables, seed data, ledger trigger, and missing columns.
-- Safe to re-run: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / ON CONFLICT DO NOTHING.
-- Prerequisite: DB has base schema from src/db/init.sql (users, territories, events, etc.).
-- ============================================

-- ---------- PART 1: CORE TABLES ----------

-- 1) Users: optional hierarchy columns
ALTER TABLE users ADD COLUMN IF NOT EXISTS territory_id BIGINT REFERENCES territories(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS guru_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

-- 2) Territories: optional columns
ALTER TABLE territories ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'GBP';
ALTER TABLE territories ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';

-- 3) Networks
CREATE TABLE IF NOT EXISTS networks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  territory_id BIGINT REFERENCES territories(id) ON DELETE SET NULL,
  network_manager_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  brand_identity TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  licence_fee_amount BIGINT DEFAULT 0,
  licence_cleared_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_networks_territory ON networks(territory_id);
CREATE INDEX IF NOT EXISTS idx_networks_network_manager ON networks(network_manager_id);
CREATE INDEX IF NOT EXISTS idx_networks_status ON networks(status);

-- 4) Users.network_id
ALTER TABLE users ADD COLUMN IF NOT EXISTS network_id BIGINT REFERENCES networks(id) ON DELETE SET NULL;

-- 5) Guru profiles
CREATE TABLE IF NOT EXISTS guru_profiles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  network_id BIGINT REFERENCES networks(id) ON DELETE SET NULL,
  level TEXT,
  licence_balance BIGINT DEFAULT 0,
  licence_cleared_at TIMESTAMPTZ,
  l3_granted_at TIMESTAMPTZ,
  l3_retention_ticket_count INT DEFAULT 0,
  quarterly_refund_rate NUMERIC(5,4),
  contract_start_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);
CREATE INDEX IF NOT EXISTS idx_guru_profiles_user ON guru_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_guru_profiles_network ON guru_profiles(network_id);

-- 6) Promoter profiles
CREATE TABLE IF NOT EXISTS promoter_profiles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guru_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  territory_id BIGINT REFERENCES territories(id) ON DELETE SET NULL,
  ticket_count_settled INT NOT NULL DEFAULT 0,
  unlock_status TEXT,
  unlock_date DATE,
  annual_cycle_start DATE,
  current_threshold INT,
  year_number INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);
CREATE INDEX IF NOT EXISTS idx_promoter_profiles_user ON promoter_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_promoter_profiles_guru ON promoter_profiles(guru_id);
CREATE INDEX IF NOT EXISTS idx_promoter_profiles_territory ON promoter_profiles(territory_id);

-- 7) Credit wallets
CREATE TABLE IF NOT EXISTS credit_wallets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  projected_balance BIGINT NOT NULL DEFAULT 0,
  available_balance BIGINT NOT NULL DEFAULT 0,
  held_balance BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'GBP',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, role)
);
CREATE INDEX IF NOT EXISTS idx_credit_wallets_user ON credit_wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_wallets_role ON credit_wallets(role);

-- 8) Ledger entries
CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_type TEXT NOT NULL,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  role TEXT,
  level TEXT,
  territory_id BIGINT REFERENCES territories(id) ON DELETE SET NULL,
  network_id BIGINT REFERENCES networks(id) ON DELETE SET NULL,
  amount BIGINT NOT NULL DEFAULT 0,
  rate_applied NUMERIC(10,6),
  gross_credit BIGINT,
  net_credit BIGINT,
  reference_id BIGINT,
  reference_type TEXT,
  approval_actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  proof_reference TEXT,
  status TEXT NOT NULL DEFAULT 'posted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_user ON ledger_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_territory ON ledger_entries(territory_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_network ON ledger_entries(network_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_created ON ledger_entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_entry_type ON ledger_entries(entry_type);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_reference ON ledger_entries(reference_type, reference_id);

-- 9) Escrow accounts
CREATE TABLE IF NOT EXISTS escrow_accounts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  territory_id BIGINT NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
  balance BIGINT NOT NULL DEFAULT 0,
  pending_liabilities BIGINT NOT NULL DEFAULT 0,
  coverage_ratio NUMERIC(10,4),
  interest_earned BIGINT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (territory_id)
);
CREATE INDEX IF NOT EXISTS idx_escrow_accounts_territory ON escrow_accounts(territory_id);

-- ---------- PART 2: EVENTS FIX (missing column) ----------

ALTER TABLE events ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public';

-- ---------- PART 2b: EDIT/PUBLISH GAP — events columns + per-event escrow ----------

ALTER TABLE events ADD COLUMN IF NOT EXISTS doors_open_time TIMESTAMPTZ NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS stream_url TEXT NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS age_restriction TEXT NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS collect_attendee_names BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS stop_sale_at TIMESTAMPTZ NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS event_slug TEXT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_event_slug ON events(event_slug) WHERE event_slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_escrow_liability (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  promoter_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  territory_id BIGINT REFERENCES territories(id) ON DELETE SET NULL,
  total_ticket_revenue BIGINT NOT NULL DEFAULT 0,
  booking_fee_collected BIGINT NOT NULL DEFAULT 0,
  escrow_balance BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'holding' CHECK (status IN ('holding', 'released', 'refunded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at TIMESTAMPTZ NULL,
  UNIQUE (event_id)
);
CREATE INDEX IF NOT EXISTS idx_event_escrow_liability_event ON event_escrow_liability(event_id);
CREATE INDEX IF NOT EXISTS idx_event_escrow_liability_status ON event_escrow_liability(status);

-- ---------- PART 3: LEDGER IMMUTABILITY TRIGGER ----------

CREATE OR REPLACE FUNCTION ledger_entries_immutable_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'ledger_entries is immutable: UPDATE not allowed';
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger_entries is immutable: DELETE not allowed';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_entries_immutable ON ledger_entries;
CREATE TRIGGER ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW
  EXECUTE PROCEDURE ledger_entries_immutable_trigger();

-- ---------- PART 4: SEED (idempotent) ----------

CREATE TABLE IF NOT EXISTS roles (key TEXT PRIMARY KEY);

INSERT INTO roles (key) VALUES
  ('buyer'),
  ('promoter'),
  ('guru'),
  ('network_manager'),
  ('admin'),
  ('staff_finance'),
  ('staff_rewards'),
  ('staff_charity'),
  ('kings_account'),
  ('founder')
ON CONFLICT (key) DO NOTHING;

INSERT INTO territories (id, name, country, currency, status)
OVERRIDING SYSTEM VALUE
SELECT 1, 'United Kingdom', 'UK', 'GBP', 'active'
WHERE NOT EXISTS (SELECT 1 FROM territories WHERE id = 1);

SELECT setval(pg_get_serial_sequence('territories', 'id'), (SELECT COALESCE(MAX(id), 1) FROM territories));

-- End of migration.
