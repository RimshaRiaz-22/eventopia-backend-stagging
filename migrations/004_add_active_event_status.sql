-- ============================================
-- Migration 004: Add active event status
-- Run once on existing databases after init.sql.
-- ============================================

ALTER TYPE event_status_enum ADD VALUE IF NOT EXISTS 'active' AFTER 'pending_approval';
