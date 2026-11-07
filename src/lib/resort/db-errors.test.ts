import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { SupabaseConfigError } from '@/lib/supabase/env'
import { classifyDbError, isSetupProblem } from './db-errors'

describe('classifyDbError', () => {
  it('reports a missing table as a migration problem, naming the table', () => {
    const p = classifyDbError({ code: 'PGRST205', message: "Could not find the table 'public.availability_blocks' in the schema cache" })
    expect(p).toMatchObject({ code: 'migration_required', status: 503, missing: 'public.availability_blocks' })
    expect(p.message).toMatch(/059–065/)
  })

  it('recognises the same problem when wrapped in an Error message', () => {
    const p = classifyDbError(new Error("Could not load property configuration: Could not find the table 'public.property_settings' in the schema cache"))
    expect(p).toMatchObject({ code: 'migration_required', missing: 'public.property_settings' })
  })

  it('handles Postgres relation, function and column errors', () => {
    expect(classifyDbError({ code: '42P01', message: 'relation "bookings" does not exist' }).code).toBe('migration_required')
    expect(classifyDbError({ code: 'PGRST202', message: 'Could not find the function public.resort_reserve' }).code).toBe('migration_required')
    expect(classifyDbError({ code: '42703', message: 'column automations.archived_at does not exist' }).missing).toBe('automations.archived_at')
  })

  it('separates configuration, permission and generic query failures', () => {
    const config = classifyDbError(new SupabaseConfigError(['SUPABASE_SERVICE_ROLE_KEY']))
    expect(config).toMatchObject({ code: 'config_missing', status: 503 })
    expect(config.message).toContain('SUPABASE_SERVICE_ROLE_KEY')
    expect(classifyDbError({ code: '42501', message: 'permission denied for table bookings' })).toMatchObject({ code: 'permission_denied', status: 403 })
    expect(classifyDbError({ code: '57014', message: 'canceling statement due to statement timeout' })).toMatchObject({ code: 'query_failed', status: 500, message: '' })
    expect(classifyDbError({ message: 'TypeError: fetch failed' })).toMatchObject({ code: 'connection_failed', status: 503 })
    expect(classifyDbError({ code: 'PGRST001', message: 'Database client error' })).toMatchObject({ code: 'connection_failed' })
    expect(classifyDbError({ code: 'PGRST301', message: 'JWSError' })).toMatchObject({ code: 'permission_denied', status: 403 })
    expect(classifyDbError({ message: 'Invalid API key' })).toMatchObject({ code: 'permission_denied' })
    expect(classifyDbError({ code: '23514', message: 'new row violates check constraint "resort_automations_key_check"' })).toMatchObject({ code: 'migration_required', missing: 'migration 065' })
  })

  it('treats only config and migration problems as setup problems', () => {
    expect(isSetupProblem('migration_required')).toBe(true)
    expect(isSetupProblem('config_missing')).toBe(true)
    expect(isSetupProblem('query_failed')).toBe(false)
  })
})

describe('supabase/apply bundle', () => {
  it('matches migrations 059–065 exactly', () => {
    expect(() => execFileSync(process.execPath, ['scripts/bundle-resort-migrations.mjs', '--check'], { stdio: 'pipe' })).not.toThrow()
  })
})
