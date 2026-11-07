import type { SupabaseClient } from '@supabase/supabase-js'
import { isUniqueViolation } from '@/lib/contacts/dedupe'

export type NotificationKind =
  | 'new_enquiry'
  | 'qualified_lead'
  | 'quote_requested'
  | 'booking_requested'
  | 'payment_verified'
  | 'booking_confirmed'
  | 'upcoming_arrival'
  | 'upcoming_checkout'
  | 'event_approval_required'
  | 'cancellation_requested'
  | 'message_failed'
  | 'handoff_requested'
  | 'payment_reminder'
  | 'post_stay_feedback'
  | 'enquiry_followup'
  | 'reschedule_requested'

const STAFF_ROLES = ['owner', 'admin', 'agent']

interface StaffAlert {
  kind: NotificationKind
  title: string
  body: string
  linkPath?: string
  conversationId?: string | null
  contactId?: string | null
  bookingId?: string | null
  leadId?: string | null
  /** Notify only these members; default is every owner/admin/agent. */
  userIds?: string[]
  /** Collapses repeats (webhook retries, double submits) into one alert. */
  dedupeKey?: string
}

/**
 * In-app alert for the reservation team. Respects the per-kind switch in
 * property_settings.notification_settings ({"new_enquiry": false} turns
 * that alert off). Never throws — a failed alert must not fail a booking.
 */
export async function alertStaff(db: SupabaseClient, accountId: string, alert: StaffAlert): Promise<void> {
  try {
    const { data: settings } = await db
      .from('property_settings')
      .select('notification_settings')
      .eq('account_id', accountId)
      .maybeSingle()
    const prefs = (settings?.notification_settings ?? {}) as Record<string, unknown>
    if (prefs[alert.kind] === false) return

    if (alert.dedupeKey) {
      const { error } = await db.from('notification_jobs').insert({
        account_id: accountId,
        kind: alert.kind,
        channel: 'staff',
        booking_id: alert.bookingId ?? null,
        lead_id: alert.leadId ?? null,
        conversation_id: alert.conversationId ?? null,
        contact_id: alert.contactId ?? null,
        payload: { title: alert.title },
        status: 'sent',
        sent_at: new Date().toISOString(),
        dedupe_key: alert.dedupeKey,
      })
      if (error) {
        if (isUniqueViolation(error)) return
        console.error('[resort] staff alert dedupe insert failed:', error.message)
      }
    }

    let recipients = alert.userIds
    if (!recipients || recipients.length === 0) {
      const { data: members, error } = await db
        .from('profiles')
        .select('user_id, account_role')
        .eq('account_id', accountId)
        .in('account_role', STAFF_ROLES)
      if (error) throw new Error(error.message)
      recipients = (members ?? []).map((m: { user_id: string }) => m.user_id)
    }
    if (recipients.length === 0) return

    const { error } = await db.from('notifications').insert(
      recipients.map((userId) => ({
        account_id: accountId,
        user_id: userId,
        type: 'resort_alert',
        conversation_id: alert.conversationId ?? null,
        contact_id: alert.contactId ?? null,
        title: alert.title.slice(0, 200),
        body: alert.body.slice(0, 1000),
        link_path: alert.linkPath ?? null,
      })),
    )
    if (error) throw new Error(error.message)
  } catch (err) {
    console.error('[resort] staff alert failed:', err instanceof Error ? err.message : err)
  }
}

export interface GuestMessageJob {
  kind: NotificationKind
  contactId: string
  conversationId: string | null
  bookingId?: string | null
  leadId?: string | null
  scheduledFor: Date
  /** Required when the job may run outside WhatsApp's 24-hour window. */
  templateName?: string | null
  payload: Record<string, unknown>
  dedupeKey: string
}

/** Queue a guest WhatsApp message for the notification cron. Idempotent per dedupeKey. */
export async function scheduleGuestMessage(db: SupabaseClient, accountId: string, job: GuestMessageJob): Promise<boolean> {
  const { error } = await db.from('notification_jobs').insert({
    account_id: accountId,
    kind: job.kind,
    channel: 'whatsapp',
    contact_id: job.contactId,
    conversation_id: job.conversationId,
    booking_id: job.bookingId ?? null,
    lead_id: job.leadId ?? null,
    template_name: job.templateName ?? null,
    payload: job.payload,
    scheduled_for: job.scheduledFor.toISOString(),
    dedupe_key: job.dedupeKey,
  })
  if (error) {
    if (isUniqueViolation(error)) return false
    throw new Error(`Could not schedule message: ${error.message}`)
  }
  return true
}

/** Stop pending reminders for a booking (cancelled, completed …). */
export async function cancelPendingJobsForBooking(db: SupabaseClient, bookingId: string, reason: string): Promise<void> {
  const { error } = await db
    .from('notification_jobs')
    .update({ status: 'cancelled', last_error: reason })
    .eq('booking_id', bookingId)
    .eq('status', 'pending')
  if (error) console.error('[resort] could not cancel reminders:', error.message)
}

export async function writeAudit(
  db: SupabaseClient,
  entry: {
    accountId: string
    actorUserId?: string | null
    actorType?: 'user' | 'system' | 'bot' | 'webhook'
    action: string
    entityType: string
    entityId?: string | null
    before?: unknown
    after?: unknown
  },
): Promise<void> {
  const { error } = await db.from('audit_logs').insert({
    account_id: entry.accountId,
    actor_user_id: entry.actorUserId ?? null,
    actor_type: entry.actorType ?? (entry.actorUserId ? 'user' : 'system'),
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
  })
  if (error) console.error('[resort] audit write failed:', error.message)
}
