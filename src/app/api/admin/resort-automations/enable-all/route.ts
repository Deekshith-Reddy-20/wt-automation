import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { adminRoute, dbError } from '@/lib/resort/admin-http'
import { ensureResortAutomations } from '@/lib/resort/automations/store'
import { writeAudit } from '@/lib/resort/notify'

export const dynamic = 'force-dynamic'

/**
 * "Turn all on" (admins only): create any missing resort automation rows,
 * enable every one, and switch the WhatsApp bot on. Test mode is left as it
 * is (on by default), so replies only reach the staff test numbers until an
 * admin turns test mode off. Writes go through the caller's RLS-scoped client.
 */
export const POST = adminRoute('admin', async ({ supabase, accountId, userId }) => {
  await ensureResortAutomations(supabase, accountId)

  const { data: enabled, error } = await supabase
    .from('resort_automations')
    .update({ is_enabled: true, updated_by: userId })
    .eq('account_id', accountId)
    .select('key')
  if (error) {
    if (error.code === '42501') return NextResponse.json({ error: 'Only admins can change automations.' }, { status: 403 })
    return dbError('Could not enable the automations', error)
  }

  const { data: settings, error: setErr } = await supabase
    .from('property_settings')
    .upsert({ account_id: accountId, bot_enabled: true, updated_by: userId }, { onConflict: 'account_id' })
    .select('bot_enabled, test_mode')
    .single()
  if (setErr) return dbError('Automations are on, but the bot could not be switched on', setErr)

  await writeAudit(supabaseAdmin(), {
    accountId,
    actorUserId: userId,
    action: 'resort_automation.enabled_all',
    entityType: 'resort_automation',
    entityId: null,
    after: { keys: (enabled ?? []).map((r) => r.key), bot_enabled: true, test_mode: settings.test_mode },
  })
  return NextResponse.json({ enabled: (enabled ?? []).length, bot_enabled: settings.bot_enabled, test_mode: settings.test_mode })
})
