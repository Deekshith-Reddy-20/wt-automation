-- ============================================================
-- V-Farms resort booking schema.
--
-- The estate is ONE reservable resource. Overnight stays, events,
-- temporary holds and manual/maintenance blocks all occupy time on the
-- same calendar (availability_blocks). An exclusion constraint makes
-- two overlapping ACTIVE blocks impossible for the same account, so
-- double-booking is prevented by the database even under concurrent
-- requests. The five guest rooms are descriptive (property_settings.
-- room_count / building_description), never separate inventory.
--
-- Every business fact (rates, capacity, times, amenities, policies) is
-- nullable / inactive by default. NULL means "Not configured" and the
-- application must not promise anything based on it.
--
-- Tenancy follows migration 017: every table carries account_id and is
-- protected by is_account_member(account_id, min_role).
--   viewer : read
--   agent  : reservation manager — leads, bookings, conversations
--   admin  : property, pricing, settings (owner inherits admin)
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- A project that never ran this migration can still hold unrelated tables
-- with the same names (e.g. a `leads` table from an earlier CRM setup).
-- CREATE TABLE IF NOT EXISTS would silently keep them and later statements
-- would fail on their columns. They are renamed to legacy_pre_vfarms_<name>
-- (indexes and sequences too) with data and policies untouched. Undo by
-- renaming back. No-op once property_settings exists.
DO $$
DECLARE
  t TEXT;
  r RECORD;
BEGIN
  IF to_regclass('public.property_settings') IS NOT NULL THEN
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY[
    'property_media', 'amenities', 'property_faqs', 'pricing_rules', 'seasonal_rates',
    'event_packages', 'addons', 'leads', 'lead_notes', 'conversation_states', 'bookings', 'booking_guests',
    'booking_quotes', 'event_requests', 'availability_blocks', 'payments', 'refunds', 'notification_jobs',
    'audit_logs', 'webhook_events', 'consent_records'
  ] LOOP
    CONTINUE WHEN to_regclass(format('public.%I', t)) IS NULL;
    IF to_regclass(format('public.%I', 'legacy_pre_vfarms_' || t)) IS NOT NULL THEN
      RAISE EXCEPTION 'public.% predates V-Farms and public.legacy_pre_vfarms_% already exists; rename one of them and re-run.', t, t;
    END IF;
    FOR r IN
      SELECT c.relname, CASE c.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'INDEX' END AS kind
      FROM pg_class c
      WHERE c.oid IN (SELECT indexrelid FROM pg_index WHERE indrelid = format('public.%I', t)::regclass)
         OR c.oid IN (SELECT objid FROM pg_depend WHERE refobjid = format('public.%I', t)::regclass AND deptype IN ('a', 'i') AND classid = 'pg_class'::regclass)
            AND c.relkind = 'S'
    LOOP
      EXECUTE format('ALTER %s public.%I RENAME TO %I', r.kind, r.relname, left('legacy_pre_vfarms_' || r.relname, 63));
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I RENAME TO %I', t, 'legacy_pre_vfarms_' || t);
    RAISE NOTICE 'Kept pre-existing public.% as public.legacy_pre_vfarms_% (data untouched).', t, t;
  END LOOP;
END $$;

-- ============================================================
-- PROPERTY SETTINGS (one row per account)
-- ============================================================
CREATE TABLE IF NOT EXISTS property_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  resort_name TEXT NOT NULL DEFAULT 'V-Farms',
  tagline TEXT,
  description TEXT,
  farm_description TEXT,
  building_description TEXT,
  room_count INTEGER CHECK (room_count IS NULL OR room_count > 0),
  property_area_acres NUMERIC(6,2) CHECK (property_area_acres IS NULL OR property_area_acres > 0),
  address TEXT,
  locality TEXT,
  latitude NUMERIC(9,6) CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude NUMERIC(9,6) CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  map_url TEXT CHECK (map_url IS NULL OR map_url ~* '^https://'),
  directions TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  whatsapp_number TEXT,
  check_in_time TIME,
  check_out_time TIME,
  max_stay_guests INTEGER CHECK (max_stay_guests IS NULL OR max_stay_guests > 0),
  max_event_guests INTEGER CHECK (max_event_guests IS NULL OR max_event_guests > 0),
  guest_policies TEXT,
  event_policies TEXT,
  cancellation_policy TEXT,
  refund_policy TEXT,
  food_info TEXT,
  activities_info TEXT,
  accessibility_info TEXT,
  parking_info TEXT,
  privacy_policy TEXT,
  terms TEXT,
  -- Booking logic assumes India's fixed +05:30 offset (no DST).
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata' CHECK (timezone = 'Asia/Kolkata'),
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  bot_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  test_mode BOOLEAN NOT NULL DEFAULT TRUE,
  payments_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- When true a reservation is confirmed only by a staff member, even
  -- after a verified payment (the dates stay protected meanwhile).
  manual_approval_required BOOLEAN NOT NULL DEFAULT TRUE,
  holds_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  hold_duration_minutes INTEGER NOT NULL DEFAULT 30
    CHECK (hold_duration_minutes BETWEEN 5 AND 2880),
  -- Setup / cleanup time added around every event on the calendar.
  event_buffer_minutes INTEGER NOT NULL DEFAULT 0
    CHECK (event_buffer_minutes BETWEEN 0 AND 720),
  -- {"mon":{"open":"09:00","close":"20:00"}, ...}; NULL = not configured.
  business_hours JSONB,
  -- {"new_enquiry":true,"payment_verified":true,...}
  notification_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- {"arrival_reminder_hours":24,"checkout_reminder_hours":2,
  --  "arrival_template":"<approved template name>", ...}
  reminder_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The public website serves exactly one published property.
CREATE UNIQUE INDEX IF NOT EXISTS uq_property_settings_one_published
  ON property_settings ((TRUE)) WHERE is_published;

-- ============================================================
-- PROPERTY MEDIA / AMENITIES / FAQS
-- ============================================================
CREATE TABLE IF NOT EXISTS property_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  storage_path TEXT,
  public_url TEXT NOT NULL CHECK (public_url ~* '^https?://'),
  caption TEXT,
  alt_text TEXT,
  category TEXT NOT NULL DEFAULT 'other'
    CHECK (category IN ('farm', 'building', 'rooms', 'event_space', 'amenities', 'food', 'other')),
  -- Only photographs confirmed to show V-Farms itself may be shown as such.
  is_verified_property_photo BOOLEAN NOT NULL DEFAULT FALSE,
  is_approved BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_property_media_account ON property_media(account_id, sort_order);

CREATE TABLE IF NOT EXISTS amenities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT,
  applies_to TEXT NOT NULL DEFAULT 'both' CHECK (applies_to IN ('stay', 'event', 'both')),
  is_approved BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, name)
);

CREATE TABLE IF NOT EXISTS property_faqs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  question TEXT NOT NULL CHECK (length(trim(question)) > 0),
  answer TEXT NOT NULL CHECK (length(trim(answer)) > 0),
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_property_faqs_account ON property_faqs(account_id, sort_order);

-- ============================================================
-- PRICING
-- ============================================================
-- One rule set per account. NULL rates = not configured → no quote.
CREATE TABLE IF NOT EXISTS pricing_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  weekday_night_rate NUMERIC(12,2) CHECK (weekday_night_rate IS NULL OR weekday_night_rate >= 0),
  weekend_night_rate NUMERIC(12,2) CHECK (weekend_night_rate IS NULL OR weekend_night_rate >= 0),
  -- ISO weekday of the NIGHT's start date priced at the weekend rate
  -- (5 = Friday night, 6 = Saturday night).
  weekend_nights SMALLINT[] NOT NULL DEFAULT '{5,6}'
    CHECK (weekend_nights <@ ARRAY[1,2,3,4,5,6,7]::SMALLINT[]),
  base_guests_included INTEGER CHECK (base_guests_included IS NULL OR base_guests_included > 0),
  extra_adult_rate_per_night NUMERIC(12,2) CHECK (extra_adult_rate_per_night IS NULL OR extra_adult_rate_per_night >= 0),
  extra_child_rate_per_night NUMERIC(12,2) CHECK (extra_child_rate_per_night IS NULL OR extra_child_rate_per_night >= 0),
  -- Children strictly older than this are priced as adults.
  child_age_limit INTEGER CHECK (child_age_limit IS NULL OR child_age_limit BETWEEN 0 AND 17),
  min_nights INTEGER NOT NULL DEFAULT 1 CHECK (min_nights >= 1),
  extended_stay_min_nights INTEGER CHECK (extended_stay_min_nights IS NULL OR extended_stay_min_nights >= 2),
  extended_stay_discount_pct NUMERIC(5,2) CHECK (extended_stay_discount_pct IS NULL OR extended_stay_discount_pct BETWEEN 0 AND 100),
  tax_label TEXT NOT NULL DEFAULT 'GST',
  tax_pct NUMERIC(5,2) CHECK (tax_pct IS NULL OR tax_pct BETWEEN 0 AND 100),
  prices_include_tax BOOLEAN NOT NULL DEFAULT FALSE,
  deposit_pct NUMERIC(5,2) CHECK (deposit_pct IS NULL OR deposit_pct BETWEEN 0 AND 100),
  deposit_fixed_amount NUMERIC(12,2) CHECK (deposit_fixed_amount IS NULL OR deposit_fixed_amount >= 0),
  quote_validity_hours INTEGER CHECK (quote_validity_hours IS NULL OR quote_validity_hours > 0),
  -- Largest discount a staff member may authorise on a quote.
  max_staff_discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (max_staff_discount_pct BETWEEN 0 AND 100),
  -- [{"days_before":7,"refund_pct":100}, ...] — informational for staff.
  cancellation_rules JSONB,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pricing_rules_one_deposit_kind CHECK (deposit_pct IS NULL OR deposit_fixed_amount IS NULL)
);

-- Seasonal / special-date overrides. Special dates and holidays (tier 2)
-- win over seasons (tier 1); rates of the same tier may not overlap, so
-- the nightly price is always deterministic.
CREATE TABLE IF NOT EXISTS seasonal_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  kind TEXT NOT NULL DEFAULT 'season' CHECK (kind IN ('season', 'special_date', 'holiday')),
  rate_tier SMALLINT GENERATED ALWAYS AS (CASE WHEN kind = 'season' THEN 1 ELSE 2 END) STORED,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  nightly_rate NUMERIC(12,2) NOT NULL CHECK (nightly_rate >= 0),
  weekend_nightly_rate NUMERIC(12,2) CHECK (weekend_nightly_rate IS NULL OR weekend_nightly_rate >= 0),
  min_nights INTEGER CHECK (min_nights IS NULL OR min_nights >= 1),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT seasonal_rates_valid_range CHECK (end_date >= start_date)
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seasonal_rates_no_overlap') THEN
    ALTER TABLE seasonal_rates ADD CONSTRAINT seasonal_rates_no_overlap
      EXCLUDE USING gist (
        account_id WITH =,
        rate_tier WITH =,
        daterange(start_date, end_date, '[]') WITH &&
      ) WHERE (is_active);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS event_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT,
  -- NULL = applies to every event type.
  event_types TEXT[],
  base_price NUMERIC(12,2) NOT NULL CHECK (base_price >= 0),
  included_hours NUMERIC(4,1) CHECK (included_hours IS NULL OR included_hours > 0),
  extra_hour_rate NUMERIC(12,2) CHECK (extra_hour_rate IS NULL OR extra_hour_rate >= 0),
  max_guests INTEGER CHECK (max_guests IS NULL OR max_guests > 0),
  includes_accommodation BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS addons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT,
  price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  unit TEXT NOT NULL DEFAULT 'per_booking'
    CHECK (unit IN ('per_booking', 'per_night', 'per_guest', 'per_guest_per_night')),
  applies_to TEXT NOT NULL DEFAULT 'both' CHECK (applies_to IN ('stay', 'event', 'both')),
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- LEADS
-- ============================================================
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_number BIGINT GENERATED ALWAYS AS IDENTITY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  customer_name TEXT,
  -- E.164 digits with leading '+', e.g. +919876543210.
  phone_e164 TEXT CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email TEXT,
  preferred_language TEXT NOT NULL DEFAULT 'en',
  source TEXT NOT NULL DEFAULT 'whatsapp'
    CHECK (source IN ('website', 'whatsapp', 'qr_code', 'instagram', 'facebook_ads', 'referral', 'manual')),
  category TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('stay', 'event', 'pricing', 'general')),
  stage TEXT NOT NULL DEFAULT 'new'
    CHECK (stage IN ('new', 'contacted', 'qualified', 'quote_sent', 'awaiting_customer',
                     'booking_requested', 'confirmed', 'completed', 'cancelled', 'lost')),
  priority TEXT NOT NULL DEFAULT 'nurture' CHECK (priority IN ('hot', 'warm', 'nurture')),
  check_in DATE,
  check_out DATE,
  event_date DATE,
  event_start_time TIME,
  event_end_time TIME,
  adults INTEGER CHECK (adults IS NULL OR adults >= 0),
  children INTEGER CHECK (children IS NULL OR children >= 0),
  children_ages INTEGER[],
  guest_count INTEGER CHECK (guest_count IS NULL OR guest_count >= 0),
  purpose TEXT,
  special_requirements TEXT,
  budget_inr NUMERIC(12,2) CHECK (budget_inr IS NULL OR budget_inr >= 0),
  estimated_quote_inr NUMERIC(12,2) CHECK (estimated_quote_inr IS NULL OR estimated_quote_inr >= 0),
  assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  last_interaction_at TIMESTAMPTZ,
  next_follow_up_at TIMESTAMPTZ,
  notes TEXT,
  consent_status TEXT NOT NULL DEFAULT 'unknown' CHECK (consent_status IN ('unknown', 'granted', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT leads_valid_stay_dates CHECK (check_in IS NULL OR check_out IS NULL OR check_out > check_in)
);
-- One open lead per contact: repeat enquiries update it instead of
-- creating duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_open_per_contact
  ON leads(account_id, contact_id)
  WHERE contact_id IS NOT NULL AND stage NOT IN ('completed', 'cancelled', 'lost');
CREATE INDEX IF NOT EXISTS idx_leads_account_stage ON leads(account_id, stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_follow_up ON leads(account_id, next_follow_up_at)
  WHERE next_follow_up_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(account_id, phone_e164);

CREATE TABLE IF NOT EXISTS lead_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  author_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_notes_lead ON lead_notes(lead_id, created_at DESC);

-- ============================================================
-- CONVERSATION STATE (resort bot)
-- ============================================================
CREATE TABLE IF NOT EXISTS conversation_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  flow TEXT NOT NULL DEFAULT 'menu',
  step TEXT NOT NULL DEFAULT 'start',
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  language TEXT NOT NULL DEFAULT 'en',
  bot_mode TEXT NOT NULL DEFAULT 'bot' CHECK (bot_mode IN ('bot', 'human')),
  handoff_reason TEXT,
  handoff_at TIMESTAMPTZ,
  handed_off_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resumed_at TIMESTAMPTZ,
  resumed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  last_inbound_at TIMESTAMPTZ,
  last_processed_message_id TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conversation_states_account_mode
  ON conversation_states(account_id, bot_mode);

-- ============================================================
-- BOOKINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  booking_ref TEXT NOT NULL UNIQUE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  booking_type TEXT NOT NULL CHECK (booking_type IN ('stay', 'event')),
  status TEXT NOT NULL DEFAULT 'enquiry'
    CHECK (status IN ('enquiry', 'qualified', 'availability_checked', 'quote_created',
                      'booking_requested', 'hold', 'payment_pending', 'payment_verified',
                      'confirmed', 'checked_in', 'checked_out', 'completed',
                      'cancellation_requested', 'cancelled', 'rejected', 'expired')),
  source TEXT NOT NULL DEFAULT 'whatsapp'
    CHECK (source IN ('website', 'whatsapp', 'qr_code', 'instagram', 'facebook_ads', 'referral', 'manual')),
  check_in DATE,
  check_out DATE,
  event_date DATE,
  event_start_time TIME,
  event_end_time TIME,
  adults INTEGER NOT NULL DEFAULT 0 CHECK (adults >= 0),
  children INTEGER NOT NULL DEFAULT 0 CHECK (children >= 0),
  children_ages INTEGER[],
  guest_count INTEGER NOT NULL CHECK (guest_count >= 1),
  purpose TEXT,
  special_requirements TEXT,
  guest_name TEXT,
  guest_phone TEXT CHECK (guest_phone IS NULL OR guest_phone ~ '^\+[1-9][0-9]{6,14}$'),
  guest_email TEXT,
  active_quote_id UUID,
  quoted_total NUMERIC(12,2) CHECK (quoted_total IS NULL OR quoted_total >= 0),
  advance_due NUMERIC(12,2) CHECK (advance_due IS NULL OR advance_due >= 0),
  amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  amount_refunded NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount_refunded >= 0),
  payment_status TEXT NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid', 'partially_paid', 'paid', 'refund_pending',
                              'partially_refunded', 'refunded')),
  -- Set when money was verified but the dates could no longer be
  -- reserved (hold expired and someone else booked). Staff must act.
  availability_conflict BOOLEAN NOT NULL DEFAULT FALSE,
  -- SHA-256 of the guest's private booking link token.
  access_token_hash TEXT,
  idempotency_key TEXT,
  staff_notes TEXT,
  confirmed_at TIMESTAMPTZ,
  confirmed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  completed_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bookings_type_fields CHECK (
    (booking_type = 'stay' AND check_in IS NOT NULL AND check_out IS NOT NULL AND check_out > check_in)
    OR
    (booking_type = 'event' AND event_date IS NOT NULL AND event_start_time IS NOT NULL
      AND event_end_time IS NOT NULL AND event_end_time <> event_start_time)
  ),
  CONSTRAINT bookings_guest_split CHECK (guest_count >= adults + children OR booking_type = 'event'),
  CONSTRAINT bookings_idempotency UNIQUE (account_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_bookings_account_status ON bookings(account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_account_check_in ON bookings(account_id, check_in);
CREATE INDEX IF NOT EXISTS idx_bookings_account_event_date ON bookings(account_id, event_date);
CREATE INDEX IF NOT EXISTS idx_bookings_lead ON bookings(lead_id);

CREATE TABLE IF NOT EXISTS booking_guests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  full_name TEXT,
  age INTEGER CHECK (age IS NULL OR age BETWEEN 0 AND 120),
  is_child BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_booking_guests_booking ON booking_guests(booking_id);

CREATE TABLE IF NOT EXISTS booking_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  booking_type TEXT NOT NULL CHECK (booking_type IN ('stay', 'event')),
  line_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  nights INTEGER CHECK (nights IS NULL OR nights > 0),
  event_hours NUMERIC(5,2) CHECK (event_hours IS NULL OR event_hours > 0),
  subtotal NUMERIC(12,2) NOT NULL CHECK (subtotal >= 0),
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  discount_reason TEXT,
  discount_authorized_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount NUMERIC(12,2) NOT NULL CHECK (total_amount >= 0),
  advance_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (advance_amount >= 0),
  balance_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (balance_amount >= 0),
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  valid_until TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'accepted', 'expired', 'superseded')),
  pricing_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT booking_quotes_discount_needs_authoriser
    CHECK (discount_amount = 0 OR discount_authorized_by IS NOT NULL),
  CONSTRAINT booking_quotes_advance_within_total CHECK (advance_amount <= total_amount)
);
CREATE INDEX IF NOT EXISTS idx_booking_quotes_booking ON booking_quotes(booking_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_active_quote_fk') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_active_quote_fk
      FOREIGN KEY (active_quote_id) REFERENCES booking_quotes(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS event_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('birthday', 'anniversary', 'family_gathering', 'private_celebration', 'corporate', 'other')),
  event_type_other TEXT,
  accommodation_required BOOLEAN,
  catering_required BOOLEAN,
  decoration_requirements TEXT,
  budget_inr NUMERIC(12,2) CHECK (budget_inr IS NULL OR budget_inr >= 0),
  contact_phone TEXT,
  contact_email TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'approved', 'rejected', 'cancelled')),
  review_notes TEXT,
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_event_requests_status ON event_requests(account_id, status);

-- ============================================================
-- AVAILABILITY (the single-estate calendar)
-- ============================================================
CREATE TABLE IF NOT EXISTS availability_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  period TSTZRANGE NOT NULL,
  block_type TEXT NOT NULL CHECK (block_type IN ('booking', 'hold', 'manual_block', 'maintenance')),
  booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'expired')),
  expires_at TIMESTAMPTZ,
  reason TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at TIMESTAMPTZ,
  CONSTRAINT availability_blocks_nonempty CHECK (NOT isempty(period) AND lower(period) < upper(period)),
  CONSTRAINT availability_blocks_hold_expires CHECK (block_type <> 'hold' OR expires_at IS NOT NULL),
  CONSTRAINT availability_blocks_booking_link CHECK (block_type NOT IN ('booking', 'hold') OR booking_id IS NOT NULL)
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'availability_blocks_no_overlap') THEN
    ALTER TABLE availability_blocks ADD CONSTRAINT availability_blocks_no_overlap
      EXCLUDE USING gist (account_id WITH =, period WITH &&) WHERE (status = 'active');
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_availability_blocks_one_active_per_booking
  ON availability_blocks(booking_id) WHERE status = 'active' AND booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_availability_blocks_holds
  ON availability_blocks(account_id, expires_at) WHERE status = 'active' AND block_type = 'hold';

-- ============================================================
-- PAYMENTS / REFUNDS
-- ============================================================
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('razorpay', 'manual')),
  purpose TEXT NOT NULL DEFAULT 'advance' CHECK (purpose IN ('advance', 'balance', 'full')),
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  amount_refunded_paise BIGINT NOT NULL DEFAULT 0 CHECK (amount_refunded_paise >= 0),
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  provider_order_id TEXT UNIQUE,
  provider_payment_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'attempted', 'captured', 'failed', 'refunded', 'partially_refunded')),
  method TEXT,
  failure_code TEXT,
  failure_reason TEXT,
  verified_via TEXT CHECK (verified_via IS NULL OR verified_via IN ('checkout_signature', 'webhook', 'manual')),
  verified_at TIMESTAMPTZ,
  recorded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payments_refund_within_amount CHECK (amount_refunded_paise <= amount_paise),
  CONSTRAINT payments_razorpay_has_order CHECK (provider <> 'razorpay' OR provider_order_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id, created_at DESC);

CREATE TABLE IF NOT EXISTS refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  provider_refund_id TEXT UNIQUE,
  -- processed       : the provider confirmed the refund
  -- manual_recorded : an authorised operator recorded an offline refund
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'pending', 'processed', 'failed', 'manual_recorded')),
  reason TEXT,
  notes TEXT,
  requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refunds_booking ON refunds(booking_id);

-- ============================================================
-- NOTIFICATION JOBS
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'new_enquiry', 'qualified_lead', 'quote_requested', 'booking_requested',
    'payment_verified', 'booking_confirmed', 'upcoming_arrival', 'upcoming_checkout',
    'event_approval_required', 'cancellation_requested', 'message_failed', 'handoff_requested'
  )),
  -- staff    : in-app notification for team members
  -- whatsapp : message to the guest (session window or approved template)
  channel TEXT NOT NULL CHECK (channel IN ('staff', 'whatsapp')),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  template_name TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  last_error TEXT,
  dedupe_key TEXT,
  locked_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notification_jobs_dedupe UNIQUE (account_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_notification_jobs_due
  ON notification_jobs(scheduled_for) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_notification_jobs_booking ON notification_jobs(booking_id);

-- Staff alerts reuse the existing in-app notifications table.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link_path TEXT;
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'resort_alert'));

-- ============================================================
-- AUDIT / WEBHOOK EVENTS / CONSENT
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'system', 'bot', 'webhook')),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  before JSONB,
  after JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_account ON audit_logs(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('razorpay', 'whatsapp')),
  event_id TEXT NOT NULL,
  event_type TEXT,
  account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  payload_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  CONSTRAINT webhook_events_unique UNIQUE (provider, event_id)
);

CREATE TABLE IF NOT EXISTS consent_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  phone_e164 TEXT,
  channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp')),
  consent_type TEXT NOT NULL CHECK (consent_type IN ('service', 'marketing')),
  status TEXT NOT NULL CHECK (status IN ('granted', 'revoked')),
  source TEXT NOT NULL CHECK (source IN ('whatsapp_inbound', 'website_form', 'stop_keyword', 'start_keyword', 'staff')),
  evidence TEXT,
  recorded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_consent_records_contact ON consent_records(account_id, contact_id, created_at DESC);

-- ============================================================
-- updated_at triggers
-- ============================================================
DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'property_settings', 'property_media', 'amenities', 'property_faqs',
    'pricing_rules', 'seasonal_rates', 'event_packages', 'addons',
    'leads', 'conversation_states', 'bookings', 'event_requests',
    'payments', 'refunds', 'notification_jobs'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON %I', v_table);
    EXECUTE format(
      'CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()',
      v_table
    );
  END LOOP;
END $$;

-- ============================================================
-- ROW LEVEL SECURITY
--
-- No anon policies anywhere: the public website reads published,
-- approved rows through server routes with the service role, never
-- straight from the browser.
-- ============================================================
DO $$
DECLARE
  v_table TEXT;
BEGIN
  -- Settings-class: members read, admins write.
  FOREACH v_table IN ARRAY ARRAY[
    'property_settings', 'property_media', 'amenities', 'property_faqs',
    'pricing_rules', 'seasonal_rates', 'event_packages', 'addons'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', v_table || '_select', v_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', v_table || '_insert', v_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', v_table || '_update', v_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', v_table || '_delete', v_table);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (is_account_member(account_id))', v_table || '_select', v_table);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (is_account_member(account_id, ''admin''))', v_table || '_insert', v_table);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (is_account_member(account_id, ''admin'')) WITH CHECK (is_account_member(account_id, ''admin''))', v_table || '_update', v_table);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (is_account_member(account_id, ''admin''))', v_table || '_delete', v_table);
  END LOOP;

  -- Operational: members read, agents (reservation managers) write,
  -- admins delete.
  FOREACH v_table IN ARRAY ARRAY[
    'leads', 'lead_notes', 'conversation_states', 'bookings', 'booking_guests',
    'booking_quotes', 'event_requests'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', v_table || '_select', v_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', v_table || '_insert', v_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', v_table || '_update', v_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', v_table || '_delete', v_table);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (is_account_member(account_id))', v_table || '_select', v_table);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (is_account_member(account_id, ''agent''))', v_table || '_insert', v_table);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (is_account_member(account_id, ''agent'')) WITH CHECK (is_account_member(account_id, ''agent''))', v_table || '_update', v_table);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (is_account_member(account_id, ''admin''))', v_table || '_delete', v_table);
  END LOOP;

  -- Server-written ledgers: members read; writes only through the
  -- service role / SECURITY DEFINER functions.
  FOREACH v_table IN ARRAY ARRAY[
    'availability_blocks', 'payments', 'refunds', 'consent_records'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', v_table || '_select', v_table);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (is_account_member(account_id))', v_table || '_select', v_table);
  END LOOP;
END $$;

-- Pricing must not be readable by guests (no anon policy); notification
-- jobs are visible to reservation managers, audit + webhook logs to admins.
ALTER TABLE notification_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_jobs_select ON notification_jobs;
CREATE POLICY notification_jobs_select ON notification_jobs FOR SELECT
  USING (is_account_member(account_id, 'agent'));

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_logs_select ON audit_logs;
CREATE POLICY audit_logs_select ON audit_logs FOR SELECT
  USING (account_id IS NOT NULL AND is_account_member(account_id, 'admin'));

ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_events_select ON webhook_events;
CREATE POLICY webhook_events_select ON webhook_events FOR SELECT
  USING (account_id IS NOT NULL AND is_account_member(account_id, 'admin'));

-- Ledgers are append/modify by the server only, even for members who
-- could otherwise write through PostgREST grants.
REVOKE INSERT, UPDATE, DELETE ON availability_blocks, payments, refunds, consent_records,
  notification_jobs, audit_logs, webhook_events FROM anon, authenticated;

-- Realtime for the dashboard's live booking / conversation-state views.
DO $$
DECLARE
  v_table TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH v_table IN ARRAY ARRAY['bookings', 'conversation_states', 'leads'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = v_table
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I', v_table);
      END IF;
    END LOOP;
  END IF;
END $$;
