import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { adminRoute, dbError } from '@/lib/resort/admin-http'
import { writeAudit } from '@/lib/resort/notify'

export const dynamic = 'force-dynamic'

/**
 * Re-queue a failed or skipped guest message. The cron re-checks
 * opt-out, booking status and the 24-hour window before sending, so a
 * retry can never message a guest who has since said STOP.
 */
export const POST = adminRoute<{ id: string }>('agent', async ({ accountId, userId }, _req, { id }) => {
  const admin = supabaseAdmin()
  const { data, error } = await admin
    .from('notification_jobs')
    .update({ status: 'pending', attempts: 0, last_error: null, locked_at: null, scheduled_for: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('id', id)
    .eq('channel', 'whatsapp')
    .in('status', ['failed', 'skipped'])
    .select('id')
    .maybeSingle()
  if (error) return dbError('Failed to retry', error)
  if (!data) return NextResponse.json({ error: 'Only failed or skipped messages can be retried.' }, { status: 404 })
  await writeAudit(admin, {
    accountId,
    actorUserId: userId,
    action: 'notification.retry',
    entityType: 'notification_job',
    entityId: id,
  })
  return NextResponse.json({ ok: true })
})
