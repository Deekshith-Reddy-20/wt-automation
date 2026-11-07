import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SupabaseConfigError, getSupabasePublicConfig, isSupabasePublicConfigured } from './env'
import { getSupabaseServiceConfig, isSupabaseServiceConfigured } from './service-env'

const URL_OK = 'https://abcdefghijklmnop.supabase.co'

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', URL_OK)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'public-anon-key-value')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'server-only-service-key-value')
})
afterEach(() => vi.unstubAllEnvs())

function configError(fn: () => unknown): SupabaseConfigError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(SupabaseConfigError)
    return err as SupabaseConfigError
  }
  throw new Error('expected a SupabaseConfigError')
}

describe('public Supabase config', () => {
  it('returns trimmed values when configured', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ` ${URL_OK}/ `)
    expect(getSupabasePublicConfig()).toEqual({ url: URL_OK, anonKey: 'public-anon-key-value' })
    expect(isSupabasePublicConfigured()).toBe(true)
  })

  it('names every missing variable and how to fix it', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '   ')
    const err = configError(getSupabasePublicConfig)
    expect(err.missing).toEqual(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'])
    expect(err.message).toMatch(/\.env\.local/)
    expect(err.message).toMatch(/restart/)
    expect(isSupabasePublicConfigured()).toBe(false)
  })

  it('rejects example placeholders and malformed URLs', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://your-project.supabase.co')
    expect(configError(getSupabasePublicConfig).message).toMatch(/placeholder/)
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'supabase.co')
    expect(configError(getSupabasePublicConfig).message).toMatch(/not a valid URL/)
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'ftp://x.supabase.co')
    expect(configError(getSupabasePublicConfig).message).toMatch(/https:\/\//)
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', URL_OK)
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'replace-with-anon-key')
    expect(configError(getSupabasePublicConfig).missing).toEqual(['NEXT_PUBLIC_SUPABASE_ANON_KEY'])
  })

  it('accepts new-format keys and rejects them in the wrong variable', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', URL_OK)
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'sb_publishable_example')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_example')
    expect(getSupabasePublicConfig().anonKey).toBe('sb_publishable_example')
    expect(getSupabaseServiceConfig().serviceRoleKey).toBe('sb_secret_example')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'sb_secret_example')
    const leaked = configError(getSupabasePublicConfig)
    expect(leaked.message).toMatch(/every browser/)
    expect(leaked.message).not.toContain('sb_secret_example')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_publishable_example')
    expect(configError(getSupabaseServiceConfig).message).toMatch(/needs the secret key/)
  })

  it('never puts key values into the error message', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    expect(configError(getSupabasePublicConfig).message).not.toContain('public-anon-key-value')
    expect(configError(getSupabaseServiceConfig).message).not.toContain('server-only-service-key-value')
  })
})

describe('service-role Supabase config', () => {
  it('returns the service key only from the server-only variable', () => {
    expect(getSupabaseServiceConfig()).toEqual({ url: URL_OK, serviceRoleKey: 'server-only-service-key-value' })
    expect(isSupabaseServiceConfigured()).toBe(true)
  })

  it('does not fall back to the anon key', () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    expect(configError(getSupabaseServiceConfig).missing).toEqual(['SUPABASE_SERVICE_ROLE_KEY'])
    expect(isSupabaseServiceConfigured()).toBe(false)
  })

  it('rejects the example placeholder', () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'replace-with-service-role-key')
    expect(configError(getSupabaseServiceConfig).message).toMatch(/placeholder/)
  })
})
