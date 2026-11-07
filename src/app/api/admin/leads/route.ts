import { NextResponse } from 'next/server'
import { adminRoute, dbError } from '@/lib/resort/admin-http'
import { LEAD_PRIORITIES, LEAD_SOURCES, LEAD_STAGES } from '@/lib/resort/types'

export const dynamic = 'force-dynamic'

export const GET = adminRoute('viewer', async ({ supabase, accountId }, request) => {
  const url = new URL(request.url)
  const stage = url.searchParams.get('stage')
  const priority = url.searchParams.get('priority')
  const source = url.searchParams.get('source')
  const category = url.searchParams.get('category')
  const q = url.searchParams.get('q')?.trim().slice(0, 80)
  const open = url.searchParams.get('open') === '1'
  const page = Math.max(0, Number(url.searchParams.get('page') ?? 0) || 0)
  const pageSize = 50

  let query = supabase
    .from('leads')
    .select(
      'id, lead_number, customer_name, phone_e164, email, source, category, stage, priority, check_in, check_out, event_date, guest_count, adults, children, budget_inr, estimated_quote_inr, next_follow_up_at, last_interaction_at, consent_status, conversation_id, created_at, updated_at',
      { count: 'exact' },
    )
    .eq('account_id', accountId)
    .order('updated_at', { ascending: false })
    .range(page * pageSize, page * pageSize + pageSize - 1)

  if (stage && (LEAD_STAGES as readonly string[]).includes(stage)) query = query.eq('stage', stage)
  if (priority && (LEAD_PRIORITIES as readonly string[]).includes(priority)) query = query.eq('priority', priority)
  if (source && (LEAD_SOURCES as readonly string[]).includes(source)) query = query.eq('source', source)
  if (category && ['stay', 'event', 'pricing', 'general'].includes(category)) query = query.eq('category', category)
  if (open) query = query.not('stage', 'in', '(completed,cancelled,lost)')
  if (q) {
    const safe = q.replace(/[%_,()]/g, ' ')
    query = query.or(`customer_name.ilike.%${safe}%,phone_e164.ilike.%${safe}%,email.ilike.%${safe}%`)
  }

  const { data, count, error } = await query
  if (error) return dbError('Failed to load leads', error)
  return NextResponse.json({ leads: data ?? [], total: count ?? 0, page, page_size: pageSize })
})
