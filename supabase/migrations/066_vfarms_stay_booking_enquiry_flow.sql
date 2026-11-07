-- ============================================================
-- V-Farms: "Customer Information & Stay Booking Enquiry" becomes its own
-- resort flow (key stay_booking_enquiry). It collects the guest's details
-- one question at a time, checks the live calendar and saves a new
-- enquiry for staff review; it never confirms, holds or prices a stay.
-- Registry rows are created disabled by the app.
--
-- Idempotent. Rollback: supabase/rollback/066_vfarms_stay_booking_enquiry_flow_down.sql
-- ============================================================

ALTER TABLE resort_automations DROP CONSTRAINT IF EXISTS resort_automations_key_check;
ALTER TABLE resort_automations ADD CONSTRAINT resort_automations_key_check CHECK (key IN (
  'welcome_menu', 'stay_enquiry', 'stay_booking_enquiry', 'availability_check', 'pricing_quote',
  'event_enquiry', 'human_escalation', 'booking_request', 'booking_confirmation', 'payment_reminder',
  'pre_arrival_reminder', 'post_stay_feedback', 'abandoned_followup', 'cancel_reschedule'
));
