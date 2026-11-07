import { describe, expect, it, vi } from 'vitest'
import { RESORT_AUTOMATIONS } from '@/lib/resort/automations/definitions'
import { fetchResortAutomations, groupAutomations, type ResortAutomation } from './resort-automations-data'

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch

const rows: ResortAutomation[] = RESORT_AUTOMATIONS.map((d, i) => ({
  ...d,
  id: `id-${i}`,
  required: Boolean(d.required),
  proactive: Boolean(d.proactive),
  is_enabled: Boolean(d.required),
  config: {},
  execution_count: 0,
  success_count: 0,
  failure_count: 0,
  skipped_count: 0,
  last_executed_at: null,
  last_status: null,
  last_error: null,
}))

describe('fetchResortAutomations', () => {
  it('returns the persisted records', async () => {
    const r = await fetchResortAutomations(respond(200, { automations: rows }))
    expect('items' in r && r.items).toHaveLength(14)
  })

  it('a missing migration is an error with its code, not an empty list', async () => {
    const r = await fetchResortAutomations(respond(503, { error: 'The database is missing the table public.resort_automations.', code: 'migration_required' }))
    expect(r).toEqual({ error: { message: expect.stringContaining('resort_automations'), code: 'migration_required' } })
  })

  it('a signed-out session is reported as unauthenticated', async () => {
    expect(await fetchResortAutomations(respond(401, {}))).toMatchObject({ error: { code: 'unauthenticated' } })
  })

  it('a malformed response or network failure is an error, never fabricated records', async () => {
    expect(await fetchResortAutomations(respond(200, { ok: true }))).toHaveProperty('error')
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch
    expect(await fetchResortAutomations(offline)).toHaveProperty('error')
  })
})

describe('groupAutomations', () => {
  it('flows: the 12 numbered flows in order, then the extra automations', () => {
    const groups = groupAutomations([...rows].reverse(), 'flows')
    expect(groups[0].rows.map((r) => r.flow_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(groups[1]).toMatchObject({ title: 'Additional resort automations' })
    expect(groups[1].rows.map((r) => r.key).sort()).toEqual(['abandoned_followup', 'stay_booking_enquiry'])
  })

  it('every guest-facing flow except human handoff starts disabled', () => {
    expect(rows.filter((r) => r.is_enabled).map((r) => r.key)).toEqual(['human_escalation'])
  })

  it('no records means no groups (the empty state)', () => {
    expect(groupAutomations([], 'flows')).toEqual([])
    expect(groupAutomations([], 'automations')).toEqual([])
  })
})
