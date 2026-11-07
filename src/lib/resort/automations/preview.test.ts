import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb } from '../../flows/fake-db.test-helper'
import type { PropertySettings } from '../types'
import { RESORT_AUTOMATION_KEYS, automationSettingsFrom } from './definitions'

const settings = {
  id: 's1', account_id: 'acc', resort_name: 'V-Farms', tagline: null, description: null,
  farm_description: null, building_description: null, room_count: null, property_area_acres: null,
  address: null, locality: null, latitude: null, longitude: null, map_url: null, directions: null,
  contact_phone: null, contact_email: null, whatsapp_number: null, check_in_time: null, check_out_time: null,
  max_stay_guests: null, max_event_guests: null, guest_policies: null, event_policies: null,
  cancellation_policy: null, refund_policy: null, food_info: null, activities_info: null,
  accessibility_info: null, parking_info: null, privacy_policy: null, terms: null,
  timezone: 'Asia/Kolkata', currency: 'INR', is_published: false, bot_enabled: false, test_mode: true,
  payments_enabled: false, manual_approval_required: true, holds_enabled: true, test_phone_numbers: [],
  hold_duration_minutes: 30, event_buffer_minutes: 60, business_hours: null, notification_settings: {},
  reminder_settings: {}, updated_at: '2026-10-01T00:00:00Z',
} as PropertySettings

const checkOccupancy = vi.fn(async () => ({ status: 'available', conflicts: [] }))

vi.mock('../property-store', () => ({
  loadPropertyBundle: async () => ({ settings, pricing: { rules: null, seasonal: [], packages: [], addons: [] } }),
  missingPricing: () => ['pricing_rules'],
}))
vi.mock('../availability', () => ({ checkOccupancy: (...args: unknown[]) => checkOccupancy(...(args as [])) }))

const { previewAutomation } = await import('./preview')

/** A database that fails the test on any write. */
function readOnlyDb() {
  const fake = createFakeDb({ profiles: [{ account_id: 'acc', user_id: 'u1', account_role: 'owner' }] })
  const writes: string[] = []
  const db = {
    ...fake,
    rpc: async (name: string) => { writes.push(`rpc:${name}`); return { error: null } },
    from(table: string) {
      const b = fake.from(table) as Record<string, unknown>
      for (const op of ['insert', 'update', 'upsert', 'delete']) {
        const original = b[op] as (...a: unknown[]) => unknown
        b[op] = (...a: unknown[]) => { writes.push(`${op}:${table}`); return original(...a) }
      }
      return b
    },
  }
  return { db: db as unknown as SupabaseClient, writes }
}

describe('automation Run Test (preview)', () => {
  beforeEach(() => checkOccupancy.mockClear())

  it.each(RESORT_AUTOMATION_KEYS)('%s never writes, sends or books', async (key) => {
    const { db, writes } = readOnlyDb()
    const all = automationSettingsFrom(RESORT_AUTOMATION_KEYS.map((k) => ({ key: k, is_enabled: true, config: {} })))
    const res = await previewAutomation(db, 'acc', key, all, { check_in: '2030-01-10', check_out: '2030-01-12' })
    expect(res.read_only).toBe(true)
    expect(writes).toEqual([])
  })

  it('shows the exact welcome menu text', async () => {
    const { db } = readOnlyDb()
    const all = automationSettingsFrom(RESORT_AUTOMATION_KEYS.map((k) => ({ key: k, is_enabled: true, config: {} })))
    const res = await previewAutomation(db, 'acc', 'welcome_menu', all, {})
    expect(JSON.stringify(res.messages)).toContain('Welcome to V-Farms!')
  })

  it('runs a live availability read only when dates are given', async () => {
    const { db } = readOnlyDb()
    const all = automationSettingsFrom([])
    await previewAutomation(db, 'acc', 'availability_check', all, {})
    expect(checkOccupancy).not.toHaveBeenCalled()
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
    const res = await previewAutomation(db, 'acc', 'availability_check', all, { check_in: day(30), check_out: day(32) })
    expect(res.checks.find((c) => c.label === 'Dates valid')).toBeUndefined()
    expect(checkOccupancy).toHaveBeenCalledTimes(1)
    expect(res.data).toMatchObject({ status: 'available' })
    expect(res.checks.find((c) => c.label === 'Automation enabled')?.ok).toBe(false)
  })

  it('flags reminders and follow-ups that are not configured', async () => {
    const { db } = readOnlyDb()
    const all = automationSettingsFrom([])
    const pay = await previewAutomation(db, 'acc', 'payment_reminder', all, {})
    expect(pay.checks.find((c) => c.label === 'Balance due date configured')?.ok).toBe(false)
    const fu = await previewAutomation(db, 'acc', 'abandoned_followup', all, {})
    expect(fu.checks.find((c) => c.label === 'Follow-up period configured')?.ok).toBe(false)
  })
})
