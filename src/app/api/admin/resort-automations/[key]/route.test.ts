import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb } from '@/lib/flows/fake-db.test-helper'

type Tables = Record<string, Record<string, unknown>[]>
const h = vi.hoisted(() => ({ tables: {} as Record<string, Record<string, unknown>[]>, role: 'admin' }))

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return {
    ...actual,
    requireRole: vi.fn(async () => {
      if (h.role !== 'admin') throw new actual.ForbiddenError()
      const { createFakeDb: make } = await import('@/lib/flows/fake-db.test-helper')
      return { accountId: 'acc', userId: 'u1', role: 'admin', supabase: make(h.tables) }
    }),
  }
})
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => createFakeDb(h.tables) }))

const { PATCH } = await import('./route')

function call(key: string, body: unknown) {
  const req = new Request(`http://localhost/api/admin/resort-automations/${key}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return PATCH(req, { params: Promise.resolve({ key }) })
}

function seed(): Tables {
  return {
    resort_automations: [
      { id: 'r1', account_id: 'acc', key: 'human_escalation', is_enabled: true, config: { assign_to_user_id: null } },
      { id: 'r2', account_id: 'acc', key: 'abandoned_followup', is_enabled: false, config: {} },
    ],
    profiles: [{ account_id: 'acc', user_id: '11111111-1111-4111-8111-111111111111', account_role: 'agent' }],
    audit_logs: [],
  }
}

describe('PATCH /api/admin/resort-automations/[key]', () => {
  beforeEach(() => { h.tables = seed(); h.role = 'admin' })

  it('refuses to disable human escalation', async () => {
    const res = await call('human_escalation', { is_enabled: false })
    expect(res.status).toBe(422)
    expect(h.tables.resort_automations[0].is_enabled).toBe(true)
  })

  it('enables an automation and writes an audit entry', async () => {
    const res = await call('abandoned_followup', { is_enabled: true })
    expect(res.status).toBe(200)
    expect(h.tables.resort_automations[1]).toMatchObject({ is_enabled: true, updated_by: 'u1' })
    expect(h.tables.audit_logs[0]).toMatchObject({ action: 'resort_automation.enabled' })
  })

  it('rejects unknown config fields and out-of-range values', async () => {
    expect((await call('abandoned_followup', { config: { max_follow_ups: 5 } })).status).toBe(422)
    expect((await call('abandoned_followup', { config: { send_to_everyone: true } })).status).toBe(422)
  })

  it('only assigns escalations to staff on this account', async () => {
    expect((await call('human_escalation', { config: { assign_to_user_id: '22222222-2222-4222-8222-222222222222' } })).status).toBe(422)
    expect((await call('human_escalation', { config: { assign_to_user_id: '11111111-1111-4111-8111-111111111111' } })).status).toBe(200)
  })

  it('404s an unknown automation and 403s non-admins', async () => {
    expect((await call('solar_followup', { is_enabled: true })).status).toBe(404)
    h.role = 'agent'
    expect((await call('abandoned_followup', { is_enabled: true })).status).toBe(403)
  })
})
