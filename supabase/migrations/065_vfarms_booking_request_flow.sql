-- ============================================================
-- V-Farms: "Booking Request" becomes its own resort flow (key
-- booking_request), separate from "Booking Confirmation". It gates the
-- guest's "Request booking" step, which places a temporary hold through
-- resort_reserve(); when disabled the request goes to the team and
-- nothing is held. Registry rows are created disabled by the app.
--
-- Idempotent. Rollback: supabase/rollback/065_vfarms_booking_request_flow_down.sql
-- ============================================================

ALTER TABLE resort_automations DROP CONSTRAINT IF EXISTS resort_automations_key_check;
ALTER TABLE resort_automations ADD CONSTRAINT resort_automations_key_check CHECK (key IN (
  'welcome_menu', 'stay_enquiry', 'availability_check', 'pricing_quote', 'event_enquiry',
  'human_escalation', 'booking_request', 'booking_confirmation', 'payment_reminder',
  'pre_arrival_reminder', 'post_stay_feedback', 'abandoned_followup', 'cancel_reschedule'
));
