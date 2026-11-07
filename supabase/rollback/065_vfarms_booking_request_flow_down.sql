-- Undo 065: removes the booking_request registry rows and restores the A–L key list.
BEGIN;
DELETE FROM resort_automations WHERE key = 'booking_request';
ALTER TABLE resort_automations DROP CONSTRAINT IF EXISTS resort_automations_key_check;
ALTER TABLE resort_automations ADD CONSTRAINT resort_automations_key_check CHECK (key IN (
  'welcome_menu', 'stay_enquiry', 'availability_check', 'pricing_quote', 'event_enquiry',
  'human_escalation', 'booking_confirmation', 'payment_reminder', 'pre_arrival_reminder',
  'post_stay_feedback', 'abandoned_followup', 'cancel_reschedule'
));
COMMIT;
