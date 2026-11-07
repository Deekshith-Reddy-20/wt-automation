import { isSupabaseConfigError } from '@/lib/supabase/env'

/**
 * Turn a Supabase / PostgREST failure into something staff can act on.
 * Raw database messages are only passed through for schema problems
 * (they name the missing table or column, nothing sensitive).
 */
export type DbProblemCode = 'config_missing' | 'migration_required' | 'permission_denied' | 'connection_failed' | 'query_failed'

export interface DbProblem {
  code: DbProblemCode
  message: string
  status: number
  missing?: string
}

export const RESORT_MIGRATIONS_HINT =
  'Apply the V-Farms migrations (supabase/migrations 059–065, or the bundled file supabase/apply/vfarms_resort_059_065.sql in the Supabase SQL editor), then retry. See SUPABASE_SETUP.md.'

const MISSING_TABLE = /could not find the table '([^']+)'|relation "?([\w.]+)"? does not exist/i
const MISSING_FUNCTION = /could not find the function ([\w.]+)|function ([\w.]+)\(.*\) does not exist/i
const MISSING_COLUMN = /column "?([\w.]+)"? (of relation "?[\w.]+"? )?does not exist|could not find the '([^']+)' column/i

export function classifyDbError(err: unknown): DbProblem {
  if (isSupabaseConfigError(err)) {
    return { code: 'config_missing', status: 503, message: err.message }
  }
  const e = (err ?? {}) as { code?: string; message?: string }
  const msg = typeof e.message === 'string' ? e.message : err instanceof Error ? err.message : String(err ?? '')
  const table = MISSING_TABLE.exec(msg)
  if (e.code === 'PGRST205' || e.code === '42P01' || table) {
    const missing = table?.[1] ?? table?.[2]
    return {
      code: 'migration_required',
      status: 503,
      missing,
      message: `The database is missing ${missing ? `the table ${missing}` : 'a required table'}. ${RESORT_MIGRATIONS_HINT}`,
    }
  }
  const fn = MISSING_FUNCTION.exec(msg)
  if (e.code === 'PGRST202' || e.code === '42883' || fn) {
    const missing = fn?.[1] ?? fn?.[2]
    return {
      code: 'migration_required',
      status: 503,
      missing,
      message: `The database is missing ${missing ? `the function ${missing}` : 'a required function'}. ${RESORT_MIGRATIONS_HINT}`,
    }
  }
  const col = MISSING_COLUMN.exec(msg)
  if (e.code === '42703' || e.code === 'PGRST204' || col) {
    const missing = col?.[1] ?? col?.[3]
    return {
      code: 'migration_required',
      status: 503,
      missing,
      message: `The database schema is out of date${missing ? ` (missing column ${missing})` : ''}. ${RESORT_MIGRATIONS_HINT}`,
    }
  }
  if (e.code === '23514' && /resort_automations_key_check/.test(msg)) {
    return {
      code: 'migration_required',
      status: 503,
      missing: 'migration 065',
      message: `The database does not know the newer resort flows yet (migration 065). ${RESORT_MIGRATIONS_HINT}`,
    }
  }
  if (e.code === '42501' || /permission denied|row-level security/i.test(msg)) {
    return {
      code: 'permission_denied',
      status: 403,
      message: 'The database refused this request (row-level security). Check that your account role allows it.',
    }
  }
  if (/^PGRST30\d$/.test(e.code ?? '') || /invalid api key|jwt (expired|malformed)|invalid jwt|no suitable key/i.test(msg)) {
    return {
      code: 'permission_denied',
      status: 403,
      message: 'Supabase rejected the server credentials (API key or JWT). Check SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_ANON_KEY belong to this project.',
    }
  }
  // PGRST000–003: PostgREST cannot reach Postgres; fetch errors: the app cannot reach Supabase.
  if (/^PGRST00[0-3]$/.test(e.code ?? '') || /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network ?error|socket hang up/i.test(msg)) {
    return {
      code: 'connection_failed',
      status: 503,
      message: 'Could not reach the database. Check that the Supabase project is running and reachable, then retry.',
    }
  }
  return { code: 'query_failed', status: 500, message: '' }
}

export function isSetupProblem(code: string | undefined): boolean {
  return code === 'config_missing' || code === 'migration_required'
}
