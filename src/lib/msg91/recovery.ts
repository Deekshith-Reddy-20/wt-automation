import type { SupabaseClient } from '@supabase/supabase-js'
import { replyToMsg91Inbound, resolveMsg91Account, type PipelineOutcome } from './inbound-pipeline'
import { createTrace } from './trace'

/** Younger messages may still be in their after() run (the bot watchdog is 45s). */
export const RECOVERY_MIN_AGE_MS = 2 * 60_000
/** Older than this a late automated reply would confuse more than help; staff handle it from the inbox. */
export const RECOVERY_MAX_AGE_MS = 30 * 60_000
const BATCH = 25

interface PendingRow {
  conversation_id: string
  message_id: string
  content_text: string | null
  created_at: string
}

export interface RecoverySummary {
  checked: number
  recovered: number
  outcomes: Record<string, number>
}

/**
 * Safety net for the after-response reply: a guest message that reached the
 * inbox but never got a bot run (instance recycled, crash, deploy) is handed
 * to the bot once from the resort cron. Safe to repeat: the bot ignores a
 * message it already processed, stays silent in human mode, and only the
 * latest message of a conversation is considered — never one staff or the
 * bot has already answered.
 */
export async function recoverUnansweredMsg91Inbound(db: SupabaseClient, now = new Date()): Promise<RecoverySummary> {
  const summary: RecoverySummary = { checked: 0, recovered: 0, outcomes: {} }
  if (!process.env.MSG91_AUTHKEY?.trim()) return summary
  const account = await resolveMsg91Account(db)
  if (!account) return summary

  const { data: recent, error } = await db
    .from('messages')
    .select('conversation_id, message_id, content_text, created_at, conversations!inner(account_id)')
    .eq('conversations.account_id', account.accountId)
    .eq('sender_type', 'customer')
    .gte('created_at', new Date(now.getTime() - RECOVERY_MAX_AGE_MS).toISOString())
    .lte('created_at', new Date(now.getTime() - RECOVERY_MIN_AGE_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(BATCH * 4)
  if (error) throw new Error(`Recovery scan failed: ${error.message}`)

  const latestPerConversation = new Map<string, PendingRow>()
  for (const row of (recent ?? []) as PendingRow[]) {
    if (!latestPerConversation.has(row.conversation_id)) latestPerConversation.set(row.conversation_id, row)
  }

  for (const pending of [...latestPerConversation.values()].slice(0, BATCH)) {
    summary.checked++
    const outcome = await recoverOne(db, account, pending)
    if (!outcome) continue
    summary.recovered++
    summary.outcomes[outcome.status] = (summary.outcomes[outcome.status] ?? 0) + 1
  }
  return summary
}

async function recoverOne(
  db: SupabaseClient,
  account: { accountId: string; ownerUserId: string },
  pending: PendingRow,
): Promise<PipelineOutcome | null> {
  const [{ data: latest }, { data: state }, { data: conversation }] = await Promise.all([
    db.from('messages').select('message_id, sender_type').eq('conversation_id', pending.conversation_id).order('created_at', { ascending: false }).limit(1),
    db.from('conversation_states').select('bot_mode, last_processed_message_id').eq('conversation_id', pending.conversation_id).maybeSingle(),
    db.from('conversations').select('id, status, contact_id').eq('id', pending.conversation_id).maybeSingle(),
  ])
  const last = (latest as { message_id: string; sender_type: string }[] | null)?.[0]
  if (!last || last.message_id !== pending.message_id || last.sender_type !== 'customer') return null
  const st = state as { bot_mode: string; last_processed_message_id: string | null } | null
  if (st?.bot_mode === 'human' || st?.last_processed_message_id === pending.message_id) return null
  const conv = conversation as { id: string; status: string | null; contact_id: string } | null
  if (!conv) return null

  const { data: contact } = await db.from('contacts').select('*').eq('id', conv.contact_id).maybeSingle()
  const c = contact as { id: string; phone: string | null; name: string | null; opted_out_at?: string | null } | null
  if (!c?.phone) return null

  const text = pending.content_text ?? ''
  const unsupported = /^\[(\w+)\]$/.exec(text)?.[1] ?? null
  const trace = createTrace()
  trace.log('BOT_PROCESSING_STARTED', { recovery: true, conversationId: conv.id, messageId: pending.message_id })
  try {
    const outcome = await replyToMsg91Inbound(
      {
        account,
        contact: c,
        conversation: { id: conv.id, status: conv.status },
        messageId: pending.message_id,
        inbound: {
          kind: 'inbound',
          customerNumber: c.phone.replace(/\D/g, ''),
          text,
          buttonText: null,
          replyId: null,
          requestId: null,
          messageId: pending.message_id,
          unsupported,
        },
      },
      trace,
      { bookkeeping: false },
    )
    console.log(JSON.stringify({ msg91: 'OUTCOME', cid: trace.cid, recovery: true, ...outcome }))
    return outcome
  } catch (err) {
    trace.log('PROCESSING_FAILED', { stage: 'recovery', error: err instanceof Error ? err.message : String(err) })
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
}
