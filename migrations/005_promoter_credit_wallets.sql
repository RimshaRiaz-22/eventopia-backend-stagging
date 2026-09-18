-- Promoter credit wallet (Credit Engine) — one row per promoter user (users.id)
CREATE TABLE IF NOT EXISTS promoter_credit_wallets (
  wallet_id TEXT PRIMARY KEY,
  promoter_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'LOCKED',
  ticket_count INT NOT NULL DEFAULT 0,
  unlock_date TIMESTAMPTZ,
  service_fee_rate NUMERIC(5,4) NOT NULL DEFAULT 0.10,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT promoter_credit_wallets_status_check CHECK (status IN ('LOCKED', 'UNLOCKED'))
);

CREATE INDEX IF NOT EXISTS idx_promoter_credit_wallets_promoter ON promoter_credit_wallets(promoter_id);
