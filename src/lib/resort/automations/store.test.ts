import { describe, expect, it, vi } from 'vitest'
import { RESORT_AUTOMATION_KEYS } from './definitions'
import { ensureResortAutomations } from './store'

/** resort_automations whose key CHECK constraint only allows `allowed`. */
function fakeDb(allowed: readonly string[]) {
  const rows: { key: string }[] = []
  const upsert = vi.fn(async (batch: { key: string }[]) => {
    if (batch.some((r) => !allowed.includes(r.key))) return { error: { code: '23514', message: 'violates check constraint "resort_automations_key_check"' } }
    rows.push(...batch)
    return { error: null }
  })
  const db = {
    from: () => ({
      select: () => ({ eq: async () => ({ data: rows.map((r) => ({ ...r })), error: null }) }),
      upsert,
    }),
  }
  return { db: db as never, rows, upsert }
}

describe('ensureResortAutomations', () => {
  it('creates every automation row, disabled, when the database knows all keys', async () => {
    const { db, rows } = fakeDb(RESORT_AUTOMATION_KEYS)
    await ensureResortAutomations(db, 'a1')
    expect(rows.map((r) => r.key).sort()).toEqual([...RESORT_AUTOMATION_KEYS].sort())
  })

  it('before migration 066, creates the other rows and skips only the new one instead of failing the page', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db, rows } = fakeDb(RESORT_AUTOMATION_KEYS.filter((k) => k !== 'stay_booking_enquiry'))
    const list = await ensureResortAutomations(db, 'a1')
    expect(rows.map((r) => r.key)).not.toContain('stay_booking_enquiry')
    expect(list).toHaveLength(RESORT_AUTOMATION_KEYS.length - 1)
  })
})
