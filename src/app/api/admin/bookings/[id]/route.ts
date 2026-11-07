import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { runBookingAction, bookingActionSchema } from '@/lib/resort/admin-actions'
import { canManageRefunds } from '@/lib/auth/roles'
import { adminRoute, bookingActionError, dbError, parseBody } from '@/lib/resort/admin-http'
import { coerceBooking } from '@/lib/resort/bookings'
import { canTransition } from '@/lib/resort/lifecycle'
import { loadPropertyBundle } from '@/lib/resort/property-store'
import { BOOKING_STATUSES } from '@/lib/resort/types'

export const dynamic = 'force-dynamic'

type P = { id: string }

export const GET = adminRoute<P>('viewer', async ({ supabase, accountId }, _req, { id }) => {
  const { data: row, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .maybeSingle()
  if (error) return dbError('Failed to load booking', error)
  if (!row) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
  const booking = coerceBooking(row)
  // The access token hash is never sent to the browser.
  const { access_token_hash: _omit, ...safeRow } = row as Record<string, unknown>
  void _omit

  const [quotes, payments, refunds, eventRequest, guests, jobs, audit, block] = await Promise.all([
    supabase.from('booking_quotes').select('*').eq('booking_id', id).order('created_at', { ascending: false }).limit(20),
    supabase.from('payments').select('id, provider, purpose, amount_paise, amount_refunded_paise, status, method, provider_order_id, provider_payment_id, verified_via, verified_at, failure_reason, created_at').eq('booking_id', id).order('created_at', { ascending: false }),
    supabase.from('refunds').select('id, payment_id, amount_paise, provider_refund_id, status, reason, notes, processed_at, created_at').eq('booking_id', id).order('created_at', { ascending: false }),
    supabase.from('event_requests').select('*').eq('booking_id', id).maybeSingle(),
    supabase.from('booking_guests').select('id, full_name, age, is_child').eq('booking_id', id),
    supabase.from('notification_jobs').select('id, kind, channel, status, scheduled_for, attempts, last_error, sent_at').eq('booking_id', id).eq('channel', 'whatsapp').order('scheduled_for', { ascending: false }).limit(30),
    supabase.from('audit_logs').select('id, action, actor_type, actor_user_id, before, after, created_at').eq('entity_type', 'booking').eq('entity_id', id).order('created_at', { ascending: false }).limit(50),
    supabase.from('availability_blocks').select('id, block_type, period, expires_at').eq('booking_id', id).eq('status', 'active').maybeSingle(),
  ])

  const allowed = BOOKING_STATUSES.filter((s) => canTransition(booking.status, s))
  return NextResponse.json({
    booking: { ...safeRow, ...booking },
    quotes: quotes.data ?? [],
    payments: payments.data ?? [],
    refunds: refunds.data ?? [],
    event_request: eventRequest.data ?? null,
    guests: guests.data ?? [],
    guest_messages: jobs.data ?? [],
    // audit_logs are admin-only under RLS; agents simply see an empty list.
    audit: audit.data ?? [],
    calendar_block: block.data ?? null,
    allowed_transitions: allowed,
  })
})

export const POST = adminRoute<P>('agent', async ({ accountId, userId, role }, request, { id }) => {
  const parsed = await parseBody(request, bookingActionSchema)
  if (!parsed.ok) return parsed.response
  if (parsed.data.action === 'record_payment' && !canManageRefunds(role)) {
    return NextResponse.json({ error: 'Only owners and admins can record payments.' }, { status: 403 })
  }
  const admin = supabaseAdmin()
  try {
    const bundle = await loadPropertyBundle(admin, accountId)
    const result = await runBookingAction({ admin, accountId, userId, bundle }, id, parsed.data)
    return NextResponse.json(result)
  } catch (err) {
    return bookingActionError(err)
  }
})
