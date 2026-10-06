-- ============================================
-- Migration 001: Add core tables (spec-aligned)
-- Run once. Safe to re-run: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- Does not drop or rename any existing columns or tables.
-- ============================================

-- 0) Add phone field to users for Settings module
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;

-- 1) Add optional columns to users (hierarchy / caching)
ALTER TABLE users ADD COLUMN IF NOT EXISTS territory_id BIGINT REFERENCES territories(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS guru_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
-- network_id added after networks table exists (see step 3)

-- 2) Add optional columns to territories
ALTER TABLE territories ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'GBP';
ALTER TABLE territories ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';

-- 3) Networks table (spec: territory_id, network_manager_id, name, brand_identity, status, licence_fee_amount, licence_cleared_at)
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

-- 4) Add users.network_id now that networks exists
ALTER TABLE users ADD COLUMN IF NOT EXISTS network_id BIGINT REFERENCES networks(id) ON DELETE SET NULL;

-- 5) Guru profiles (spec: user_id, network_id, level, licence_balance, licence_cleared_at, l3_*, quarterly_refund_rate, contract_start_date)
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

-- 6) Promoter profiles (spec: user_id, guru_id, territory_id, ticket_count_settled, unlock_status, unlock_date, annual_cycle_start, current_threshold, year_number)
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

-- 7) Credit wallets (spec: user_id, role, projected_balance, available_balance, held_balance, currency)
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

-- 8) Ledger entries (spec: immutable; entry_type, user_id, role, level, territory_id, network_id, amount, rate_applied, gross_credit, net_credit, reference_id/type, approval_actor_id, proof_reference, status)
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

-- 9) Escrow accounts (spec: territory_id, balance, pending_liabilities, coverage_ratio, interest_earned)
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

-- 11) Add updated_at column to guru_invites for resend invitation tracking
ALTER TABLE guru_invites ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- 12) Add promoter_referral_invites table (time-limited invitations from Guru to Promoter)
CREATE TABLE IF NOT EXISTS promoter_referral_invites (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  referral_token TEXT UNIQUE NOT NULL,
  guru_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kings_account_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMP NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes'),
  used_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promoter_referral_invites_token ON promoter_referral_invites(referral_token);
CREATE INDEX IF NOT EXISTS idx_promoter_referral_invites_email ON promoter_referral_invites(email);
CREATE INDEX IF NOT EXISTS idx_promoter_referral_invites_guru ON promoter_referral_invites(guru_user_id);

-- Done. Existing tables and APIs unchanged.
