-- ============================================
-- Migration 002: Ledger entries immutability
-- Run after 001_migration_and_seed.sql (ledger_entries must exist).
-- Ensures no UPDATE or DELETE on ledger_entries at database level.
-- ============================================

-- Trigger function: raise error on any UPDATE or DELETE attempt
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

-- Attach trigger to ledger_entries
DROP TRIGGER IF EXISTS ledger_entries_immutable ON ledger_entries;
CREATE TRIGGER ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW
  EXECUTE PROCEDURE ledger_entries_immutable_trigger();

-- Permission note for production:
-- The application user that connects to the database should have
-- only INSERT and SELECT on ledger_entries (no UPDATE, no DELETE).
-- Example (run as superuser, replace 'app_user' with your role):
--   REVOKE UPDATE, DELETE ON ledger_entries FROM app_user;
--   GRANT INSERT, SELECT ON ledger_entries TO app_user;
--   GRANT USAGE, SELECT ON SEQUENCE ledger_entries_id_seq TO app_user;
