import type { SupabaseClient } from '@supabase/supabase-js'
import { checkOccupancy } from './availability'
import { bookingOccupancy, coerceBooking, quoteRowToQuote } from './bookings'
import { alertStaff, writeAudit } from './notify'
import { formatINR } from './pricing'
import { loadPropertyBundle, paymentsReady, type PropertyBundle } from './property-store'
import {
  RazorpayError,
  createOrder,
  createRefund,
  razorpayCredentials,
  type RazorpayCredentials,
} from './razorpay'
import { scheduleBookingMessages } from './reminders'
import type { Booking, BookingStatus } from './types'

// ------------------------------------------------------------
// Eligibility — re-checked every time an order is created, so a
// stale tab or a replayed request can never take money for dates that
// are no longer held, a quote that has expired, or a cancelled booking.
// ------------------------------------------------------------

export type Eligibility =
  | { ok: true; amountPaise: number; quoteId: string }
  | { ok: false; reason: string; message: string }

export async function paymentEligibility(
  db: SupabaseClient,
  bundle: PropertyBundle,
  booking: Booking,
  now = new Date(),
): Promise<Eligibility> {
  const no = (reason: string, message: string): Eligibility => ({ ok: false, reason, message })
  if (!razorpayCredentials()) return no('payments_not_configured', 'Online payment is not available. Please contact us on WhatsApp.')
  if (!paymentsReady(bundle.settings, bundle.pricing.rules)) return no('payments_disabled', 'Online payment is not available. Please contact us on WhatsApp.')
  if (booking.status !== 'payment_pending') return no('not_payable', 'This booking is not awaiting payment.')
  if (booking.availability_conflict) return no('conflict', 'Our team needs to review this booking before payment.')
  if (!booking.active_quote_id) return no('no_quote', 'There is no quote to pay yet.')

  const { data: q } = await db.from('booking_quotes').select('*').eq('id', booking.active_quote_id).maybeSingle()
  if (!q) return no('no_quote', 'There is no quote to pay yet.')
  const quote = quoteRowToQuote(q as Record<string, unknown>)
  if (q.valid_until && new Date(q.valid_until as string) <= now) {
    return no('quote_expired', 'This quote has expired. Please request a new one.')
  }
  const advance = quote.advance ?? 0
  if (advance < 100) return no('no_advance', 'No advance payment is due for this booking.')
  const alreadyPaid = Math.round(booking.amount_paid * 100)
  const due = advance - alreadyPaid
  if (due < 100) return no('already_paid', 'The advance has already been paid.')

  const { data: block } = await db
    .from('availability_blocks')
    .select('block_type, expires_at')
    .eq('booking_id', booking.id)
    .eq('status', 'active')
    .maybeSingle()
  if (block) {
    if (block.block_type === 'hold' && new Date(block.expires_at as string) <= now) {
      return no('hold_expired', 'Your hold on these dates has expired. Please request the booking again.')
    }
  } else {
    // No hold (holds disabled): the dates must still be free right now.
    const occ = bookingOccupancy(booking, bundle)
    if (!occ) return no('no_dates', 'This booking has no dates.')
    const live = await checkOccupancy(db, booking.account_id, occ, { excludeBookingId: booking.id })
    if (live.status === 'unavailable') return no('unavailable', 'Sorry, those dates are no longer available.')
    if (live.status === 'unknown') return no('unverified', 'We could not check availability just now. Please try again shortly.')
  }
  return { ok: true, amountPaise: due, quoteId: booking.active_quote_id }
}

export interface OrderForCheckout {
  key_id: string
  order_id: string
  amount: number
  currency: 'INR'
  name: string
  description: string
  prefill: { name?: string; contact?: string; email?: string }
}

/** Create (or reuse) a Razorpay order for the booking's outstanding advance. */
export async function createPaymentOrder(
  db: SupabaseClient,
  bundle: PropertyBundle,
  booking: Booking,
  amountPaise: number,
  creds: RazorpayCredentials,
): Promise<OrderForCheckout> {
  const checkout = (orderId: string): OrderForCheckout => ({
    key_id: creds.keyId,
    order_id: orderId,
    amount: amountPaise,
    currency: 'INR',
    name: bundle.settings?.resort_name ?? 'V-Farms',
    description: `Advance for ${booking.booking_ref}`,
    prefill: {
      ...(booking.guest_name ? { name: booking.guest_name } : {}),
      ...(booking.guest_phone ? { contact: booking.guest_phone } : {}),
      ...(booking.guest_email ? { email: booking.guest_email } : {}),
    },
  })

  // An unpaid order for the same amount can be reused (e.g. the guest
  // closed the checkout and pressed Pay again).
  const since = new Date(Date.now() - 60 * 60_000).toISOString()
  const { data: existing } = await db
    .from('payments')
    .select('provider_order_id')
    .eq('booking_id', booking.id)
    .eq('provider', 'razorpay')
    .eq('amount_paise', amountPaise)
    .in('status', ['created', 'attempted', 'failed'])
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existing?.provider_order_id) return checkout(existing.provider_order_id as string)

  const order = await createOrder(creds, {
    amountPaise,
    receipt: `${booking.booking_ref}-${Date.now().toString(36)}`,
    notes: { booking_ref: booking.booking_ref, booking_id: booking.id },
  })
  if (order.amount !== amountPaise || order.currency !== 'INR') {
    throw new RazorpayError('Razorpay returned an unexpected order amount', 502)
  }
  const { error } = await db.from('payments').insert({
    account_id: booking.account_id,
    booking_id: booking.id,
    provider: 'razorpay',
    purpose: 'advance',
    amount_paise: amountPaise,
    provider_order_id: order.id,
    status: 'created',
  })
  if (error) throw new Error(`Could not record the payment order: ${error.message}`)
  return checkout(order.id)
}

// ------------------------------------------------------------
// Verified payments
// ------------------------------------------------------------

export interface AppliedPayment {
  already_processed: boolean
  booking_id: string
  booking_status: BookingStatus
  availability_conflict: boolean
}

export class PaymentApplyError extends Error {
  constructor(public code: 'order_not_found' | 'amount_mismatch' | 'other_payment' | 'failed', message: string) {
    super(message)
  }
}

/**
 * Record a payment whose authenticity was verified (checkout signature
 * or webhook signature). The database function secures the dates and
 * decides the status — a payment never bypasses availability or the
 * manual-approval setting.
 */
export async function applyVerifiedPayment(
  db: SupabaseClient,
  input: { orderId: string; paymentId: string; amountPaise: number; via: 'checkout_signature' | 'webhook'; method?: string | null },
): Promise<AppliedPayment> {
  const { data, error } = await db.rpc('resort_apply_verified_payment', {
    p_provider_order_id: input.orderId,
    p_provider_payment_id: input.paymentId,
    p_amount_paise: input.amountPaise,
    p_via: input.via,
    p_method: input.method ?? null,
  })
  if (error) {
    if (/payment_order_not_found/.test(error.message)) throw new PaymentApplyError('order_not_found', 'Unknown payment order')
    if (/amount_mismatch/.test(error.message)) throw new PaymentApplyError('amount_mismatch', 'Payment amount does not match the order')
    if (/order_already_paid_by_other_payment/.test(error.message)) throw new PaymentApplyError('other_payment', 'Order already paid by another payment')
    throw new PaymentApplyError('failed', error.message)
  }
  const result = data as AppliedPayment
  if (!result.already_processed) await afterPaymentVerified(db, result, input.amountPaise)
  return result
}

async function afterPaymentVerified(db: SupabaseClient, result: AppliedPayment, amountPaise: number): Promise<void> {
  const { data: row } = await db.from('bookings').select('*').eq('id', result.booking_id).maybeSingle()
  if (!row) return
  const booking = coerceBooking(row)
  const link = `/resort/bookings/${booking.id}`
  if (result.availability_conflict) {
    await alertStaff(db, booking.account_id, {
      kind: 'payment_verified',
      title: `Payment received but dates NOT secured — ${booking.booking_ref}`,
      body: `${formatINR(amountPaise)} was paid, but the dates are no longer free (or the booking was cancelled). Contact the guest to reschedule or refund.`,
      linkPath: link,
      bookingId: booking.id,
      conversationId: booking.conversation_id,
      dedupeKey: `payment_conflict:${booking.id}:${amountPaise}:${Date.now()}`,
    })
    return
  }
  await alertStaff(db, booking.account_id, {
    kind: 'payment_verified',
    title: `Payment verified — ${booking.booking_ref}`,
    body:
      result.booking_status === 'confirmed'
        ? `${formatINR(amountPaise)} received. The booking was confirmed automatically.`
        : `${formatINR(amountPaise)} received. Review and confirm the booking.`,
    linkPath: link,
    bookingId: booking.id,
    conversationId: booking.conversation_id,
  })
  if (result.booking_status === 'confirmed') {
    const bundle = await loadPropertyBundle(db, booking.account_id)
    if (bundle.settings) await scheduleBookingMessages(db, booking, bundle.settings)
  }
}

export function paymentResultMessage(result: Pick<AppliedPayment, 'booking_status' | 'availability_conflict'>): string {
  if (result.availability_conflict) {
    return 'Payment received, but we could not secure these dates automatically. Our team will contact you shortly to arrange alternative dates or a refund.'
  }
  if (result.booking_status === 'confirmed') return 'Payment received — your booking is confirmed. We look forward to hosting you!'
  return 'Payment received. Our team will review and confirm your booking shortly.'
}

// ------------------------------------------------------------
// Refunds
// ------------------------------------------------------------

/** Bring a payment's refunded amount in line with confirmed refunds, then the booking's money columns. */
export async function syncRefundLedger(db: SupabaseClient, paymentRowId: string): Promise<void> {
  const { data: payment } = await db.from('payments').select('id, booking_id, amount_paise').eq('id', paymentRowId).single()
  if (!payment) return
  const { data: refunds } = await db.from('refunds').select('amount_paise, status').eq('payment_id', paymentRowId)
  const refunded = (refunds ?? [])
    .filter((r) => r.status === 'processed' || r.status === 'manual_recorded')
    .reduce((s, r) => s + Number(r.amount_paise), 0)
  const capped = Math.min(refunded, Number(payment.amount_paise))
  await db
    .from('payments')
    .update({
      amount_refunded_paise: capped,
      ...(capped > 0 ? { status: capped >= Number(payment.amount_paise) ? 'refunded' : 'partially_refunded' } : {}),
    })
    .eq('id', paymentRowId)
  await db.rpc('resort_recompute_booking_money', { p_booking: payment.booking_id })
}

export interface RefundRequest {
  accountId: string
  bookingId: string
  paymentRowId: string
  amountPaise: number
  reason: string
  mode: 'razorpay' | 'manual'
  actorUserId: string
}

export interface RefundOutcome {
  status: 'processed' | 'pending' | 'manual_recorded'
  message: string
  refundId: string
}

export class RefundError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export async function requestRefund(db: SupabaseClient, req: RefundRequest): Promise<RefundOutcome> {
  const { data: payment } = await db
    .from('payments')
    .select('id, booking_id, account_id, provider, provider_payment_id, amount_paise, amount_refunded_paise, status')
    .eq('id', req.paymentRowId)
    .eq('account_id', req.accountId)
    .eq('booking_id', req.bookingId)
    .maybeSingle()
  if (!payment) throw new RefundError(404, 'Payment not found for this booking.')
  if (!['captured', 'partially_refunded'].includes(payment.status as string)) {
    throw new RefundError(422, 'Only captured payments can be refunded.')
  }
  const { data: open } = await db.from('refunds').select('amount_paise').eq('payment_id', payment.id).in('status', ['requested', 'pending'])
  const reserved = (open ?? []).reduce((s, r) => s + Number(r.amount_paise), 0)
  const refundable = Number(payment.amount_paise) - Number(payment.amount_refunded_paise) - reserved
  if (req.amountPaise > refundable) {
    throw new RefundError(422, `At most ${formatINR(refundable)} can be refunded on this payment.`)
  }

  if (req.mode === 'manual') {
    const { data: row, error } = await db
      .from('refunds')
      .insert({
        account_id: req.accountId,
        payment_id: payment.id,
        booking_id: req.bookingId,
        amount_paise: req.amountPaise,
        status: 'manual_recorded',
        reason: req.reason,
        notes: 'Recorded by an authorised operator (paid outside Razorpay).',
        requested_by: req.actorUserId,
        processed_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    await syncRefundLedger(db, payment.id)
    await writeAudit(db, {
      accountId: req.accountId,
      actorUserId: req.actorUserId,
      action: 'refund.manual_recorded',
      entityType: 'booking',
      entityId: req.bookingId,
      after: { amount: req.amountPaise / 100, reason: req.reason, refund_id: row.id },
    })
    return { status: 'manual_recorded', message: 'Offline refund recorded.', refundId: row.id }
  }

  if (payment.provider !== 'razorpay' || !payment.provider_payment_id) {
    throw new RefundError(422, 'This payment was not made through Razorpay. Record an offline refund instead.')
  }
  const creds = razorpayCredentials()
  if (!creds) throw new RefundError(503, 'Razorpay keys are not configured on the server.')

  const { data: row, error } = await db
    .from('refunds')
    .insert({
      account_id: req.accountId,
      payment_id: payment.id,
      booking_id: req.bookingId,
      amount_paise: req.amountPaise,
      status: 'requested',
      reason: req.reason,
      requested_by: req.actorUserId,
    })
    .select('id')
    .single()
  if (error) throw new Error(error.message)

  try {
    const refund = await createRefund(creds, payment.provider_payment_id as string, {
      amountPaise: req.amountPaise,
      notes: { refund_row_id: row.id, booking_id: req.bookingId, reason: req.reason.slice(0, 200) },
      receipt: row.id,
    })
    const processed = refund.status === 'processed'
    await db
      .from('refunds')
      .update({
        provider_refund_id: refund.id,
        status: processed ? 'processed' : refund.status === 'failed' ? 'failed' : 'pending',
        processed_at: processed ? new Date().toISOString() : null,
      })
      .eq('id', row.id)
    await syncRefundLedger(db, payment.id)
    await writeAudit(db, {
      accountId: req.accountId,
      actorUserId: req.actorUserId,
      action: 'refund.requested',
      entityType: 'booking',
      entityId: req.bookingId,
      after: { amount: req.amountPaise / 100, reason: req.reason, provider_refund_id: refund.id, provider_status: refund.status },
    })
    if (refund.status === 'failed') throw new RefundError(502, 'Razorpay reported the refund as failed.')
    return processed
      ? { status: 'processed', message: 'Refund processed by Razorpay.', refundId: row.id }
      : { status: 'pending', message: 'Refund submitted to Razorpay. It will show as completed once Razorpay confirms it.', refundId: row.id }
  } catch (err) {
    if (err instanceof RefundError) throw err
    await db
      .from('refunds')
      .update({ status: 'failed', notes: err instanceof Error ? err.message.slice(0, 500) : 'Refund request failed' })
      .eq('id', row.id)
    await syncRefundLedger(db, payment.id)
    throw new RefundError(502, `Razorpay did not accept the refund: ${err instanceof Error ? err.message : 'unknown error'}`)
  }
}

// ------------------------------------------------------------
// Webhook events
// ------------------------------------------------------------

interface RazorpayWebhook {
  event: string
  payload: {
    payment?: { entity: { id: string; order_id: string | null; amount: number; status: string; method?: string | null; error_code?: string | null; error_description?: string | null } }
    refund?: { entity: { id: string; payment_id: string; amount: number; status: string; notes?: Record<string, string> | unknown[] } }
    order?: { entity: { id: string; amount_paid?: number } }
  }
}

export type WebhookResult = 'processed' | 'ignored'

export async function handleRazorpayEvent(db: SupabaseClient, body: RazorpayWebhook): Promise<WebhookResult> {
  const payment = body.payload.payment?.entity
  switch (body.event) {
    case 'payment.captured':
    case 'order.paid': {
      if (!payment?.order_id) return 'ignored'
      try {
        await applyVerifiedPayment(db, {
          orderId: payment.order_id,
          paymentId: payment.id,
          amountPaise: payment.amount,
          via: 'webhook',
          method: payment.method ?? null,
        })
        return 'processed'
      } catch (err) {
        if (err instanceof PaymentApplyError && err.code === 'order_not_found') return 'ignored'
        throw err
      }
    }
    case 'payment.authorized':
      // Captured payments arrive as payment.captured; nothing to record yet.
      return 'ignored'
    case 'payment.failed': {
      if (!payment?.order_id) return 'ignored'
      const { data } = await db
        .from('payments')
        .update({
          status: 'failed',
          failure_code: payment.error_code ?? null,
          failure_reason: payment.error_description?.slice(0, 500) ?? null,
        })
        .eq('provider_order_id', payment.order_id)
        .in('status', ['created', 'attempted'])
        .select('id')
      return data && data.length > 0 ? 'processed' : 'ignored'
    }
    case 'refund.processed':
    case 'refund.failed':
    case 'refund.created': {
      const refund = body.payload.refund?.entity
      if (!refund) return 'ignored'
      const status = body.event === 'refund.processed' ? 'processed' : body.event === 'refund.failed' ? 'failed' : 'pending'
      let { data: row } = await db.from('refunds').select('id, payment_id, status').eq('provider_refund_id', refund.id).maybeSingle()
      if (!row) {
        // The webhook can beat our own update after createRefund; match by our row id in notes.
        const notes = !Array.isArray(refund.notes) ? (refund.notes as Record<string, string> | undefined) : undefined
        if (notes?.refund_row_id) {
          const r = await db.from('refunds').select('id, payment_id, status').eq('id', notes.refund_row_id).maybeSingle()
          row = r.data
        }
      }
      if (!row) return 'ignored'
      if (row.status === 'processed' || row.status === 'manual_recorded') return 'ignored'
      if (status === 'pending' && row.status === 'pending') return 'ignored'
      await db
        .from('refunds')
        .update({
          provider_refund_id: refund.id,
          status,
          processed_at: status === 'processed' ? new Date().toISOString() : null,
        })
        .eq('id', row.id)
      await syncRefundLedger(db, row.payment_id as string)
      return 'processed'
    }
    default:
      return 'ignored'
  }
}
