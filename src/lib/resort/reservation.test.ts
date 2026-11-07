import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./notify', () => ({
  alertStaff: vi.fn(async () => {}),
  cancelPendingJobsForBooking: vi.fn(async () => {}),
  writeAudit: vi.fn(async () => {}),
}))

const { requestReservation } = await import('./bookings')

// Online payment is fully configured; only RESORT_WEBSITE_URL varies.
const settings = {
  account_id: 'a1', check_in_time: '12:00', check_out_time: '11:00', max_stay_guests: 12,
  payments_enabled: true, cancellation_policy: 'Stated policy', refund_policy: 'Stated policy',
  manual_approval_required: false, holds_enabled: true, hold_duration_minutes: 30, event_buffer_minutes: 60,
}
const bundle = {
  settings,
  pricing: { rules: { deposit_pct: 30, deposit_fixed_amount: null }, seasonal: [], packages: [], addons: [] },
} as never

function fakeDb() {
  const booking = {
    id: 'b1', account_id: 'a1', booking_ref: 'VF-261027-ABCDE', booking_type: 'stay', status: 'quote_created',
    check_in: '2026-11-20', check_out: '2026-11-22', active_quote_id: 'q1', lead_id: null,
    guest_name: 'Guest', guest_phone: null, conversation_id: null, contact_id: null, source: 'whatsapp',
  }
  const quote = { booking_type: 'stay', nights: 2, subtotal: 20000, total_amount: 20000, advance_amount: 6000, balance_amount: 14000, valid_until: null }
  const statusUpdates: string[] = []
  const from = (table: string) => {
    let patch: Record<string, unknown> = {}
    const q = {
      select: () => q,
      eq: () => q,
      update: (p: Record<string, unknown>) => {
        patch = p
        if (table === 'bookings') statusUpdates.push(String(p.status))
        return q
      },
      maybeSingle: async () => ({ data: table === 'bookings' ? booking : table === 'booking_quotes' ? quote : null, error: null }),
      single: async () => ({ data: { ...booking, ...patch }, error: null }),
    }
    return q
  }
  const rpc = vi.fn(async () => ({ error: null }))
  return { db: { from, rpc } as never, rpc, statusUpdates }
}

const now = new Date('2026-10-27T04:30:00Z')

afterEach(() => vi.unstubAllEnvs())

describe('requestReservation without a guest website', () => {
  it('holds the dates and hands the request to staff instead of waiting for an online payment', async () => {
    vi.stubEnv('RESORT_WEBSITE_URL', '')
    const { db, rpc, statusUpdates } = fakeDb()

    const r = await requestReservation(db, bundle, 'a1', 'b1', { now })

    expect(r.outcome).toBe('requested')
    expect(statusUpdates).toEqual(['booking_requested'])
    expect(rpc).toHaveBeenCalledWith('resort_reserve', expect.objectContaining({ p_block_type: 'hold', p_booking: 'b1' }))
  })

  it('asks for the online advance when a guest website with the payment page is configured', async () => {
    vi.stubEnv('RESORT_WEBSITE_URL', 'https://vfarms.example')
    const { db, statusUpdates } = fakeDb()

    const r = await requestReservation(db, bundle, 'a1', 'b1', { now })

    expect(r.outcome).toBe('payment_required')
    expect(statusUpdates).toEqual(['payment_pending'])
  })
})
