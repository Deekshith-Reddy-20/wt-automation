import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Calendar API against a stubbed Supabase query: the response must carry
 * persisted blocks, drop lapsed holds, and turn a missing table or missing
 * configuration into an actionable 503 rather than an empty calendar.
 */
const h = vi.hoisted(() => ({
  result: { data: [] as unknown[] | null, error: null as { code?: string; message: string } | null },
  throwOnAuth: null as Error | null,
  calls: [] as [string, unknown[]][],
}))

function query() {
  const q: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'overlaps', 'order']) {
    q[m] = (...args: unknown[]) => {
      h.calls.push([m, args])
      return q
    }
  }
  q.then = (resolve: (r: unknown) => unknown) => Promise.resolve(resolve(h.result))
  return q
}

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return {
    ...actual,
    requireRole: vi.fn(async () => {
      if (h.throwOnAuth) throw h.throwOnAuth
      return { accountId: 'acc', userId: 'u1', role: 'viewer', supabase: { from: () => query() } }
    }),
  }
})

const { GET } = await import('./route')

const get = (qs = '?from=2026-11-01&days=42') => GET(new Request(`http://localhost/api/admin/availability${qs}`))

describe('GET /api/admin/availability', () => {
  beforeEach(() => {
    h.result = { data: [], error: null }
    h.throwOnAuth = null
    h.calls = []
  })

  it('queries active blocks for the account overlapping the IST window', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ from: '2026-11-01', days: 42, blocks: [] })
    expect(h.calls).toContainEqual(['eq', ['account_id', 'acc']])
    expect(h.calls).toContainEqual(['eq', ['status', 'active']])
    // 2026-11-01 00:00 IST = 2026-10-31 18:30 UTC
    expect(h.calls).toContainEqual(['overlaps', ['period', '[2026-10-31T18:30:00.000Z,2026-12-12T18:30:00.000Z)']])
  })

  it('returns stays, events, manual blocks, maintenance and live holds, but not lapsed holds', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString()
    const past = new Date(Date.now() - 60_000).toISOString()
    h.result = {
      data: [
        { id: 'stay', block_type: 'booking', expires_at: null, bookings: { booking_type: 'stay', status: 'confirmed' } },
        { id: 'event', block_type: 'booking', expires_at: null, bookings: { booking_type: 'event', status: 'confirmed' } },
        { id: 'owner', block_type: 'manual_block', expires_at: null },
        { id: 'm', block_type: 'maintenance', expires_at: null },
        { id: 'h1', block_type: 'hold', expires_at: future },
        { id: 'h2', block_type: 'hold', expires_at: past },
      ],
      error: null,
    }
    const body = await (await get()).json()
    expect(body.blocks.map((b: { id: string }) => b.id)).toEqual(['stay', 'event', 'owner', 'm', 'h1'])
  })

  it('an empty window is an empty list, not an error', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).blocks).toEqual([])
  })

  it('an unreachable database is a 503 connection error, never an open calendar', async () => {
    h.result = { data: null, error: { message: 'TypeError: fetch failed' } }
    const res = await get()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe('connection_failed')
    expect(body.blocks).toBeUndefined()
  })

  it('rejects an invalid date', async () => {
    expect((await get('?from=2026-13-40')).status).toBe(400)
  })

  it('a missing table is a 503 setup error naming the migration, not an empty calendar', async () => {
    h.result = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.availability_blocks' in the schema cache" } }
    const res = await get()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe('migration_required')
    expect(body.error).toMatch(/availability_blocks/)
    expect(body.blocks).toBeUndefined()
  })

  it('missing Supabase configuration is a 503 that names the variable', async () => {
    const { SupabaseConfigError } = await import('@/lib/supabase/env')
    h.throwOnAuth = new SupabaseConfigError(['NEXT_PUBLIC_SUPABASE_URL'])
    const res = await get()
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'config_missing', error: expect.stringContaining('NEXT_PUBLIC_SUPABASE_URL') })
  })

  it('other query failures are a 500 without leaking the database message', async () => {
    h.result = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout on secret_table' } }
    const res = await get()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('query_failed')
    expect(body.error).not.toMatch(/secret_table/)
  })

  it('an unauthenticated caller gets 401', async () => {
    const { UnauthorizedError } = await import('@/lib/auth/account')
    h.throwOnAuth = new UnauthorizedError()
    expect((await get()).status).toBe(401)
  })
})
