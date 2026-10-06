-- ============================================
-- guru_invites: capture the name + contract name the King enters when
-- inviting a Guru, so the King's admin panel can show a real, informative
-- pending record instead of a blank one while the invite is unaccepted.
-- Both columns are nullable — the invitee still supplies (and can correct)
-- their own name/contract_name at POST /auth/guru/register; this is purely
-- for the King's own visibility into what they invited.
-- Safe to re-run.
-- Usage: node scripts/run-migration.js migrations/007_guru_invites_add_contract_name.sql
-- ============================================

ALTER TABLE guru_invites ADD COLUMN IF NOT EXISTS contract_name TEXT;
