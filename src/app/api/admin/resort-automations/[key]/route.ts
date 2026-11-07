import { NextResponse } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { adminRoute, dbError, parseBody } from '@/lib/resort/admin-http'
import {
  AUTOMATION_CONFIG_SCHEMAS,
  automationDefinition,
  isResortAutomationKey,
  parseAutomationConfig,
} from '@/lib/resort/automations/definitions'
import { AUTOMATION_ROW_COLUMNS } from '@/lib/resort/automations/store'
import { writeAudit } from '@/lib/resort/notify'

export const dynamic = 'force-dynamic'

const patchSchema = z
  .object({
    is_enabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((b) => b.is_enabled !== undefined || b.config !== undefined, 'Nothing to update')

/**
 * Enable / disable an automation or change its settings (admins only).
 * Written through the caller's RLS-scoped client, so the database also
 * enforces the admin role. The config is validated against the
 * automation's schema; unknown fields are rejected.
 */
export const PATCH = adminRoute<{ key: string }>('admin', async ({ supabase, accountId, userId }, request, { key }) => {
  if (!isResortAutomationKey(key)) return NextResponse.json({ error: 'Unknown automation' }, { status: 404 })
  const parsed = await parseBody(request, patchSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data
  const def = automationDefinition(key)

  if (body.is_enabled === false && def.required) {
    return NextResponse.json({ error: `${def.name} can't be turned off — guests must always be able to reach a person.` }, { status: 422 })
  }

  const { data: current, error: loadErr } = await supabase
    .from('resort_automations')
    .select(AUTOMATION_ROW_COLUMNS)
    .eq('account_id', accountId)
    .eq('key', key)
    .maybeSingle()
  if (loadErr) return dbError('Could not load the automation', loadErr)
  if (!current) return NextResponse.json({ error: 'Open the Automations page first to set up the resort automations.' }, { status: 404 })

  const update: Record<string, unknown> = { updated_by: userId }
  if (body.is_enabled !== undefined) update.is_enabled = body.is_enabled
  if (body.config !== undefined) {
    const schema = AUTOMATION_CONFIG_SCHEMAS[key].strict()
    const merged = { ...parseAutomationConfig(key, current.config), ...body.config }
    const result = schema.safeParse(merged)
    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
        { status: 422 },
      )
    }
    if (key === 'human_escalation') {
      const assignee = (result.data as unknown as { assign_to_user_id: string | null }).assign_to_user_id
      if (assignee) {
        const { data: member } = await supabase
          .from('profiles')
          .select('user_id')
          .eq('account_id', accountId)
          .eq('user_id', assignee)
          .in('account_role', ['owner', 'admin', 'agent'])
          .maybeSingle()
        if (!member) return NextResponse.json({ error: 'The assignee must be an owner, admin or agent on this account.' }, { status: 422 })
      }
    }
    update.config = result.data
  }

  const { data, error } = await supabase
    .from('resort_automations')
    .update(update)
    .eq('account_id', accountId)
    .eq('key', key)
    .select(AUTOMATION_ROW_COLUMNS)
    .maybeSingle()
  if (error) {
    if (error.code === '42501') return NextResponse.json({ error: 'Only admins can change automations.' }, { status: 403 })
    return dbError('Could not save the automation', error)
  }
  if (!data) return NextResponse.json({ error: 'Only admins can change automations.' }, { status: 403 })

  await writeAudit(supabaseAdmin(), {
    accountId,
    actorUserId: userId,
    action: body.is_enabled === undefined ? 'resort_automation.configured' : body.is_enabled ? 'resort_automation.enabled' : 'resort_automation.disabled',
    entityType: 'resort_automation',
    entityId: data.id,
    before: { is_enabled: current.is_enabled, config: current.config },
    after: { is_enabled: data.is_enabled, config: data.config },
  })
  return NextResponse.json({ automation: { ...data, config: parseAutomationConfig(key, data.config) } })
})
