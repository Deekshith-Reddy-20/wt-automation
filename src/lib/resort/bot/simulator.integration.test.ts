import { execFileSync } from 'node:child_process'
import { SignJWT } from 'jose'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it } from 'vitest'
import { ensureResortAutomations } from '../automations/store'
import { simulateTurn } from './simulator'

// Staff test chat against a DISPOSABLE local database (see
// scripts/disposable-db/up.ps1). Skipped unless WACRM_DISPOSABLE_DB=1.

const ENABLED = process.env.WACRM_DISPOSABLE_DB === '1'
const REST = 'http://127.0.0.1:55433'
const JWT_SECRET = 'disposable-local-only-jwt-secret-not-for-prod-0001'
const OWNER = '00000000-0000-4000-8000-000000000001'

const restFetch: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return fetch(url.replace(`${REST}/rest/v1/`, `${REST}/`), init)
}

let svc: SupabaseClient
let accountId = ''

async function counts() {
  const out: Record<string, number | null> = {}
  for (const table of ['bookings', 'leads', 'resort_automation_runs', 'availability_blocks', 'audit_logs']) {
    const { count, error } = await svc.from(table).select('*', { count: 'exact', head: true }).eq('account_id', accountId)
    expect(error).toBeNull()
    out[table] = count
  }
  return out
}

describe.skipIf(!ENABLED)('bot test chat (disposable)', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    accountId = execFileSync(
      'docker',
      ['exec', '-i', 'wacrm058-db', 'psql', '-U', 'postgres', '-d', 'postgres', '-AtqX', '-c', `SELECT account_id FROM public.profiles WHERE user_id = '${OWNER}'`],
      { encoding: 'utf8' },
    ).trim()
    const token = await new SignJWT({ role: 'service_role' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(JWT_SECRET))
    svc = createClient(REST, token, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: restFetch } })
    await svc.from('property_settings').upsert({ account_id: accountId }, { onConflict: 'account_id', ignoreDuplicates: true })
    await ensureResortAutomations(svc, accountId)
    const { error } = await svc.from('resort_automations').update({ is_enabled: true }).eq('account_id', accountId)
    expect(error).toBeNull()
  })

  it('walks the real menu and flows without sending or saving anything', async () => {
    const before = await counts()

    const hi = await simulateTurn(svc, accountId, null, { text: 'Hi', replyId: null })
    const list = hi.messages.find((m) => m.kind === 'list')
    expect(list?.kind === 'list' && list.sections[0].rows.map((r) => r.id)).toEqual([
      'm_stay', 'm_event', 'm_pricing', 'm_avail', 'm_explore', 'm_location', 'm_human',
    ])

    const stay = await simulateTurn(svc, accountId, hi.state, { text: '🏡 Private Farm Stay', replyId: 'm_stay' })
    expect(stay.state.flow).toBe('stay')
    expect(stay.messages.length).toBeGreaterThan(0)

    const human = await simulateTurn(svc, accountId, stay.state, { text: 'HUMAN', replyId: null })
    expect(human.handoff).toBe(true)
    expect(human.simulated.some((s) => s.includes('handed to your team'))).toBe(true)

    expect(await counts()).toEqual(before)
  })
})
