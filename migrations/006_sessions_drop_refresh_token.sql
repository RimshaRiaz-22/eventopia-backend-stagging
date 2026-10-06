-- ============================================
-- Sessions: refresh tokens are no longer used.
-- A login now issues a single 24h access token (JWT_ACCESS_EXPIRE); when it expires the user logs in again.
-- Run this BEFORE deploying the code that stops writing sessions.refresh_token_hash.
-- Safe to re-run. The column is only made nullable (not dropped) so old and new code both work during rollout.
-- Usage: node scripts/run-migration.js migrations/006_sessions_drop_refresh_token.sql
-- ============================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'refresh_token_hash'
  ) THEN
    ALTER TABLE sessions ALTER COLUMN refresh_token_hash DROP NOT NULL;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_sessions_refresh_token;
