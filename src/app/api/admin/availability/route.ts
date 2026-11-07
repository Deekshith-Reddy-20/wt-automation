import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { fetchBlocks } from '@/lib/resort/availability'
import { adminRoute, dbError, parseBody } from '@/lib/resort/admin-http'
import { blockCreateSchema } from '@/lib/resort/admin-schemas'
import { writeAudit } from '@/lib/resort/notify'
import { addDays, daysBetween, isIsoDate, istToInstant, todayIST } from '@/lib/resort/time'

export const dynamic = 'force-dynamic'

/** Calendar for staff: every active block with its booking summary. */
export const GET = adminRoute('viewer', async ({ supabase, accountId }, request) => {
  const url = new URL(request.url)
  const from = url.searchParams.get('from') ?? todayIST()
  const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? 42) || 42, 1), 120)
  if (!isIsoDate(from)) return NextResponse.json({ error: 'Invalid from date' }, { status: 400 })
  const to = addDays(from, days)

  const { data, error } = await supabase
    .from('availability_blocks')
    .select('id, period, block_type, booking_id, expires_at, reason, created_at, bookings(booking_ref, booking_type, guest_name, status)')
    .eq('account_id', accountId)
    .eq('status', 'active')
    .overlaps('period', `[${istToInstant(from, '00:00').toISOString()},${istToInstant(to, '00:00').toISOString()})`)
    .order('period')
  if (error) return dbError('Failed to load calendar', error)
  const now = Date.now()
  const blocks = (data ?? []).filter((b) => !(b.block_type === 'hold' && b.expires_at && Date.parse(b.expires_at) <= now))
  return NextResponse.json({ from, days, blocks })
})

/** Block dates (owner use, maintenance). Whole IST days, start..end inclusive. */
export const POST = adminRoute('agent', async ({ accountId, userId }, request) => {
  const parsed = await parseBody(request, blockCreateSchema)
  if (!parsed.ok) return parsed.response
  const { block_type, start_date, end_date, reason } = parsed.data
  if (daysBetween(start_date, end_date) > 366) {
    return NextResponse.json({ error: 'Block at most one year at a time.' }, { status: 422 })
  }
  const start = istToInstant(start_date, '00:00')
  const end = istToInstant(addDays(end_date, 1), '00:00')
  const admin = supabaseAdmin()

  const { data: blockId, error } = await admin.rpc('resort_reserve', {
    p_account: accountId,
    p_block_type: block_type,
    p_start: start.toISOString(),
    p_end: end.toISOString(),
    p_reason: reason ?? null,
    p_actor: userId,
  })
  if (error) {
    if (error.code === '23P01' || /estate_unavailable/.test(error.message)) {
      const conflicts = await fetchBlocks(admin, accountId, start, end).catch(() => [])
      return NextResponse.json(
        { error: 'Those dates overlap an existing booking, hold or block.', conflicts },
        { status: 409 },
      )
    }
    return dbError('Failed to block dates', error)
  }
  await writeAudit(admin, {
    accountId,
    actorUserId: userId,
    action: 'calendar.blocked',
    entityType: 'availability_block',
    entityId: blockId as string,
    after: { block_type, start_date, end_date, reason: reason ?? null },
  })
  return NextResponse.json({ id: blockId }, { status: 201 })
})

/** Remove a manual / maintenance block. Booking blocks are released by cancelling the booking. */
export const DELETE = adminRoute('agent', async ({ accountId, userId }, request) => {
  const id = new URL(request.url).searchParams.get('id')
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  const admin = supabaseAdmin()
  const { data, error } = await admin
    .from('availability_blocks')
    .update({ status: 'released', released_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('id', id)
    .eq('status', 'active')
    .in('block_type', ['manual_block', 'maintenance'])
    .select('id')
    .maybeSingle()
  if (error) return dbError('Failed to remove block', error)
  if (!data) {
    return NextResponse.json(
      { error: 'Block not found. Booking and hold blocks are released by cancelling the booking.' },
      { status: 404 },
    )
  }
  await writeAudit(admin, {
    accountId,
    actorUserId: userId,
    action: 'calendar.unblocked',
    entityType: 'availability_block',
    entityId: id,
  })
  return NextResponse.json({ ok: true })
})
