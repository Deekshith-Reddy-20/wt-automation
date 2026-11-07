import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb } from '../flows/fake-db.test-helper'

const sendText = vi.fn(async () => ({}))
const sendTemplate = vi.fn(async () => ({}))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: (...a: unknown[]) => sendText(...(a as [])) }))
vi.mock('@/lib/automations/meta-send', () => ({ engineSendTemplate: (...a: unknown[]) => sendTemplate(...(a as [])) }))
vi.mock('@/lib/contacts/opt-out', () => ({ loadOptedOutAt: async () => null }))
vi.mock('./property-store', () => ({ loadPropertyBundle: async () => ({ settings: null, pricing: {} }) }))
const msg91Text = vi.fn(async () => ({ ok: true as const, dryRun: false, messageId: 'uuid-t' }))
const msg91Interactive = vi.fn(async () => ({ ok: true as const, dryRun: false, messageId: 'uuid-i' }))
vi.mock('@/lib/msg91/client', () => ({
  sendSessionText: (...a: unknown[]) => msg91Text(...(a as [])),
  sendSessionInteractive: (...a: unknown[]) => msg91Interactive(...(a as [])),
}))

const { processGuestJob } = await import('./guest-messages')

type Tables = Record<string, Record<string, unknown>[]>

function job(kind: string, over: Record<string, unknown> = {}) {
  return {
    id: 'j1', account_id: 'acc', kind, channel: 'whatsapp', contact_id: 'c1', conversation_id: 'conv1',
    booking_id: 'b1', lead_id: 'l1', template_name: null, payload: { booking_ref: 'VF-1' }, attempts: 1, max_attempts: 3,
    ...over,
  }
}

function tables(enabled: Record<string, boolean>): Tables {
  return {
    resort_automations: Object.entries(enabled).map(([key, is_enabled]) => ({ account_id: 'acc', key, is_enabled, config: {} })),
    resort_automation_runs: [],
    notification_jobs: [{ id: 'j1', status: 'processing' }],
    bookings: [{ id: 'b1', account_id: 'acc', status: 'completed', booking_type: 'stay', quoted_total: null, advance_due: null }],
    booking_feedback: [],
    messages: [],
    accounts: [{ id: 'acc', owner_user_id: 'owner' }],
    contacts: [{ id: 'c1', phone: '919800000000' }],
    notifications: [],
    profiles: [],
  }
}

describe('guest message jobs respect the automation registry', () => {
  beforeEach(() => { sendText.mockClear(); sendTemplate.mockClear() })

  it('cancels a job whose automation is disabled, without sending', async () => {
    const t = tables({ post_stay_feedback: false })
    const out = await processGuestJob(createFakeDb(t) as unknown as SupabaseClient, job('post_stay_feedback'))
    expect(out).toBe('cancelled')
    expect(t.notification_jobs[0]).toMatchObject({ status: 'cancelled', last_error: 'automation_disabled' })
    expect(sendText).not.toHaveBeenCalled()
    expect(sendTemplate).not.toHaveBeenCalled()
    expect(t.resort_automation_runs[0]).toMatchObject({ automation_key: 'post_stay_feedback', status: 'skipped', dedupe_key: 'job:j1' })
  })

  it('outside the 24-hour window with no template, skips instead of sending', async () => {
    const t = tables({ post_stay_feedback: true })
    const out = await processGuestJob(createFakeDb(t) as unknown as SupabaseClient, job('post_stay_feedback'))
    expect(out).toBe('skipped')
    expect(t.notification_jobs[0]).toMatchObject({ last_error: 'outside_24h_window_no_template' })
    expect(sendText).not.toHaveBeenCalled()
  })

  it('never sends a confirmation for an unpaid booking', async () => {
    const t = tables({ booking_confirmation: true })
    t.bookings[0] = { id: 'b1', account_id: 'acc', status: 'confirmed', booking_type: 'stay', quoted_total: 30000, advance_due: 10000 }
    t.availability_blocks = [{ booking_id: 'b1', block_type: 'booking', status: 'active' }]
    t.payments = []
    const out = await processGuestJob(createFakeDb(t) as unknown as SupabaseClient, job('booking_confirmed'))
    expect(out).toBe('skipped')
    expect(t.notification_jobs[0]).toMatchObject({ last_error: 'payment_not_verified' })
    expect(sendText).not.toHaveBeenCalled()
  })
})

describe('guest message jobs via MSG91 (mocked MSG91 API)', () => {
  const stayPayload = { booking_ref: 'VF-1', booking_type: 'stay', check_in: '2026-12-10', check_out: '2026-12-12' }
  const confirmedJob = () => job('booking_confirmed', { payload: stayPayload })
  const confirmedTables = () => {
    const t = tables({ booking_confirmation: true })
    t.bookings[0] = { id: 'b1', account_id: 'acc', status: 'confirmed', booking_type: 'stay', quoted_total: 30000, advance_due: null, booking_ref: 'VF-1' }
    t.availability_blocks = [{ booking_id: 'b1', block_type: 'booking', status: 'active' }]
    t.payments = []
    return t
  }
  beforeEach(() => {
    msg91Text.mockClear()
    msg91Interactive.mockClear()
    vi.stubEnv('MSG91_AUTHKEY', 'test-authkey')
    vi.stubEnv('MSG91_INTEGRATED_NUMBER', '919900000000')
    vi.stubEnv('TICKET_SIGNING_SECRET', 'ticket-secret')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('outside the 24-hour window MSG91 has no template, so it skips honestly', async () => {
    const t = confirmedTables()
    const out = await processGuestJob(createFakeDb(t) as unknown as SupabaseClient, job('booking_confirmed', { payload: stayPayload, template_name: 'meta_tpl' }))
    expect(out).toBe('skipped')
    expect(t.notification_jobs[0]).toMatchObject({ last_error: 'outside_24h_window_msg91_no_template' })
    expect(msg91Text).not.toHaveBeenCalled()
    expect(sendTemplate).not.toHaveBeenCalled()
  })

  it('in the window, sends the confirmation with the ticket image and never via Meta', async () => {
    vi.stubEnv('TICKET_PUBLIC_BASE_URL', 'https://crm.example.com')
    const t = confirmedTables()
    t.messages = [{ conversation_id: 'conv1', sender_type: 'customer', created_at: new Date().toISOString() }]
    const out = await processGuestJob(createFakeDb(t) as unknown as SupabaseClient, confirmedJob())
    expect(t.notification_jobs[0].last_error ?? null).toBeNull()
    expect(out).toBe('sent')
    expect(sendText).not.toHaveBeenCalled()
    expect(msg91Interactive).toHaveBeenCalledTimes(1)
    const sent = (msg91Interactive.mock.calls[0] as unknown as [{ interactive: { header?: { image: { link: string } } } }])[0]
    expect(sent.interactive.header?.image.link).toMatch(/^https:\/\/crm\.example\.com\/api\/resort\/ticket\/b1\?sig=/)
  })

  it('without a public https URL, sends the confirmation as text (no ticket)', async () => {
    vi.stubEnv('TICKET_PUBLIC_BASE_URL', '')
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://localhost:3000')
    const t = confirmedTables()
    t.messages = [{ conversation_id: 'conv1', sender_type: 'customer', created_at: new Date().toISOString() }]
    const out = await processGuestJob(createFakeDb(t) as unknown as SupabaseClient, confirmedJob())
    expect(out).toBe('sent')
    expect(msg91Interactive).not.toHaveBeenCalled()
    expect(msg91Text).toHaveBeenCalledTimes(1)
  })

  it('an MSG91 rejection is retried later, not reported as sent', async () => {
    msg91Text.mockResolvedValueOnce({ ok: false, error: 'msg91_rejected:demo' } as never)
    vi.stubEnv('TICKET_PUBLIC_BASE_URL', '')
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    const t = confirmedTables()
    t.messages = [{ conversation_id: 'conv1', sender_type: 'customer', created_at: new Date().toISOString() }]
    const out = await processGuestJob(createFakeDb(t) as unknown as SupabaseClient, confirmedJob())
    expect(out).toBe('retry')
    expect(t.notification_jobs[0]).toMatchObject({ status: 'pending' })
  })
})
