-- ============================================
-- Guru role removed: roles are now King, Promoter and Buyer.
-- Promoter invites are sent by the King (kings_account_user_id), so the old
-- guru_user_id no longer has to be present. Existing rows are left untouched.
-- Safe to re-run.
-- Usage: node scripts/run-migration.js migrations/008_promoter_invites_king_only.sql
-- ============================================

ALTER TABLE promoter_referral_invites ALTER COLUMN guru_user_id DROP NOT NULL;

-- Audit trail for the King's Promoter module (replaces admin_guru_actions for new actions)
CREATE TABLE IF NOT EXISTS admin_promoter_actions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id BIGINT NOT NULL REFERENCES users(id),
  promoter_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action_type TEXT NOT NULL, -- 'application_approved', 'application_rejected', 'profile_update', 'block', 'unblock', 'delete'
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_promoter_actions_admin ON admin_promoter_actions(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_promoter_actions_promoter ON admin_promoter_actions(promoter_id);
CREATE INDEX IF NOT EXISTS idx_admin_promoter_actions_type ON admin_promoter_actions(action_type);

-- Promoter -> Promoter referrals no longer need a Guru on the referrer
ALTER TABLE promoter_referrals ALTER COLUMN guru_id DROP NOT NULL;
