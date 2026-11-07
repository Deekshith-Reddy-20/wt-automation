import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { adminRoute, dbError, parseBody } from '@/lib/resort/admin-http'
import { conversationModeSchema } from '@/lib/resort/admin-schemas'
import { botActivity, type ActivityMessage, type BotActivity } from '@/lib/resort/bot/activity'
import { resumeBotMode, setHumanMode } from '@/lib/resort/bot/mode'
import { writeAudit } from '@/lib/resort/notify'
import { reconcileMsg91Deliveries } from '@/lib/msg91/delivery-reconcile'

export const dynamic = 'force-dynamic'

/** One MSG91 log lookup per conversation per window, however many inbox tabs poll. */
const RECONCILE_EVERY_MS = 10_000
const lastReconcile = new Map<string, number>()
function claimReconcile(conversationId: string): boolean {
  const now = Date.now()
  if ((lastReconcile.get(conversationId) ?? 0) > now - RECONCILE_EVERY_MS) return false
  lastReconcile.set(conversationId, now)
  if (lastReconcile.size > 500) lastReconcile.clear()
  return true
}

/** Current resort-bot mode for a conversation; `enabled` is false when the account has no resort bot. */
export const GET = adminRoute<{ id: string }>('viewer', async ({ supabase, accountId }, _request, { id }) => {
  const [{ data: settings }, { data: state, error }, { data: conv }] = await Promise.all([
    supabase.from('property_settings').select('bot_enabled').eq('account_id', accountId).maybeSingle(),
    supabase
      .from('conversation_states')
      .select('bot_mode, handoff_reason')
      .eq('account_id', accountId)
      .eq('conversation_id', id)
      .maybeSingle(),
    supabase.from('conversations').select('id').eq('account_id', accountId).eq('id', id).maybeSingle(),
  ])
  if (error) return dbError('Failed to load conversation state', error)

  let activity: BotActivity | null = null
  if (conv && state?.bot_mode === 'bot') {
    const loadActivity = async () => {
      const { data: recent } = await supabase
        .from('messages')
        .select('sender_type, status, content_text, created_at')
        .eq('conversation_id', id)
        .order('created_at', { ascending: false })
        .limit(20)
      return botActivity((recent ?? []) as ActivityMessage[])
    }
    activity = await loadActivity()
    if ((activity.state === 'accepted' || activity.state === 'sent') && claimReconcile(id)) {
      const result = await reconcileMsg91Deliveries(supabaseAdmin(), { conversationId: id, limit: 20, timeoutMs: 4000 }).catch(
        (err) => {
          console.error('[msg91] delivery reconcile failed:', err instanceof Error ? err.message : err)
          return null
        },
      )
      if (result?.updated) activity = await loadActivity()
    }
  }
  return NextResponse.json({
    enabled: Boolean(settings?.bot_enabled),
    mode: state?.bot_mode ?? null,
    handoff_reason: state?.handoff_reason ?? null,
    activity,
  })
})

/**
 * Take over a conversation from the bot, or hand it back. `id` is the
 * conversation id. Only reservation managers and above; the bot stays
 * silent in human mode until someone resumes it here.
 */
export const POST = adminRoute<{ id: string }>('agent', async ({ supabase, accountId, userId }, request, { id }) => {
  const parsed = await parseBody(request, conversationModeSchema)
  if (!parsed.ok) return parsed.response

  const { data: conv, error } = await supabase
    .from('conversations')
    .select('id, contact_id')
    .eq('account_id', accountId)
    .eq('id', id)
    .maybeSingle()
  if (error) return dbError('Failed to load conversation', error)
  if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

  const admin = supabaseAdmin()
  if (parsed.data.mode === 'human') {
    await setHumanMode(admin, {
      accountId,
      conversationId: id,
      contactId: conv.contact_id,
      userId,
      reason: parsed.data.reason ?? 'staff_takeover',
    })
  } else {
    const resumed = await resumeBotMode(admin, { accountId, conversationId: id, userId })
    if (!resumed) return NextResponse.json({ error: 'The bot has not handled this conversation yet.' }, { status: 404 })
  }
  await writeAudit(admin, {
    accountId,
    actorUserId: userId,
    action: parsed.data.mode === 'human' ? 'conversation.takeover' : 'conversation.bot_resumed',
    entityType: 'conversation',
    entityId: id,
  })
  return NextResponse.json({ ok: true, mode: parsed.data.mode })
})
