import { NextResponse } from 'next/server'
import { adminRoute, dbError, parseBody } from '@/lib/resort/admin-http'
import { leadPatchSchema } from '@/lib/resort/admin-schemas'

export const dynamic = 'force-dynamic'

type P = { id: string }

export const GET = adminRoute<P>('viewer', async ({ supabase, accountId }, _req, { id }) => {
  const { data: lead, error } = await supabase.from('leads').select('*').eq('account_id', accountId).eq('id', id).maybeSingle()
  if (error) return dbError('Failed to load lead', error)
  if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })

  const [notes, bookings] = await Promise.all([
    supabase.from('lead_notes').select('id, body, author_user_id, created_at').eq('lead_id', id).order('created_at', { ascending: false }).limit(100),
    supabase.from('bookings').select('id, booking_ref, booking_type, status, payment_status, check_in, check_out, event_date, quoted_total, amount_paid, created_at')
      .eq('account_id', accountId).eq('lead_id', id).order('created_at', { ascending: false }),
  ])
  return NextResponse.json({ lead, notes: notes.data ?? [], bookings: bookings.data ?? [] })
})

export const PATCH = adminRoute<P>('agent', async ({ supabase, accountId }, request, { id }) => {
  const parsed = await parseBody(request, leadPatchSchema)
  if (!parsed.ok) return parsed.response
  if (Object.keys(parsed.data).length === 0) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })

  if (parsed.data.assigned_to) {
    const { data: member } = await supabase
      .from('profiles')
      .select('user_id')
      .eq('account_id', accountId)
      .eq('user_id', parsed.data.assigned_to)
      .maybeSingle()
    if (!member) return NextResponse.json({ error: 'Assignee is not a team member' }, { status: 422 })
  }

  const { data, error } = await supabase
    .from('leads')
    .update(parsed.data)
    .eq('account_id', accountId)
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error) return dbError('Failed to update lead', error)
  if (!data) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  return NextResponse.json({ lead: data })
})
