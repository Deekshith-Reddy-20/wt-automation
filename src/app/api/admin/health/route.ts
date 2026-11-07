import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { adminRoute } from '@/lib/resort/admin-http'
import { classifyDbError, type DbProblemCode } from '@/lib/resort/db-errors'
import { addDays, istToInstant, todayIST } from '@/lib/resort/time'
import { isSupabaseConfigError } from '@/lib/supabase/env'
import { getSupabaseServiceConfig } from '@/lib/supabase/service-env'

export const dynamic = 'force-dynamic'

/** Tables the resort screens read, with the migration that creates them. */
const REQUIRED_TABLES: [string, string][] = [
  ['property_settings', '059'],
  ['availability_blocks', '059'],
  ['bookings', '059'],
  ['leads', '059'],
  ['event_requests', '059'],
  ['payments', '059'],
  ['notification_jobs', '059'],
  ['conversation_states', '059'],
  ['resort_automations', '063'],
  ['resort_automation_runs', '063'],
]

type CheckStatus = 'ok' | 'config_error' | 'missing_table' | 'rls_error' | 'connection_error' | 'query_error'

interface Check {
  id: string
  label: string
  status: CheckStatus
  detail?: string
}

const TABLE_PROBLEM: Partial<Record<DbProblemCode, string>> = {
  permission_denied: 'Supabase rejected the server credentials — check SUPABASE_SERVICE_ROLE_KEY belongs to this project.',
  connection_failed: 'Could not reach the database — check the Supabase project is running.',
  query_failed: 'Query failed — see the server log.',
}

function statusFor(code: DbProblemCode): CheckStatus {
  if (code === 'config_missing') return 'config_error'
  if (code === 'migration_required') return 'missing_table'
  if (code === 'permission_denied') return 'rls_error'
  if (code === 'connection_failed') return 'connection_error'
  return 'query_error'
}

// Not a head request: supabase-js reports a HEAD 404 (missing table) as success.
async function probe(db: SupabaseClient, table: string): Promise<{ ok: true } | { ok: false; code: DbProblemCode; message?: string }> {
  const { error } = await db.from(table).select('id').limit(1)
  if (!error) return { ok: true }
  const p = classifyDbError(error)
  return { ok: false, code: p.code, message: error.message }
}

/**
 * Read-only diagnosis for the resort screens. Reaching this handler
 * already proves the Supabase public configuration works and the caller
 * is signed in (an auth failure returns 401 before this runs). Reports
 * whether each problem is configuration, missing migrations, access
 * (row-level security or rejected credentials), an unreachable database
 * or a failing query. Never writes; never returns secret values.
 */
export const GET = adminRoute('viewer', async ({ supabase, accountId, role }) => {
  const checks: Check[] = [
    { id: 'auth', label: 'Signed in with an account role', status: 'ok', detail: `Role: ${role}` },
  ]

  let admin: SupabaseClient | null = null
  try {
    getSupabaseServiceConfig()
    admin = supabaseAdmin()
    checks.push({ id: 'config', label: 'Server Supabase configuration', status: 'ok' })
  } catch (err) {
    checks.push({
      id: 'config',
      label: 'Server Supabase configuration',
      status: 'config_error',
      detail: isSupabaseConfigError(err) ? err.message : 'Could not create the server Supabase client.',
    })
  }

  const missing: string[] = []
  const found: [string, string][] = []
  let unreachable = false
  if (admin) {
    for (const [table, migration] of REQUIRED_TABLES) {
      const r = await probe(admin, table)
      if (r.ok) {
        found.push([table, migration])
        continue
      }
      if (r.code === 'connection_failed') {
        unreachable = true
        checks.push({ id: 'connection', label: 'Database connection', status: 'connection_error', detail: TABLE_PROBLEM.connection_failed })
        break
      }
      if (r.code === 'migration_required') missing.push(`${table} (migration ${migration})`)
      else checks.push({ id: `table:${table}`, label: `Read ${table}`, status: statusFor(r.code), detail: TABLE_PROBLEM[r.code] })
    }
  }
  if (admin && !unreachable) {
    // A table from a migration that hasn't run predates V-Farms; the migration keeps it under a legacy name.
    const migrationsMissing = new Set(REQUIRED_TABLES.filter(([t]) => missing.some((m) => m.startsWith(`${t} `))).map(([, m]) => m))
    const foreign = found.filter(([, m]) => migrationsMissing.has(m)).map(([t]) => t)
    checks.push({
      id: 'tables',
      label: 'Resort tables exist',
      status: missing.length ? 'missing_table' : 'ok',
      detail: missing.length
        ? `Missing: ${missing.join(', ')}. Apply the V-Farms migrations (see SUPABASE_SETUP.md).` +
          (foreign.length ? ` Already present from an earlier setup: ${foreign.join(', ')} — the migrations keep ${foreign.length === 1 ? 'it' : 'them'} as legacy_pre_vfarms_<name> and create the V-Farms table${foreign.length === 1 ? '' : 's'}.` : '')
        : `${REQUIRED_TABLES.length} tables found`,
    })
  }

  if (missing.length === 0 && !unreachable) {
    const rls = await probe(supabase, 'availability_blocks')
    checks.push(
      rls.ok
        ? { id: 'rls', label: 'Row-level security lets you read the calendar', status: 'ok' }
        : { id: 'rls', label: 'Row-level security lets you read the calendar', status: statusFor(rls.code), detail: rls.code === 'permission_denied' ? 'Your role cannot read availability_blocks.' : undefined },
    )
    const from = todayIST()
    const { data, error } = await supabase
      .from('availability_blocks')
      .select('id, block_type')
      .eq('account_id', accountId)
      .eq('status', 'active')
      .overlaps('period', `[${istToInstant(from, '00:00').toISOString()},${istToInstant(addDays(from, 42), '00:00').toISOString()})`)
    if (error) {
      const p = classifyDbError(error)
      checks.push({ id: 'calendar', label: 'Calendar query (next 6 weeks)', status: statusFor(p.code), detail: p.message || 'Query failed — see the server log.' })
      if (p.code === 'query_failed') console.error('[resort-health] calendar query failed:', error.message)
    } else {
      checks.push({ id: 'calendar', label: 'Calendar query (next 6 weeks)', status: 'ok', detail: `${data?.length ?? 0} active block(s)` })
    }
    const { data: settings, error: settingsErr } = await supabase
      .from('property_settings')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle()
    checks.push(
      settingsErr
        ? { id: 'property', label: 'Property profile', status: statusFor(classifyDbError(settingsErr).code) }
        : { id: 'property', label: 'Property profile', status: 'ok', detail: settings ? 'Set up' : 'Not created yet — run scripts/seed-vfarms.mjs or fill in Property.' },
    )
  }

  const failing = checks.find((c) => c.status !== 'ok')
  return NextResponse.json({
    ok: !failing,
    status: failing?.status ?? 'ok',
    checked_at: new Date().toISOString(),
    checks,
  })
})
