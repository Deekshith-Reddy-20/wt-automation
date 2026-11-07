import { beforeEach, describe, expect, it, vi } from 'vitest'

const stored = new Set<string>()
const dispatch = vi.fn(async () => ({ consumed: true }))
let optedOut = false

function query(table: string) {
  const q: Record<string, unknown> = {}
  const chain = () => q
  Object.assign(q, {
    then: (resolve: (v: unknown) => void) => resolve({ data: [{ id: 'acc', owner_user_id: 'owner' }], error: null }),
    select: chain,
    eq: chain,
    limit: async () =>
      table === 'property_settings'
        ? { data: [{ account_id: 'acc' }], error: null }
        : { data: [{ id: 'acc', owner_user_id: 'owner' }], error: null },
    upsert: (row: { conversation_id: string; message_id: string }) => ({
      select: async () => {
        const key = `${row.conversation_id}:${row.message_id}`
        if (stored.has(key)) return { data: [], error: null }
        stored.add(key)
        return { data: [{ id: `m${stored.size}` }], error: null }
      },
    }),
  })
  return q
}

let rpc: () => Promise<{ error: null }> = async () => ({ error: null })
let contactRow: Record<string, unknown> = { id: 'ct', phone: '916300729913', name: null }
const loadOptedOutAt = vi.fn(async () => (optedOut ? '2026-11-01' : null))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ from: query, rpc: () => rpc() }),
}))
const findOrCreateContact = vi.fn(async () => ({ contact: contactRow, wasCreated: false }))
const reopen = vi.fn<(db: unknown, conv: { id: string; status?: string | null }) => Promise<boolean>>(async () => false)
vi.mock('@/lib/whatsapp/inbound-webhook', () => ({
  findOrCreateContact: () => findOrCreateContact(),
  findOrCreateConversation: async () => ({ conversation: { id: 'conv', status: 'open' } }),
}))
vi.mock('@/lib/conversations/reopen', () => ({ reopenClosedConversation: (db: unknown, c: { id: string }) => reopen(db, c) }))
vi.mock('@/lib/contacts/opt-out', () => ({ loadOptedOutAt: () => loadOptedOutAt() }))
vi.mock('@/lib/resort/bot/runtime', () => ({
  dispatchInboundToResortBot: (...a: unknown[]) => dispatch(...(a as [])),
  loadConversationState: async () => null,
  prefetchResortBotConfig: () => {},
}))

const { forgetMsg91Identities, ingestMsg91Inbound, processMsg91Inbound } = await import('./inbound-pipeline')

const msg = (messageId: string | null, text = 'Hi') => ({
  kind: 'inbound' as const,
  customerNumber: '916300729913',
  text,
  buttonText: null,
  replyId: null,
  requestId: null,
  messageId,
  unsupported: null,
})

beforeEach(() => {
  stored.clear()
  dispatch.mockClear()
  optedOut = false
  rpc = async () => ({ error: null })
  contactRow = { id: 'ct', phone: '916300729913', name: null }
  loadOptedOutAt.mockClear()
  findOrCreateContact.mockClear()
  reopen.mockClear()
  forgetMsg91Identities()
  vi.stubEnv('MSG91_ACCOUNT_ID', '')
  vi.stubEnv('RESORT_CONFIG_CACHE', '')
})

describe('MSG91 inbound pipeline (simulated, no network)', () => {
  it('a repeated webhook for the same message is stored once and answered once', async () => {
    const first = await processMsg91Inbound(msg('uuid-1'))
    const retry = await processMsg91Inbound(msg('uuid-1'))
    expect(first).toMatchObject({ status: 'processed', botConsumed: true })
    expect(retry).toEqual({ status: 'duplicate' })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('concurrent duplicate deliveries run the bot once', async () => {
    const results = await Promise.all([processMsg91Inbound(msg('uuid-2')), processMsg91Inbound(msg('uuid-2'))])
    expect(results.filter((r) => r.status === 'duplicate')).toHaveLength(1)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('passes the tapped button id to the single resort bot', async () => {
    await processMsg91Inbound({ ...msg('uuid-3', 'Stay booking'), replyId: 'm_stay' })
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ message: { text: 'Stay booking', replyId: 'm_stay', messageId: 'uuid-3', unsupported: null } }),
    )
  })

  it('two guests messaging at the same time each get their own run', async () => {
    const [a, b] = await Promise.all([processMsg91Inbound(msg('uuid-a', 'Hi')), processMsg91Inbound(msg('uuid-b', 'Hello'))])
    expect(a.status).toBe('processed')
    expect(b.status).toBe('processed')
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('several quick messages from one guest are each stored and handed to the bot in turn', async () => {
    for (const [id, text] of [['q1', 'Hi'], ['q2', 'MENU'], ['q3', '1']]) await processMsg91Inbound(msg(id, text))
    expect(dispatch.mock.calls.map((c) => (c as unknown as [{ message: { text: string } }])[0].message.text)).toEqual(['Hi', 'MENU', '1'])
  })

  it('logs each stage under one correlation id', async () => {
    const stages: string[] = []
    const marks: string[] = []
    await processMsg91Inbound(msg('uuid-t'), { cid: 'c1', log: (s) => stages.push(s), mark: (m) => marks.push(m), timings: () => ({}) })
    expect(stages).toEqual(['CUSTOMER_IDENTIFIED', 'MESSAGE_SAVED'])
    expect(marks).toEqual(['conversation_lookup_ms', 'message_saved_ms'])
  })

  it('hands the bot the state read that ran alongside the inbox write', async () => {
    await processMsg91Inbound(msg('uuid-p'))
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ prefetchedState: expect.any(Promise) }))
  })

  it('ingest only stores the message; the bot runs in the reply step', async () => {
    const r = await ingestMsg91Inbound(msg('uuid-i'))
    expect(r).toMatchObject({ status: 'saved', ingested: { messageId: 'uuid-i', conversation: { id: 'conv' } } })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('the bot reply does not wait for inbox bookkeeping', async () => {
    let release!: () => void
    rpc = () => new Promise((r) => (release = () => r({ error: null })))
    const run = processMsg91Inbound(msg('uuid-slow'))
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    release()
    await expect(run).resolves.toMatchObject({ status: 'processed' })
  })

  it('reads opt-out from the contact row it already has, without another query', async () => {
    contactRow = { ...contactRow, opted_out_at: '2026-11-01T00:00:00Z' }
    const r = await processMsg91Inbound(msg('uuid-o'))
    expect(r.status).toBe('opted_out')
    expect(loadOptedOutAt).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('reports why the bot stayed silent', async () => {
    dispatch.mockResolvedValueOnce({ consumed: true, skipped: 'human_mode' } as never)
    const r = await processMsg91Inbound(msg('uuid-h'))
    expect(r).toMatchObject({ status: 'processed', botSkipped: 'human_mode' })
  })

  it('does not run the bot for a guest who opted out', async () => {
    optedOut = true
    const r = await processMsg91Inbound(msg('uuid-4'))
    expect(r.status).toBe('opted_out')
    expect(dispatch).not.toHaveBeenCalled()
  })

  describe('returning guest within a few minutes (identity cache on)', () => {
    beforeEach(() => vi.stubEnv('RESORT_CONFIG_CACHE', 'on'))

    it('skips the contact/conversation lookup for the next message', async () => {
      await processMsg91Inbound(msg('c1', 'Hi'))
      await processMsg91Inbound(msg('c2', 'MENU'))
      expect(findOrCreateContact).toHaveBeenCalledTimes(1)
      expect(dispatch).toHaveBeenCalledTimes(2)
      expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: 'conv', contactId: 'ct' }))
    })

    it('still honours an opt-out made after the first message', async () => {
      await processMsg91Inbound(msg('c3', 'Hi'))
      optedOut = true
      const r = await processMsg91Inbound(msg('c4', 'MENU'))
      expect(r.status).toBe('opted_out')
      expect(loadOptedOutAt).toHaveBeenCalledTimes(2)
      expect(dispatch).toHaveBeenCalledTimes(1)
    })

    it('still re-opens a conversation staff closed in between (guarded update)', async () => {
      await processMsg91Inbound(msg('c5', 'Hi'))
      await processMsg91Inbound(msg('c6', 'MENU'))
      expect(reopen.mock.calls.map((c) => c[1].status)).toEqual(['open', 'closed'])
    })
  })
})
