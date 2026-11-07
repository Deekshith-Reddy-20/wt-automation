import { beforeEach, describe, expect, it, vi } from 'vitest'

const reply = vi.fn(async () => ({ status: 'processed', conversationId: 'conv', botConsumed: true }))
vi.mock('./inbound-pipeline', () => ({
  resolveMsg91Account: async () => ({ accountId: 'acc', ownerUserId: 'owner' }),
  replyToMsg91Inbound: (...a: unknown[]) => reply(...(a as [])),
}))

const { recoverUnansweredMsg91Inbound } = await import('./recovery')

type Row = Record<string, unknown>
let recent: Row[] = []
let latest: Record<string, Row> = {}
let states: Record<string, Row | null> = {}

/** Minimal Supabase stand-in: each table resolves to the data the test set up. */
function db() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {}
      const q: Record<string, unknown> = {}
      const chain = () => q
      const result = () => {
        const id = filters.conversation_id as string
        if (table === 'messages') return filters.conversation_id ? { data: latest[id] ? [latest[id]] : [], error: null } : { data: recent, error: null }
        return { data: null, error: null }
      }
      Object.assign(q, {
        select: chain,
        gte: chain,
        lte: chain,
        order: chain,
        eq: (k: string, v: unknown) => ((filters[k] = v), q),
        limit: async () => result(),
        maybeSingle: async () => {
          if (table === 'conversation_states') return { data: states[filters.conversation_id as string] ?? null, error: null }
          if (table === 'conversations') return { data: { id: filters.id, status: 'open', contact_id: 'ct' }, error: null }
          if (table === 'contacts') return { data: { id: 'ct', phone: '+91 63007 29913', name: null, opted_out_at: null }, error: null }
          return { data: null, error: null }
        },
      })
      return q
    },
  } as never
}

const msg = (conversation_id: string, message_id: string, content_text = 'Hi') => ({ conversation_id, message_id, content_text, created_at: '2026-11-07T10:00:00Z' })

beforeEach(() => {
  reply.mockClear()
  vi.stubEnv('MSG91_AUTHKEY', 'k')
  recent = []
  latest = {}
  states = {}
})

describe('MSG91 inbound recovery sweep', () => {
  it('answers a saved guest message that never got a bot run', async () => {
    recent = [msg('c1', 'm1')]
    latest = { c1: { message_id: 'm1', sender_type: 'customer' } }
    const s = await recoverUnansweredMsg91Inbound(db())
    expect(s).toMatchObject({ checked: 1, recovered: 1, outcomes: { processed: 1 } })
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'm1', inbound: expect.objectContaining({ customerNumber: '916300729913', text: 'Hi', unsupported: null }) }),
      expect.anything(),
      { bookkeeping: false },
    )
  })

  it('skips a message the bot already processed', async () => {
    recent = [msg('c1', 'm1')]
    latest = { c1: { message_id: 'm1', sender_type: 'customer' } }
    states = { c1: { bot_mode: 'bot', last_processed_message_id: 'm1' } }
    expect((await recoverUnansweredMsg91Inbound(db())).recovered).toBe(0)
    expect(reply).not.toHaveBeenCalled()
  })

  it('stays silent when staff have taken over', async () => {
    recent = [msg('c1', 'm1')]
    latest = { c1: { message_id: 'm1', sender_type: 'customer' } }
    states = { c1: { bot_mode: 'human', last_processed_message_id: null } }
    await recoverUnansweredMsg91Inbound(db())
    expect(reply).not.toHaveBeenCalled()
  })

  it('skips a conversation that someone has already replied to', async () => {
    recent = [msg('c1', 'm1')]
    latest = { c1: { message_id: 'out-1', sender_type: 'agent' } }
    await recoverUnansweredMsg91Inbound(db())
    expect(reply).not.toHaveBeenCalled()
  })

  it('handles only the latest guest message per conversation', async () => {
    recent = [msg('c1', 'm2', 'MENU'), msg('c1', 'm1')]
    latest = { c1: { message_id: 'm2', sender_type: 'customer' } }
    await recoverUnansweredMsg91Inbound(db())
    expect(reply).toHaveBeenCalledTimes(1)
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm2' }), expect.anything(), expect.anything())
  })

  it('restores the unsupported-media flag from the stored placeholder', async () => {
    recent = [msg('c1', 'm1', '[image]')]
    latest = { c1: { message_id: 'm1', sender_type: 'customer' } }
    await recoverUnansweredMsg91Inbound(db())
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ inbound: expect.objectContaining({ unsupported: 'image' }) }), expect.anything(), expect.anything())
  })

  it('does nothing when MSG91 is not configured', async () => {
    vi.stubEnv('MSG91_AUTHKEY', '')
    expect(await recoverUnansweredMsg91Inbound(db())).toEqual({ checked: 0, recovered: 0, outcomes: {} })
  })
})
