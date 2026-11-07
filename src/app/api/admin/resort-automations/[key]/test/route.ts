import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { adminRoute, parseBody } from '@/lib/resort/admin-http'
import { isResortAutomationKey } from '@/lib/resort/automations/definitions'
import { previewAutomation, previewInputSchema } from '@/lib/resort/automations/preview'
import { loadAutomationSettings, recordAutomationRun } from '@/lib/resort/automations/store'

export const dynamic = 'force-dynamic'

/**
 * Run Test: a read-only preview. It never sends a WhatsApp message,
 * creates an enquiry / hold / booking, or changes any setting. The run is
 * logged as "test" and does not count towards the execution counters.
 */
export const POST = adminRoute<{ key: string }>('agent', async ({ accountId, userId }, request, { key }) => {
  if (!isResortAutomationKey(key)) return NextResponse.json({ error: 'Unknown automation' }, { status: 404 })
  const parsed = await parseBody(request, previewInputSchema)
  if (!parsed.ok) return parsed.response
  const db = supabaseAdmin()
  const automations = await loadAutomationSettings(db, accountId)
  const preview = await previewAutomation(db, accountId, key, automations, parsed.data)
  await recordAutomationRun(db, {
    accountId,
    key,
    trigger: 'manual_test',
    status: 'test',
    detail: { by: userId, checks_passed: preview.checks.filter((c) => c.ok).length, checks_total: preview.checks.length },
  })
  return NextResponse.json(preview)
})
