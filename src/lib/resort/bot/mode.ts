import type { SupabaseClient } from '@supabase/supabase-js'
import { applyResortTags } from '../tags'

/** Staff took over (manual reply or "Take over"): silence the bot for this conversation. */
export async function setHumanMode(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; contactId: string; userId: string | null; reason: string },
): Promise<void> {
  const now = new Date().toISOString()
  const { data } = await db
    .from('conversation_states')
    .update({ bot_mode: 'human', handoff_at: now, handoff_reason: args.reason, handed_off_by: args.userId })
    .eq('conversation_id', args.conversationId)
    .eq('account_id', args.accountId)
    .select('id')
  if (data && data.length > 0) return
  await db.from('conversation_states').insert({
    account_id: args.accountId,
    conversation_id: args.conversationId,
    contact_id: args.contactId,
    bot_mode: 'human',
    flow: 'human',
    step: 'waiting',
    handoff_at: now,
    handoff_reason: args.reason,
    handed_off_by: args.userId,
  })
}

/** An authorised user returns the conversation to the bot, starting from the main menu. */
export async function resumeBotMode(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; userId: string },
): Promise<boolean> {
  const { data, error } = await db
    .from('conversation_states')
    .update({
      bot_mode: 'bot',
      flow: 'menu',
      step: 'start',
      data: {},
      history: [],
      resumed_at: new Date().toISOString(),
      resumed_by: args.userId,
    })
    .eq('conversation_id', args.conversationId)
    .eq('account_id', args.accountId)
    .select('id, contact_id')
  if (error) throw new Error(error.message)
  const row = (data ?? [])[0] as { contact_id?: string } | undefined
  if (row?.contact_id) await applyResortTags(db, args.accountId, row.contact_id, { remove: ['needs_human'] })
  return Boolean(row)
}
