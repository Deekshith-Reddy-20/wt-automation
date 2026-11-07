-- Rollback for 063_vfarms_resort_automations.sql. Run manually, after a
-- backup, only if 063 must be undone. It deletes the automation registry,
-- run history, guest feedback, change requests and the legacy archive
-- (restore archived rows first with
-- `node scripts/archive-solar-records.mjs --restore`).

-- Guest jobs of the new kinds would violate the old constraint.
UPDATE notification_jobs SET status = 'cancelled', last_error = 'rollback_063'
 WHERE kind IN ('payment_reminder', 'post_stay_feedback', 'enquiry_followup', 'reschedule_requested')
   AND status = 'pending';
DELETE FROM notification_jobs
 WHERE kind IN ('payment_reminder', 'post_stay_feedback', 'enquiry_followup', 'reschedule_requested');
ALTER TABLE notification_jobs DROP CONSTRAINT IF EXISTS notification_jobs_kind_check;
ALTER TABLE notification_jobs ADD CONSTRAINT notification_jobs_kind_check CHECK (kind IN (
  'new_enquiry', 'qualified_lead', 'quote_requested', 'booking_requested',
  'payment_verified', 'booking_confirmed', 'upcoming_arrival', 'upcoming_checkout',
  'event_approval_required', 'cancellation_requested', 'message_failed', 'handoff_requested'
));

DROP TABLE IF EXISTS resort_automation_runs;
DROP TABLE IF EXISTS resort_automations;
DROP FUNCTION IF EXISTS public.resort_automation_run_counter();
DROP TABLE IF EXISTS booking_feedback;
DROP TABLE IF EXISTS booking_change_requests;
DROP TABLE IF EXISTS legacy_archive;

ALTER TABLE bookings DROP COLUMN IF EXISTS payment_exception_note;
ALTER TABLE bookings DROP COLUMN IF EXISTS payment_exception_by;
ALTER TABLE bookings DROP COLUMN IF EXISTS payment_exception_at;
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_follow_up_count_nonneg;
ALTER TABLE leads DROP COLUMN IF EXISTS follow_up_count;
ALTER TABLE leads DROP COLUMN IF EXISTS last_follow_up_at;

-- Archived automations stay inactive; they become visible again.
ALTER TABLE automations DROP CONSTRAINT IF EXISTS automations_archived_inactive;
ALTER TABLE automations DROP COLUMN IF EXISTS archived_at;
