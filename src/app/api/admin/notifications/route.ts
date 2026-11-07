import { NextResponse } from 'next/server'
import { adminRoute, dbError } from '@/lib/resort/admin-http'

export const dynamic = 'force-dynamic'

/** Guest-message jobs (confirmations, reminders) — failed ones first. */
export const GET = adminRoute('agent', async ({ supabase, accountId }, request) => {
  const status = new URL(request.url).searchParams.get('status') ?? 'failed'
  let query = supabase
    .from('notification_jobs')
    .select('id, kind, channel, status, scheduled_for, attempts, max_attempts, last_error, sent_at, booking_id, contact_id, conversation_id, template_name, created_at, bookings(booking_ref, guest_name)')
    .eq('account_id', accountId)
    .eq('channel', 'whatsapp')
    .order('scheduled_for', { ascending: false })
    .limit(100)
  if (['pending', 'processing', 'sent', 'failed', 'cancelled', 'skipped'].includes(status)) query = query.eq('status', status)
  const { data, error } = await query
  if (error) return dbError('Failed to load messages', error)
  return NextResponse.json({ jobs: data ?? [] })
})
