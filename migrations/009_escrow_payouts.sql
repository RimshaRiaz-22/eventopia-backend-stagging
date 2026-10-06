-- Escrow payouts: one row per liability paid out to a promoter after the event concludes.
-- Written only by the King's payout approval (escrowPayout.service.js). One payout per liability.
CREATE TABLE IF NOT EXISTS escrow_payouts (
  payout_id        SERIAL PRIMARY KEY,
  liability_id     INTEGER NOT NULL UNIQUE REFERENCES escrow_liabilities(liability_id),
  event_id         BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  promoter_id      BIGINT NOT NULL REFERENCES promoter_profiles(id) ON DELETE CASCADE,
  territory_id     BIGINT NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
  amount           NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  status           VARCHAR(20) NOT NULL DEFAULT 'PAID',
  coverage_status  VARCHAR(20),
  override_reason  TEXT,
  notes            TEXT,
  approved_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  approved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_escrow_payouts_territory ON escrow_payouts(territory_id, approved_at DESC);
CREATE INDEX IF NOT EXISTS idx_escrow_payouts_promoter ON escrow_payouts(promoter_id);
