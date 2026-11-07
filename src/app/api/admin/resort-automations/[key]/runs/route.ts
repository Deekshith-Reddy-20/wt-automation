import { NextResponse } from 'next/server'
import { adminRoute, dbError } from '@/lib/resort/admin-http'
import { isResortAutomationKey } from '@/lib/resort/automations/definitions'

export const dynamic = 'force-dynamic'

/** Execution history for one automation (newest first). */
export const GET = adminRoute<{ key: string }>('agent', async ({ supabase, accountId }, request, { key }) => {
  if (!isResortAutomationKey(key)) return NextResponse.json({ error: 'Unknown automation' }, { status: 404 })
  const url = new URL(request.url)
  const status = url.searchParams.get('status')
  let q = supabase
    .from('resort_automation_runs')
    .select('id, trigger, status, conversation_id, contact_id, booking_id, lead_id, detail, error, created_at')
    .eq('account_id', accountId)
    .eq('automation_key', key)
    .order('created_at', { ascending: false })
    .limit(100)
  if (status && ['success', 'failed', 'skipped', 'test'].includes(status)) q = q.eq('status', status)
  const { data, error } = await q
  if (error) return dbError('Could not load execution history', error)
  return NextResponse.json({ runs: data ?? [] })
})
