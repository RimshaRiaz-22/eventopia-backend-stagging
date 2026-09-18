/* ================================
   Extensions
   ================================ */
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


/* ================================
   Users table
   ================================ */
CREATE TABLE IF NOT EXISTS users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email CITEXT UNIQUE NOT NULL,
  password_hash TEXT, -- For email/password signups
  email_verified_at TIMESTAMP,
  name TEXT,
  city TEXT,
  avatar_url TEXT,
  status TEXT DEFAULT 'active',
  role TEXT, -- Single role per user (e.g. 'buyer', 'promoter', 'guru', 'network_manager', etc.). NULL for pending applications.
  roles_version INT DEFAULT 1, -- Incremented when role changes to invalidate tokens
  account_status TEXT DEFAULT 'active', -- 'pending', 'invited', 'requested', 'active', 'blocked'
  email_status TEXT DEFAULT 'pending', -- 'pending', 'verified' (or 'active' per spec)
  
  -- OAuth fields
  oauth_provider VARCHAR(50), -- 'google', 'facebook', etc.
  oauth_id VARCHAR(255), -- Unique ID from OAuth provider

  -- Phone number (E.164 format validation required)
  phone TEXT,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_login_at TIMESTAMP
);

-- Index for fast OAuth lookups
CREATE INDEX IF NOT EXISTS idx_users_oauth_provider_id
ON users(oauth_provider, oauth_id);



/* ================================
   Roles table
   ================================ */
CREATE TABLE IF NOT EXISTS roles (
  key TEXT PRIMARY KEY
);

INSERT INTO roles (key) VALUES
  ('buyer'),           -- Default role, auto-assigned on signup
  ('promoter'),        -- Paid upgrade (£85), requires buyer role
  ('guru'),            -- Paid upgrade (£250), requires buyer role
  ('network_manager'), -- Admin-assigned only, requires buyer role
  ('admin'),           -- Admin-assigned only
  ('staff_finance'),   -- Admin-assigned only
  ('staff_rewards'),   -- Admin-assigned only
  ('staff_charity'),
  ('kings_account'),   -- Admin-assigned only
  ('founder')          -- Admin-assigned only
ON CONFLICT DO NOTHING;



/* (User roles table removed: single role is now stored directly on users.role) */


/* ================================
   OTPs table (AUTO-INCREMENT)
   ================================ */
CREATE TABLE IF NOT EXISTS otps (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- challengeId
  email CITEXT NOT NULL,
  purpose TEXT NOT NULL, -- SIGNUP | LOGIN
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  consumed_at TIMESTAMP,
  attempt_count INT DEFAULT 0,
  send_count INT DEFAULT 1,
  last_sent_at TIMESTAMP DEFAULT NOW(),
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);


/* ================================
   Auth identities (for social logins)
   ================================ */
CREATE TABLE IF NOT EXISTS auth_identities (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, -- 'google', 'apple', 'facebook'
  provider_user_id TEXT NOT NULL,
  email CITEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_identities_user_id ON auth_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_identities_provider ON auth_identities(provider, provider_user_id);

/* ================================
   Devices table
   ================================ */
CREATE TABLE IF NOT EXISTS devices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_type TEXT, -- 'web', 'ios', 'android'
  last_seen_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_device_id ON devices(device_id);

/* ================================
   Promoter-Guru links (referral system)
   ================================ */
CREATE TABLE IF NOT EXISTS promoter_guru_links (
  promoter_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  guru_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'referral_link', -- 'referral_link' or 'admin'
  created_at TIMESTAMP DEFAULT NOW(),
  changed_at TIMESTAMP,
  changed_by_admin_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (promoter_user_id)
);

CREATE INDEX IF NOT EXISTS idx_promoter_guru_guru ON promoter_guru_links(guru_user_id);

/* ================================
   Email verification tokens
   ================================ */
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  consumed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_verification_user ON email_verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verification_token ON email_verification_tokens(token);

/* ================================
   Password reset tokens
   ================================ */
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  consumed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_token ON password_reset_tokens(token);

/* ================================
   Sessions table (updated for JWT + refresh tokens)
   ================================ */
CREATE TABLE IF NOT EXISTS sessions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT,
  refresh_token_hash TEXT NOT NULL, -- Hashed refresh token
  access_token_jti TEXT, -- JWT ID for access token (for revocation tracking)
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL, -- Refresh token expiration
  revoked_at TIMESTAMP,
  revoked_reason TEXT,
  ip TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_refresh_token ON sessions(refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(user_id, device_id);

/* ================================
  Profile audit logs (Settings)
  ================================ */
CREATE TABLE IF NOT EXISTS profile_audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  action_details JSONB,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profile_audit_user ON profile_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_profile_audit_created ON profile_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_audit_action ON profile_audit_logs(action_type);


/* ================================
   Categories + Tags (Discovery)
   ================================ */
CREATE TABLE IF NOT EXISTS categories (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id BIGINT NULL REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_categories_parent_sort
  ON categories(parent_id, sort_order, name);

CREATE TABLE IF NOT EXISTS tags (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_tags_slug UNIQUE (slug)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name_lower
  ON tags(LOWER(name));

CREATE INDEX IF NOT EXISTS idx_tags_sort
  ON tags(sort_order, name);

/* ================================
   User Preferences (Discovery defaults)
   ================================ */
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  city TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_preference_tags (
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  tag_id BIGINT REFERENCES tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_upt_user ON user_preference_tags(user_id);
CREATE INDEX IF NOT EXISTS idx_upt_tag ON user_preference_tags(tag_id);

/* ================================
   Events (Public discovery)
   ================================ */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_type_enum') THEN
    CREATE TYPE event_type_enum AS ENUM ('online','in_person','hybrid', 'virtual');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_visibility_enum') THEN
    CREATE TYPE event_visibility_enum AS ENUM ('public','unlisted','private');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_status_enum') THEN
    CREATE TYPE event_status_enum AS ENUM ('draft','pending_approval','active','published','completed','cancelled','unpublished');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ticket_status_enum') THEN
    CREATE TYPE ticket_status_enum AS ENUM ('active','sold_out','ended','hidden');
  END IF;

  -- Access mode enum for ticket types
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'access_mode_enum') THEN
    CREATE TYPE access_mode_enum AS ENUM ('IN_PERSON', 'ONLINE_LIVE', 'ON_DEMAND');
  END IF;

  -- Reveal rule enum for online live tickets
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reveal_rule_enum') THEN
    CREATE TYPE reveal_rule_enum AS ENUM ('AT_PURCHASE', 'ONE_HOUR_BEFORE', 'AT_START');
  END IF;

  -- Access token purpose enum
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'access_token_purpose_enum') THEN
    CREATE TYPE access_token_purpose_enum AS ENUM ('LIVE_JOIN', 'ONDEMAND_VIEW');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  promoter_id BIGINT REFERENCES users(id) ON DELETE SET NULL,

  -- Frozen hierarchy attribution (must be stored on event)
  guru_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  network_manager_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  territory_id BIGINT REFERENCES territories(id) ON DELETE SET NULL,

  -- Core event data
  title TEXT NOT NULL,
  description TEXT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Europe/London',

  -- Event format (delivery)
  format event_type_enum NOT NULL DEFAULT 'in_person',

  -- Event access mode (entry model)
  access_mode TEXT NOT NULL DEFAULT 'ticketed', -- 'ticketed', 'guest_list', 'mixed'

  -- Visibility (discoverability)
  visibility TEXT NOT NULL DEFAULT 'public', -- 'public', 'private_link'
  share_token TEXT UNIQUE, -- Required if private_link

  -- Location display
  city_display TEXT NOT NULL,
  venue_name TEXT NULL,
  venue_address TEXT NULL,
  lat DOUBLE PRECISION NULL,
  lng DOUBLE PRECISION NULL,

  -- Lifecycle
  status event_status_enum NOT NULL DEFAULT 'draft',
  published_at TIMESTAMPTZ NULL,
  cancelled_at TIMESTAMPTZ NULL,
  cancel_reason TEXT,

  -- Completion
  completion_status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'completed'
  completed_at TIMESTAMPTZ NULL,
  completed_by BIGINT REFERENCES users(id),

  -- Ticket readiness
  ticketing_required BOOLEAN NOT NULL DEFAULT true,

  -- Other fields
  category_id BIGINT REFERENCES categories(id) ON DELETE SET NULL,
  meeting_link TEXT NULL,
  cover_image_url TEXT NULL,
  gallery_image_urls TEXT[] NULL,
  tickets_sold INT NOT NULL DEFAULT 0,

  -- Access control for online events
  live_access_url TEXT NULL,
  ondemand_access_url TEXT NULL,
  access_link_version INT NOT NULL DEFAULT 1,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()

);

CREATE INDEX IF NOT EXISTS idx_events_public_base ON events(status, visibility, start_at);
CREATE INDEX IF NOT EXISTS idx_events_city_start ON events(city_display, start_at);
CREATE INDEX IF NOT EXISTS idx_events_category_start ON events(category_id, start_at);
CREATE INDEX IF NOT EXISTS idx_events_popular ON events(tickets_sold DESC);
CREATE INDEX IF NOT EXISTS idx_events_promoter_status ON events(promoter_id, status);
CREATE INDEX IF NOT EXISTS idx_events_share_token ON events(share_token);
CREATE INDEX IF NOT EXISTS idx_events_completion ON events(completion_status, completed_at);
CREATE INDEX IF NOT EXISTS idx_events_visibility_start ON events(visibility, start_at);
CREATE INDEX IF NOT EXISTS idx_events_completed_by ON events(completed_by);

-- Index for access token lookups
CREATE INDEX IF NOT EXISTS idx_events_access_version ON events(id, access_link_version);

-- Create audit log table for tracking event changes
CREATE TABLE IF NOT EXISTS event_audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id BIGINT REFERENCES events(id) ON DELETE CASCADE,
  promoter_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  field_name TEXT,
  old_value TEXT,
  new_value TEXT,
  request_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_audit_logs_event_id ON event_audit_logs(event_id);
CREATE INDEX IF NOT EXISTS idx_event_audit_logs_promoter_id ON event_audit_logs(promoter_id);
CREATE INDEX IF NOT EXISTS idx_event_audit_logs_action ON event_audit_logs(action);

-- Create event views tracking table for analytics
CREATE TABLE IF NOT EXISTS event_views (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id BIGINT REFERENCES events(id) ON DELETE CASCADE,
  viewer_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ip_address INET,
  user_agent TEXT,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_views_event_id ON event_views(event_id);
CREATE INDEX IF NOT EXISTS idx_event_views_viewed_at ON event_views(viewed_at);

CREATE TABLE IF NOT EXISTS event_tags (
  event_id BIGINT REFERENCES events(id) ON DELETE CASCADE,
  tag_id BIGINT REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_event_tags_tag ON event_tags(tag_id, event_id);

CREATE TABLE IF NOT EXISTS ticket_types (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id BIGINT REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  currency TEXT NOT NULL DEFAULT 'GBP',
  price_amount INT NOT NULL,
  booking_fee_amount INT NOT NULL DEFAULT 0,
  sales_start_at TIMESTAMPTZ NULL,
  sales_end_at TIMESTAMPTZ NULL,
  capacity_total INT NULL,
  qty_sold INT NOT NULL DEFAULT 0,
  per_order_limit INT NOT NULL DEFAULT 10,
  visibility TEXT NOT NULL DEFAULT 'public',
  status ticket_status_enum NOT NULL DEFAULT 'active',
  sort_order INT NOT NULL DEFAULT 0,

  -- Access control settings
  access_mode access_mode_enum NOT NULL DEFAULT 'IN_PERSON',
  reveal_rule reveal_rule_enum NULL,
  on_demand_start_at TIMESTAMPTZ NULL,
  on_demand_end_at TIMESTAMPTZ NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add constraint: reveal_rule only for ONLINE_LIVE
ALTER TABLE ticket_types
ADD CONSTRAINT IF NOT EXISTS chk_reveal_rule_for_online_live
CHECK (
  (access_mode = 'ONLINE_LIVE' AND reveal_rule IS NOT NULL) OR
  (access_mode != 'ONLINE_LIVE' AND reveal_rule IS NULL)
);

-- Add constraint: on-demand windows only for ON_DEMAND
ALTER TABLE ticket_types
ADD CONSTRAINT IF NOT EXISTS chk_on_demand_window
CHECK (
  (access_mode = 'ON_DEMAND' AND on_demand_start_at IS NOT NULL AND on_demand_end_at IS NOT NULL) OR
  (access_mode != 'ON_DEMAND' AND (on_demand_start_at IS NULL AND on_demand_end_at IS NULL))
);

-- Add constraint: on-demand window must be before end
ALTER TABLE ticket_types
ADD CONSTRAINT IF NOT EXISTS chk_on_demand_window_order
CHECK (
  on_demand_start_at IS NULL OR on_demand_end_at IS NULL OR
  on_demand_start_at < on_demand_end_at
);

CREATE INDEX IF NOT EXISTS idx_ticket_types_event_sort ON ticket_types(event_id, sort_order);

/* ================================
   Ticket validation logs (must exist before tickets due to FK)
   ================================ */
CREATE TABLE IF NOT EXISTS ticket_validation_logs (
    id BIGSERIAL PRIMARY KEY,
    event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    ticket_id BIGINT, -- FK added after tickets table exists
    qr_hash VARCHAR(255) NOT NULL,
    result_status VARCHAR(50) NOT NULL,
    scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    scanned_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_validation_logs_event_id ON ticket_validation_logs(event_id);
CREATE INDEX IF NOT EXISTS idx_ticket_validation_logs_ticket_id ON ticket_validation_logs(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_validation_logs_scanned_at ON ticket_validation_logs(scanned_at);
CREATE INDEX IF NOT EXISTS idx_ticket_validation_logs_result_status ON ticket_validation_logs(result_status);

/* ================================
   Territories table (Optional - for caching if needed)
   Note: Territories are fetched directly from GeoNames API
   ================================ */
CREATE TABLE IF NOT EXISTS territories (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE, -- City/region name (e.g., "London", "Birmingham")
  country TEXT NOT NULL DEFAULT 'UK',
  geoname_id BIGINT, -- GeoNames ID for reference
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_territories_name ON territories(name);
CREATE INDEX IF NOT EXISTS idx_territories_active ON territories(is_active);

/* ================================
   Network Manager Applications table
   ================================ */
CREATE TABLE IF NOT EXISTS network_manager_applications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  territory_name TEXT NOT NULL,
  avatar_url TEXT,
  account_status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL, -- Admin who reviewed
  reviewed_at TIMESTAMP,
  rejection_reason TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id) -- One application per user
);

CREATE INDEX IF NOT EXISTS idx_nm_applications_user_id ON network_manager_applications(user_id);
CREATE INDEX IF NOT EXISTS idx_nm_applications_status ON network_manager_applications(account_status);

/* ================================
   Guru Applications table
   ================================ */
CREATE TABLE IF NOT EXISTS guru_applications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  network_manager_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  invite_token TEXT UNIQUE,
  avatar_url TEXT,
  contract_name TEXT,
  agreed_to_terms BOOLEAN NOT NULL DEFAULT FALSE,
  agreed_to_guru_agreement BOOLEAN NOT NULL DEFAULT FALSE,
  account_status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
  territory_name TEXT, -- Territory name for the Guru
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  rejection_reason TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id) -- One application per user
);

CREATE INDEX IF NOT EXISTS idx_guru_applications_user_id ON guru_applications(user_id);
CREATE INDEX IF NOT EXISTS idx_guru_applications_status ON guru_applications(account_status);
CREATE INDEX IF NOT EXISTS idx_guru_applications_nm_id ON guru_applications(network_manager_user_id);
CREATE INDEX IF NOT EXISTS idx_guru_applications_invite_token ON guru_applications(invite_token);
CREATE INDEX IF NOT EXISTS idx_guru_applications_territory ON guru_applications(territory_name);

/* Extend guru_applications: activation fee commitment (Guru £250 flow) */
DO $$
BEGIN
  ALTER TABLE guru_applications ADD COLUMN IF NOT EXISTS verification_status TEXT DEFAULT 'pending';
  ALTER TABLE guru_applications ADD COLUMN IF NOT EXISTS activation_fee_status TEXT;
  ALTER TABLE guru_applications ADD COLUMN IF NOT EXISTS activation_fee_balance BIGINT DEFAULT 0;
  ALTER TABLE guru_applications ADD COLUMN IF NOT EXISTS activation_fee_payment_method TEXT;
  ALTER TABLE guru_applications ADD COLUMN IF NOT EXISTS activation_fee_committed_at TIMESTAMPTZ;
  ALTER TABLE guru_applications ADD COLUMN IF NOT EXISTS phone TEXT;
  ALTER TABLE guru_applications ADD COLUMN IF NOT EXISTS contract_name TEXT;
END $$;

/* ================================
   Guru-Network Manager relationship table
   ================================ */
CREATE TABLE IF NOT EXISTS guru_network_manager (
  guru_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  network_manager_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  territory_id BIGINT REFERENCES territories(id),
  territory_name TEXT, -- Territory/city name from Network Manager
  assigned_at TIMESTAMP DEFAULT NOW(),
  assigned_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (guru_user_id)
);

CREATE INDEX IF NOT EXISTS idx_gnm_guru_id ON guru_network_manager(guru_user_id);
CREATE INDEX IF NOT EXISTS idx_gnm_nm_id ON guru_network_manager(network_manager_user_id);
CREATE INDEX IF NOT EXISTS idx_gnm_territory ON guru_network_manager(territory_id);
CREATE INDEX IF NOT EXISTS idx_gnm_territory_name ON guru_network_manager(territory_name);

/* ================================
   Promoter Applications table
   ================================ */
CREATE TABLE IF NOT EXISTS promoter_applications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guru_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  invite_token TEXT UNIQUE,
  avatar_url TEXT,
  agreed_to_terms BOOLEAN NOT NULL DEFAULT FALSE,
  agreed_to_promoter_agreement BOOLEAN NOT NULL DEFAULT FALSE,
  agreed_to_activation_fee_terms BOOLEAN NOT NULL DEFAULT FALSE,
  account_status TEXT NOT NULL DEFAULT 'pending',
  territory_name TEXT,
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  rejection_reason TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_promoter_applications_user_id ON promoter_applications(user_id);
CREATE INDEX IF NOT EXISTS idx_promoter_applications_status ON promoter_applications(account_status);
CREATE INDEX IF NOT EXISTS idx_promoter_applications_guru_id ON promoter_applications(guru_user_id);
CREATE INDEX IF NOT EXISTS idx_promoter_applications_invite_token ON promoter_applications(invite_token);
CREATE INDEX IF NOT EXISTS idx_promoter_applications_territory ON promoter_applications(territory_name);

/* ================================
   Wallets table
   ================================ */
CREATE TABLE IF NOT EXISTS wallets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance_amount BIGINT NOT NULL DEFAULT 0, -- Amount in smallest currency unit (pence for GBP)
  currency TEXT NOT NULL DEFAULT 'GBP',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id) -- One wallet per user
);

CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);

/* ================================
   Invoices/Ledger entries table
   ================================ */
CREATE TABLE IF NOT EXISTS invoices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  amount BIGINT NOT NULL, -- Amount in smallest currency unit (pence for GBP)
  currency TEXT NOT NULL DEFAULT 'GBP',
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'paid', 'cancelled'
  invoice_type TEXT NOT NULL DEFAULT 'fee', -- 'fee', 'payment', 'refund', etc.
  related_entity_type TEXT, -- 'network_manager_application', 'event', etc.
  related_entity_id BIGINT, -- ID of related entity
  paid_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_user_id ON invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_related ON invoices(related_entity_type, related_entity_id);

/* ================================
   Orders table for ticketing system
   ================================ */
CREATE TABLE IF NOT EXISTS orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_number TEXT UNIQUE NOT NULL,
  buyer_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  subtotal_amount BIGINT NOT NULL DEFAULT 0,
  booking_fee_amount BIGINT NOT NULL DEFAULT 0,
  total_amount BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'GBP',
  status TEXT NOT NULL DEFAULT 'payment_pending',
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  payment_intent_id TEXT,
  payment_provider TEXT,
  expires_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_buyer_user ON orders(buyer_user_id);
CREATE INDEX IF NOT EXISTS idx_orders_event ON orders(event_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_number ON orders(order_number);
CREATE INDEX IF NOT EXISTS idx_orders_idempotency ON orders(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);

/* ================================
   Order items table for ticketing system
   ================================ */
CREATE TABLE IF NOT EXISTS order_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  ticket_type_id BIGINT NOT NULL REFERENCES ticket_types(id) ON DELETE RESTRICT,
  ticket_name TEXT NOT NULL,
  ticket_price_amount BIGINT NOT NULL,
  ticket_booking_fee_amount BIGINT NOT NULL DEFAULT 0,
  quantity INT NOT NULL DEFAULT 1,
  subtotal_amount BIGINT NOT NULL,
  buyer_name TEXT,
  buyer_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Add UUID for external references
  -- uuid_id UUID PRIMARY KEY DEFAULT uuid_generate_v4()
  uuid_id UUID UNIQUE DEFAULT gen_random_uuid()

);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_ticket_type ON order_items(ticket_type_id);
CREATE INDEX IF NOT EXISTS idx_order_items_created_at ON order_items(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_uuid ON order_items(uuid_id);

/* ================================
   Inventory Reservations table
   Reserved inventory without incrementing qty_sold until payment
   ================================ */
CREATE TABLE IF NOT EXISTS inventory_reservations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  ticket_type_id BIGINT NOT NULL REFERENCES ticket_types(id) ON DELETE RESTRICT,
  quantity INT NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- 'active', 'consumed', 'expired', 'cancelled'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_reservations_order ON inventory_reservations(order_id);
CREATE INDEX IF NOT EXISTS idx_inventory_reservations_ticket_type ON inventory_reservations(ticket_type_id);
CREATE INDEX IF NOT EXISTS idx_inventory_reservations_status ON inventory_reservations(status);
CREATE INDEX IF NOT EXISTS idx_inventory_reservations_expires ON inventory_reservations(expires_at);

/* ================================
   Tickets table for ticketing system
   ================================ */
CREATE TABLE IF NOT EXISTS tickets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_item_id BIGINT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  ticket_type_id BIGINT NOT NULL REFERENCES ticket_types(id) ON DELETE RESTRICT,
  ticket_code TEXT UNIQUE NOT NULL,
  buyer_name TEXT NOT NULL,
  buyer_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  checked_in_at TIMESTAMPTZ,
  checked_in_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  qr_code_data TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- New columns for enhanced ticket system
  -- uuid_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- order_id BIGINT REFERENCES orders(id) ON DELETE CASCADE,
  uuid_id UUID UNIQUE DEFAULT gen_random_uuid(),
  order_id BIGINT REFERENCES orders(id) ON DELETE CASCADE,


  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  used_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  validation_log_id BIGINT REFERENCES ticket_validation_logs(id) ON DELETE SET NULL
);

-- Add new status constraint
ALTER TABLE tickets
DROP CONSTRAINT IF EXISTS tickets_status_check;
ALTER TABLE tickets
ADD CONSTRAINT tickets_status_check
CHECK (status IN ('ACTIVE', 'USED', 'REFUNDED', 'CANCELLED', 'VOID'));

-- Update existing tickets to ACTIVE if status is 'active' (legacy)
UPDATE tickets SET status = 'ACTIVE' WHERE status = 'active';
UPDATE tickets SET status = 'USED' WHERE status = 'checked_in';

-- Add new indexes
CREATE INDEX IF NOT EXISTS idx_tickets_uuid ON tickets(uuid_id);
CREATE INDEX IF NOT EXISTS idx_tickets_order ON tickets(order_id);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_used_at ON tickets(used_at);
CREATE INDEX IF NOT EXISTS idx_tickets_refunded_at ON tickets(refunded_at);
CREATE INDEX IF NOT EXISTS idx_tickets_cancelled_at ON tickets(cancelled_at);

CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets(event_id);
CREATE INDEX IF NOT EXISTS idx_tickets_order_item ON tickets(order_item_id);
CREATE INDEX IF NOT EXISTS idx_tickets_code ON tickets(ticket_code);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_buyer_email ON tickets(buyer_email);
CREATE INDEX IF NOT EXISTS idx_tickets_created_at ON tickets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_used_by_user ON tickets(used_by_user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_validation_log ON tickets(validation_log_id);

-- Add FK from ticket_validation_logs.ticket_id to tickets (circular dependency)
ALTER TABLE ticket_validation_logs
  DROP CONSTRAINT IF EXISTS ticket_validation_logs_ticket_id_fkey;
ALTER TABLE ticket_validation_logs
  ADD CONSTRAINT ticket_validation_logs_ticket_id_fkey
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE;

/* ================================
   Check-ins table for ticket scanning
   ================================ */
CREATE TABLE IF NOT EXISTS checkins (
    id BIGSERIAL PRIMARY KEY,
    ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    promoter_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    gate_id VARCHAR(100),
    method VARCHAR(20) DEFAULT 'CAMERA',
    device_id VARCHAR(100),
    ip INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checkins_ticket_id ON checkins(ticket_id);
CREATE INDEX IF NOT EXISTS idx_checkins_event_id ON checkins(event_id);
CREATE INDEX IF NOT EXISTS idx_checkins_promoter ON checkins(promoter_user_id);
CREATE INDEX IF NOT EXISTS idx_checkins_event_scanned
  ON checkins(event_id, scanned_at DESC);

/* ================================
   Ticket audit logs for append-only status tracking
   ================================ */
CREATE TABLE IF NOT EXISTS ticket_audit_logs (
    id BIGSERIAL PRIMARY KEY,
    ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL, -- MINTED, VALIDATED, CHECKED_IN, UNDO_CHECKIN, REFUNDED, CANCELLED
    before_status VARCHAR(20),
    after_status VARCHAR(20),
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_audit_logs_ticket_id ON ticket_audit_logs(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_audit_logs_event_id ON ticket_audit_logs(event_id);
CREATE INDEX IF NOT EXISTS idx_ticket_audit_logs_created_at ON ticket_audit_logs(created_at DESC);

/* ================================
   Helper function to calculate ticket availability
   ================================ */
CREATE OR REPLACE FUNCTION calculate_ticket_availability(
  p_ticket_type_id BIGINT
) RETURNS TABLE (
  capacity_total INT,
  qty_sold INT,
  capacity_remaining INT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(tt.capacity_total, 999999)::INT as capacity_total,
    tt.qty_sold,
    (COALESCE(tt.capacity_total, 999999) - tt.qty_sold)::INT as capacity_remaining
  FROM ticket_types tt
  WHERE tt.id = p_ticket_type_id;
END;
$$ LANGUAGE plpgsql;

/* ================================
   Job Runs table for background job tracking
   ================================ */
CREATE TABLE IF NOT EXISTS job_runs (
    id BIGSERIAL PRIMARY KEY,
    job_name VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    error_message TEXT,
    attempts INTEGER NOT NULL DEFAULT 1,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_runs_job_name ON job_runs(job_name);
CREATE INDEX IF NOT EXISTS idx_job_runs_status ON job_runs(status);
CREATE INDEX IF NOT EXISTS idx_job_runs_started_at ON job_runs(started_at);

/* ================================
   Guru System Extensions
   ================================ */

/* Add Guru activation fields to users table */
ALTER TABLE users ADD COLUMN IF NOT EXISTS guru_active BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS guru_active_until TIMESTAMP NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS guru_activation_date TIMESTAMP NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_fee_paid BOOLEAN DEFAULT FALSE;

/* ================================
   Guru Invites table (for admin-created invites before user exists)
   ================================ */
CREATE TABLE IF NOT EXISTS guru_invites (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'guru',
  invite_token TEXT UNIQUE NOT NULL,
  network_manager_user_id BIGINT REFERENCES users(id),
  created_by BIGINT NOT NULL REFERENCES users(id),
  expires_at TIMESTAMP NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  used_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guru_invites_token ON guru_invites(invite_token);
CREATE INDEX IF NOT EXISTS idx_guru_invites_email ON guru_invites(email);

/* ================================
   Promoter Referral Invites table (Time-limited invitations from Guru to Promoter)
   Module 5: Promoter — Registration via Guru Referral Link
   ================================ */
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

/* ================================
   Guru Levels System
   ================================ */
CREATE TABLE IF NOT EXISTS guru_levels (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guru_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level INT NOT NULL CHECK (level >= 1 AND level <= 3),
  rate_per_ticket INT NOT NULL, -- In pence (20, 35, 50)
  effective_from TIMESTAMP NOT NULL DEFAULT NOW(),
  effective_until TIMESTAMP NULL,
  created_by BIGINT REFERENCES users(id),
  reason TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guru_levels_guru_id ON guru_levels(guru_id);
CREATE INDEX IF NOT EXISTS idx_guru_levels_current ON guru_levels(guru_id, effective_from) WHERE effective_until IS NULL;

CREATE TABLE IF NOT EXISTS guru_commission_rates (
  level INT PRIMARY KEY,
  rate_per_ticket INT NOT NULL, -- In pence
  effective_from TIMESTAMP NOT NULL DEFAULT NOW(),
  effective_until TIMESTAMP NULL
);

INSERT INTO guru_commission_rates (level, rate_per_ticket) VALUES
  (1, 20),
  (2, 35),
  (3, 50)
ON CONFLICT (level) DO NOTHING;

/* ================================
   Referral System
   ================================ */
CREATE TABLE IF NOT EXISTS guru_referrals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guru_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referral_code TEXT UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  revoked_at TIMESTAMP NULL
);

CREATE INDEX IF NOT EXISTS idx_guru_referrals_guru_id ON guru_referrals(guru_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_guru_referrals_code ON guru_referrals(referral_code);

CREATE TABLE IF NOT EXISTS referral_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  referral_code TEXT NOT NULL,
  guru_id BIGINT NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('click', 'signup', 'promoter_activation')),
  visitor_id TEXT,
  user_id BIGINT REFERENCES users(id),
  ip_address INET,
  user_agent TEXT,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_events_code ON referral_events(referral_code);
CREATE INDEX IF NOT EXISTS idx_referral_events_guru ON referral_events(guru_id);
CREATE INDEX IF NOT EXISTS idx_referral_events_user ON referral_events(user_id);

CREATE TABLE IF NOT EXISTS user_attributions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guru_id BIGINT REFERENCES users(id),
  referral_code TEXT,
  signed_up_via_referral BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_attributions_guru ON user_attributions(guru_id);
CREATE INDEX IF NOT EXISTS idx_user_attributions_user ON user_attributions(user_id);

/* ================================
   Promoter -> Promoter Referrals (Flow 1)
   ================================ */
CREATE TABLE IF NOT EXISTS territory_referral_pool (
  territory_code TEXT PRIMARY KEY,
  pool_total BIGINT NOT NULL,
  pool_remaining BIGINT NOT NULL,
  total_paid_out BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS promoter_referrals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  referrer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  guru_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  territory_code TEXT NOT NULL DEFAULT 'UK',
  referral_link_token TEXT UNIQUE NOT NULL,
  start_date TIMESTAMPTZ,
  expiry_date TIMESTAMPTZ,
  ticket_count INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'link_issued',
  payout_amount BIGINT NOT NULL DEFAULT 17250,
  payout_scheduled_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promoter_referrals_referrer ON promoter_referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_promoter_referrals_referred ON promoter_referrals(referred_id);
CREATE INDEX IF NOT EXISTS idx_promoter_referrals_status ON promoter_referrals(status);
CREATE INDEX IF NOT EXISTS idx_promoter_referrals_expiry ON promoter_referrals(expiry_date);

CREATE TABLE IF NOT EXISTS promoter_referral_payouts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  referral_id BIGINT NOT NULL UNIQUE REFERENCES promoter_referrals(id) ON DELETE CASCADE,
  referrer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payout_amount BIGINT NOT NULL DEFAULT 17250,
  scheduled_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ,
  approved_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  paid_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'payout_pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promoter_referral_payouts_status ON promoter_referral_payouts(status);
CREATE INDEX IF NOT EXISTS idx_promoter_referral_payouts_schedule ON promoter_referral_payouts(scheduled_at);

/* ================================
   Signup Fee Tracking
   ================================ */
CREATE TABLE IF NOT EXISTS signup_fees (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_type TEXT NOT NULL,
  amount INT NOT NULL, -- In pence
  currency TEXT NOT NULL DEFAULT 'GBP',
  status TEXT NOT NULL DEFAULT 'paid',
  payment_method TEXT,
  payment_reference TEXT,
  paid_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signup_fees_user ON signup_fees(user_id);
CREATE INDEX IF NOT EXISTS idx_signup_fees_role ON signup_fees(role_type);

/* ================================
   Commission Tracking
   ================================ */
CREATE TABLE IF NOT EXISTS guru_commissions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guru_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  promoter_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id BIGINT REFERENCES events(id) ON DELETE SET NULL,
  order_id BIGINT REFERENCES orders(id) ON DELETE CASCADE,
  tickets_count INT NOT NULL,
  commission_rate INT NOT NULL, -- In pence per ticket
  total_commission INT NOT NULL, -- In pence
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'paid', 'cancelled'
  calculated_at TIMESTAMP DEFAULT NOW(),
  paid_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guru_commissions_guru ON guru_commissions(guru_id);
CREATE INDEX IF NOT EXISTS idx_guru_commissions_promoter ON guru_commissions(promoter_id);
CREATE INDEX IF NOT EXISTS idx_guru_commissions_status ON guru_commissions(status);
CREATE INDEX IF NOT EXISTS idx_guru_commissions_order ON guru_commissions(order_id);

/* ================================
   Admin Actions Audit Log
   ================================ */
CREATE TABLE IF NOT EXISTS admin_guru_actions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id BIGINT NOT NULL REFERENCES users(id),
  guru_id BIGINT REFERENCES users(id),
  action_type TEXT NOT NULL, -- 'level_change', 'promoter_attachment', 'manual_activation'
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_guru_actions_admin ON admin_guru_actions(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_guru_actions_guru ON admin_guru_actions(guru_id);
CREATE INDEX IF NOT EXISTS idx_admin_guru_actions_type ON admin_guru_actions(action_type);

/* ================================
   Webhook Events Table for Idempotency
   Track processed webhook events to prevent duplicate processing
   ================================ */
CREATE TABLE IF NOT EXISTS webhook_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL, -- 'stripe', 'paypal', etc.
  event_id TEXT NOT NULL, -- Provider's unique event ID
  event_type TEXT NOT NULL, -- 'payment_intent.succeeded', 'payment_intent.payment_failed', etc.
  processed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_provider_event ON webhook_events(provider, event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_processed_at ON webhook_events(processed_at);

/* ================================
   Event Media Table
   Store event images with stable IDs for API
   ================================ */
CREATE TABLE IF NOT EXISTS event_media (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  file_url TEXT NOT NULL,
  file_type TEXT NOT NULL DEFAULT 'image', -- 'image', 'video', etc.
  sort_order INT NOT NULL DEFAULT 0,
  is_cover BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_media_event ON event_media(event_id);
CREATE INDEX IF NOT EXISTS idx_event_media_sort ON event_media(event_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_event_media_cover ON event_media(event_id, is_cover);

/* ================================
   Reward Vouchers Table
   Stores loyalty reward vouchers issued to promoters and gurus
   ================================ */
CREATE TABLE IF NOT EXISTS reward_vouchers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('promoter', 'guru')),
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  amount BIGINT NOT NULL, -- Amount in pence
  currency TEXT NOT NULL DEFAULT 'GBP',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'expired')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL DEFAULT 'event_completion',
  reminder_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency constraint: one voucher per event per owner
CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_vouchers_unique
  ON reward_vouchers(event_id, owner_type, owner_id);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_reward_vouchers_owner ON reward_vouchers(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_reward_vouchers_event ON reward_vouchers(event_id);
CREATE INDEX IF NOT EXISTS idx_reward_vouchers_status ON reward_vouchers(status);
CREATE INDEX IF NOT EXISTS idx_reward_vouchers_expires ON reward_vouchers(expires_at);

/* ================================
   System Configuration Table
   Store system-wide configuration settings
   ================================ */
CREATE TABLE IF NOT EXISTS system_config (
  config_key TEXT PRIMARY KEY,
  config_value TEXT NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL
);

-- Insert default configuration values
INSERT INTO system_config (config_key, config_value, description) VALUES
  ('voucher_expiry_months', '12', 'Number of months before vouchers expire'),
  ('promoter_reward_per_ticket_pence', '100', 'Promoter reward amount in pence per ticket sold (£1.00)'),
  ('voucher_expiry_reminder_days', '7', 'Send reminder this many days before voucher expires')
ON CONFLICT (config_key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_system_config_key ON system_config(config_key);

/* ================================
   Access Tokens Table
   Secure short-lived tokens for online access
   ================================ */
CREATE TABLE IF NOT EXISTS access_tokens (
  id BIGSERIAL PRIMARY KEY,
  ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL, -- SHA-256 hash of the token
  purpose access_token_purpose_enum NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ NULL,
  version_at_issue INT NOT NULL,
  access_count INT NOT NULL DEFAULT 0,
  last_accessed_at TIMESTAMPTZ NULL,
  ip_address INET NULL,
  user_agent TEXT NULL,
  created_by BIGINT NULL REFERENCES users(id)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_access_tokens_hash ON access_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_access_tokens_event ON access_tokens(event_id);
CREATE INDEX IF NOT EXISTS idx_access_tokens_ticket ON access_tokens(ticket_id);
CREATE INDEX IF NOT EXISTS idx_access_tokens_active ON access_tokens(event_id, revoked_at) WHERE revoked_at IS NULL;

-- Constraints
ALTER TABLE access_tokens
ADD CONSTRAINT IF NOT EXISTS chk_token_not_expired
CHECK (expires_at > created_at);

ALTER TABLE access_tokens
ADD CONSTRAINT IF NOT EXISTS chk_token_version_positive
CHECK (version_at_issue > 0);

-- ==========================================
-- CHARITY POT SYSTEM (Phase 9)
-- ==========================================

-- Charity Applications Table
CREATE TABLE IF NOT EXISTS charity_applications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  promoter_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id BIGINT REFERENCES events(id) ON DELETE CASCADE,

  -- Application details
  charity_name TEXT NOT NULL,
  charity_number TEXT NOT NULL,
  charity_description TEXT NOT NULL,
  charity_website TEXT,
  charitable_objectives TEXT NOT NULL,
  beneficiary_details TEXT,
  requested_amount BIGINT NOT NULL, -- In pence
  application_fee_amount BIGINT NOT NULL DEFAULT 0, -- In pence

  -- Status tracking
  status TEXT NOT NULL DEFAULT 'DRAFT',
  decision_amount BIGINT,
  rejection_reason TEXT,

  -- Admin review
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  admin_notes TEXT,

  -- Timestamps
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_charity_applications_promoter ON charity_applications(promoter_id);
CREATE INDEX IF NOT EXISTS idx_charity_applications_event ON charity_applications(event_id);
CREATE INDEX IF NOT EXISTS idx_charity_applications_status ON charity_applications(status);
CREATE INDEX IF NOT EXISTS idx_charity_applications_created ON charity_applications(created_at DESC);

-- Charity Application Payments Table
CREATE TABLE IF NOT EXISTS charity_application_payments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id BIGINT NOT NULL REFERENCES charity_applications(id) ON DELETE CASCADE,

  -- Payment details
  amount BIGINT NOT NULL, -- In pence
  currency TEXT NOT NULL DEFAULT 'GBP',
  payment_provider TEXT NOT NULL, -- 'noda', 'stripe', etc.
  payment_intent_id TEXT,
  payment_method TEXT, -- 'open_banking', 'card', etc.

  -- Idempotency
  idempotency_key TEXT UNIQUE,

  -- Status tracking
  status TEXT NOT NULL, -- 'pending', 'processing', 'succeeded', 'failed', 'cancelled'
  provider_data JSONB,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_charity_app_payments_app ON charity_application_payments(application_id);
CREATE INDEX IF NOT EXISTS idx_charity_app_payments_status ON charity_application_payments(status);
CREATE INDEX IF NOT EXISTS idx_charity_app_payments_idempotency ON charity_application_payments(idempotency_key);

-- Charity Application Decisions Table
CREATE TABLE IF NOT EXISTS charity_application_decisions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id BIGINT NOT NULL REFERENCES charity_applications(id) ON DELETE CASCADE,

  -- Decision details
  decision TEXT NOT NULL, -- 'approved', 'partial_approved', 'rejected'
  decision_amount BIGINT, -- In pence (for approved/partial)
  rejection_reason TEXT,
  admin_notes TEXT,

  -- Admin who made the decision
  decided_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_charity_decisions_app ON charity_application_decisions(application_id);
CREATE INDEX IF NOT EXISTS idx_charity_decisions_decided_by ON charity_application_decisions(decided_by);

-- Charity Pot Ledger Table
CREATE TABLE IF NOT EXISTS charity_pot_ledger (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Reference to application (nullable for adjustments)
  application_id BIGINT REFERENCES charity_applications(id) ON DELETE SET NULL,

  -- Transaction details
  transaction_type TEXT NOT NULL, -- 'credit', 'debit', 'adjustment'
  amount BIGINT NOT NULL, -- In pence
  balance_after BIGINT NOT NULL, -- Running balance after this transaction

  -- Account reference
  account TEXT NOT NULL DEFAULT 'Charity_Pot_Payable', -- Liability account

  -- Description
  description TEXT NOT NULL,
  reference_type TEXT, -- 'application_fee', 'decision_payout', 'refund', 'adjustment'
  reference_id BIGINT, -- ID of related record

  -- Metadata
  metadata JSONB,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_charity_ledger_app ON charity_pot_ledger(application_id);
CREATE INDEX IF NOT EXISTS idx_charity_ledger_created ON charity_pot_ledger(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_charity_ledger_type ON charity_pot_ledger(transaction_type);
CREATE INDEX IF NOT EXISTS idx_charity_ledger_account ON charity_pot_ledger(account);

-- Charity Pot Executions Table
CREATE TABLE IF NOT EXISTS charity_pot_executions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id BIGINT NOT NULL REFERENCES charity_applications(id) ON DELETE CASCADE,

  -- Execution details
  execution_type TEXT NOT NULL, -- 'payout', 'refund'
  amount BIGINT NOT NULL, -- In pence
  currency TEXT NOT NULL DEFAULT 'GBP',

  -- Payment recipient (NEVER promoter)
  recipient_type TEXT NOT NULL, -- 'venue', 'supplier', 'marketing_platform', 'refund_to_applicant'
  recipient_name TEXT NOT NULL,
  recipient_details JSONB, -- Store bank details, invoice refs, etc.

  -- Execution tracking
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed', 'cancelled'
  execution_reference TEXT, -- External payment reference

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_charity_executions_app ON charity_pot_executions(application_id);
CREATE INDEX IF NOT EXISTS idx_charity_executions_status ON charity_pot_executions(status);
CREATE INDEX IF NOT EXISTS idx_charity_executions_created ON charity_pot_executions(created_at DESC);

-- Charity Pot Audit Logs Table
CREATE TABLE IF NOT EXISTS charity_pot_audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id BIGINT REFERENCES charity_applications(id) ON DELETE SET NULL,

  -- Action tracking
  action TEXT NOT NULL, -- 'created', 'submitted', 'fee_paid', 'approved', 'rejected', 'executed', etc.
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,

  -- Change tracking
  field_name TEXT,
  old_value TEXT,
  new_value TEXT,

  -- Request metadata
  request_id TEXT,
  ip_address TEXT,
  user_agent TEXT,

  -- Additional data
  metadata JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_charity_audit_app ON charity_pot_audit_logs(application_id);
CREATE INDEX IF NOT EXISTS idx_charity_audit_action ON charity_pot_audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_charity_audit_actor ON charity_pot_audit_logs(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_charity_audit_created ON charity_pot_audit_logs(created_at DESC);

-- ==========================================
-- PLATFORM LEDGER AND ALLOCATIONS (Phase 10)
-- ==========================================

CREATE TABLE IF NOT EXISTS platform_ledger (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entity_type TEXT NOT NULL,
  entity_id BIGINT,
  entry_type TEXT NOT NULL,
  amount BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  description TEXT NOT NULL,
  order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  event_id BIGINT REFERENCES events(id) ON DELETE SET NULL,
  promoter_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_platform_ledger_created ON platform_ledger(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_ledger_entity ON platform_ledger(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_platform_ledger_order ON platform_ledger(order_id);
CREATE INDEX IF NOT EXISTS idx_platform_ledger_event ON platform_ledger(event_id);

CREATE TABLE IF NOT EXISTS ledger_allocations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ledger_entry_id BIGINT REFERENCES platform_ledger(id) ON DELETE CASCADE,
  allocation_type TEXT NOT NULL,
  beneficiary_type TEXT NOT NULL,
  beneficiary_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  amount BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reference_id BIGINT,
  reference_type TEXT
);

CREATE INDEX IF NOT EXISTS idx_ledger_allocations_entry ON ledger_allocations(ledger_entry_id);
CREATE INDEX IF NOT EXISTS idx_ledger_allocations_type_beneficiary ON ledger_allocations(allocation_type, beneficiary_id);
CREATE INDEX IF NOT EXISTS idx_ledger_allocations_created ON ledger_allocations(created_at DESC);

-- Obligations (promoter payable, network manager payable)
CREATE TABLE IF NOT EXISTS obligations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  beneficiary_type TEXT NOT NULL,
  beneficiary_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_owed BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reference_type TEXT,
  reference_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_obligations_beneficiary ON obligations(beneficiary_type, beneficiary_id);
CREATE INDEX IF NOT EXISTS idx_obligations_status ON obligations(status);

-- Admin audit log (King's Account views and exports)
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id BIGINT NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource TEXT,
  metadata JSONB,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin ON admin_audit_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action ON admin_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created ON admin_audit_log(created_at DESC);

/* ================================
   Territory Licence Inventory (Network Manager licence territories)
   Separate from territories table used for events/gurus.
   ================================ */
CREATE TABLE IF NOT EXISTS territory_licence_inventory (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  country_code TEXT NOT NULL,
  region_name TEXT NOT NULL,
  region_slug TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  licence_fee_amount BIGINT NOT NULL DEFAULT 250000,
  contract_duration_months INT NOT NULL DEFAULT 12,
  renewal_type TEXT NOT NULL DEFAULT 'MANUAL',
  max_slots INT NOT NULL DEFAULT 12,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  available_from TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (region_slug)
);

CREATE INDEX IF NOT EXISTS idx_tli_status ON territory_licence_inventory(status);
CREATE INDEX IF NOT EXISTS idx_tli_region_slug ON territory_licence_inventory(region_slug);
CREATE INDEX IF NOT EXISTS idx_tli_available_from ON territory_licence_inventory(available_from);

/* ================================
   Territory Reservations (10-min hold for slot)
   ================================ */
CREATE TABLE IF NOT EXISTS territory_reservations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  territory_id BIGINT NOT NULL REFERENCES territory_licence_inventory(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'HELD',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tr_territory_status ON territory_reservations(territory_id, status);
CREATE INDEX IF NOT EXISTS idx_tr_user_id ON territory_reservations(user_id);
CREATE INDEX IF NOT EXISTS idx_tr_expires_at ON territory_reservations(expires_at);

/* ================================
   Territory Applications (waitlist / request access when full)
   ================================ */
CREATE TABLE IF NOT EXISTS territory_applications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  territory_id BIGINT NOT NULL REFERENCES territory_licence_inventory(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SUBMITTED',
  notes TEXT,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ta_territory_id ON territory_applications(territory_id);
CREATE INDEX IF NOT EXISTS idx_ta_user_id ON territory_applications(user_id);
CREATE INDEX IF NOT EXISTS idx_ta_status ON territory_applications(status);

/* ================================
   Territory Licences (one per user per territory)
   ================================ */
CREATE TABLE IF NOT EXISTS territory_licences (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  territory_id BIGINT NOT NULL REFERENCES territory_licence_inventory(id) ON DELETE RESTRICT,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  licence_fee_amount_snapshot BIGINT NOT NULL,
  payment_mode TEXT NOT NULL,
  licence_status TEXT NOT NULL DEFAULT 'ACTIVE',
  licence_balance_remaining BIGINT NOT NULL DEFAULT 0,
  contract_start_date DATE NOT NULL,
  contract_end_date DATE NOT NULL,
  auto_renew_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  identity_verified BOOLEAN NOT NULL DEFAULT FALSE,
  non_transferable BOOLEAN NOT NULL DEFAULT TRUE,
  level_status TEXT NOT NULL DEFAULT 'L1',
  service_fee_rate_current NUMERIC(5,4) NOT NULL DEFAULT 0.2,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tl_user_territory_active ON territory_licences(territory_id, user_id) WHERE licence_status IN ('ACTIVE', 'CLEARED');
CREATE INDEX IF NOT EXISTS idx_tl_user_id ON territory_licences(user_id);
CREATE INDEX IF NOT EXISTS idx_tl_territory_id ON territory_licences(territory_id);
CREATE INDEX IF NOT EXISTS idx_tl_licence_status ON territory_licences(licence_status);

/* ================================
   Credit Ledger (immutable audit for NM credits and fees)
   ================================ */
CREATE TABLE IF NOT EXISTS credit_ledger (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  territory_id BIGINT REFERENCES territory_licence_inventory(id) ON DELETE SET NULL,
  network_licence_id BIGINT REFERENCES territory_licences(id) ON DELETE SET NULL,
  event_id BIGINT,
  entry_type TEXT NOT NULL,
  amount BIGINT NOT NULL DEFAULT 0,
  metadata_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cl_user_id ON credit_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_cl_territory_id ON credit_ledger(territory_id);
CREATE INDEX IF NOT EXISTS idx_cl_network_licence_id ON credit_ledger(network_licence_id);
CREATE INDEX IF NOT EXISTS idx_cl_entry_type ON credit_ledger(entry_type);
CREATE INDEX IF NOT EXISTS idx_cl_created_at ON credit_ledger(created_at DESC);

/* ================================
   Service Fee Statements (monthly per user/territory)
   ================================ */
CREATE TABLE IF NOT EXISTS service_fee_statements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  territory_id BIGINT REFERENCES territory_licence_inventory(id) ON DELETE SET NULL,
  network_licence_id BIGINT REFERENCES territory_licences(id) ON DELETE SET NULL,
  statement_month TEXT NOT NULL,
  gross_credit BIGINT NOT NULL DEFAULT 0,
  service_fee_rate NUMERIC(5,4) NOT NULL DEFAULT 0.2,
  service_fee_amount BIGINT NOT NULL DEFAULT 0,
  net_credit BIGINT NOT NULL DEFAULT 0,
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sfs_user_id ON service_fee_statements(user_id);
CREATE INDEX IF NOT EXISTS idx_sfs_statement_month ON service_fee_statements(statement_month);

/* ================================
   Extend network_manager_applications for new flow
   ================================ */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'network_manager_applications' AND column_name = 'territory_id') THEN
    ALTER TABLE network_manager_applications ADD COLUMN territory_id BIGINT REFERENCES territory_licence_inventory(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'network_manager_applications' AND column_name = 'reservation_id') THEN
    ALTER TABLE network_manager_applications ADD COLUMN reservation_id BIGINT REFERENCES territory_reservations(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'network_manager_applications' AND column_name = 'applicant_profile_json') THEN
    ALTER TABLE network_manager_applications ADD COLUMN applicant_profile_json JSONB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'network_manager_applications' AND column_name = 'docs_json') THEN
    ALTER TABLE network_manager_applications ADD COLUMN docs_json JSONB;
  END IF;
  -- Dropped: accepted_terms_at, agreed_to_terms, agreed_to_territory_terms,
  -- agreed_to_privacy_policy, confirmed_docs_authentic, agreed_to_code_of_conduct
  ALTER TABLE network_manager_applications DROP COLUMN IF EXISTS accepted_terms_at;
  ALTER TABLE network_manager_applications DROP COLUMN IF EXISTS agreed_to_terms;
  ALTER TABLE network_manager_applications DROP COLUMN IF EXISTS agreed_to_territory_terms;
  ALTER TABLE network_manager_applications DROP COLUMN IF EXISTS agreed_to_privacy_policy;
  ALTER TABLE network_manager_applications DROP COLUMN IF EXISTS confirmed_docs_authentic;
  ALTER TABLE network_manager_applications DROP COLUMN IF EXISTS agreed_to_code_of_conduct;
END $$;

/* Extend territory_licences: level_status (L1/L2/L3), service_fee_rate_current for acceptance criteria */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'territory_licences' AND column_name = 'level_status') THEN
    ALTER TABLE territory_licences ADD COLUMN level_status TEXT NOT NULL DEFAULT 'L1';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'territory_licences' AND column_name = 'service_fee_rate_current') THEN
    ALTER TABLE territory_licences ADD COLUMN service_fee_rate_current NUMERIC(5,4) NOT NULL DEFAULT 0.2;
  END IF;
  DROP INDEX IF EXISTS idx_tl_user_territory_active;
  CREATE UNIQUE INDEX idx_tl_user_territory_active ON territory_licences(territory_id, user_id) WHERE licence_status IN ('ACTIVE', 'CLEARED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

/* Territory expansion: allow one application per (user, territory) instead of one per user */
DO $$
DECLARE
  conname text;
BEGIN
  SELECT c.conname INTO conname
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  WHERE t.relname = 'network_manager_applications' AND c.contype = 'u' AND array_length(c.conkey, 1) = 1
  LIMIT 1;
  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE network_manager_applications DROP CONSTRAINT IF EXISTS %I', conname);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_nma_user_territory ON network_manager_applications(user_id, territory_id) WHERE territory_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_nma_user_legacy ON network_manager_applications(user_id) WHERE territory_id IS NULL;

/* ================================
   Guru Registration - Activation Fee & Payment Transactions
   ================================ */
CREATE TABLE IF NOT EXISTS payment_transactions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id BIGINT,
  amount BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  direction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  payment_method TEXT,
  payment_reference TEXT,
  idempotency_key TEXT UNIQUE,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_user ON payment_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_entity ON payment_transactions(entity_type, entity_id);

/* Add service_fee_rate to guru_commission_rates (L1=20%, L2=15%, L3=10%) */
DO $$
BEGIN
  ALTER TABLE guru_commission_rates ADD COLUMN IF NOT EXISTS service_fee_rate NUMERIC(5,4) NOT NULL DEFAULT 0.2;
END $$;
UPDATE guru_commission_rates SET service_fee_rate = 0.20 WHERE level = 1;
UPDATE guru_commission_rates SET service_fee_rate = 0.15 WHERE level = 2;
UPDATE guru_commission_rates SET service_fee_rate = 0.10 WHERE level = 3;

/* Add service_fee_rate to guru_levels */
DO $$
BEGIN
  ALTER TABLE guru_levels ADD COLUMN IF NOT EXISTS service_fee_rate NUMERIC(5,4) DEFAULT 0.2;
END $$;

/* Wallets: allow negative balance for Guru activation fee debt */
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS chk_wallet_balance_non_negative;

/* Seed territory licence inventory (UK, Europe, UAE) */
INSERT INTO territory_licence_inventory (country_code, region_name, region_slug, currency, licence_fee_amount, contract_duration_months, renewal_type, max_slots, status)
VALUES
  ('UK', 'United Kingdom', 'uk', 'GBP', 250000, 12, 'MANUAL', 12, 'ACTIVE'),
  ('EU', 'Europe', 'europe', 'GBP', 250000, 12, 'MANUAL', 12, 'ACTIVE'),
  ('AE', 'UAE', 'uae', 'GBP', 250000, 12, 'MANUAL', 12, 'ACTIVE')
ON CONFLICT (region_slug) DO NOTHING;

/* ================================
   My Gurus module: Phase 0 - Guru to licence link
   ================================ */
DO $$
BEGIN
  ALTER TABLE guru_network_manager
    ADD COLUMN IF NOT EXISTS network_licence_id BIGINT REFERENCES territory_licences(id) ON DELETE SET NULL;
END $$;
CREATE INDEX IF NOT EXISTS idx_gnm_network_licence ON guru_network_manager(network_licence_id);

/* Backfill: set network_licence_id from NM's first active licence */
UPDATE guru_network_manager gnm
SET network_licence_id = sub.licence_id
FROM (
  SELECT gnm2.guru_user_id,
         (SELECT tl.id FROM territory_licences tl
          WHERE tl.user_id = gnm2.network_manager_user_id
            AND tl.licence_status IN ('ACTIVE', 'CLEARED')
          ORDER BY tl.id LIMIT 1) AS licence_id
  FROM guru_network_manager gnm2
  WHERE gnm2.network_licence_id IS NULL
) sub
WHERE gnm.guru_user_id = sub.guru_user_id AND sub.licence_id IS NOT NULL;

/* ================================
   My Gurus module: Phase 1 - Settlement fields
   ================================ */
DO $$
BEGIN
  ALTER TABLE events ADD COLUMN IF NOT EXISTS settlement_status TEXT DEFAULT 'pending';
END $$;
UPDATE events SET settlement_status = 'SETTLED' WHERE completion_status = 'completed' AND COALESCE(settlement_status, '') != 'SETTLED';

/* ================================
   My Gurus module: Phase 2 - Aggregation tables
   ================================ */
CREATE TABLE IF NOT EXISTS guru_metrics_daily (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guru_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  territory_id BIGINT REFERENCES territory_licence_inventory(id) ON DELETE SET NULL,
  network_licence_id BIGINT REFERENCES territory_licences(id) ON DELETE SET NULL,
  metric_date DATE NOT NULL,
  settled_tickets_count INT NOT NULL DEFAULT 0,
  refunds_count INT NOT NULL DEFAULT 0,
  active_promoters_count INT NOT NULL DEFAULT 0,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (guru_id, network_licence_id, metric_date)
);
CREATE INDEX IF NOT EXISTS idx_gmd_guru_date ON guru_metrics_daily(guru_id, metric_date);
CREATE INDEX IF NOT EXISTS idx_gmd_licence_date ON guru_metrics_daily(network_licence_id, metric_date);

CREATE TABLE IF NOT EXISTS guru_metrics_rollups (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guru_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  territory_id BIGINT REFERENCES territory_licence_inventory(id) ON DELETE SET NULL,
  network_licence_id BIGINT REFERENCES territory_licences(id) ON DELETE SET NULL,
  settled_tickets_mtd INT NOT NULL DEFAULT 0,
  settled_tickets_90d INT NOT NULL DEFAULT 0,
  settled_tickets_quarter INT NOT NULL DEFAULT 0,
  settled_tickets_ytd INT NOT NULL DEFAULT 0,
  refunds_quarter INT NOT NULL DEFAULT 0,
  refund_rate_quarter_percent NUMERIC(8,4) DEFAULT 0,
  risk_score INT DEFAULT 0,
  risk_level TEXT DEFAULT 'low',
  risk_reasons JSONB DEFAULT '[]'::jsonb,
  active_promoters_count INT NOT NULL DEFAULT 0,
  last_settlement_at TIMESTAMPTZ,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gmr_guru_licence ON guru_metrics_rollups(guru_id, network_licence_id) WHERE network_licence_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_gmr_guru_null_licence ON guru_metrics_rollups(guru_id) WHERE network_licence_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_gmr_guru ON guru_metrics_rollups(guru_id);
CREATE INDEX IF NOT EXISTS idx_gmr_licence ON guru_metrics_rollups(network_licence_id);

/* ================================
   My Gurus module: Phase 4 - Notes, Flags, Replacement, Audit
   ================================ */
CREATE TABLE IF NOT EXISTS guru_notes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guru_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  network_licence_id BIGINT REFERENCES territory_licences(id) ON DELETE SET NULL,
  note_text TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Performance', 'Refund risk', 'Compliance', 'Support')),
  attachments JSONB DEFAULT '[]'::jsonb,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_guru_notes_guru ON guru_notes(guru_id);
CREATE INDEX IF NOT EXISTS idx_guru_notes_licence ON guru_notes(network_licence_id);
CREATE INDEX IF NOT EXISTS idx_guru_notes_created ON guru_notes(created_at DESC);

CREATE TABLE IF NOT EXISTS guru_flags (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guru_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  network_licence_id BIGINT REFERENCES territory_licences(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  category TEXT CHECK (category IN ('Performance', 'Refund risk', 'Compliance', 'Support')),
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by BIGINT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_guru_flags_guru ON guru_flags(guru_id);
CREATE INDEX IF NOT EXISTS idx_guru_flags_licence ON guru_flags(network_licence_id);

CREATE TABLE IF NOT EXISTS guru_replacement_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guru_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  network_licence_id BIGINT REFERENCES territory_licences(id) ON DELETE SET NULL,
  requested_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  evidence_notes TEXT,
  attachments JSONB DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_notes TEXT,
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_grr_guru ON guru_replacement_requests(guru_id);
CREATE INDEX IF NOT EXISTS idx_grr_licence ON guru_replacement_requests(network_licence_id);
CREATE INDEX IF NOT EXISTS idx_grr_status ON guru_replacement_requests(status);

CREATE TABLE IF NOT EXISTS network_manager_audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  resource_id BIGINT,
  before_snapshot JSONB,
  after_snapshot JSONB,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nmal_actor ON network_manager_audit_log(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_nmal_action ON network_manager_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_nmal_created ON network_manager_audit_log(created_at DESC);

/* ================================
   ESCROW SYSTEM TABLES (Day 6)
   Contracts 15, 16, 17
   ================================ */

-- escrow_accounts: Segregated custodial accounts (escrow + operating) per territory
CREATE TABLE IF NOT EXISTS escrow_accounts (
  escrow_account_id    SERIAL PRIMARY KEY,
  territory_id         BIGINT NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
  account_type         VARCHAR(20) NOT NULL CHECK (account_type IN ('escrow', 'operating')),
  current_balance      NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
  total_deposited      NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
  total_withdrawn      NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
  interest_earned      NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
  last_interest_update TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(territory_id, account_type)
);
CREATE INDEX IF NOT EXISTS idx_escrow_accounts_territory ON escrow_accounts(territory_id);
CREATE INDEX IF NOT EXISTS idx_escrow_accounts_type ON escrow_accounts(account_type);

-- escrow_liabilities: Track promoter payment obligations per event
CREATE TABLE IF NOT EXISTS escrow_liabilities (
  liability_id         SERIAL PRIMARY KEY,
  territory_id         BIGINT NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
  promoter_id          BIGINT NOT NULL REFERENCES promoter_profiles(id) ON DELETE CASCADE,
  event_id             BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  gross_ticket_revenue NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
  refund_deductions    NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
  net_liability        NUMERIC(14, 2) GENERATED ALWAYS AS (gross_ticket_revenue - refund_deductions) STORED,
  status               VARCHAR(30) NOT NULL DEFAULT 'HOLDING'
                       CHECK (status IN ('HOLDING', 'PAYOUT_ELIGIBLE', 'PAID_OUT', 'REFUNDED', 'PARTIAL_REFUND')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_escrow_liabilities_territory_status ON escrow_liabilities(territory_id, status);
CREATE INDEX IF NOT EXISTS idx_escrow_liabilities_event_id ON escrow_liabilities(event_id);
CREATE INDEX IF NOT EXISTS idx_escrow_liabilities_promoter_id ON escrow_liabilities(promoter_id);

-- escrow_interest_log: Immutable interest earning history (interest belongs to Eventopia, not promoters)
CREATE TABLE IF NOT EXISTS escrow_interest_log (
  interest_id       SERIAL PRIMARY KEY,
  territory_id      BIGINT NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
  period_start      DATE NOT NULL,
  period_end        DATE NOT NULL,
  opening_balance   NUMERIC(14, 2) NOT NULL,
  interest_rate     NUMERIC(8, 6) NOT NULL,
  interest_amount   NUMERIC(14, 2) NOT NULL,
  source            VARCHAR(50) NOT NULL DEFAULT 'bank_statement',
  recorded_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_escrow_interest_territory_period ON escrow_interest_log(territory_id, period_end DESC);

-- Trigger: Prevent UPDATE/DELETE on escrow_interest_log (immutable audit trail)
CREATE OR REPLACE FUNCTION prevent_escrow_interest_modification()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'escrow_interest_log is immutable. Cannot % interest entry.', 
      CASE WHEN TG_OP = 'UPDATE' THEN 'update' ELSE 'delete' END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_prevent_interest_modification ON escrow_interest_log;
CREATE TRIGGER trigger_prevent_interest_modification
BEFORE UPDATE OR DELETE ON escrow_interest_log
FOR EACH ROW EXECUTE FUNCTION prevent_escrow_interest_modification();

/* ================================
   ALERTS SYSTEM (Day 6 - Phase 6)
   Stores system-wide alerts (RED coverage, compliance, etc.)
   ================================ */

CREATE TABLE IF NOT EXISTS alerts (
  id                SERIAL PRIMARY KEY,
  territory_id      BIGINT NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
  alert_type        VARCHAR(50) NOT NULL,
  level             VARCHAR(20) NOT NULL CHECK (level IN ('INFO', 'WARNING', 'CRITICAL')),
  title             VARCHAR(255) NOT NULL,
  message           TEXT NOT NULL,
  notified_roles    JSONB DEFAULT '[]'::jsonb,
  triggered_at      TIMESTAMPTZ NOT NULL,
  resolved_at       TIMESTAMPTZ,
  status            VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'acknowledged', 'resolved')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_territory ON alerts(territory_id);
CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_alerts_level ON alerts(level);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON alerts(resolved_at);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_territory_type_resolved ON alerts(territory_id, alert_type, resolved_at);

/* ================================
   ALERT AUDIT LOG (Immutable)
   Track all alert lifecycle events for compliance
   ================================ */

CREATE TABLE IF NOT EXISTS alert_audit_logs (
  id                SERIAL PRIMARY KEY,
  alert_id          INT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  territory_id      BIGINT NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
  action            VARCHAR(50) NOT NULL,
  actor_id          VARCHAR(100) NOT NULL,
  metadata          JSONB DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_audit_logs_alert ON alert_audit_logs(alert_id);
CREATE INDEX IF NOT EXISTS idx_alert_audit_logs_territory ON alert_audit_logs(territory_id);
CREATE INDEX IF NOT EXISTS idx_alert_audit_logs_action ON alert_audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_alert_audit_logs_created ON alert_audit_logs(created_at DESC);
