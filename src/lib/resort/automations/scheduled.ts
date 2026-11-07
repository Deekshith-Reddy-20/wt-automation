import type { SupabaseClient } from '@supabase/supabase-js'
import { scheduleGuestMessage } from '../notify'
import { formatINR, rupeesToPaise } from '../pricing'
import { addDays, formatDateHuman, formatTimeHuman, istToInstant } from '../time'
import type { Booking, PropertySettings } from '../types'
import type { AutomationSettings, ResortAutomationKey } from './definitions'

/** Which automation owns each guest-message kind. */
export const JOB_AUTOMATION: Record<string, ResortAutomationKey> = {
  booking_confirmed: 'booking_confirmation',
  payment_reminder: 'payment_reminder',
  upcoming_arrival: 'pre_arrival_reminder',
  upcoming_checkout: 'pre_arrival_reminder',
  post_stay_feedback: 'post_stay_feedback',
  enquiry_followup: 'abandoned_followup',
}

/** Lead stages that still count as an open enquiry for follow-ups. */
export const FOLLOW_UP_STAGES = ['new', 'contacted', 'qualified', 'quote_sent', 'awaiting_customer']

/** Verified money received for a booking, from the payment ledger (paise, net of refunds). */
export async function ledgerPaidPaise(db: SupabaseClient, bookingId: string): Promise<number> {
  const { data, error } = await db
    .from('payments')
    .select('amount_paise, amount_refunded_paise, status, verified_at')
    .eq('booking_id', bookingId)
    .in('status', ['captured', 'partially_refunded'])
  if (error) throw new Error(`Payment ledger lookup failed: ${error.message}`)
  return (data ?? [])
    .filter((p) => p.verified_at)
    .reduce((sum, p) => sum + Number(p.amount_paise) - Number(p.amount_refunded_paise ?? 0), 0)
}

export type PreSendCheck =
  | { ok: true; extra: Record<string, unknown> }
  | { ok: false; status: 'cancelled' | 'skipped'; reason: string; alertStaff?: boolean }

/**
 * Booking confirmation (G) may only go out for a booking that is confirmed,
 * holds the estate, has any event approval, and is paid up to the advance
 * (or staff recorded a payment exception).
 */
export async function checkConfirmation(db: SupabaseClient, booking: Booking & Record<string, unknown>): Promise<PreSendCheck> {
  if (booking.status !== 'confirmed') return { ok: false, status: 'cancelled', reason: `booking_${booking.status}` }
  const { data: block, error: blockErr } = await db
    .from('availability_blocks')
    .select('id')
    .eq('booking_id', booking.id)
    .eq('block_type', 'booking')
    .eq('status', 'active')
    .maybeSingle()
  if (blockErr) throw new Error(`Calendar lookup failed: ${blockErr.message}`)
  if (!block) return { ok: false, status: 'skipped', reason: 'estate_not_held', alertStaff: true }
  if (booking.booking_type === 'event') {
    const { data: ev } = await db.from('event_requests').select('status').eq('booking_id', booking.id).maybeSingle()
    if (ev?.status !== 'approved') return { ok: false, status: 'skipped', reason: 'event_not_approved', alertStaff: true }
  }
  const paid = await ledgerPaidPaise(db, booking.id)
  const advance = booking.advance_due !== null ? rupeesToPaise(Number(booking.advance_due)) : 0
  if (advance > 0 && paid < advance && !booking.payment_exception_at) {
    return { ok: false, status: 'skipped', reason: 'payment_not_verified', alertStaff: true }
  }
  return { ok: true, extra: moneyFields(booking, paid) }
}

function moneyFields(booking: Booking, paidPaise: number): Record<string, unknown> {
  const total = booking.quoted_total !== null ? rupeesToPaise(Number(booking.quoted_total)) : null
  return {
    total_paise: total,
    paid_paise: paidPaise,
    balance_paise: total !== null ? Math.max(0, total - paidPaise) : null,
    guest_name: booking.guest_name,
    guest_count: booking.guest_count,
  }
}

/** Payment reminder (H): only while a balance is outstanding on an active booking. */
export async function checkPaymentReminder(db: SupabaseClient, booking: Booking): Promise<PreSendCheck> {
  if (!['confirmed', 'payment_verified', 'payment_pending', 'hold'].includes(booking.status)) {
    return { ok: false, status: 'cancelled', reason: `booking_${booking.status}` }
  }
  if (booking.quoted_total === null) return { ok: false, status: 'skipped', reason: 'no_quoted_total' }
  const paid = await ledgerPaidPaise(db, booking.id)
  const extra = moneyFields(booking, paid)
  if ((extra.balance_paise as number) <= 0) return { ok: false, status: 'cancelled', reason: 'fully_paid' }
  return { ok: true, extra }
}

export async function checkFeedback(db: SupabaseClient, booking: Booking): Promise<PreSendCheck> {
  if (!['completed', 'checked_out'].includes(booking.status)) return { ok: false, status: 'cancelled', reason: `booking_${booking.status}` }
  const { data } = await db.from('booking_feedback').select('id').eq('booking_id', booking.id).maybeSingle()
  if (data) return { ok: false, status: 'skipped', reason: 'feedback_already_recorded' }
  return { ok: true, extra: {} }
}

/**
 * Abandoned-enquiry follow-up (K): stops on any reply since it was queued,
 * a booking, cancellation, human takeover, revoked consent or the limit.
 */
export async function checkFollowUp(
  db: SupabaseClient,
  job: { lead_id?: string | null; conversation_id: string | null; payload: Record<string, unknown>; created_at?: string },
  automations: AutomationSettings,
): Promise<PreSendCheck> {
  if (!job.lead_id) return { ok: false, status: 'skipped', reason: 'no_lead' }
  const { data: lead } = await db
    .from('leads')
    .select('stage, consent_status, follow_up_count')
    .eq('id', job.lead_id)
    .maybeSingle()
  if (!lead) return { ok: false, status: 'cancelled', reason: 'lead_missing' }
  if (!FOLLOW_UP_STAGES.includes(lead.stage as string)) return { ok: false, status: 'cancelled', reason: `lead_${lead.stage}` }
  if (lead.consent_status === 'revoked') return { ok: false, status: 'cancelled', reason: 'consent_revoked' }
  if (Number(lead.follow_up_count ?? 0) >= automations.config.abandoned_followup.max_follow_ups) {
    return { ok: false, status: 'cancelled', reason: 'follow_up_limit' }
  }
  const { count: bookings } = await db
    .from('bookings')
    .select('id', { count: 'exact', head: true })
    .eq('lead_id', job.lead_id)
    .not('status', 'in', '(enquiry,qualified,availability_checked,quote_created,expired,rejected)')
  if ((bookings ?? 0) > 0) return { ok: false, status: 'cancelled', reason: 'booking_exists' }
  if (job.conversation_id) {
    const { data: state } = await db.from('conversation_states').select('bot_mode').eq('conversation_id', job.conversation_id).maybeSingle()
    if (state?.bot_mode === 'human') return { ok: false, status: 'cancelled', reason: 'human_takeover' }
    const since = typeof job.payload.last_interaction_at === 'string' ? job.payload.last_interaction_at : job.created_at
    if (since) {
      const { count: replies } = await db
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id', job.conversation_id)
        .eq('sender_type', 'customer')
        .gt('created_at', since)
      if ((replies ?? 0) > 0) return { ok: false, status: 'cancelled', reason: 'guest_replied' }
    }
  }
  return { ok: true, extra: {} }
}

function whenText(p: Record<string, unknown>): string {
  return p.booking_type === 'stay'
    ? `${formatDateHuman(String(p.check_in))} → ${formatDateHuman(String(p.check_out))}`
    : `${formatDateHuman(String(p.event_date))}, ${formatTimeHuman(p.event_start_time as string)}–${formatTimeHuman(p.event_end_time as string)}`
}

const inr = (paise: unknown) => (typeof paise === 'number' ? formatINR(paise) : null)

/**
 * Plain-text body for a guest message (used inside WhatsApp's 24-hour
 * window). Only configured property details and recorded amounts appear;
 * a missing detail is left out, never guessed.
 */
export function guestMessageBody(
  kind: string,
  p: Record<string, unknown>,
  settings: PropertySettings | null,
  automations: AutomationSettings,
): string | null {
  const ref = String(p.booking_ref ?? '')
  const isStay = p.booking_type === 'stay'
  const name = settings?.resort_name ?? 'V-Farms'
  const lines: string[] = []
  const contact = settings?.contact_phone ? `Contact: ${settings.contact_phone}` : null
  switch (kind) {
    case 'booking_confirmed': {
      lines.push(`Your ${name} booking ${ref} is confirmed ✅`, '')
      if (p.guest_name) lines.push(`Name: ${p.guest_name}`)
      lines.push(`${isStay ? 'Dates' : 'Event'}: ${whenText(p)}`)
      if (typeof p.guest_count === 'number' && p.guest_count > 0) lines.push(`Guests: ${p.guest_count}`)
      if (inr(p.total_paise)) lines.push(`Total: ${inr(p.total_paise)}`)
      if (inr(p.paid_paise) && Number(p.paid_paise) > 0) lines.push(`Paid: ${inr(p.paid_paise)}`)
      if (inr(p.balance_paise) && Number(p.balance_paise) > 0) lines.push(`Balance due: ${inr(p.balance_paise)}`)
      if (isStay && settings?.check_in_time) lines.push(`Check-in from ${formatTimeHuman(settings.check_in_time)}.`)
      const instructions = automations.config.pre_arrival_reminder.arrival_instructions
      if (instructions) lines.push('', instructions)
      if (contact) lines.push('', contact)
      if (settings?.cancellation_policy) lines.push('', `Cancellation policy: ${truncate(settings.cancellation_policy, 400)}`)
      lines.push('', 'Reply MENU for options or HUMAN to talk to our team.')
      break
    }
    case 'payment_reminder': {
      if (!inr(p.balance_paise)) return null
      lines.push(`Payment reminder for your ${name} booking ${ref} (${whenText(p)}).`, '')
      if (inr(p.total_paise)) lines.push(`Total: ${inr(p.total_paise)}`)
      lines.push(`Paid: ${inr(p.paid_paise) ?? formatINR(0)}`, `Balance: ${inr(p.balance_paise)}`)
      if (typeof p.due_date === 'string') lines.push(`Due by: ${formatDateHuman(p.due_date)}`)
      lines.push('', typeof p.payment_link === 'string' ? `Pay securely here: ${p.payment_link}` : 'Reply HUMAN and our team will share the payment details.')
      break
    }
    case 'upcoming_arrival': {
      lines.push(`Reminder: your ${isStay ? 'stay' : 'event'} at ${name} (${ref}) is coming up — ${whenText(p)}.`)
      if (isStay && settings?.check_in_time) lines.push(`Check-in from ${formatTimeHuman(settings.check_in_time)}.`)
      if (settings?.address) lines.push('', settings.address)
      if (settings?.map_url) lines.push(`Directions: ${settings.map_url}`)
      if (settings?.directions) lines.push(truncate(settings.directions, 500))
      if (settings?.parking_info) lines.push(`Parking: ${truncate(settings.parking_info, 200)}`)
      const instructions = automations.config.pre_arrival_reminder.arrival_instructions
      if (instructions) lines.push('', instructions)
      if (contact) lines.push('', contact)
      lines.push('', 'Reply HUMAN if you need anything from our team.')
      break
    }
    case 'upcoming_checkout':
      if (!settings?.check_out_time) return null
      lines.push(`Reminder: check-out for ${ref} is at ${formatTimeHuman(settings.check_out_time)}. Thank you for staying with us!`)
      break
    case 'post_stay_feedback':
      return automations.config.post_stay_feedback.message_text
    case 'enquiry_followup':
      return automations.config.abandoned_followup.message_text
    default:
      return null
  }
  return lines.join('\n')
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function bookingPayload(booking: Booking) {
  return {
    booking_ref: booking.booking_ref,
    guest_name: booking.guest_name,
    booking_type: booking.booking_type,
    check_in: booking.check_in,
    check_out: booking.check_out,
    event_date: booking.event_date,
    event_start_time: booking.event_start_time,
    event_end_time: booking.event_end_time,
  }
}

/**
 * Queue the balance reminder (H) when a due date is configured: the
 * balance is due `balance_due_days_before` days before arrival and the
 * reminder goes out `remind_days_before_due` days before that, at 10:00 IST.
 */
export async function schedulePaymentReminder(
  db: SupabaseClient,
  booking: Booking,
  automations: AutomationSettings,
  opts: { now?: Date; dedupeSuffix?: string } = {},
): Promise<boolean> {
  const cfg = automations.config.payment_reminder
  if (!automations.enabled.payment_reminder || cfg.balance_due_days_before === null) return false
  if (!booking.contact_id || booking.quoted_total === null) return false
  const start = booking.check_in ?? booking.event_date
  if (!start) return false
  const due = addDays(start, -cfg.balance_due_days_before)
  const at = istToInstant(addDays(due, -cfg.remind_days_before_due), '10:00')
  const now = opts.now ?? new Date()
  if (at <= now) return false
  return scheduleGuestMessage(db, booking.account_id, {
    kind: 'payment_reminder',
    contactId: booking.contact_id,
    conversationId: booking.conversation_id,
    bookingId: booking.id,
    leadId: booking.lead_id,
    scheduledFor: at,
    templateName: cfg.template_name,
    payload: { ...bookingPayload(booking), due_date: due },
    dedupeKey: `payment_reminder:${booking.id}${opts.dedupeSuffix ? `:${opts.dedupeSuffix}` : ''}`,
  })
}

/** Queue the feedback request (J) once per completed booking. */
export async function scheduleFeedback(
  db: SupabaseClient,
  booking: Booking,
  automations: AutomationSettings,
  now = new Date(),
): Promise<boolean> {
  if (!automations.enabled.post_stay_feedback || !booking.contact_id) return false
  const cfg = automations.config.post_stay_feedback
  return scheduleGuestMessage(db, booking.account_id, {
    kind: 'post_stay_feedback',
    contactId: booking.contact_id,
    conversationId: booking.conversation_id,
    bookingId: booking.id,
    leadId: booking.lead_id,
    scheduledFor: new Date(now.getTime() + cfg.delay_hours * 3_600_000),
    templateName: cfg.template_name,
    payload: bookingPayload(booking),
    dedupeKey: `post_stay_feedback:${booking.id}`,
  })
}

/**
 * Queue follow-ups (K) for enquiries that went quiet. Only runs when the
 * automation is enabled and a period is configured; bounded per pass.
 */
export async function scanAbandonedEnquiries(
  db: SupabaseClient,
  accountId: string,
  automations: AutomationSettings,
  now = new Date(),
  limit = 50,
): Promise<number> {
  const cfg = automations.config.abandoned_followup
  if (!automations.enabled.abandoned_followup || cfg.after_hours === null) return 0
  const cutoff = new Date(now.getTime() - cfg.after_hours * 3_600_000).toISOString()
  const { data: leads, error } = await db
    .from('leads')
    .select('id, contact_id, conversation_id, follow_up_count, last_follow_up_at, last_interaction_at, consent_status')
    .eq('account_id', accountId)
    .in('stage', FOLLOW_UP_STAGES)
    .neq('consent_status', 'revoked')
    .lt('follow_up_count', cfg.max_follow_ups)
    .lt('last_interaction_at', cutoff)
    .not('contact_id', 'is', null)
    .not('conversation_id', 'is', null)
    .order('last_interaction_at', { ascending: true })
    .limit(limit)
  if (error) {
    console.error('[resort-followup] scan failed:', error.message)
    return 0
  }
  let queued = 0
  for (const lead of leads ?? []) {
    if (lead.last_follow_up_at && new Date(lead.last_follow_up_at as string).getTime() > Date.parse(cutoff)) continue
    const n = Number(lead.follow_up_count ?? 0) + 1
    try {
      if (await scheduleGuestMessage(db, accountId, {
        kind: 'enquiry_followup',
        contactId: lead.contact_id as string,
        conversationId: lead.conversation_id as string,
        leadId: lead.id as string,
        scheduledFor: now,
        templateName: cfg.template_name,
        payload: { last_interaction_at: lead.last_interaction_at, follow_up_number: n },
        dedupeKey: `enquiry_followup:${lead.id}:${n}`,
      })) queued++
    } catch (err) {
      console.error('[resort-followup] could not queue:', err instanceof Error ? err.message : err)
    }
  }
  return queued
}

/** After the feedback request is delivered, the bot treats the guest's next message as their feedback. */
export async function armFeedbackCapture(
  db: SupabaseClient,
  job: { account_id: string; conversation_id: string; contact_id: string; booking_id: string },
): Promise<void> {
  const { data: row } = await db
    .from('conversation_states')
    .select('id, bot_mode, version')
    .eq('conversation_id', job.conversation_id)
    .maybeSingle()
  const fields = { flow: 'menu', step: 'feedback', data: { feedback_booking_id: job.booking_id }, history: [] }
  if (!row) {
    await db.from('conversation_states').insert({ account_id: job.account_id, conversation_id: job.conversation_id, contact_id: job.contact_id, ...fields })
    return
  }
  if (row.bot_mode === 'human') return
  await db.from('conversation_states').update({ ...fields, version: Number(row.version) + 1 }).eq('id', row.id).eq('version', row.version)
}
