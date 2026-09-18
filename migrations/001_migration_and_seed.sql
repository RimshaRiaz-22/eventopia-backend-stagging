-- ============================================
-- Migration 001: Core tables + seed (single file)
-- Run once. Safe to re-run: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / ON CONFLICT DO NOTHING.
-- Does not drop or rename any existing columns or tables.
-- Prerequisite: DB already has base schema from src/db/init.sql (users, territories, etc.).
-- ============================================

-- ---------- PART 1: CORE TABLES MIGRATION ----------

-- 0) Add phone field to users for Settings module
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;

-- 1) Add optional columns to users (hierarchy / caching)
ALTER TABLE users ADD COLUMN IF NOT EXISTS territory_id BIGINT REFERENCES territories(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS guru_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

-- 2) Add optional columns to territories
ALTER TABLE territories ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'GBP';
ALTER TABLE territories ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';

-- 3) Networks table
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

-- 4) Add users.network_id
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

-- 10) Profile audit log - track all profile change attempts (Settings module requirement)
CREATE TABLE IF NOT EXISTS profile_audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL, -- 'update_profile', 'change_password', 'email_verification', etc.
  action_details JSONB, -- store what fields changed
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_profile_audit_user ON profile_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_profile_audit_created ON profile_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_audit_action ON profile_audit_logs(action_type);

-- ---------- PART 2: SEED (idempotent) ----------

-- Ensure roles table exists (in case migration runs without full init)
CREATE TABLE IF NOT EXISTS roles (key TEXT PRIMARY KEY);

-- Seed roles (safe to re-run)
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

-- Insert only if it does not already exist. OVERRIDING SYSTEM VALUE allows id=1 (column is IDENTITY).
INSERT INTO territories (id, name, country, currency, status)
OVERRIDING SYSTEM VALUE
SELECT 1, 'United Kingdom', 'UK', 'GBP', 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM territories WHERE id = 1
);
-- Ensure sequence is past id=1 so future inserts get 2, 3, ...
SELECT setval(pg_get_serial_sequence('territories', 'id'), (SELECT COALESCE(MAX(id), 1) FROM territories));

-- End of migration + seed.
