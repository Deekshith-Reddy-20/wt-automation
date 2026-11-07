import type { SupabaseClient } from '@supabase/supabase-js'
import { BOOKING_STATUS_LABELS } from './lifecycle'
import { getBookingByRef, quoteRowToQuote } from './bookings'
import { paymentsReady, type PropertyBundle } from './property-store'
import { tokenMatches } from './refs'
import type { Quote } from './pricing'
import type { Booking } from './types'

/** What a guest may see about their own booking — no staff notes, no internal ids. */
export interface GuestBookingView {
  ref: string
  type: Booking['booking_type']
  status: Booking['status']
  status_label: string
  guest_name: string | null
  check_in: string | null
  check_out: string | null
  event_date: string | null
  event_start_time: string | null
  event_end_time: string | null
  adults: number
  children: number
  guest_count: number
  quote: Quote | null
  amount_paid: number
  payment_status: Booking['payment_status']
  hold_expires_at: string | null
  can_request_reservation: boolean
  can_pay: boolean
  can_cancel: boolean
  event_review_status: string | null
}

/**
 * Resolve a booking from its reference and private link token. Returns
 * null for an unknown ref or a wrong token alike, so refs can't be probed.
 */
export async function loadGuestBooking(
  db: SupabaseClient,
  ref: string,
  token: string,
): Promise<Booking | null> {
  const booking = await getBookingByRef(db, ref)
  if (!booking) return null
  const { data } = await db.from('bookings').select('access_token_hash').eq('id', booking.id).single()
  return tokenMatches(token, data?.access_token_hash) ? booking : null
}

export async function buildGuestView(
  db: SupabaseClient,
  booking: Booking,
  bundle: PropertyBundle | null,
): Promise<GuestBookingView> {
  const [quoteRow, hold, eventReq] = await Promise.all([
    booking.active_quote_id
      ? db.from('booking_quotes').select('*').eq('id', booking.active_quote_id).maybeSingle()
      : Promise.resolve({ data: null }),
    db
      .from('availability_blocks')
      .select('expires_at, block_type')
      .eq('booking_id', booking.id)
      .eq('status', 'active')
      .maybeSingle(),
    booking.booking_type === 'event'
      ? db.from('event_requests').select('status').eq('booking_id', booking.id).maybeSingle()
      : Promise.resolve({ data: null }),
  ])
  const quote = quoteRow.data ? quoteRowToQuote(quoteRow.data as Record<string, unknown>) : null
  const holdExpires = hold.data?.block_type === 'hold' ? (hold.data.expires_at as string) : null
  const online = Boolean(bundle && paymentsReady(bundle.settings, bundle.pricing.rules)) && razorpayConfigured()

  return {
    ref: booking.booking_ref,
    type: booking.booking_type,
    status: booking.status,
    status_label: BOOKING_STATUS_LABELS[booking.status],
    guest_name: booking.guest_name,
    check_in: booking.check_in,
    check_out: booking.check_out,
    event_date: booking.event_date,
    event_start_time: booking.event_start_time,
    event_end_time: booking.event_end_time,
    adults: booking.adults,
    children: booking.children,
    guest_count: booking.guest_count,
    quote,
    amount_paid: booking.amount_paid,
    payment_status: booking.payment_status,
    hold_expires_at: holdExpires,
    can_request_reservation: ['enquiry', 'qualified', 'availability_checked', 'quote_created', 'expired'].includes(booking.status),
    can_pay:
      online &&
      booking.status === 'payment_pending' &&
      quote !== null &&
      quote.advance !== null &&
      (!holdExpires || new Date(holdExpires) > new Date()),
    can_cancel: !['cancelled', 'cancellation_requested', 'rejected', 'expired', 'completed', 'checked_in', 'checked_out'].includes(booking.status),
    event_review_status: (eventReq.data?.status as string | undefined) ?? null,
  }
}

export function razorpayConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
}
