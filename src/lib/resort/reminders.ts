import type { SupabaseClient } from '@supabase/supabase-js'
import type { AutomationSettings } from './automations/definitions'
import { schedulePaymentReminder } from './automations/scheduled'
import { loadAutomationSettings } from './automations/store'
import { scheduleGuestMessage } from './notify'
import { eventOccupancy, stayOccupancy } from './occupancy'
import type { Booking, PropertySettings } from './types'

/**
 * Queue the guest messages for a confirmed booking — confirmation (G),
 * balance reminder (H) and arrival / check-out reminders (I) — each only
 * when its automation is enabled. The notification cron sends them and
 * re-checks at send time that the message is still true (booking active,
 * paid, not opted out). Timing comes only from the automation config or
 * property_settings.reminder_settings; nothing is scheduled by default.
 */
export async function scheduleBookingMessages(
  db: SupabaseClient,
  booking: Booking,
  settings: PropertySettings,
  opts: { now?: Date; skipConfirmation?: boolean; dedupeSuffix?: string; automations?: AutomationSettings } = {},
): Promise<number> {
  if (!booking.contact_id) return 0
  const now = opts.now ?? new Date()
  const automations = opts.automations ?? (await loadAutomationSettings(db, booking.account_id))
  const rs = settings.reminder_settings ?? {}
  const suffix = opts.dedupeSuffix ? `:${opts.dedupeSuffix}` : ''
  const base = {
    contactId: booking.contact_id,
    conversationId: booking.conversation_id,
    bookingId: booking.id,
    leadId: booking.lead_id,
  }
  const payload = {
    booking_ref: booking.booking_ref,
    guest_name: booking.guest_name,
    booking_type: booking.booking_type,
    check_in: booking.check_in,
    check_out: booking.check_out,
    event_date: booking.event_date,
    event_start_time: booking.event_start_time,
    event_end_time: booking.event_end_time,
  }
  let queued = 0

  if (!opts.skipConfirmation && automations.enabled.booking_confirmation) {
    if (await scheduleGuestMessage(db, booking.account_id, {
      ...base,
      kind: 'booking_confirmed',
      scheduledFor: now,
      templateName: automations.config.booking_confirmation.template_name ?? rs.confirmation_template ?? null,
      payload,
      dedupeKey: `booking_confirmed:${booking.id}${suffix}`,
    })) queued++
  }

  if (await schedulePaymentReminder(db, booking, automations, { now, dedupeSuffix: opts.dedupeSuffix })) queued++

  if (!automations.enabled.pre_arrival_reminder) return queued
  const occ =
    booking.booking_type === 'stay' && booking.check_in && booking.check_out
      ? stayOccupancy(booking.check_in, booking.check_out, settings)
      : booking.event_date && booking.event_start_time && booking.event_end_time
        ? eventOccupancy(booking.event_date, booking.event_start_time, booking.event_end_time, 0)
        : null
  if (!occ) return queued

  const arrival = automations.config.pre_arrival_reminder
  const arrivalHours = arrival.hours_before ?? rs.arrival_reminder_hours ?? null
  if (arrivalHours && arrivalHours > 0) {
    const at = new Date(occ.start.getTime() - arrivalHours * 3_600_000)
    if (at > now && await scheduleGuestMessage(db, booking.account_id, {
      ...base,
      kind: 'upcoming_arrival',
      scheduledFor: at,
      templateName: arrival.template_name ?? rs.arrival_template ?? null,
      payload,
      dedupeKey: `upcoming_arrival:${booking.id}${suffix}`,
    })) queued++
  }

  if (booking.booking_type === 'stay' && rs.checkout_reminder_hours && rs.checkout_reminder_hours > 0) {
    const at = new Date(occ.end.getTime() - rs.checkout_reminder_hours * 3_600_000)
    if (at > now && await scheduleGuestMessage(db, booking.account_id, {
      ...base,
      kind: 'upcoming_checkout',
      scheduledFor: at,
      templateName: rs.checkout_template ?? null,
      payload,
      dedupeKey: `upcoming_checkout:${booking.id}${suffix}`,
    })) queued++
  }
  return queued
}
