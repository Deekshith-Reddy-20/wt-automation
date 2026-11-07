import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }))

const { HUMAN_QUIET_MS, resumeQuietHandoff } = await import('./runtime')

const now = new Date('2026-11-07T15:00:00Z')
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString()

function row(over: Record<string, unknown>) {
  return {
    id: 's1', flow: 'human', step: 'waiting', data: {}, history: [], bot_mode: 'human',
    handoff_at: minutesAgo(1), handoff_reason: 'guest_requested', handed_off_by: null,
    last_inbound_at: null, last_processed_message_id: null, version: 3, ...over,
  } as never
}

function db() {
  const updates: unknown[] = []
  const q = {
    update: (v: unknown) => (updates.push(v), q),
    eq: () => q,
    select: async () => ({ data: [{ id: 's1', bot_mode: 'bot', flow: 'menu', step: 'start', version: 4 }], error: null }),
  }
  return { client: { from: () => q } as never, updates }
}

const hi = { text: 'Hi', replyId: null, messageId: 'm1' }

describe('resumeQuietHandoff — Hi / MENU after a handoff', () => {
  it.each(['guest_requested', 'location_not_configured'])('returns to the bot at once when the bot handed off (%s)', async (reason) => {
    const { client, updates } = db()
    const resumed = await resumeQuietHandoff(client, row({ handoff_reason: reason }), hi, now)
    expect(resumed).toMatchObject({ bot_mode: 'bot', flow: 'menu' })
    expect(updates).toHaveLength(1)
  })

  it.each([
    { handoff_reason: 'agent_replied' },
    { handoff_reason: 'staff_takeover', handed_off_by: 'u1' },
    { handoff_reason: 'vip_guest', handed_off_by: 'u1' },
  ])('stays with staff who took over or replied recently (%o)', async (over) => {
    const { client, updates } = db()
    expect(await resumeQuietHandoff(client, row(over), hi, now)).toBeNull()
    expect(updates).toHaveLength(0)
  })

  it('returns to the bot once staff have been quiet long enough', async () => {
    const { client } = db()
    const quiet = row({ handoff_reason: 'agent_replied', handoff_at: minutesAgo(HUMAN_QUIET_MS / 60_000 + 1) })
    expect(await resumeQuietHandoff(client, quiet, hi, now)).toMatchObject({ bot_mode: 'bot' })
  })

  it('ignores anything that is not a greeting or MENU', async () => {
    const { client } = db()
    expect(await resumeQuietHandoff(client, row({}), { text: 'what is the price', replyId: null, messageId: 'm2' }, now)).toBeNull()
  })
})
