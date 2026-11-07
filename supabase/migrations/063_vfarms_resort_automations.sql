-- ============================================================
-- V-Farms resort automations (A–L).
--
-- resort_automations is the per-account registry the Automations page
-- shows: one row per resort automation, disabled by default, with a
-- validated config and persisted counters. resort_automation_runs is the
-- execution history; a trigger keeps the counters in step, and
-- (account_id, dedupe_key) makes a repeated webhook / cron pass record
-- the same execution once.
--
-- Also adds: guest feedback, cancellation / reschedule requests, the
-- payment-exception record staff give when confirming without the
-- advance, follow-up counters on leads, three new guest-message kinds,
-- and an archive marker on automations (used by
-- scripts/archive-solar-records.mjs; nothing is archived here).
--
-- Idempotent. Rollback: supabase/rollback/063_vfarms_resort_automations_down.sql
-- ============================================================

-- Same-named tables that predate this migration are kept as
-- legacy_pre_vfarms_<name> (see 059). No-op once resort_automations exists.
DO $$
DECLARE
  t TEXT;
  r RECORD;
BEGIN
  IF to_regclass('public.resort_automations') IS NOT NULL THEN
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY['resort_automation_runs', 'booking_feedback', 'booking_change_requests', 'legacy_archive'] LOOP
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

-- ---- Guest message kinds -----------------------------------------
ALTER TABLE notification_jobs DROP CONSTRAINT IF EXISTS notification_jobs_kind_check;
ALTER TABLE notification_jobs ADD CONSTRAINT notification_jobs_kind_check CHECK (kind IN (
  'new_enquiry', 'qualified_lead', 'quote_requested', 'booking_requested',
  'payment_verified', 'booking_confirmed', 'upcoming_arrival', 'upcoming_checkout',
  'event_approval_required', 'cancellation_requested', 'message_failed', 'handoff_requested',
  'payment_reminder', 'post_stay_feedback', 'enquiry_followup', 'reschedule_requested'
));

-- ---- Automation registry -----------------------------------------
CREATE TABLE IF NOT EXISTS resort_automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (key IN (
    'welcome_menu', 'stay_enquiry', 'availability_check', 'pricing_quote', 'event_enquiry',
    'human_escalation', 'booking_confirmation', 'payment_reminder', 'pre_arrival_reminder',
    'post_stay_feedback', 'abandoned_followup', 'cancel_reschedule'
  )),
  name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  execution_count INTEGER NOT NULL DEFAULT 0 CHECK (execution_count >= 0),
  success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  last_executed_at TIMESTAMPTZ,
  last_status TEXT CHECK (last_status IS NULL OR last_status IN ('success', 'failed', 'skipped')),
  last_error TEXT,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT resort_automations_one_per_key UNIQUE (account_id, key)
);

CREATE TABLE IF NOT EXISTS resort_automation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  automation_key TEXT NOT NULL,
  trigger TEXT NOT NULL,
  -- test: a manual Run Test preview; never counted, never sends.
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'skipped', 'test')),
  dedupe_key TEXT,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT resort_automation_runs_dedupe UNIQUE (account_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_resort_automation_runs_key
  ON resort_automation_runs(account_id, automation_key, created_at DESC);

CREATE OR REPLACE FUNCTION public.resort_automation_run_counter()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'test' THEN
    RETURN NEW;
  END IF;
  UPDATE resort_automations
     SET execution_count = execution_count + 1,
         success_count = success_count + (NEW.status = 'success')::int,
         failure_count = failure_count + (NEW.status = 'failed')::int,
         skipped_count = skipped_count + (NEW.status = 'skipped')::int,
         last_executed_at = NEW.created_at,
         last_status = NEW.status,
         last_error = CASE WHEN NEW.status = 'failed' THEN left(NEW.error, 500) ELSE NULL END
   WHERE account_id = NEW.account_id AND key = NEW.automation_key;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS resort_automation_run_counter ON resort_automation_runs;
CREATE TRIGGER resort_automation_run_counter
  AFTER INSERT ON resort_automation_runs
  FOR EACH ROW EXECUTE FUNCTION public.resort_automation_run_counter();

ALTER FUNCTION public.resort_automation_run_counter() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resort_automation_run_counter() FROM PUBLIC, anon, authenticated;

-- ---- Guest feedback (post-stay) ----------------------------------
CREATE TABLE IF NOT EXISTS booking_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  comment TEXT CHECK (comment IS NULL OR length(comment) <= 2000),
  source TEXT NOT NULL DEFAULT 'whatsapp' CHECK (source IN ('whatsapp', 'staff')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---- Cancellation / reschedule requests --------------------------
-- A guest request is recorded here; only an authorised staff action
-- changes the booking itself.
CREATE TABLE IF NOT EXISTS booking_change_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('cancel', 'reschedule')),
  requested_check_in DATE,
  requested_check_out DATE,
  requested_event_date DATE,
  -- Live result at request time: available | unavailable | pending_manual | unknown.
  availability_status TEXT,
  quote_snapshot JSONB,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  source TEXT NOT NULL DEFAULT 'whatsapp' CHECK (source IN ('whatsapp', 'staff')),
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT booking_change_requests_dates CHECK (
    requested_check_in IS NULL OR requested_check_out IS NULL OR requested_check_out > requested_check_in
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_change_requests_one_pending
  ON booking_change_requests(booking_id) WHERE status = 'pending';

-- ---- Payment exception / follow-up tracking ----------------------
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_exception_note TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_exception_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_exception_at TIMESTAMPTZ;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_follow_up_at TIMESTAMPTZ;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_follow_up_count_nonneg') THEN
    ALTER TABLE leads ADD CONSTRAINT leads_follow_up_count_nonneg CHECK (follow_up_count >= 0);
  END IF;
END $$;

-- ---- Archive marker for retired (e.g. Suraj Solar) automations ---
ALTER TABLE automations ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automations_archived_inactive') THEN
    ALTER TABLE automations ADD CONSTRAINT automations_archived_inactive
      CHECK (archived_at IS NULL OR is_active = FALSE);
  END IF;
END $$;

-- Snapshots of rows removed by the archive script, so they can be restored.
CREATE TABLE IF NOT EXISTS legacy_archive (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  source_table TEXT NOT NULL,
  source_id UUID NOT NULL,
  snapshot JSONB NOT NULL,
  reason TEXT NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  restored_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_legacy_archive_source ON legacy_archive(source_table, source_id);

-- ---- updated_at --------------------------------------------------
DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['resort_automations', 'booking_change_requests'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON %I', v_table);
    EXECUTE format(
      'CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()',
      v_table
    );
  END LOOP;
END $$;

-- ---- Row level security ------------------------------------------
-- Registry: members read, admins change (enable / config). Rows are
-- created by the server. Runs, feedback, change requests and the
-- archive are written by the server only.
ALTER TABLE resort_automations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS resort_automations_select ON resort_automations;
DROP POLICY IF EXISTS resort_automations_update ON resort_automations;
CREATE POLICY resort_automations_select ON resort_automations FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY resort_automations_update ON resort_automations FOR UPDATE
  USING (is_account_member(account_id, 'admin')) WITH CHECK (is_account_member(account_id, 'admin'));

ALTER TABLE resort_automation_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS resort_automation_runs_select ON resort_automation_runs;
CREATE POLICY resort_automation_runs_select ON resort_automation_runs FOR SELECT
  USING (is_account_member(account_id, 'agent'));

ALTER TABLE booking_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS booking_feedback_select ON booking_feedback;
CREATE POLICY booking_feedback_select ON booking_feedback FOR SELECT
  USING (is_account_member(account_id));

ALTER TABLE booking_change_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS booking_change_requests_select ON booking_change_requests;
CREATE POLICY booking_change_requests_select ON booking_change_requests FOR SELECT
  USING (is_account_member(account_id));

ALTER TABLE legacy_archive ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS legacy_archive_select ON legacy_archive;
CREATE POLICY legacy_archive_select ON legacy_archive FOR SELECT
  USING (account_id IS NOT NULL AND is_account_member(account_id, 'admin'));

REVOKE INSERT, DELETE ON resort_automations FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON resort_automation_runs, booking_feedback, booking_change_requests, legacy_archive
  FROM anon, authenticated;
