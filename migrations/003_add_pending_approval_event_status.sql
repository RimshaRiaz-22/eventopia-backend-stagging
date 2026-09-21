-- ============================================
-- Migration 003: Add pending_approval event status
-- Run once on existing databases after init.sql.
-- ============================================

ALTER TYPE event_status_enum ADD VALUE IF NOT EXISTS 'pending_approval' AFTER 'draft';
