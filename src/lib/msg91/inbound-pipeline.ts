import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { loadOptedOutAt } from '@/lib/contacts/opt-out'
import { ACCOUNT_TTL_MS, cached, configCacheEnabled } from '@/lib/resort/config-cache'
import { dispatchInboundToResortBot, loadConversationState, prefetchResortBotConfig } from '@/lib/resort/bot/runtime'
import { findOrCreateContact, findOrCreateConversation } from '@/lib/whatsapp/inbound-webhook'
import type { ParsedInbound } from './inbound'
import { Msg91Provider } from './provider'
import { noopTrace, type Trace } from './trace'

type Inbound = Extract<ParsedInbound, { kind: 'inbound' }>

/** Past this, the bot run is reported as stuck in the logs (the work itself is not cancelled). */
export const BOT_PROCESSING_TIMEOUT_MS = 45_000

export type PipelineOutcome =
  | { status: 'processed'; conversationId: string; botConsumed: boolean; botSkipped?: string }
  | { status: 'duplicate' }
  | { status: 'opted_out'; conversationId: string }
  | { status: 'failed'; reason: string }

export interface AccountTarget {
  accountId: string
  ownerUserId: string
}

/** A guest message that is safely in the inbox and still needs a bot reply. */
export interface IngestedInbound {
  account: AccountTarget
  contact: { id: string; phone: string | null; name: string | null; opted_out_at?: string | null }
  conversation: { id: string; status?: string | null }
  messageId: string
  inbound: Inbound
  /** Bot state read started alongside the inbox write. */
  statePrefetch?: Promise<unknown>
  /** Opt-out read started alongside the inbox write, when the contact row did not include it. */
  optOutPrefetch?: Promise<string | null>
}

export type IngestOutcome = { status: 'saved'; ingested: IngestedInbound } | Exclude<PipelineOutcome, { status: 'processed' } | { status: 'opted_out' }>

/**
 * The MSG91 number belongs to one account. MSG91_ACCOUNT_ID pins it; otherwise
 * the account running the resort bot, otherwise the only account.
 */
async function lookupAccount(db: SupabaseClient): Promise<AccountTarget | null> {
  let accountId = process.env.MSG91_ACCOUNT_ID?.trim() || null
  if (!accountId) {
    const { data } = await db.from('property_settings').select('account_id').eq('bot_enabled', true).limit(2)
    if (data?.length === 1) accountId = data[0].account_id as string
  }
  const query = db.from('accounts').select('id, owner_user_id')
  const { data: accounts, error } = accountId ? await query.eq('id', accountId) : await query.limit(2)
  if (error) throw new Error(`Could not load account: ${error.message}`)
  if (!accounts || accounts.length !== 1) return null
  return { accountId: accounts[0].id as string, ownerUserId: accounts[0].owner_user_id as string }
}

const NO_ACCOUNT = 'no_account'

/** Cached once found; "no account" is not cached so a settings fix takes effect on the next message. */
export async function resolveMsg91Account(db: SupabaseClient): Promise<AccountTarget | null> {
  try {
    return await cached('msg91-account', ACCOUNT_TTL_MS, async () => {
      const account = await lookupAccount(db)
      if (!account) throw new Error(NO_ACCOUNT)
      return account
    })
  } catch (err) {
    if (err instanceof Error && err.message === NO_ACCOUNT) return null
    throw err
  }
}

/**
 * Step 1, before MSG91 gets its 200: put the guest message in the shared inbox.
 * Only the three round trips that make the message durable run here; when any
 * fails the webhook answers 5xx so MSG91 redelivers.
 */
/**
 * phone → contact + conversation ids for guests seen in the last hour,
 * so a back-and-forth conversation skips the 2–3 lookup round trips. Only ids
 * and the display name are kept: opt-out and closed status are re-checked on
 * every message (see `IngestedInbound.optOutPrefetch` and the guarded reopen).
 */
const IDENTITY_TTL_MS = 60 * 60_000
const identities = new Map<string, { contact: { id: string; phone: string | null; name: string | null }; conversationId: string; expires: number }>()

async function identify(accountId: string, ownerUserId: string, phone: string) {
  const key = `${accountId}:${phone}`
  const hit = configCacheEnabled() ? identities.get(key) : undefined
  if (hit && hit.expires > Date.now()) {
    // Status unknown: 'closed' makes the reopen run its guarded UPDATE … WHERE status = 'closed'.
    return { contact: hit.contact, conversation: { id: hit.conversationId, status: 'closed' }, wasCreated: false, cached: true }
  }
  const contactOutcome = await findOrCreateContact(accountId, ownerUserId, {
    phone,
    waUserId: null,
    waParentUserId: null,
    waUsername: null,
    name: '',
  })
  if (!contactOutcome) return 'contact' as const
  const contact = contactOutcome.contact
  const convResult = await findOrCreateConversation(accountId, ownerUserId, contact.id, contactOutcome.wasCreated)
  if (!convResult) return 'conversation' as const
  if (configCacheEnabled()) {
    identities.set(key, {
      contact: { id: contact.id, phone: contact.phone ?? null, name: contact.name ?? null },
      conversationId: convResult.conversation.id,
      expires: Date.now() + IDENTITY_TTL_MS,
    })
  }
  return { contact, conversation: convResult.conversation, wasCreated: contactOutcome.wasCreated, cached: false }
}

export function forgetMsg91Identities(): void {
  identities.clear()
}

export async function ingestMsg91Inbound(inbound: Inbound, trace: Trace = noopTrace): Promise<IngestOutcome> {
  const db = supabaseAdmin()
  const account = await resolveMsg91Account(db)
  if (!account) return { status: 'failed', reason: 'no_account (set MSG91_ACCOUNT_ID)' }
  const { accountId, ownerUserId } = account
  prefetchResortBotConfig(accountId)

  const identity = await identify(accountId, ownerUserId, inbound.customerNumber)
  if (typeof identity === 'string') return { status: 'failed', reason: identity }
  const { contact, conversation } = identity
  trace.mark('conversation_lookup_ms')
  trace.log('CUSTOMER_IDENTIFIED', { customer: inbound.customerNumber, contactId: contact.id, conversationId: conversation.id, newContact: identity.wasCreated, cached: identity.cached })

  const messageId = inbound.messageId ?? `msg91-in:${randomUUID()}`
  const statePrefetch = loadConversationState(db, conversation.id)
  statePrefetch.catch(() => {})
  const optOutPrefetch = 'opted_out_at' in contact ? undefined : loadOptedOutAt(db, accountId, contact.id)
  optOutPrefetch?.catch(() => {})
  const { data: inserted, error: msgError } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: 'text',
        content_text: inbound.text,
        message_id: messageId,
        status: 'delivered',
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
    )
    .select('id')
  if (msgError) {
    identities.delete(`${accountId}:${inbound.customerNumber}`)
    return { status: 'failed', reason: `message_insert: ${msgError.message}` }
  }
  if (!inserted || inserted.length === 0) {
    trace.log('MESSAGE_SAVED', { messageId, duplicate: true })
    return { status: 'duplicate' }
  }
  trace.mark('message_saved_ms')
  trace.log('MESSAGE_SAVED', { messageId, inboxMessageId: inserted[0]?.id })
  return { status: 'saved', ingested: { account, contact, conversation, messageId, inbound, statePrefetch, optOutPrefetch } }
}

/**
 * Step 2, after the webhook has answered: inbox bookkeeping and the bot reply
 * run side by side, so the reply never waits on the bookkeeping.
 */
export async function replyToMsg91Inbound(
  ingested: IngestedInbound,
  trace: Trace = noopTrace,
  opts: { bookkeeping?: boolean } = {},
): Promise<PipelineOutcome> {
  const db = supabaseAdmin()
  const { account, contact, conversation, messageId, inbound, statePrefetch, optOutPrefetch } = ingested
  const { accountId, ownerUserId } = account

  const bookkeeping = opts.bookkeeping === false ? Promise.resolve() : Promise.all([
    db.rpc('bump_conversation_on_inbound', {
      p_conversation_id: conversation.id,
      p_last_message_text: inbound.text,
    }) as unknown as Promise<{ error: { message: string } | null }>,
    reopenClosedConversation(db, conversation),
  ])
    .then(([bump]) => {
      if (bump.error) console.error('[msg91] conversation bump failed:', bump.error.message)
    })
    .catch((err) => console.error('[msg91] conversation bookkeeping failed:', err instanceof Error ? err.message : err))

  try {
    const optedOutAt = 'opted_out_at' in contact
      ? contact.opted_out_at
      : await (optOutPrefetch ?? loadOptedOutAt(db, accountId, contact.id))
    if (optedOutAt) {
      trace.log('BOT_SKIPPED', { reason: 'opted_out' })
      return { status: 'opted_out', conversationId: conversation.id }
    }

    const watchdog = setTimeout(
      () => trace.log('PROCESSING_FAILED', { stage: 'bot', reason: 'timeout', afterMs: BOT_PROCESSING_TIMEOUT_MS }),
      BOT_PROCESSING_TIMEOUT_MS,
    )
    try {
      const { consumed, skipped } = await dispatchInboundToResortBot({
        accountId,
        userId: ownerUserId,
        contactId: contact.id,
        conversationId: conversation.id,
        contact: { phone: contact.phone ?? inbound.customerNumber, name: contact.name ?? null },
        message: { text: inbound.text, replyId: inbound.replyId, messageId, unsupported: inbound.unsupported },
        provider: new Msg91Provider(
          db,
          { accountId, userId: ownerUserId, conversationId: conversation.id, contactId: contact.id },
          inbound.customerNumber,
          trace,
        ),
        trace,
        prefetchedState: statePrefetch,
      })
      return { status: 'processed', conversationId: conversation.id, botConsumed: consumed, ...(skipped ? { botSkipped: skipped } : {}) }
    } finally {
      clearTimeout(watchdog)
    }
  } finally {
    await bookkeeping
  }
}

/** Inbound MSG91 message → shared inbox → V-Farms resort bot, which replies through MSG91. */
export async function processMsg91Inbound(inbound: Inbound, trace: Trace = noopTrace): Promise<PipelineOutcome> {
  const ingest = await ingestMsg91Inbound(inbound, trace)
  if (ingest.status !== 'saved') return ingest
  return replyToMsg91Inbound(ingest.ingested, trace)
}
