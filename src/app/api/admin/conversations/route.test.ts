import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Inbox API: searching by guest name, phone or booking reference, the
 * latest booking per conversation, and a truthful WhatsApp mode.
 */
const h = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: [] as [string, string, unknown[]][],
  dryRun: false,
}))

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return {
    ...actual,
    requireRole: vi.fn(async () => ({
      accountId: 'acc',
      userId: 'u1',
      role: 'agent',
      supabase: {
        from: (table: string) => {
          const q: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'order', 'limit', 'or', 'ilike', 'not', 'in', 'maybeSingle']) {
            q[m] = (...args: unknown[]) => {
              h.calls.push([table, m, args])
              return q
            }
          }
          q.then = (resolve: (r: unknown) => unknown) => Promise.resolve(resolve({ data: h.data[table] ?? null, error: null }))
          return q
        },
      },
    })),
  }
})
vi.mock('@/lib/resort/bot/provider', () => ({ dryRunForced: () => h.dryRun }))

const { GET } = await import('./route')

const get = async (qs = '') => (await GET(new Request(`http://localhost/api/admin/conversations${qs}`))).json()
const callsOn = (table: string, method: string) => h.calls.filter(([t, m]) => t === table && m === method).map(([, , a]) => a)

describe('GET /api/admin/conversations', () => {
  beforeEach(() => {
    h.data = {}
    h.calls = []
    h.dryRun = false
  })

  it('defaults to the human-handoff queue and attaches the latest booking', async () => {
    h.data = {
      conversation_states: [{ id: 's1', conversation_id: 'c1', bot_mode: 'human' }],
      bookings: [
        { id: 'b2', conversation_id: 'c1', booking_ref: 'VF-NEW', status: 'pending' },
        { id: 'b1', conversation_id: 'c1', booking_ref: 'VF-OLD', status: 'cancelled' },
      ],
    }
    const body = await get()
    expect(callsOn('conversation_states', 'eq')).toContainEqual(['bot_mode', 'human'])
    expect(body.conversations[0].booking.booking_ref).toBe('VF-NEW')
  })

  it('mode=all does not filter by bot mode', async () => {
    await get('?mode=all')
    expect(callsOn('conversation_states', 'eq').some(([col]) => col === 'bot_mode')).toBe(false)
  })

  it('searches guest name, phone digits and booking reference', async () => {
    h.data = { contacts: [{ id: 'k1' }], bookings: [{ conversation_id: 'c9' }], conversation_states: [] }
    await get('?q=' + encodeURIComponent('+91 98480'))
    expect(callsOn('contacts', 'or')[0][0]).toMatch(/name\.ilike\.%\+91 98480%,phone\.ilike\.%9198480%/)
    expect(callsOn('bookings', 'ilike')).toContainEqual(['booking_ref', '%+91 98480%'])
    expect(callsOn('conversation_states', 'or')[0][0]).toBe('contact_id.in.(k1),conversation_id.in.(c9)')
  })

  it('strips PostgREST filter syntax from the search text', async () => {
    h.data = { contacts: [], bookings: [] }
    const body = await get('?q=' + encodeURIComponent('a,b),id.eq.(x'))
    expect(callsOn('contacts', 'or')[0][0]).not.toMatch(/[(),]\w*\.eq/)
    expect(body.conversations).toEqual([])
  })

  it.each([
    [null, null, false, 'not_connected'],
    [{ status: 'connected' }, { bot_enabled: true, test_mode: false }, true, 'dry_run'],
    [{ status: 'connected' }, { bot_enabled: false, test_mode: false }, false, 'bot_off'],
    [{ status: 'connected' }, { bot_enabled: true, test_mode: true }, false, 'test_mode'],
    [{ status: 'connected' }, { bot_enabled: true, test_mode: false }, false, 'live'],
  ])('WhatsApp mode %o / %o / dryRun=%s → %s', async (wa, settings, dryRun, mode) => {
    h.data = { conversation_states: [], whatsapp_config: wa, property_settings: settings }
    h.dryRun = dryRun
    expect((await get()).whatsapp.mode).toBe(mode)
  })
})
