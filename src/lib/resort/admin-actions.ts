import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { checkOccupancy } from './availability'
import {
  BookingError,
  bookingOccupancy,
  cancelBooking,
  confirmBooking,
  getBooking,
  saveQuote,
} from './bookings'
import { canTransition } from './lifecycle'
import { cancelPendingJobsForBooking, writeAudit } from './notify'
import { eventOccupancy, stayOccupancy, toRangeLiteral, validateEventDate, validateStayDates, DATE_ERROR_MESSAGES } from './occupancy'
import { discountWithinLimit, formatQuoteText, quoteEvent, quoteStay, rupeesToPaise, type QuoteResult } from './pricing'
import type { PropertyBundle } from './property-store'
import { scheduleBookingMessages } from './reminders'
import { ledgerPaidPaise, scheduleFeedback } from './automations/scheduled'
import { loadAutomationSettings } from './automations/store'
import { eventDurationHours } from './occupancy'
import { isIsoDate, normalizeTime } from './time'
import type { Booking, BookingStatus, EventType } from './types'

const time = z.string().refine((v) => normalizeTime(v) !== null, 'Invalid time')
const date = z.string().refine(isIsoDate, 'Invalid date')

export const bookingActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('confirm'),
    /** Required to confirm while the advance is unpaid; recorded with who approved it. */
    payment_exception_note: z.string().trim().min(5).max(500).optional(),
  }),
  z.object({ action: z.literal('reject'), reason: z.string().max(500).optional() }),
  z.object({ action: z.literal('approve_event'), notes: z.string().max(1000).optional() }),
  z.object({ action: z.literal('reject_event'), reason: z.string().max(500).optional() }),
  z.object({ action: z.literal('cancel'), reason: z.string().max(500).optional() }),
  z.object({ action: z.literal('check_in') }),
  z.object({ action: z.literal('check_out') }),
  z.object({ action: z.literal('complete') }),
  z.object({ action: z.literal('note'), staff_notes: z.string().max(4000) }),
  z.object({
    /** Staff checked their bank / UPI app: records an offline payment. Does not confirm the booking. */
    action: z.literal('record_payment'),
    amount_inr: z.number().positive().max(10_000_000),
    method: z.enum(['upi', 'bank_transfer', 'cash', 'other']),
    purpose: z.enum(['advance', 'balance', 'full']).default('advance'),
    /** UPI / bank reference; recording the same reference twice is rejected. */
    reference: z.string().trim().min(3).max(100).optional(),
    notes: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal('send_quote'),
    discount_inr: z.number().min(0).max(10_000_000).optional(),
    discount_reason: z.string().max(200).optional(),
  }),
  z.object({
    action: z.literal('reschedule'),
    check_in: date.optional(),
    check_out: date.optional(),
    event_date: date.optional(),
    start_time: time.optional(),
    end_time: time.optional(),
  }),
])
export type BookingAction = z.infer<typeof bookingActionSchema>

export interface ActionContext {
  /** Service-role client — callers must have checked the staff role first. */
  admin: SupabaseClient
  accountId: string
  userId: string
  bundle: PropertyBundle
}

export interface ActionResult {
  booking: Booking | null
  message: string
  /** Plain-text quote for staff to send from the inbox (send_quote only). */
  quote_text?: string
}

async function setStatus(ctx: ActionContext, booking: Booking, to: BookingStatus, extra: Record<string, unknown> = {}) {
  if (!canTransition(booking.status, to)) {
    throw new BookingError('invalid_transition', `Cannot move a ${booking.status} booking to ${to}.`)
  }
  const { error } = await ctx.admin
    .from('bookings')
    .update({ status: to, ...extra })
    .eq('id', booking.id)
    .eq('account_id', ctx.accountId)
    .eq('status', booking.status)
  if (error) throw new Error(error.message)
  await writeAudit(ctx.admin, {
    accountId: ctx.accountId,
    actorUserId: ctx.userId,
    action: `booking.${to}`,
    entityType: 'booking',
    entityId: booking.id,
    before: { status: booking.status },
    after: { status: to, ...extra },
  })
}

export async function runBookingAction(ctx: ActionContext, bookingId: string, action: BookingAction): Promise<ActionResult> {
  const booking = await getBooking(ctx.admin, ctx.accountId, bookingId)
  if (!booking) throw new BookingError('not_found')
  const refresh = () => getBooking(ctx.admin, ctx.accountId, bookingId)

  switch (action.action) {
    case 'confirm': {
      const advancePaise = booking.advance_due !== null ? rupeesToPaise(Number(booking.advance_due)) : 0
      const unpaid = advancePaise > 0 && (await ledgerPaidPaise(ctx.admin, bookingId)) < advancePaise
      if (unpaid && booking.status !== 'confirmed') {
        if (!action.payment_exception_note) {
          throw new BookingError(
            'invalid_transition',
            'The advance has not been paid. Record it first, or add a payment-exception note to confirm without it.',
          )
        }
        const { error } = await ctx.admin
          .from('bookings')
          .update({
            payment_exception_note: action.payment_exception_note,
            payment_exception_by: ctx.userId,
            payment_exception_at: new Date().toISOString(),
          })
          .eq('id', bookingId)
          .eq('account_id', ctx.accountId)
        if (error) throw new Error(error.message)
        await writeAudit(ctx.admin, {
          accountId: ctx.accountId,
          actorUserId: ctx.userId,
          action: 'booking.payment_exception',
          entityType: 'booking',
          entityId: bookingId,
          after: { note: action.payment_exception_note },
        })
      }
      const r = await confirmBooking(ctx.admin, ctx.accountId, bookingId, ctx.userId)
      const fresh = await refresh()
      if (fresh && !r.alreadyConfirmed && ctx.bundle.settings) {
        await scheduleBookingMessages(ctx.admin, fresh, ctx.bundle.settings)
      }
      return { booking: fresh, message: r.alreadyConfirmed ? 'Booking was already confirmed.' : 'Booking confirmed.' }
    }

    case 'reject': {
      if (booking.amount_paid > 0) {
        throw new BookingError('invalid_transition', 'This booking has a payment. Cancel it and record the refund instead.')
      }
      await setStatus(ctx, booking, 'rejected', { cancellation_reason: action.reason ?? null })
      await ctx.admin.rpc('resort_release_booking', { p_account: ctx.accountId, p_booking: bookingId })
      await cancelPendingJobsForBooking(ctx.admin, bookingId, 'booking_rejected')
      if (booking.lead_id) await ctx.admin.from('leads').update({ stage: 'lost' }).eq('id', booking.lead_id)
      return { booking: await refresh(), message: 'Request rejected and dates released.' }
    }

    case 'approve_event':
    case 'reject_event': {
      if (booking.booking_type !== 'event') throw new BookingError('invalid_transition', 'Not an event booking.')
      const approved = action.action === 'approve_event'
      const { error } = await ctx.admin
        .from('event_requests')
        .update({
          status: approved ? 'approved' : 'rejected',
          review_notes: approved ? (action.notes ?? null) : (action.reason ?? null),
          reviewed_by: ctx.userId,
          reviewed_at: new Date().toISOString(),
        })
        .eq('booking_id', bookingId)
      if (error) throw new Error(error.message)
      await writeAudit(ctx.admin, {
        accountId: ctx.accountId,
        actorUserId: ctx.userId,
        action: approved ? 'event.approved' : 'event.rejected',
        entityType: 'booking',
        entityId: bookingId,
      })
      if (!approved) {
        if (booking.amount_paid > 0) {
          return { booking: await refresh(), message: 'Event rejected. It has a payment — cancel the booking and record the refund.' }
        }
        if (canTransition(booking.status, 'rejected')) {
          await setStatus(ctx, booking, 'rejected', { cancellation_reason: action.reason ?? null })
          await ctx.admin.rpc('resort_release_booking', { p_account: ctx.accountId, p_booking: bookingId })
        }
        return { booking: await refresh(), message: 'Event rejected.' }
      }
      return { booking: await refresh(), message: 'Event approved. Confirm the booking when the details and payment are settled.' }
    }

    case 'cancel': {
      await cancelBooking(ctx.admin, ctx.accountId, bookingId, { actorUserId: ctx.userId, reason: action.reason ?? null })
      if (booking.amount_paid > 0) {
        await ctx.admin.from('bookings').update({ payment_status: 'refund_pending' }).eq('id', bookingId).in('payment_status', ['paid', 'partially_paid'])
      }
      return {
        booking: await refresh(),
        message: booking.amount_paid > 0 ? 'Booking cancelled. A payment exists — review the refund policy and record any refund.' : 'Booking cancelled and dates released.',
      }
    }

    case 'check_in':
      await setStatus(ctx, booking, 'checked_in')
      return { booking: await refresh(), message: 'Guest checked in.' }
    case 'check_out':
      await setStatus(ctx, booking, 'checked_out')
      return { booking: await refresh(), message: 'Guest checked out.' }
    case 'complete': {
      await setStatus(ctx, booking, 'completed')
      await cancelPendingJobsForBooking(ctx.admin, bookingId, 'booking_completed')
      if (booking.lead_id) await ctx.admin.from('leads').update({ stage: 'completed' }).eq('id', booking.lead_id)
      const completed = await refresh()
      if (completed) {
        await scheduleFeedback(ctx.admin, completed, await loadAutomationSettings(ctx.admin, ctx.accountId)).catch((err) =>
          console.error('[resort] feedback scheduling failed:', err instanceof Error ? err.message : err),
        )
      }
      return { booking: completed, message: 'Booking completed.' }
    }

    case 'note': {
      const { error } = await ctx.admin.from('bookings').update({ staff_notes: action.staff_notes }).eq('id', bookingId)
      if (error) throw new Error(error.message)
      return { booking: await refresh(), message: 'Notes saved.' }
    }

    case 'record_payment':
      return recordManualPayment(ctx, booking, action)

    case 'send_quote':
      return sendQuote(ctx, booking, action)

    case 'reschedule':
      return reschedule(ctx, booking, action)
  }
}

async function recordManualPayment(
  ctx: ActionContext,
  booking: Booking,
  action: Extract<BookingAction, { action: 'record_payment' }>,
): Promise<ActionResult> {
  if (['cancelled', 'rejected', 'expired'].includes(booking.status)) {
    throw new BookingError('invalid_transition', `A ${booking.status} booking cannot take a payment.`)
  }
  const amountPaise = rupeesToPaise(action.amount_inr)
  const now = new Date().toISOString()
  const { data: payment, error } = await ctx.admin
    .from('payments')
    .insert({
      account_id: ctx.accountId,
      booking_id: booking.id,
      provider: 'manual',
      purpose: action.purpose,
      amount_paise: amountPaise,
      status: 'captured',
      method: action.method,
      provider_payment_id: action.reference ? `manual:${action.reference}` : null,
      verified_via: 'manual',
      verified_at: now,
      recorded_by: ctx.userId,
      notes: action.notes ?? null,
    })
    .select('id')
    .single()
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new BookingError('invalid_transition', 'A payment with this reference is already recorded.')
    }
    throw new Error(error.message)
  }
  const { error: moneyErr } = await ctx.admin.rpc('resort_recompute_booking_money', { p_booking: booking.id })
  if (moneyErr) throw new Error(moneyErr.message)
  await writeAudit(ctx.admin, {
    accountId: ctx.accountId,
    actorUserId: ctx.userId,
    action: 'payment.manual_recorded',
    entityType: 'booking',
    entityId: booking.id,
    after: { payment_id: (payment as { id: string }).id, amount: action.amount_inr, method: action.method, purpose: action.purpose, reference: action.reference ?? null },
  })
  return {
    booking: await getBooking(ctx.admin, ctx.accountId, booking.id),
    message: 'Payment recorded. The booking is not confirmed until you press Confirm.',
  }
}

async function sendQuote(
  ctx: ActionContext,
  booking: Booking,
  action: Extract<BookingAction, { action: 'send_quote' }>,
): Promise<ActionResult> {
  const discountPaise = action.discount_inr ? rupeesToPaise(action.discount_inr) : 0
  if (discountPaise > 0 && !action.discount_reason) {
    throw new BookingError('invalid_transition', 'A discount needs a reason.')
  }
  const manual = discountPaise > 0 ? { amount: discountPaise, reason: action.discount_reason! } : null
  let result: QuoteResult
  if (booking.booking_type === 'stay') {
    result = quoteStay(ctx.bundle.pricing, {
      check_in: booking.check_in!,
      check_out: booking.check_out!,
      adults: booking.adults,
      children: booking.children,
      children_ages: booking.children_ages,
    }, manual)
  } else {
    const { data: ev } = await ctx.admin.from('event_requests').select('event_type').eq('booking_id', booking.id).single()
    result = quoteEvent(ctx.bundle.pricing, {
      event_type: (ev?.event_type ?? 'other') as EventType,
      event_hours: eventDurationHours(booking.event_start_time!, booking.event_end_time!),
      guest_count: booking.guest_count,
    }, manual)
  }
  if (result.status !== 'ok') {
    const reason =
      result.status === 'not_configured' ? `Pricing is not configured: ${result.missing.join(', ')}.` :
      result.status === 'below_min_nights' ? `Below the minimum stay of ${result.min_nights} nights.` :
      'This request cannot be priced automatically — agree the price with the guest directly.'
    throw new BookingError('invalid_transition', reason)
  }
  const maxPct = ctx.bundle.pricing.rules?.max_staff_discount_pct ?? 0
  if (!discountWithinLimit(result.quote.subtotal, discountPaise, maxPct)) {
    throw new BookingError('invalid_transition', `Discount exceeds the ${maxPct}% staff limit set in pricing.`)
  }
  await saveQuote(ctx.admin, booking, result.quote, { rules: ctx.bundle.pricing.rules }, ctx.userId, ctx.userId)
  if (['enquiry', 'qualified', 'availability_checked'].includes(booking.status)) {
    await ctx.admin.from('bookings').update({ status: 'quote_created' }).eq('id', booking.id)
  }
  if (booking.lead_id) {
    await ctx.admin.from('leads').update({ stage: 'quote_sent', estimated_quote_inr: result.quote.total / 100 }).eq('id', booking.lead_id).in('stage', ['new', 'contacted', 'qualified'])
  }
  await writeAudit(ctx.admin, {
    accountId: ctx.accountId,
    actorUserId: ctx.userId,
    action: 'quote.created',
    entityType: 'booking',
    entityId: booking.id,
    after: { total: result.quote.total / 100, discount: result.quote.discount / 100, reason: action.discount_reason ?? null },
  })
  return {
    booking: await getBooking(ctx.admin, ctx.accountId, booking.id),
    message: 'Quote saved.',
    quote_text: `Quote for ${booking.booking_ref}:\n${formatQuoteText(result.quote)}`,
  }
}

async function reschedule(
  ctx: ActionContext,
  booking: Booking,
  action: Extract<BookingAction, { action: 'reschedule' }>,
): Promise<ActionResult> {
  const s = ctx.bundle.settings
  if (!s) throw new BookingError('property_not_configured')
  if (['cancelled', 'rejected', 'completed', 'checked_out'].includes(booking.status)) {
    throw new BookingError('invalid_transition', `A ${booking.status} booking cannot be rescheduled.`)
  }
  let patch: Record<string, unknown>
  let occ
  if (booking.booking_type === 'stay') {
    const ci = action.check_in ?? booking.check_in!
    const co = action.check_out ?? booking.check_out!
    const err = validateStayDates(ci, co)
    if (err) throw new BookingError(err, DATE_ERROR_MESSAGES[err])
    occ = stayOccupancy(ci, co, s)
    patch = { check_in: ci, check_out: co }
  } else {
    const d = action.event_date ?? booking.event_date!
    const st = normalizeTime(action.start_time ?? booking.event_start_time)!
    const en = normalizeTime(action.end_time ?? booking.event_end_time)!
    const err = validateEventDate(d)
    if (err) throw new BookingError(err, DATE_ERROR_MESSAGES[err])
    if (st === en) throw new BookingError('invalid_time')
    occ = eventOccupancy(d, st, en, s.event_buffer_minutes)
    patch = { event_date: d, event_start_time: st, event_end_time: en }
  }

  const { data: block } = await ctx.admin
    .from('availability_blocks')
    .select('block_type, expires_at')
    .eq('booking_id', booking.id)
    .eq('status', 'active')
    .maybeSingle()

  if (block) {
    // Moves the existing hold/booking block atomically; fails if the new dates clash.
    const { error } = await ctx.admin.rpc('resort_reserve', {
      p_account: ctx.accountId,
      p_block_type: block.block_type,
      p_booking: booking.id,
      p_start: occ.start.toISOString(),
      p_end: occ.end.toISOString(),
      p_expires_at: block.expires_at,
      p_reason: 'rescheduled',
      p_actor: ctx.userId,
    })
    if (error) {
      if (error.code === '23P01' || /estate_unavailable/.test(error.message)) throw new BookingError('estate_unavailable')
      throw new Error(error.message)
    }
  } else {
    const live = await checkOccupancy(ctx.admin, ctx.accountId, occ, { excludeBookingId: booking.id })
    if (live.status === 'unavailable') throw new BookingError('estate_unavailable')
    if (live.status === 'unknown') throw new Error('Availability could not be verified')
  }

  const { error } = await ctx.admin
    .from('bookings')
    .update({ ...patch, occupancy: toRangeLiteral(occ) })
    .eq('id', booking.id)
  if (error) throw new Error(error.message)
  await writeAudit(ctx.admin, {
    accountId: ctx.accountId,
    actorUserId: ctx.userId,
    action: 'booking.rescheduled',
    entityType: 'booking',
    entityId: booking.id,
    before: { check_in: booking.check_in, check_out: booking.check_out, event_date: booking.event_date, start: booking.event_start_time, end: booking.event_end_time },
    after: patch,
  })
  const fresh = await getBooking(ctx.admin, ctx.accountId, booking.id)
  if (fresh && fresh.status === 'confirmed' && ctx.bundle.settings) {
    await cancelPendingJobsForBooking(ctx.admin, booking.id, 'rescheduled')
    await scheduleBookingMessages(ctx.admin, fresh, ctx.bundle.settings, { skipConfirmation: true, dedupeSuffix: `r${Date.now()}` })
  }
  return { booking: fresh, message: 'Booking rescheduled. Send an updated quote if the price changes.' }
}

export { bookingOccupancy }
