-- Undo 066: removes the stay_booking_enquiry registry rows and restores the 065 key list.
BEGIN;
DELETE FROM resort_automations WHERE key = 'stay_booking_enquiry';
ALTER TABLE resort_automations DROP CONSTRAINT IF EXISTS resort_automations_key_check;
ALTER TABLE resort_automations ADD CONSTRAINT resort_automations_key_check CHECK (key IN (
  'welcome_menu', 'stay_enquiry', 'availability_check', 'pricing_quote', 'event_enquiry',
  'human_escalation', 'booking_request', 'booking_confirmation', 'payment_reminder',
  'pre_arrival_reminder', 'post_stay_feedback', 'abandoned_followup', 'cancel_reschedule'
));
COMMIT;
