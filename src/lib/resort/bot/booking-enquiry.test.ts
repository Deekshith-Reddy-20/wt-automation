import { describe, expect, it, vi } from 'vitest'
import { handleInbound, initialState, validGuestName } from './machine'
import { renderReply } from './provider'
import type { BotReply, BotServices, BotState } from './types'
import type { PropertySettings } from '../types'
import {
  DEFAULT_BOOKING_WELCOME_TEXT,
  RESORT_AUTOMATION_KEYS,
  automationSettingsFrom,
  type ResortAutomationKey,
} from '../automations/definitions'

// "Customer Information & Stay Booking Enquiry" (automation N), with synthetic fixtures.
// Today in these tests is 27 Oct 2026 (IST).

function automations(disabled: ResortAutomationKey[] = []) {
  return automationSettingsFrom(RESORT_AUTOMATION_KEYS.map((key) => ({ key, is_enabled: !disabled.includes(key), config: {} })))
}

function settings(over: Partial<PropertySettings> = {}): PropertySettings {
  return {
    id: 's1', account_id: 'a1', resort_name: 'V-Farms', tagline: null, description: null,
    farm_description: null, building_description: null, room_count: null, property_area_acres: null,
    address: null, locality: null, latitude: null, longitude: null, map_url: null, directions: null,
    contact_phone: null, contact_email: null, whatsapp_number: null, check_in_time: null, check_out_time: null,
    max_stay_guests: 20, max_event_guests: null, guest_policies: null, event_policies: null,
    cancellation_policy: null, refund_policy: null, food_info: null, activities_info: null,
    accessibility_info: null, parking_info: null, privacy_policy: null, terms: null,
    timezone: 'Asia/Kolkata', currency: 'INR', is_published: true, bot_enabled: true, test_mode: false,
    payments_enabled: false, manual_approval_required: true, holds_enabled: true, test_phone_numbers: [],
    hold_duration_minutes: 30, event_buffer_minutes: 60, business_hours: null, notification_settings: {},
    reminder_settings: {}, updated_at: '2026-10-01T00:00:00Z', ...over,
  }
}

function makeServices(over: Partial<BotServices> = {}): BotServices {
  return {
    now: () => new Date('2026-10-27T04:30:00Z'),
    settings: settings(),
    pricing: { rules: null, seasonal: [], packages: [], addons: [], now: new Date('2026-10-27T04:30:00Z') },
    contactName: null,
    contactPhone: '+919800000000',
    amenities: [],
    faqs: vi.fn(async () => []),
    checkStay: vi.fn(async () => 'pending_manual' as const),
    checkEvent: vi.fn(async () => 'pending_manual' as const),
    alternatives: vi.fn(async () => []),
    submitStay: vi.fn(async () => ({ ref: 'VF-261027-ABCDE', bookingId: 'b1', availability: 'pending_manual' as const, quote: { status: 'not_configured' as const, missing: ['pricing_rules'] }, link: null })),
    submitEvent: vi.fn(async () => { throw new Error('not used') }),
    reserve: vi.fn(async () => ({ outcome: 'requested_review' as const })),
    handoff: vi.fn(async () => {}),
    noteInterest: vi.fn(async () => {}),
    siteUrl: null,
    automations: automations(),
    guestBookings: vi.fn(async () => []),
    findGuestBooking: vi.fn(async () => null),
    requestCancellation: vi.fn(async () => 'cancellation_requested' as const),
    checkReschedule: vi.fn(async () => ({ availability: 'available' as const, total_paise: null, quote_snapshot: null })),
    requestReschedule: vi.fn(async () => {}),
    recordFeedback: vi.fn(async () => true),
    ...over,
  }
}

const text = (replies: BotReply[]) => replies.map((r) => (r.type === 'media' ? `[${r.kind}] ${r.url}` : r.text)).join('\n---\n')
const optionIds = (replies: BotReply[]) => replies.flatMap((r) => (r.type === 'choices' ? r.options.map((o) => o.id) : []))

class Chat {
  state: BotState = initialState()
  n = 0
  constructor(public svc: BotServices) {}
  async send(body: string, replyId: string | null = null) {
    const res = await handleInbound(this.svc, this.state, { text: body, replyId, messageId: `wamid.${++this.n}` })
    this.state = res.state
    return res
  }
  get at() {
    return `${this.state.flow}.${this.state.step}`
  }
}

/** Walk to the summary with valid answers. */
async function toSummary(chat: Chat) {
  await chat.send('BOOK STAY')
  await chat.send('', 'bk_start')
  await chat.send('Priya Sharma')
  await chat.send('20-11-2026')
  await chat.send('22-11-2026')
  await chat.send('6')
  await chat.send('', 'bp_family')
  return chat.send('', 'skip')
}

describe('Stay Booking Enquiry — triggers', () => {
  it.each(['BOOK', 'STAY', 'BOOK STAY', 'book stay'])('"%s" opens the booking welcome without the main welcome menu', async (kw) => {
    const chat = new Chat(makeServices())
    const res = await chat.send(kw)
    expect(chat.at).toBe('booking.intro')
    expect(res.replies).toHaveLength(1)
    expect(text(res.replies)).toBe(DEFAULT_BOOKING_WELCOME_TEXT)
    expect(optionIds(res.replies)).toEqual(['bk_start', 'c_human', 'c_menu'])
    expect(res.events.some((e) => e.key === 'welcome_menu')).toBe(false)
  })

  it('the welcome menu’s Private Farm Stay hands over to this flow', async () => {
    const chat = new Chat(makeServices())
    await chat.send('Hi')
    await chat.send('', 'm_stay')
    expect(chat.at).toBe('booking.intro')
  })

  it('when the automation is off, Private Farm Stay keeps the original stay menu and BOOK is not intercepted', async () => {
    const chat = new Chat(makeServices({ automations: automations(['stay_booking_enquiry']) }))
    await chat.send('Hi')
    await chat.send('', 'm_stay')
    expect(chat.at).toBe('stay.menu')
    const fresh = new Chat(makeServices({ automations: automations(['stay_booking_enquiry']) }))
    await fresh.send('BOOK')
    expect(fresh.at).not.toBe('booking.intro')
  })

  it('renders the welcome buttons within WhatsApp limits', async () => {
    const chat = new Chat(makeServices())
    const res = await chat.send('BOOK')
    const rendered = renderReply(res.replies[0])
    expect(rendered.kind).toBe('buttons')
    if (rendered.kind === 'buttons') for (const b of rendered.buttons) expect(b.title.length).toBeLessThanOrEqual(20)
  })
})

describe('Stay Booking Enquiry — information collection', () => {
  it('1–2: starts the enquiry and accepts a valid full name, then asks the check-in date', async () => {
    const chat = new Chat(makeServices())
    await chat.send('BOOK')
    const start = await chat.send('', 'bk_start')
    expect(text(start.replies)).toBe('May we know your full name?')
    const res = await chat.send('Priya Sharma')
    expect(chat.state.data.name).toBe('Priya Sharma')
    expect(text(res.replies)).toContain('What is your preferred check-in date?')
  })

  it('3: rejects an invalid name and keeps asking', async () => {
    for (const bad of ['', 'a', '12345', '😀😀', 'R2D2']) {
      const chat = new Chat(makeServices())
      await chat.send('BOOK')
      await chat.send('', 'bk_start')
      const res = await chat.send(bad)
      expect(chat.at).toBe('booking.name')
      expect(text(res.replies)).toContain('full name')
    }
  })

  it('accepts Indian and international names', () => {
    for (const ok of ['Priya Sharma', "D'Souza", 'Jean-Luc Picard', 'Dr. A. Kumar', 'प्रिया शर्मा', 'Ng']) expect(validGuestName(ok)).toBe(true)
  })

  it('offers the WhatsApp profile name as a one-tap answer', async () => {
    const chat = new Chat(makeServices({ contactName: 'Ravi Kumar' }))
    await chat.send('BOOK')
    const res = await chat.send('', 'bk_start')
    expect(optionIds(res.replies)).toEqual(['use_name'])
    await chat.send('', 'use_name')
    expect(chat.state.data.name).toBe('Ravi Kumar')
  })

  it('4: rejects a past check-in date', async () => {
    const chat = new Chat(makeServices())
    await chat.send('BOOK')
    await chat.send('', 'bk_start')
    await chat.send('Priya Sharma')
    const res = await chat.send('01-10-2026')
    expect(chat.at).toBe('booking.check_in')
    expect(text(res.replies)).toContain('already passed')
  })

  it('rejects an impossible date', async () => {
    const chat = new Chat(makeServices())
    await chat.send('BOOK')
    await chat.send('', 'bk_start')
    await chat.send('Priya Sharma')
    await chat.send('31-02-2027')
    expect(chat.at).toBe('booking.check_in')
  })

  it('5: rejects a check-out on or before check-in', async () => {
    const chat = new Chat(makeServices())
    await chat.send('BOOK')
    await chat.send('', 'bk_start')
    await chat.send('Priya Sharma')
    await chat.send('20-11-2026')
    for (const bad of ['19-11-2026', '20-11-2026']) {
      const res = await chat.send(bad)
      expect(chat.at).toBe('booking.check_out')
      expect(text(res.replies)).toContain('must be after your check-in date')
    }
  })

  it('6: asks one head count — how many members — with no adults, children or ages questions', async () => {
    const chat = new Chat(makeServices())
    await chat.send('BOOK')
    await chat.send('', 'bk_start')
    await chat.send('Priya Sharma')
    await chat.send('20-11-2026')
    const membersQ = await chat.send('22-11-2026')
    expect(text(membersQ.replies)).toBe('👨‍👩‍👧 How many members will be staying?')
    expect(text(membersQ.replies)).not.toMatch(/adult|child|age/i)
    await chat.send('8 members')
    expect(chat.state.data).toMatchObject({ adults: 8, children: 0, children_ages: null })
    expect(chat.at).toBe('booking.purpose')

    const bad = new Chat(makeServices())
    await bad.send('BOOK')
    await bad.send('', 'bk_start')
    await bad.send('Priya Sharma')
    await bad.send('20-11-2026')
    await bad.send('22-11-2026')
    const res = await bad.send('a few')
    expect(text(res.replies)).toContain('number of members')
    expect(bad.at).toBe('booking.adults')
  })

  it('refuses a group above the estate’s overnight capacity', async () => {
    const chat = new Chat(makeServices({ settings: settings({ max_stay_guests: 10 }) }))
    await chat.send('BOOK')
    await chat.send('', 'bk_start')
    await chat.send('Priya Sharma')
    await chat.send('20-11-2026')
    await chat.send('22-11-2026')
    const res = await chat.send('12')
    expect(text(res.replies)).toContain('up to 10 guests')
    expect(chat.state.data.adults).toBeUndefined()
  })

  it('"Other" purpose asks for it in the guest’s own words', async () => {
    const chat = new Chat(makeServices())
    await chat.send('BOOK')
    await chat.send('', 'bk_start')
    await chat.send('Priya Sharma')
    await chat.send('20-11-2026')
    await chat.send('22-11-2026')
    await chat.send('2')
    await chat.send('', 'bp_other')
    expect(chat.at).toBe('booking.purpose_other')
    await chat.send('Company offsite')
    expect(chat.state.data.purpose).toBe('Company offsite')
  })

  it('7: skipping special requirements, then a full summary of the whole-estate enquiry', async () => {
    const chat = new Chat(makeServices())
    const res = await toSummary(chat)
    expect(chat.at).toBe('booking.summary')
    expect(chat.state.data.special).toBeNull()
    const body = text(res.replies)
    for (const line of [
      'V-Farms – Booking Enquiry Summary',
      'Guest Name: Priya Sharma',
      'Check-in: ',
      'Total Nights: 2',
      'Members: 6',
      'Visit Purpose: Family Vacation',
      'Special Requirements: None',
      'Property: Entire Exclusive V-Farms Estate',
      'Are these details correct?',
    ]) expect(body).toContain(line)
    expect(optionIds(res.replies)).toEqual(['bk_submit', 'bk_edit', 'c_cancel'])
    expect(body).not.toMatch(/room \d|per room|₹|Adults|Children/i)
  })

  it('never asks for information it already has', async () => {
    const chat = new Chat(makeServices())
    await toSummary(chat)
    await chat.send('', 'bk_edit')
    await chat.send('', 'e_adults')
    expect(chat.at).toBe('booking.adults')
    await chat.send('5')
    expect(chat.at).toBe('booking.summary')
    expect(chat.state.data.adults).toBe(5)
  })
})

describe('Stay Booking Enquiry — review, availability and submission', () => {
  it('8: edits one detail from the summary and returns to the summary', async () => {
    const chat = new Chat(makeServices())
    await toSummary(chat)
    await chat.send('', 'bk_edit')
    await chat.send('', 'e_check_out')
    expect(chat.at).toBe('booking.check_out')
    const res = await chat.send('23-11-2026')
    expect(chat.at).toBe('booking.summary')
    expect(text(res.replies)).toContain('Total Nights: 3')
  })

  it('EDIT typed mid-flow opens the edit menu', async () => {
    const chat = new Chat(makeServices())
    await chat.send('BOOK')
    await chat.send('', 'bk_start')
    await chat.send('Priya Sharma')
    await chat.send('edit')
    expect(chat.at).toBe('booking.edit')
  })

  it('9: submits only after the guest confirms; checks the live calendar first, then saves a new enquiry', async () => {
    const svc = makeServices()
    const chat = new Chat(svc)
    await toSummary(chat)
    expect(svc.checkStay).not.toHaveBeenCalled()
    expect(svc.submitStay).not.toHaveBeenCalled()

    const avail = await chat.send('', 'bk_submit')
    expect(svc.checkStay).toHaveBeenCalledWith('2026-11-20', '2026-11-22')
    expect(svc.submitStay).not.toHaveBeenCalled()
    expect(text(avail.replies)).toContain('Good news! 🌿 Your preferred dates are currently available for an exclusive V-Farms stay.')
    expect(optionIds(avail.replies)).toEqual(['bk_submit', 'bk_dates', 'c_human'])

    const done = await chat.send('', 'bk_submit')
    expect(svc.submitStay).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Priya Sharma', check_in: '2026-11-20', check_out: '2026-11-22', adults: 6, children: 0, purpose: 'Family Vacation', special_requirements: null, enquiry_only: true }),
      expect.stringMatching(/^bot:/),
    )
    const body = text(done.replies)
    expect(body).toContain('Your stay enquiry has been successfully submitted.')
    expect(body).toContain('Enquiry Reference: VF-261027-ABCDE')
    expect(done.events).toContainEqual(expect.objectContaining({ key: 'stay_booking_enquiry', status: 'success', detail: expect.objectContaining({ ref: 'VF-261027-ABCDE' }) }))
    expect(chat.at).toBe('booking.done')
    expect(svc.reserve).not.toHaveBeenCalled()
  })

  it('10: unavailable dates — says so, keeps the other details and asks for new dates, then checks again', async () => {
    const checkStay = vi.fn<BotServices['checkStay']>().mockResolvedValueOnce('unavailable').mockResolvedValueOnce('available')
    const svc = makeServices({ checkStay })
    const chat = new Chat(svc)
    await toSummary(chat)
    const res = await chat.send('', 'bk_submit')
    expect(text(res.replies)).toContain('Sorry, your selected dates are currently unavailable.')
    expect(text(res.replies)).toContain('Please choose another date range, and we will check again.')
    expect(chat.at).toBe('booking.check_in')
    expect(chat.state.data).toMatchObject({ name: 'Priya Sharma', adults: 6, children: 0 })
    expect(svc.submitStay).not.toHaveBeenCalled()

    await chat.send('27-11-2026')
    const summary = await chat.send('29-11-2026')
    expect(chat.at).toBe('booking.summary')
    expect(text(summary.replies)).toContain('Total Nights: 2')
    await chat.send('', 'bk_submit')
    expect(checkStay).toHaveBeenCalledTimes(2)
    expect(chat.at).toBe('booking.available')
  })

  it('11: two guests asking for overlapping dates each get an enquiry; the one whose dates were taken meanwhile is told', async () => {
    const first = new Chat(makeServices())
    await toSummary(first)
    await first.send('', 'bk_submit')
    await first.send('', 'bk_submit')
    expect(first.at).toBe('booking.done')

    const taken = makeServices({
      submitStay: vi.fn(async () => ({ ref: 'VF-261027-SECND', bookingId: 'b2', availability: 'unavailable' as const, quote: { status: 'not_configured' as const, missing: [] }, link: null })),
    })
    const second = new Chat(taken)
    await toSummary(second)
    await second.send('', 'bk_submit')
    const res = await second.send('', 'bk_submit')
    expect(text(res.replies)).toContain('VF-261027-SECND')
    expect(text(res.replies)).toContain('booked moments ago')
    expect(text(res.replies)).not.toContain('successfully submitted')
  })

  it('an unverifiable calendar is never reported as available', async () => {
    const chat = new Chat(makeServices({ checkStay: vi.fn(async () => 'unknown' as const) }))
    await toSummary(chat)
    const res = await chat.send('', 'bk_submit')
    expect(text(res.replies)).not.toContain('Good news')
    expect(text(res.replies)).toContain("couldn't check the calendar")
  })

  it('a failed save hands the guest to the team instead of pretending', async () => {
    const svc = makeServices({ submitStay: vi.fn(async () => { throw new Error('db down') }) })
    const chat = new Chat(svc)
    await toSummary(chat)
    await chat.send('', 'bk_submit')
    const res = await chat.send('', 'bk_submit')
    expect(text(res.replies)).toContain("couldn't save your enquiry")
    expect(res.handoff).toBe(true)
    expect(svc.handoff).toHaveBeenCalledWith('bot_submit_failed', expect.any(String))
  })

  it('Change Dates from the availability step asks for dates again', async () => {
    const chat = new Chat(makeServices())
    await toSummary(chat)
    await chat.send('', 'bk_submit')
    await chat.send('', 'bk_dates')
    expect(chat.at).toBe('booking.check_in')
    expect(chat.state.data.check_in).toBeUndefined()
  })
})

describe('Stay Booking Enquiry — commands', () => {
  it('12: BACK returns to the previous question', async () => {
    const chat = new Chat(makeServices())
    await chat.send('BOOK')
    await chat.send('', 'bk_start')
    await chat.send('Priya Sharma')
    await chat.send('20-11-2026')
    expect(chat.at).toBe('booking.check_out')
    await chat.send('BACK')
    expect(chat.at).toBe('booking.check_in')
  })

  it('13: CANCEL stops the enquiry without submitting anything', async () => {
    const svc = makeServices()
    const chat = new Chat(svc)
    await toSummary(chat)
    const res = await chat.send('CANCEL')
    expect(chat.at).toBe('menu.start')
    expect(text(res.replies)).toContain('Nothing was booked')
    expect(svc.submitStay).not.toHaveBeenCalled()
  })

  it('14: HUMAN hands over to staff with the details collected so far', async () => {
    const svc = makeServices()
    const chat = new Chat(svc)
    await chat.send('BOOK')
    await chat.send('', 'bk_start')
    await chat.send('Priya Sharma')
    await chat.send('20-11-2026')
    await chat.send('22-11-2026')
    const res = await chat.send('HUMAN')
    expect(res.handoff).toBe(true)
    expect(svc.handoff).toHaveBeenCalledWith('guest_requested', expect.stringContaining('2026-11-20'))
  })

  it('MENU returns to the main menu', async () => {
    const chat = new Chat(makeServices())
    await chat.send('BOOK')
    await chat.send('', 'bk_start')
    await chat.send('MENU')
    expect(chat.at).toBe('menu.start')
  })

  it('an unrelated question mid-flow gets a helpful reply and the booking state is untouched', async () => {
    const chat = new Chat(makeServices())
    await chat.send('BOOK')
    await chat.send('', 'bk_start')
    await chat.send('Priya Sharma')
    const before = structuredClone(chat.state.data)
    const res = await chat.send('Is there a swimming pool?')
    expect(chat.at).toBe('booking.check_in')
    expect(text(res.replies)).toContain('reply HUMAN')
    expect(text(res.replies)).toContain('check-in date')
    expect({ ...chat.state.data, retries: undefined }).toEqual({ ...before, retries: undefined })
  })

  it('a greeting mid-flow offers to continue instead of re-sending the welcome menu', async () => {
    const chat = new Chat(makeServices())
    await chat.send('BOOK')
    await chat.send('', 'bk_start')
    await chat.send('Priya Sharma')
    const res = await chat.send('Hi')
    expect(chat.at).toBe('menu.resume')
    expect(res.events.some((e) => e.key === 'welcome_menu')).toBe(false)
    await chat.send('', 'r_continue')
    expect(chat.at).toBe('booking.check_in')
    expect(chat.state.data.name).toBe('Priya Sharma')
  })

  it('an image mid-flow re-asks the current question', async () => {
    const chat = new Chat(makeServices())
    await chat.send('BOOK')
    await chat.send('', 'bk_start')
    const res = await handleInbound(chat.svc, chat.state, { text: '[image]', replyId: null, messageId: 'wamid.img', unsupported: 'image' })
    expect(res.state.step).toBe('name')
    expect(text(res.replies)).toContain('May we know your full name?')
  })
})
