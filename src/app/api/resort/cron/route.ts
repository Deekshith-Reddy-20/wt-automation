import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { reconcileMsg91Deliveries, type ReconcileResult } from '@/lib/msg91/delivery-reconcile'
import { recoverUnansweredMsg91Inbound, type RecoverySummary } from '@/lib/msg91/recovery'
import { scanAbandonedEnquiries } from '@/lib/resort/automations/scheduled'
import { loadAutomationSettings } from '@/lib/resort/automations/store'
import { processGuestJob, type GuestJobRow, type JobOutcome } from '@/lib/resort/guest-messages'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function authorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET?.trim() || process.env.AUTOMATION_CRON_SECRET?.trim()
  if (!expected) return false
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  const supplied = bearer || request.headers.get('x-cron-secret') || ''
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Resort housekeeping, run on a schedule (Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`):
 *   1. expire lapsed date holds (and their unpaid bookings);
 *   2. queue abandoned-enquiry follow-ups (automation K, when enabled);
 *   3. send due guest confirmations / reminders / follow-ups;
 *   4. answer any MSG91 guest message whose after-response bot run never happened;
 *   5. pull sent / delivered / read / failed for pending MSG91 replies from MSG91's log.
 */
async function run(request: Request) {
  if (!process.env.CRON_SECRET && !process.env.AUTOMATION_CRON_SECRET) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = supabaseAdmin()
  const started = Date.now()

  const { data: accounts, error: accErr } = await db.from('property_settings').select('account_id')
  if (accErr) return NextResponse.json({ error: accErr.message }, { status: 500 })
  let holdsExpired = 0
  let followUpsQueued = 0
  for (const a of accounts ?? []) {
    const { data, error } = await db.rpc('resort_expire_stale_holds', { p_account: a.account_id })
    if (error) console.error('[resort-cron] hold expiry failed:', error.message)
    else holdsExpired += Number(data ?? 0)
    const automations = await loadAutomationSettings(db, a.account_id)
    followUpsQueued += await scanAbandonedEnquiries(db, a.account_id, automations)
  }

  const outcomes: Record<JobOutcome, number> = { sent: 0, simulated: 0, skipped: 0, cancelled: 0, retry: 0, failed: 0 }
  for (let batch = 0; batch < 4 && Date.now() - started < 45_000; batch++) {
    const { data: jobs, error } = await db.rpc('resort_claim_notification_jobs', { p_limit: 25 })
    if (error) {
      console.error('[resort-cron] claim failed:', error.message)
      break
    }
    if (!jobs || jobs.length === 0) break
    for (const job of jobs as GuestJobRow[]) {
      outcomes[await processGuestJob(db, job)]++
    }
  }

  let inboundRecovery: RecoverySummary | { error: string }
  try {
    inboundRecovery = await recoverUnansweredMsg91Inbound(db)
  } catch (err) {
    console.error('[resort-cron] inbound recovery failed:', err instanceof Error ? err.message : err)
    inboundRecovery = { error: 'inbound recovery failed' }
  }

  let deliveryReconcile: ReconcileResult | { error: string }
  try {
    deliveryReconcile = await reconcileMsg91Deliveries(db)
  } catch (err) {
    console.error('[resort-cron] delivery reconcile failed:', err instanceof Error ? err.message : err)
    deliveryReconcile = { error: 'delivery reconcile failed' }
  }

  return NextResponse.json({
    holds_expired: holdsExpired,
    follow_ups_queued: followUpsQueued,
    messages: outcomes,
    inbound_recovery: inboundRecovery,
    delivery_reconcile: 'error' in deliveryReconcile ? deliveryReconcile : { checked: deliveryReconcile.checked, updated: deliveryReconcile.updated, still_queued: deliveryReconcile.stillQueued.length },
  })
}

export const GET = run
export const POST = run
