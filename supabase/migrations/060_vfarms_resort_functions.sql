-- ============================================================
-- V-Farms reservation functions.
--
-- Concurrency model
--   * Every write to the estate calendar goes through these functions.
--   * Each takes a transaction-scoped advisory lock keyed on the account,
--     so reservations for the estate are serialised; the exclusion
--     constraint availability_blocks_no_overlap is the final guarantee.
--   * Expired holds are released inside the same transaction before a
--     new block is inserted, so a stale hold never blocks a new guest
--     and is never silently extended.
--
-- Time zone
--   bookings.occupancy is a tstzrange computed by the application from
--   the IST (+05:30, no DST) dates and configured times. Stays are
--   [check_in + check_in_time, check_out + check_out_time); when those
--   times are not configured 12:00 IST is used for the calendar only.
--   Events are [date + start - buffer, date + end + buffer), with an end
--   at or before the start meaning the event runs past midnight.
--
-- All functions are SECURITY DEFINER and executable by service_role
-- only; API routes enforce the caller's role before calling them.
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS occupancy TSTZRANGE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_occupancy_nonempty') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_occupancy_nonempty
      CHECK (occupancy IS NULL OR (NOT isempty(occupancy) AND lower(occupancy) < upper(occupancy)));
  END IF;
END $$;

-- ------------------------------------------------------------
-- Advisory lock helper
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resort_lock_estate(p_account UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('vfarms-estate:' || p_account::text, 0));
$$;

-- ------------------------------------------------------------
-- Release holds whose expiry has passed. Bookings left in hold /
-- payment_pending with no money received become 'expired'.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resort_expire_stale_holds(p_account UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH expired AS (
    UPDATE availability_blocks
       SET status = 'expired', released_at = NOW()
     WHERE account_id = p_account
       AND status = 'active'
       AND block_type = 'hold'
       AND expires_at <= NOW()
    RETURNING booking_id
  )
  UPDATE bookings b
     SET status = 'expired'
    FROM expired e
   WHERE b.id = e.booking_id
     AND b.status IN ('hold', 'payment_pending')
     AND b.amount_paid = 0;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ------------------------------------------------------------
-- Blocks that overlap [p_start, p_end). Expired holds are ignored even
-- before the sweep has released them.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resort_find_conflicts(
  p_account UUID,
  p_start TIMESTAMPTZ,
  p_end TIMESTAMPTZ,
  p_exclude_booking UUID DEFAULT NULL
)
RETURNS TABLE (
  block_id UUID,
  block_type TEXT,
  booking_id UUID,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id, a.block_type, a.booking_id, lower(a.period), upper(a.period)
    FROM availability_blocks a
   WHERE a.account_id = p_account
     AND a.status = 'active'
     AND NOT (a.block_type = 'hold' AND a.expires_at <= NOW())
     AND a.period && tstzrange(p_start, p_end, '[)')
     AND (p_exclude_booking IS NULL OR a.booking_id IS DISTINCT FROM p_exclude_booking)
   ORDER BY lower(a.period);
$$;

-- ------------------------------------------------------------
-- Occupy the calendar for a booking (hold or firm booking) or add a
-- manual / maintenance block. Replaces the booking's previous active
-- block atomically (hold → booking, reschedule). Raises SQLSTATE 23P01
-- with message 'estate_unavailable' when the dates are taken.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resort_reserve(
  p_account UUID,
  p_block_type TEXT,
  p_booking UUID DEFAULT NULL,
  p_start TIMESTAMPTZ DEFAULT NULL,
  p_end TIMESTAMPTZ DEFAULT NULL,
  p_expires_at TIMESTAMPTZ DEFAULT NULL,
  p_reason TEXT DEFAULT NULL,
  p_actor UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_period TSTZRANGE;
  v_block UUID;
  v_booking bookings%ROWTYPE;
BEGIN
  IF p_block_type NOT IN ('booking', 'hold', 'manual_block', 'maintenance') THEN
    RAISE EXCEPTION 'invalid_block_type' USING ERRCODE = '22023';
  END IF;

  PERFORM resort_lock_estate(p_account);
  PERFORM resort_expire_stale_holds(p_account);

  IF p_booking IS NOT NULL THEN
    SELECT * INTO v_booking FROM bookings
     WHERE id = p_booking AND account_id = p_account
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'booking_not_found' USING ERRCODE = 'P0002';
    END IF;
    v_period := COALESCE(
      CASE WHEN p_start IS NOT NULL AND p_end IS NOT NULL THEN tstzrange(p_start, p_end, '[)') END,
      v_booking.occupancy
    );
  ELSE
    IF p_block_type IN ('booking', 'hold') THEN
      RAISE EXCEPTION 'booking_required' USING ERRCODE = '22023';
    END IF;
    v_period := tstzrange(p_start, p_end, '[)');
  END IF;

  IF v_period IS NULL OR isempty(v_period) THEN
    RAISE EXCEPTION 'invalid_period' USING ERRCODE = '22023';
  END IF;
  IF p_block_type = 'hold' AND (p_expires_at IS NULL OR p_expires_at <= NOW()) THEN
    RAISE EXCEPTION 'hold_requires_future_expiry' USING ERRCODE = '22023';
  END IF;

  IF p_booking IS NOT NULL THEN
    UPDATE availability_blocks
       SET status = 'released', released_at = NOW()
     WHERE booking_id = p_booking AND status = 'active';
  END IF;

  BEGIN
    INSERT INTO availability_blocks (account_id, period, block_type, booking_id, expires_at, reason, created_by)
    VALUES (
      p_account, v_period, p_block_type, p_booking,
      CASE WHEN p_block_type = 'hold' THEN p_expires_at END,
      p_reason, p_actor
    )
    RETURNING id INTO v_block;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'estate_unavailable' USING ERRCODE = '23P01';
  END;

  IF p_booking IS NOT NULL AND (v_booking.occupancy IS DISTINCT FROM v_period) THEN
    UPDATE bookings SET occupancy = v_period WHERE id = p_booking;
  END IF;

  RETURN v_block;
END;
$$;

-- ------------------------------------------------------------
-- Free the calendar for a booking (cancel / reject / reschedule-away).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resort_release_booking(p_account UUID, p_booking UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  PERFORM resort_lock_estate(p_account);
  UPDATE availability_blocks
     SET status = 'released', released_at = NOW()
   WHERE account_id = p_account AND booking_id = p_booking AND status = 'active';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ------------------------------------------------------------
-- Re-derive a booking's money columns from the payment / refund ledger.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resort_recompute_booking_money(p_booking UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_paid NUMERIC(12,2);
  v_refunded NUMERIC(12,2);
  v_refund_pending BOOLEAN;
  v_total NUMERIC(12,2);
  v_status TEXT;
BEGIN
  SELECT COALESCE(SUM(amount_paise) FILTER (WHERE status IN ('captured', 'refunded', 'partially_refunded')), 0) / 100.0
    INTO v_paid
    FROM payments WHERE booking_id = p_booking;

  SELECT COALESCE(SUM(amount_paise) FILTER (WHERE status IN ('processed', 'manual_recorded')), 0) / 100.0,
         COALESCE(BOOL_OR(status IN ('requested', 'pending')), FALSE)
    INTO v_refunded, v_refund_pending
    FROM refunds WHERE booking_id = p_booking;

  SELECT quoted_total INTO v_total FROM bookings WHERE id = p_booking;

  v_status := CASE
    WHEN v_refund_pending THEN 'refund_pending'
    WHEN v_refunded > 0 AND v_refunded >= v_paid THEN 'refunded'
    WHEN v_refunded > 0 THEN 'partially_refunded'
    WHEN v_paid = 0 THEN 'unpaid'
    WHEN v_total IS NOT NULL AND v_paid >= v_total THEN 'paid'
    ELSE 'partially_paid'
  END;

  UPDATE bookings
     SET amount_paid = v_paid,
         amount_refunded = v_refunded,
         payment_status = v_status
   WHERE id = p_booking;
END;
$$;

-- ------------------------------------------------------------
-- Apply a payment whose authenticity the server has verified (checkout
-- signature or webhook signature). Idempotent per provider payment id.
--
-- The payment never bypasses availability: the booking's dates are
-- secured (hold converted, or re-reserved if the hold lapsed). If they
-- can no longer be secured the money is recorded, the booking is marked
-- availability_conflict and left for staff (refund or reschedule).
-- Confirmation happens here only when manual approval is disabled.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resort_apply_verified_payment(
  p_provider_order_id TEXT,
  p_provider_payment_id TEXT,
  p_amount_paise BIGINT,
  p_via TEXT,
  p_method TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment payments%ROWTYPE;
  v_booking bookings%ROWTYPE;
  v_manual BOOLEAN;
  v_block availability_blocks%ROWTYPE;
  v_conflict BOOLEAN := FALSE;
  v_new_status TEXT;
BEGIN
  IF p_via NOT IN ('checkout_signature', 'webhook') THEN
    RAISE EXCEPTION 'invalid_verification_source' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_payment FROM payments
   WHERE provider = 'razorpay' AND provider_order_id = p_provider_order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_order_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_payment.status IN ('captured', 'refunded', 'partially_refunded') THEN
    IF v_payment.provider_payment_id IS DISTINCT FROM p_provider_payment_id THEN
      -- A second, different payment against an already-paid order.
      RAISE EXCEPTION 'order_already_paid_by_other_payment' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_booking FROM bookings WHERE id = v_payment.booking_id;
    RETURN jsonb_build_object(
      'already_processed', TRUE,
      'booking_id', v_booking.id,
      'booking_status', v_booking.status,
      'availability_conflict', v_booking.availability_conflict
    );
  END IF;

  IF p_amount_paise <> v_payment.amount_paise THEN
    RAISE EXCEPTION 'amount_mismatch' USING ERRCODE = '22023';
  END IF;

  PERFORM resort_lock_estate(v_payment.account_id);

  UPDATE payments
     SET status = 'captured',
         provider_payment_id = p_provider_payment_id,
         verified_via = p_via,
         verified_at = NOW(),
         method = COALESCE(p_method, method),
         failure_code = NULL,
         failure_reason = NULL
   WHERE id = v_payment.id;

  SELECT * INTO v_booking FROM bookings WHERE id = v_payment.booking_id FOR UPDATE;
  PERFORM resort_recompute_booking_money(v_booking.id);

  SELECT COALESCE(manual_approval_required, TRUE) INTO v_manual
    FROM property_settings WHERE account_id = v_booking.account_id;
  v_manual := COALESCE(v_manual, TRUE);

  IF v_booking.status IN ('confirmed', 'checked_in', 'checked_out', 'completed') THEN
    -- Balance payment on an already-confirmed reservation.
    v_new_status := v_booking.status;
  ELSIF v_booking.status IN ('cancelled', 'rejected', 'cancellation_requested') THEN
    -- Money arrived for a booking that is no longer going ahead.
    v_conflict := TRUE;
    v_new_status := v_booking.status;
  ELSE
    PERFORM resort_expire_stale_holds(v_booking.account_id);
    SELECT * INTO v_block FROM availability_blocks
     WHERE booking_id = v_booking.id AND status = 'active'
     FOR UPDATE;

    IF FOUND THEN
      UPDATE availability_blocks
         SET block_type = 'booking', expires_at = NULL
       WHERE id = v_block.id;
    ELSIF v_booking.occupancy IS NULL THEN
      v_conflict := TRUE;
    ELSE
      BEGIN
        INSERT INTO availability_blocks (account_id, period, block_type, booking_id, reason)
        VALUES (v_booking.account_id, v_booking.occupancy, 'booking', v_booking.id, 'payment_verified');
      EXCEPTION WHEN exclusion_violation THEN
        v_conflict := TRUE;
      END;
    END IF;

    IF v_conflict OR v_manual OR v_booking.booking_type = 'event' THEN
      v_new_status := 'payment_verified';
    ELSE
      v_new_status := 'confirmed';
    END IF;
  END IF;

  UPDATE bookings
     SET status = v_new_status,
         availability_conflict = availability_conflict OR v_conflict,
         confirmed_at = CASE WHEN v_new_status = 'confirmed' AND confirmed_at IS NULL THEN NOW() ELSE confirmed_at END
   WHERE id = v_booking.id;

  IF v_new_status = 'confirmed' AND v_booking.lead_id IS NOT NULL THEN
    UPDATE leads SET stage = 'confirmed' WHERE id = v_booking.lead_id
      AND stage NOT IN ('completed', 'cancelled', 'lost');
  END IF;

  INSERT INTO audit_logs (account_id, actor_type, action, entity_type, entity_id, after)
  VALUES (v_booking.account_id, 'webhook', 'payment.verified', 'booking', v_booking.id,
          jsonb_build_object('payment_id', v_payment.id, 'via', p_via,
                             'status', v_new_status, 'availability_conflict', v_conflict));

  RETURN jsonb_build_object(
    'already_processed', FALSE,
    'booking_id', v_booking.id,
    'booking_status', v_new_status,
    'availability_conflict', v_conflict
  );
END;
$$;

-- ------------------------------------------------------------
-- Staff confirmation (manual approval workflow). Secures the dates and
-- confirms. Events must be approved first.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resort_confirm_booking(
  p_account UUID,
  p_booking UUID,
  p_actor UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_booking bookings%ROWTYPE;
  v_block availability_blocks%ROWTYPE;
  v_event_status TEXT;
BEGIN
  PERFORM resort_lock_estate(p_account);
  PERFORM resort_expire_stale_holds(p_account);

  SELECT * INTO v_booking FROM bookings
   WHERE id = p_booking AND account_id = p_account
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_booking.status = 'confirmed' THEN
    RETURN jsonb_build_object('booking_id', v_booking.id, 'booking_status', 'confirmed', 'already_confirmed', TRUE);
  END IF;
  IF v_booking.status NOT IN ('enquiry', 'qualified', 'availability_checked', 'quote_created',
                              'booking_requested', 'hold', 'payment_pending', 'payment_verified', 'expired') THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = '22023',
      DETAIL = format('cannot confirm a booking in status %s', v_booking.status);
  END IF;
  IF v_booking.occupancy IS NULL THEN
    RAISE EXCEPTION 'occupancy_missing' USING ERRCODE = '22023';
  END IF;
  IF v_booking.booking_type = 'event' THEN
    SELECT status INTO v_event_status FROM event_requests WHERE booking_id = v_booking.id;
    IF v_event_status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'event_not_approved' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT * INTO v_block FROM availability_blocks
   WHERE booking_id = v_booking.id AND status = 'active'
   FOR UPDATE;
  IF FOUND AND v_block.period = v_booking.occupancy THEN
    UPDATE availability_blocks SET block_type = 'booking', expires_at = NULL WHERE id = v_block.id;
  ELSE
    IF FOUND THEN
      UPDATE availability_blocks SET status = 'released', released_at = NOW() WHERE id = v_block.id;
    END IF;
    BEGIN
      INSERT INTO availability_blocks (account_id, period, block_type, booking_id, reason, created_by)
      VALUES (p_account, v_booking.occupancy, 'booking', v_booking.id, 'staff_confirmed', p_actor);
    EXCEPTION WHEN exclusion_violation THEN
      RAISE EXCEPTION 'estate_unavailable' USING ERRCODE = '23P01';
    END;
  END IF;

  UPDATE bookings
     SET status = 'confirmed',
         availability_conflict = FALSE,
         confirmed_at = NOW(),
         confirmed_by = p_actor
   WHERE id = v_booking.id;

  IF v_booking.lead_id IS NOT NULL THEN
    UPDATE leads SET stage = 'confirmed' WHERE id = v_booking.lead_id
      AND stage NOT IN ('completed', 'cancelled', 'lost');
  END IF;

  INSERT INTO audit_logs (account_id, actor_user_id, actor_type, action, entity_type, entity_id, before, after)
  VALUES (p_account, p_actor, 'user', 'booking.confirmed', 'booking', v_booking.id,
          jsonb_build_object('status', v_booking.status),
          jsonb_build_object('status', 'confirmed'));

  RETURN jsonb_build_object('booking_id', v_booking.id, 'booking_status', 'confirmed', 'already_confirmed', FALSE);
END;
$$;

-- ------------------------------------------------------------
-- Claim due notification jobs (SKIP LOCKED so parallel cron runs never
-- double-send). Jobs stuck in 'processing' for 10 minutes are reclaimed.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resort_claim_notification_jobs(p_limit INTEGER DEFAULT 25)
RETURNS SETOF notification_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT id FROM notification_jobs
     WHERE (status = 'pending' AND scheduled_for <= NOW())
        OR (status = 'processing' AND locked_at < NOW() - INTERVAL '10 minutes')
     ORDER BY scheduled_for
     LIMIT GREATEST(1, LEAST(p_limit, 100))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE notification_jobs j
     SET status = 'processing', locked_at = NOW(), attempts = j.attempts + 1
    FROM due
   WHERE j.id = due.id
  RETURNING j.*;
END;
$$;

-- ------------------------------------------------------------
-- Audit trail for property, pricing and calendar-affecting settings.
-- auth.uid() is the signed-in admin when the change comes through the
-- dashboard's RLS-scoped client.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resort_audit_row_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_id UUID;
BEGIN
  v_account := COALESCE(NEW.account_id, OLD.account_id);
  v_id := COALESCE(NEW.id, OLD.id);
  INSERT INTO audit_logs (account_id, actor_user_id, actor_type, action, entity_type, entity_id, before, after)
  VALUES (
    v_account,
    auth.uid(),
    CASE WHEN auth.uid() IS NULL THEN 'system' ELSE 'user' END,
    lower(TG_OP),
    TG_TABLE_NAME,
    v_id,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'pricing_rules', 'seasonal_rates', 'event_packages', 'addons', 'property_settings'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS resort_audit ON %I', v_table);
    EXECUTE format(
      'CREATE TRIGGER resort_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION resort_audit_row_change()',
      v_table
    );
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- Grants: service role only.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_fn TEXT;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.resort_lock_estate(uuid)',
    'public.resort_expire_stale_holds(uuid)',
    'public.resort_find_conflicts(uuid, timestamptz, timestamptz, uuid)',
    'public.resort_reserve(uuid, text, uuid, timestamptz, timestamptz, timestamptz, text, uuid)',
    'public.resort_release_booking(uuid, uuid)',
    'public.resort_recompute_booking_money(uuid)',
    'public.resort_apply_verified_payment(text, text, bigint, text, text)',
    'public.resort_confirm_booking(uuid, uuid, uuid)',
    'public.resort_claim_notification_jobs(integer)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', v_fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END $$;

ALTER FUNCTION public.resort_audit_row_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resort_audit_row_change() FROM PUBLIC, anon, authenticated;
