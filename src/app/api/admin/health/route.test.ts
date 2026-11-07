import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The health check must tell configuration, missing migrations, RLS and
 * query failures apart, and never echo secrets or raw database errors.
 */
type Err = { code?: string; message: string } | null
const h = vi.hoisted(() => ({
  adminErrors: {} as Record<string, Err>,
  userErrors: {} as Record<string, Err>,
  configError: null as Error | null,
}))

function client(errors: Record<string, Err>) {
  return {
    from: (table: string) => {
      const q: Record<string, unknown> = {}
      let head = false
      for (const m of ['eq', 'overlaps', 'maybeSingle', 'limit']) q[m] = () => q
      q.select = (_cols: string, opts?: { head?: boolean }) => {
        head = Boolean(opts?.head)
        return q
      }
      const error = errors[table] ?? null
      // Like supabase-js: a HEAD request to a missing table comes back as success.
      q.then = (resolve: (r: unknown) => unknown) =>
        Promise.resolve(resolve(head ? { data: null, count: null, error: null } : { data: error ? null : [], count: 0, error }))
      return q
    },
  }
}

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return {
    ...actual,
    requireRole: vi.fn(async () => ({ accountId: 'acc', userId: 'u1', role: 'owner', supabase: client(h.userErrors) })),
  }
})
vi.mock('@/lib/supabase/service-env', () => ({
  getSupabaseServiceConfig: () => {
    if (h.configError) throw h.configError
    return { url: 'http://x', serviceRoleKey: 'service-secret-value' }
  },
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => client(h.adminErrors) }))

const { GET } = await import('./route')

async function run() {
  const res = await GET(new Request('http://localhost/api/admin/health'))
  const text = await res.text()
  return { res, text, body: JSON.parse(text) as { ok: boolean; status: string; checks: { id: string; status: string; detail?: string }[] } }
}

const missingTable = (t: string) => ({ code: 'PGRST205', message: `Could not find the table 'public.${t}' in the schema cache` })

describe('GET /api/admin/health', () => {
  beforeEach(() => {
    h.adminErrors = {}
    h.userErrors = {}
    h.configError = null
  })

  it('reports ok when every check passes', async () => {
    const { res, body } = await run()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.checks.map((c) => c.id)).toEqual(['auth', 'config', 'tables', 'rls', 'calendar', 'property'])
  })

  it('missing migrations are reported as missing_table with the migration number', async () => {
    h.adminErrors = { availability_blocks: missingTable('availability_blocks'), resort_automations: missingTable('resort_automations') }
    const { body } = await run()
    expect(body.status).toBe('missing_table')
    const tables = body.checks.find((c) => c.id === 'tables')!
    expect(tables.detail).toMatch(/availability_blocks \(migration 059\)/)
    expect(tables.detail).toMatch(/resort_automations \(migration 063\)/)
    expect(body.checks.find((c) => c.id === 'calendar')).toBeUndefined()
  })

  it('names a same-named table that predates the unapplied migration', async () => {
    h.adminErrors = Object.fromEntries(
      ['property_settings', 'availability_blocks', 'bookings', 'event_requests', 'payments', 'notification_jobs', 'conversation_states'].map((t) => [t, missingTable(t)]),
    )
    const { body } = await run()
    expect(body.checks.find((c) => c.id === 'tables')!.detail).toMatch(/Already present from an earlier setup: leads/)
  })

  it('missing server configuration is config_error and leaks no secret', async () => {
    const { SupabaseConfigError } = await import('@/lib/supabase/env')
    h.configError = new SupabaseConfigError(['SUPABASE_SERVICE_ROLE_KEY'])
    const { body, text } = await run()
    expect(body.status).toBe('config_error')
    expect(body.checks.find((c) => c.id === 'config')!.detail).toMatch(/SUPABASE_SERVICE_ROLE_KEY/)
    expect(text).not.toMatch(/service-secret-value/)
  })

  it('an RLS denial for the signed-in user is rls_error', async () => {
    h.userErrors = { availability_blocks: { code: '42501', message: 'permission denied for table availability_blocks' } }
    const { body } = await run()
    expect(body.status).toBe('rls_error')
    expect(body.checks.find((c) => c.id === 'rls')!.status).toBe('rls_error')
  })

  it('an unreachable database is one connection_error, not a list of missing tables', async () => {
    h.adminErrors = Object.fromEntries(['property_settings', 'availability_blocks'].map((t) => [t, { message: 'TypeError: fetch failed' }]))
    const { body } = await run()
    expect(body.status).toBe('connection_error')
    expect(body.checks.filter((c) => c.status === 'connection_error')).toHaveLength(1)
    expect(body.checks.find((c) => c.id === 'tables')).toBeUndefined()
  })

  it('rejected server credentials are an access error', async () => {
    h.adminErrors = { property_settings: { code: 'PGRST301', message: 'JWSError' } }
    const { body } = await run()
    expect(body.status).toBe('rls_error')
    expect(body.checks.find((c) => c.id === 'table:property_settings')!.detail).toMatch(/SUPABASE_SERVICE_ROLE_KEY/)
  })

  it('other failures are query_error without the raw database message', async () => {
    h.userErrors = { property_settings: { code: '57014', message: 'statement timeout on internal_secret' } }
    const { body, text } = await run()
    expect(body.status).toBe('query_error')
    expect(text).not.toMatch(/internal_secret/)
  })
})
