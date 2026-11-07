import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { adminRoute } from '@/lib/resort/admin-http'
import { RESORT_AUTOMATIONS, parseAutomationConfig } from '@/lib/resort/automations/definitions'
import { ensureResortAutomations } from '@/lib/resort/automations/store'
import { classifyDbError } from '@/lib/resort/db-errors'

export const dynamic = 'force-dynamic'

/**
 * The V-Farms automations (A–M) for this account. Missing registry rows
 * are created disabled (server-side, after the role check) so the page
 * always shows the full set with real persisted counters.
 */
export const GET = adminRoute('viewer', async ({ accountId }) => {
  let rows
  try {
    rows = await ensureResortAutomations(supabaseAdmin(), accountId)
  } catch (err) {
    console.error('[resort-automations] list failed:', err instanceof Error ? err.message : err)
    const problem = classifyDbError(err)
    return NextResponse.json(
      { error: problem.message || 'Could not load resort automations.', code: problem.code, missing: problem.missing },
      { status: problem.status },
    )
  }
  const automations = rows.flatMap((row) => {
    const def = RESORT_AUTOMATIONS.find((d) => d.key === row.key)
    if (!def) return []
    return {
      ...row,
      config: parseAutomationConfig(row.key, row.config),
      letter: def.letter,
      flow_number: def.flow_number,
      name: def.name,
      description: def.description,
      trigger_label: def.trigger_label,
      kind: def.kind,
      required: Boolean(def.required),
      proactive: Boolean(def.proactive),
      is_enabled: def.required ? true : row.is_enabled,
    }
  })
  return NextResponse.json({ automations })
})
