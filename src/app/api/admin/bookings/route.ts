import { NextResponse } from 'next/server'
import { adminRoute, dbError } from '@/lib/resort/admin-http'
import { BOOKING_STATUSES } from '@/lib/resort/types'

export const dynamic = 'force-dynamic'

export const GET = adminRoute('viewer', async ({ supabase, accountId }, request) => {
  const url = new URL(request.url)
  const status = url.searchParams.get('status')
  const type = url.searchParams.get('type')
  const view = url.searchParams.get('view')
  const q = url.searchParams.get('q')?.trim().slice(0, 80)
  const page = Math.max(0, Number(url.searchParams.get('page') ?? 0) || 0)
  const pageSize = 50

  let query = supabase
    .from('bookings')
    .select(
      'id, booking_ref, booking_type, status, payment_status, source, guest_name, guest_phone, check_in, check_out, event_date, event_start_time, event_end_time, guest_count, quoted_total, advance_due, amount_paid, amount_refunded, availability_conflict, lead_id, conversation_id, created_at, updated_at',
      { count: 'exact' },
    )
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .range(page * pageSize, page * pageSize + pageSize - 1)

  if (status && (BOOKING_STATUSES as readonly string[]).includes(status)) query = query.eq('status', status)
  if (type === 'stay' || type === 'event') query = query.eq('booking_type', type)
  if (view === 'action') query = query.in('status', ['booking_requested', 'payment_verified', 'cancellation_requested'])
  if (view === 'conflicts') query = query.eq('availability_conflict', true)
  if (view === 'refunds') query = query.eq('payment_status', 'refund_pending')
  if (q) {
    const safe = q.replace(/[%_,()]/g, ' ')
    query = query.or(`booking_ref.ilike.%${safe}%,guest_name.ilike.%${safe}%,guest_phone.ilike.%${safe}%`)
  }

  const { data, count, error } = await query
  if (error) return dbError('Failed to load bookings', error)
  return NextResponse.json({ bookings: data ?? [], total: count ?? 0, page, page_size: pageSize })
})
