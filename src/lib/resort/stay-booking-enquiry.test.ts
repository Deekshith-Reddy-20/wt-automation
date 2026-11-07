import { beforeEach, describe, expect, it, vi } from 'vitest'

const checkOccupancy = vi.fn()
vi.mock('./availability', async (orig) => ({ ...(await orig<typeof import('./availability')>()), checkOccupancy: (...a: unknown[]) => checkOccupancy(...a) }))
vi.mock('./leads', () => ({ upsertLead: vi.fn(async () => ({ id: 'l1' })) }))
const alertStaff = vi.fn(async () => {})
vi.mock('./notify', () => ({ alertStaff: (...a: unknown[]) => alertStaff(...(a as [])), cancelPendingJobsForBooking: vi.fn(), writeAudit: vi.fn() }))

const { BookingError, confirmBooking, createStayEnquiry } = await import('./bookings')

const bundle = {
  settings: { account_id: 'a1', check_in_time: '12:00', check_out_time: '11:00', max_stay_guests: 20, manual_approval_required: true, event_buffer_minutes: 60 },
  pricing: { rules: null, seasonal: [], packages: [], addons: [] },
} as never

function fakeDb() {
  const inserted: Record<string, unknown>[] = []
  const from = (table: string) => {
    let row: Record<string, unknown> = {}
    const q = {
      select: () => q,
      eq: () => q,
      insert: (r: Record<string, unknown>) => ((row = r), table === 'bookings' && inserted.push(r), q),
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: { id: 'b1', created_at: '2026-10-27T04:30:00Z', ...row }, error: null }),
    }
    return q
  }
  return { db: { from } as never, inserted }
}

const enquiry = {
  accountId: 'a1',
  source: 'whatsapp' as const,
  contactId: 'ct1',
  conversationId: 'cv1',
  guestName: 'Priya Sharma',
  guestPhone: '+919800000000',
  specialRequirements: null,
  checkIn: '2026-11-20',
  checkOut: '2026-11-22',
  adults: 4,
  children: 2,
  purpose: 'Family Vacation',
  idempotencyKey: 'bot:wamid.1',
  now: new Date('2026-10-27T04:30:00Z'),
}

beforeEach(() => {
  checkOccupancy.mockReset()
  alertStaff.mockClear()
})

describe('Stay Booking Enquiry — saving the enquiry', () => {
  it('saves a NEW enquiry (status "enquiry") with every collected detail, and alerts staff', async () => {
    checkOccupancy.mockResolvedValue({ status: 'pending_manual', conflicts: [] })
    const { db, inserted } = fakeDb()
    const out = await createStayEnquiry(db, bundle, { ...enquiry, initialStatus: 'enquiry' })
    expect(out.created).toBe(true)
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      status: 'enquiry',
      booking_type: 'stay',
      guest_name: 'Priya Sharma',
      guest_phone: '+919800000000',
      check_in: '2026-11-20',
      check_out: '2026-11-22',
      adults: 4,
      children: 2,
      guest_count: 6,
      purpose: 'Family Vacation',
      special_requirements: null,
      conversation_id: 'cv1',
      idempotency_key: 'bot:wamid.1',
    })
    expect(String(inserted[0].booking_ref)).toMatch(/^VF-/)
    expect(alertStaff).toHaveBeenCalledWith(db, 'a1', expect.objectContaining({ kind: 'new_enquiry', linkPath: '/resort/bookings/b1' }))
  })

  it('without the override, the existing stay flow keeps its status after the check', async () => {
    checkOccupancy.mockResolvedValue({ status: 'pending_manual', conflicts: [] })
    const { db, inserted } = fakeDb()
    await createStayEnquiry(db, bundle, enquiry)
    expect(inserted[0].status).toBe('availability_checked')
  })

  it('rejects a past check-in before touching the database', async () => {
    const { db, inserted } = fakeDb()
    await expect(createStayEnquiry(db, bundle, { ...enquiry, checkIn: '2026-10-01', checkOut: '2026-10-03' })).rejects.toBeInstanceOf(BookingError)
    expect(inserted).toHaveLength(0)
    expect(checkOccupancy).not.toHaveBeenCalled()
  })
})

describe('Stay Booking Enquiry — staff confirmation', () => {
  it('17: staff confirmation goes through the database, which re-checks and reserves the whole estate atomically', async () => {
    const rpc = vi.fn(async () => ({ data: { booking_status: 'confirmed', already_confirmed: false }, error: null }))
    const r = await confirmBooking({ rpc } as never, 'a1', 'b1', 'staff-1')
    expect(r).toEqual({ status: 'confirmed', alreadyConfirmed: false })
    expect(rpc).toHaveBeenCalledWith('resort_confirm_booking', { p_account: 'a1', p_booking: 'b1', p_actor: 'staff-1' })
  })

  it('18: once dates are confirmed, confirming an overlapping enquiry is refused as estate_unavailable', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: '23P01', message: 'estate_unavailable' } }))
    await expect(confirmBooking({ rpc } as never, 'a1', 'b2', 'staff-1')).rejects.toMatchObject({ code: 'estate_unavailable' })
  })

  it('18: and new guests asking for those dates are told they are unavailable', async () => {
    checkOccupancy.mockResolvedValue({ status: 'unavailable', conflicts: [{ id: 'blk1' }] })
    const { db, inserted } = fakeDb()
    const out = await createStayEnquiry(db, bundle, { ...enquiry, initialStatus: 'enquiry' })
    expect(out.availability.status).toBe('unavailable')
    expect(inserted[0].status).toBe('enquiry')
  })
})
