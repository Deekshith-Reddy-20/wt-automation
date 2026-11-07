import { describe, expect, it, vi } from 'vitest'
import { asksForMenu, handleInbound, initialState } from './machine'
import { renderReply } from './provider'
import type { BotReply, BotServices, BotState, GuestBooking } from './types'
import type { PricingRules, PropertySettings } from '../types'
import {
  DEFAULT_STAY_TEXT,
  DEFAULT_WELCOME_TEXT,
  RESORT_AUTOMATION_KEYS,
  automationSettingsFrom,
  type ResortAutomationKey,
} from '../automations/definitions'

/** These tests cover the original flows; automation N (which takes over Private Farm Stay) has its own suite. */
function automations(disabled: ResortAutomationKey[] = [], config: Partial<Record<ResortAutomationKey, unknown>> = {}) {
  return automationSettingsFrom(
    RESORT_AUTOMATION_KEYS.map((key) => ({ key, is_enabled: key !== 'stay_booking_enquiry' && !disabled.includes(key), config: config[key] ?? {} })),
  )
}

// Synthetic fixtures. Anything not set is intentionally "not configured".
function settings(over: Partial<PropertySettings> = {}): PropertySettings {
  return {
    id: 's1', account_id: 'a1', resort_name: 'Test Farm Resort', tagline: null, description: null,
    farm_description: null, building_description: null, room_count: null, property_area_acres: null,
    address: null, locality: null, latitude: null, longitude: null, map_url: null, directions: null,
    contact_phone: null, contact_email: null, whatsapp_number: null, check_in_time: null, check_out_time: null,
    max_stay_guests: null, max_event_guests: null, guest_policies: null, event_policies: null,
    cancellation_policy: null, refund_policy: null, food_info: null, activities_info: null,
    accessibility_info: null, parking_info: null, privacy_policy: null, terms: null,
    timezone: 'Asia/Kolkata', currency: 'INR', is_published: true, bot_enabled: true, test_mode: true,
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
    checkStay: vi.fn(async () => 'available' as const),
    checkEvent: vi.fn(async () => 'pending_manual' as const),
    alternatives: vi.fn(async () => []),
    submitStay: vi.fn(async () => ({ ref: 'VF-261027-ABCDE', bookingId: 'b1', availability: 'available' as const, quote: { status: 'not_configured' as const, missing: ['pricing_rules'] }, link: null })),
    submitEvent: vi.fn(async () => ({ ref: 'VF-261027-EVENT', bookingId: 'b2', availability: 'pending_manual' as const, quote: { status: 'not_configured' as const, missing: ['event_package'] }, link: null })),
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
}

describe('WhatsApp bot — menu and commands', () => {
  it('greets with the exact V-Farms welcome text and the seven options in order', async () => {
    const chat = new Chat(makeServices())
    const res = await chat.send('Hi')
    expect(res.replies).toHaveLength(1)
    expect(text(res.replies)).toBe(DEFAULT_WELCOME_TEXT)
    expect(optionIds(res.replies)).toEqual(['m_stay', 'm_event', 'm_pricing', 'm_avail', 'm_explore', 'm_location', 'm_human'])
    expect(res.events).toEqual([{ key: 'welcome_menu', status: 'success' }])
  })

  it('renders the welcome as a native interactive list with the seven options and a numbered fallback', async () => {
    const chat = new Chat(makeServices())
    const res = await chat.send('Hi')
    const msg = renderReply(res.replies[0])
    expect(msg.kind).toBe('list')
    if (msg.kind !== 'list') return
    expect(msg.button).toBe('View options')
    expect(msg.body.startsWith(DEFAULT_WELCOME_TEXT)).toBe(true)
    const titles = msg.sections[0].rows.map((r) => r.title)
    expect(titles.filter((_, i) => i !== 4)).toEqual([
      '🏡 Private Farm Stay', '🎉 Events & Celebrations', '💰 Pricing & Packages', '📅 Check Availability',
      '📍 Location & Directions', '👨‍💼 Talk to Our Team',
    ])
    expect(titles[4].startsWith('🌿 Explore ')).toBe(true)
    for (const t of titles) expect(t.length).toBeLessThanOrEqual(24)
    titles.forEach((t, i) => expect(msg.body).toContain(`${i + 1}. ${t}`))
  })

  it('typing an option title without the emoji selects it', async () => {
    const chat = new Chat(makeServices())
    await chat.send('Hi')
    const res = await chat.send('Location & Directions')
    expect(res.replies.length).toBeGreaterThan(0)
    expect(text(res.replies)).not.toMatch(/didn't catch|not sure/i)
  })

  it('uses the admin-configured welcome text', async () => {
    const custom = 'Namaste from the farm!\n\n1. Stay\n2. Events'
    const chat = new Chat(makeServices({ automations: automations([], { welcome_menu: { welcome_text: custom } }) }))
    const res = await chat.send('Hello')
    expect(text(res.replies)).toBe(custom)
  })

  it('accepts a numbered reply and does not repeat the welcome', async () => {
    const chat = new Chat(makeServices())
    await chat.send('Hi')
    const res = await chat.send('1')
    expect(text(res.replies)).toBe(DEFAULT_STAY_TEXT)
    expect(text(res.replies)).not.toContain('Welcome to V-Farms!')
    const avail = new Chat(makeServices())
    await avail.send('Hi')
    await avail.send('4')
    expect(avail.state.flow).toBe('availability')
  })

  it.each(['Hi', 'Hello', 'MENU', 'menu'])('"%s" opens the single welcome menu exactly once', async (body) => {
    const res = await new Chat(makeServices()).send(body)
    expect(res.replies).toHaveLength(1)
    expect(text(res.replies)).toBe(DEFAULT_WELCOME_TEXT)
  })

  it('MENU mid-flow returns to the welcome menu', async () => {
    const chat = new Chat(makeServices())
    await chat.send('Hi')
    await chat.send('1')
    expect(chat.state.flow).toBe('stay')
    const res = await chat.send('MENU')
    expect(chat.state.flow).toBe('menu')
    expect(text(res.replies)).toBe(DEFAULT_WELCOME_TEXT)
  })

  it('an image or voice note gets a safe fallback and the current question again, without moving the flow', async () => {
    const chat = new Chat(makeServices())
    const first = await handleInbound(chat.svc, chat.state, { text: '[image]', replyId: null, messageId: 'w1', unsupported: 'image' })
    expect(text(first.replies)).toContain('I can only read text messages')
    expect(text(first.replies)).toContain(DEFAULT_WELCOME_TEXT)
    await chat.send('Hi')
    await chat.send('1')
    const mid = await handleInbound(chat.svc, chat.state, { text: '[audio]', replyId: null, messageId: 'w2', unsupported: 'audio' })
    expect(text(mid.replies)).toContain('I can only read text messages')
    expect(mid.state.flow).toBe('stay')
    expect(mid.state.step).toBe(chat.state.step)
  })

  it('HUMAN hands off at any point', async () => {
    const chat = new Chat(makeServices())
    await chat.send('Hi')
    await chat.send('', 'm_stay')
    const res = await chat.send('human')
    expect(res.handoff).toBe(true)
    expect(res.handoffReason).toBe('guest_requested')
    expect(chat.svc.handoff).toHaveBeenCalled()
  })

  it('HELP lists the commands including STOP', async () => {
    const chat = new Chat(makeServices())
    await chat.send('Hi')
    const res = await chat.send('help')
    expect(text(res.replies)).toMatch(/MENU[\s\S]*BACK[\s\S]*CANCEL[\s\S]*HUMAN[\s\S]*STOP/)
  })

  it('CANCEL stops a request without booking anything', async () => {
    const chat = new Chat(makeServices())
    await chat.send('Hi')
    await chat.send('', 'm_stay')
    await chat.send('', 'st_family')
    const res = await chat.send('cancel')
    expect(text(res.replies)).toContain('Nothing was booked')
    expect(chat.state.flow).toBe('menu')
    expect(chat.svc.submitStay).not.toHaveBeenCalled()
  })

  it('BACK returns to the previous question', async () => {
    const chat = new Chat(makeServices())
    await chat.send('Hi')
    await chat.send('', 'm_stay')
    await chat.send('', 'st_family')
    await chat.send('15/11/2026')
    expect(chat.state.step).toBe('check_out')
    await chat.send('back')
    expect(chat.state.step).toBe('check_in')
  })
})

describe('WhatsApp bot — stay flow', () => {
  async function planStay(chat: Chat) {
    await chat.send('Hi')
    await chat.send('', 'm_stay')
    await chat.send('', 'st_family')
    await chat.send('15/11/2026')
    await chat.send('2 nights')
    await chat.send('4')
    // Purpose was preset by "Family stay"; this skips special requests.
    await chat.send('', 'skip')
    return chat.send('Asha Rao')
  }

  it('presets the purpose from the stay menu and skips that question', async () => {
    const chat = new Chat(makeServices())
    await planStay(chat)
    expect(chat.state.step).toBe('summary')
    expect(chat.state.data.purpose).toBe('Family stay')
  })

  it('records stay, availability and quote outcomes as automation events', async () => {
    const chat = new Chat(makeServices())
    await planStay(chat)
    const res = await chat.send('', 's_confirm')
    const byKey = Object.fromEntries(res.events.map((e) => [e.key, e.status]))
    expect(byKey).toMatchObject({ stay_enquiry: 'success', availability_check: 'success', pricing_quote: 'skipped' })
  })

  it('"Request booking" places the hold through the Booking Request flow and never claims confirmation', async () => {
    const chat = new Chat(makeServices({ reserve: vi.fn(async () => ({ outcome: 'requested' as const, holdExpiresAt: '2026-10-27T05:00:00Z' })) }))
    await planStay(chat)
    await chat.send('', 's_confirm')
    expect(chat.state.step).toBe('result')
    const res = await chat.send('', 's_reserve')
    expect(chat.svc.reserve).toHaveBeenCalledWith('b1')
    expect(res.events).toContainEqual(expect.objectContaining({ key: 'booking_request', status: 'success' }))
    expect(text(res.replies)).toContain('This is not a confirmed booking yet')
  })

  it('dates taken between enquiry and reserve: says so and offers alternatives, never a booking', async () => {
    const svc = makeServices({ reserve: vi.fn(async () => ({ outcome: 'unavailable' as const })) })
    const chat = new Chat(svc)
    await planStay(chat)
    await chat.send('', 's_confirm')
    const res = await chat.send('', 's_reserve')
    expect(text(res.replies)).toContain('those dates were just taken')
    expect(text(res.replies)).not.toMatch(/confirmed|on hold/i)
  })

  it('booking API failure hands off to staff without claiming anything is reserved', async () => {
    const svc = makeServices({ reserve: vi.fn(async () => { throw new Error('timeout') }) })
    const chat = new Chat(svc)
    await planStay(chat)
    await chat.send('', 's_confirm')
    const res = await chat.send('', 's_reserve')
    expect(res.handoff).toBe(true)
    expect(text(res.replies)).toContain("can't reserve the dates")
  })

  it('with Booking Request off, the request goes to the team and nothing is held', async () => {
    const chat = new Chat(makeServices({ automations: automations(['booking_request']) }))
    await planStay(chat)
    await chat.send('', 's_confirm')
    const res = await chat.send('', 's_reserve')
    expect(chat.svc.reserve).not.toHaveBeenCalled()
    expect(res.handoffReason).toBe('automation_disabled:booking_request')
    expect(res.events).toContainEqual(expect.objectContaining({ key: 'booking_request', status: 'skipped' }))
    expect(text(res.replies)).toContain('Nothing is reserved yet')
  })

  it('collects details, shows a summary and submits once with an idempotency key', async () => {
    const chat = new Chat(makeServices())
    const summary = await planStay(chat)
    expect(chat.state.step).toBe('summary')
    expect(text(summary.replies)).toContain('Asha Rao')
    await chat.send('', 's_confirm')
    expect(chat.svc.submitStay).toHaveBeenCalledTimes(1)
    const [data, key] = (chat.svc.submitStay as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(data).toMatchObject({ check_in: '2026-11-15', check_out: '2026-11-17', adults: 4, children: 0, name: 'Asha Rao' })
    expect(typeof key).toBe('string')
    expect(key.length).toBeGreaterThan(0)
  })

  it('never invents a price when pricing is not configured', async () => {
    const chat = new Chat(makeServices())
    await planStay(chat)
    const res = await chat.send('', 's_confirm')
    const out = text(res.replies)
    expect(out).toContain('VF-261027-ABCDE')
    expect(out).not.toMatch(/₹\s?\d/)
  })

  it('asks how many members are staying — never adults, children or their ages', async () => {
    const chat = new Chat(makeServices())
    await chat.send('Hi')
    await chat.send('', 'm_stay')
    await chat.send('', 'st_family')
    await chat.send('26 dec')
    const q = await chat.send('3 nights')
    expect(text(q.replies)).toContain('How many members will be staying?')
    const next = await chat.send('5')
    expect(chat.state.data).toMatchObject({ adults: 5, children: 0, children_ages: null })
    expect(chat.state.step).toBe('special')
    expect(text(next.replies)).not.toMatch(/children|age of each child/i)
    await chat.send('', 'skip')
    const summary = await chat.send('Asha Rao')
    expect(text(summary.replies)).toContain('Members: 5')
    expect(text(summary.replies)).not.toMatch(/Adults|Children/)
  })

  it('a conversation saved at the old children question moves on without asking it', async () => {
    const chat = new Chat(makeServices())
    chat.state = { ...chat.state, flow: 'stay', step: 'children', data: { check_in: '2026-11-15', check_out: '2026-11-17', adults: 4, purpose: 'Family stay' } }
    await chat.send('2')
    expect(chat.state.step).toBe('special')
    expect(chat.state.data).toMatchObject({ children: 0, children_ages: null })
  })

  it('rejects past dates and enforces configured capacity', async () => {
    const chat = new Chat(makeServices({ settings: settings({ max_stay_guests: 10 }) }))
    await chat.send('Hi')
    await chat.send('', 'm_stay')
    await chat.send('', 'st_family')
    await chat.send('01/01/2026')
    expect(chat.state.step).toBe('check_in')
    await chat.send('15/11/2026')
    await chat.send('2 nights')
    const res = await chat.send('12')
    expect(chat.state.step).toBe('adults')
    expect(text(res.replies)).toContain('up to 10 guests')
  })

  it('offers only the alternatives returned by the live calendar', async () => {
    const svc = makeServices({
      checkStay: vi.fn(async () => 'unavailable' as const),
      alternatives: vi.fn(async () => [{ check_in: '2026-11-20', check_out: '2026-11-22' }]),
      submitStay: vi.fn(async () => ({ ref: 'VF-261027-ABCDE', bookingId: 'b1', availability: 'unavailable' as const, quote: { status: 'not_configured' as const, missing: [] }, link: null })),
    })
    const chat = new Chat(svc)
    await chat.send('Hi')
    const res1 = await chat.send('', 'm_avail')
    const ids = optionIds(res1.replies)
    await chat.send('', ids.includes('av_stay') ? 'av_stay' : ids[0])
    await chat.send('15/11/2026')
    const res = await chat.send('2 nights')
    const out = text(res.replies)
    expect(out).not.toMatch(/\bis available\b/i)
    const altIds = optionIds(res.replies).filter((id) => id.startsWith('alt:'))
    expect(altIds.length).toBe(1)
    expect(altIds[0]).toContain('2026-11-20')
  })

  it('does not claim availability when the check failed', async () => {
    const chat = new Chat(makeServices({ checkStay: vi.fn(async () => 'unknown' as const) }))
    await chat.send('Hi')
    const res1 = await chat.send('', 'm_avail')
    const ids = optionIds(res1.replies)
    await chat.send('', ids.includes('av_stay') ? 'av_stay' : ids[0])
    await chat.send('15/11/2026')
    const res = await chat.send('2 nights')
    expect(text(res.replies)).not.toMatch(/\b(is|are) available\b/i)
  })
})

describe('WhatsApp bot — information flows', () => {
  it('pricing says "not configured" instead of inventing rates', async () => {
    const chat = new Chat(makeServices())
    await chat.send('Hi')
    await chat.send('', 'm_pricing')
    const res = await chat.send('', 'p_weekday')
    expect(text(res.replies)).not.toMatch(/₹\s?\d/)
  })

  it('pricing shows configured rates', async () => {
    const rules = {
      weekday_night_rate: 10000, weekend_night_rate: 15000, weekend_nights: [5, 6], base_guests_included: null,
      extra_adult_rate_per_night: null, extra_child_rate_per_night: null, child_age_limit: null, min_nights: 1,
      extended_stay_min_nights: null, extended_stay_discount_pct: null, tax_label: 'GST', tax_pct: null,
      prices_include_tax: false, deposit_pct: null, deposit_fixed_amount: null, quote_validity_hours: null,
      max_staff_discount_pct: 0, cancellation_rules: null, id: 'r', account_id: 'a1',
    } as PricingRules
    const chat = new Chat(makeServices({ pricing: { rules, seasonal: [], packages: [], addons: [], now: new Date() } }))
    await chat.send('Hi')
    await chat.send('', 'm_pricing')
    const res = await chat.send('', 'p_weekday')
    expect(text(res.replies)).toMatch(/10,000/)
  })

  it('location hands off to staff when no address is configured', async () => {
    const chat = new Chat(makeServices())
    await chat.send('Hi')
    const res = await chat.send('', 'm_location')
    expect(text(res.replies)).not.toMatch(/https?:\/\//)
    expect(res.handoffReason ?? 'location_not_configured').toBe('location_not_configured')
  })

  it('location shares only the configured address and map link', async () => {
    const chat = new Chat(makeServices({ settings: settings({ address: 'Plot 1, Test Village', map_url: 'https://maps.example/test' }) }))
    await chat.send('Hi')
    const res = await chat.send('', 'm_location')
    const out = text(res.replies)
    expect(out).toContain('Plot 1, Test Village')
    expect(out).toContain('https://maps.example/test')
  })

  it('offers exactly the six event types', async () => {
    const chat = new Chat(makeServices())
    await chat.send('Hi')
    const res = await chat.send('2')
    const titles = res.replies.flatMap((r) => (r.type === 'choices' ? r.options.map((o) => o.title) : []))
    expect(titles).toEqual(['Birthday', 'Anniversary', 'Family gathering', 'Private celebration', 'Corporate gathering', 'Other'])
  })

  it('explore lists only approved amenities', async () => {
    const chat = new Chat(makeServices({ amenities: [{ name: 'Dragon fruit orchard walk', description: null }] }))
    await chat.send('Hi')
    const res = await chat.send('', 'm_explore')
    const all = text(res.replies) + optionIds(res.replies).join(' ')
    expect(all).not.toMatch(/swimming pool/i)
  })

  it('Explore sends the website link, then the photos and video in order, then the topics', async () => {
    const explore = {
      website: 'https://vfarms.in/',
      media: [
        { kind: 'image' as const, url: 'https://cdn.test/1.jpg', caption: 'From above' },
        { kind: 'image' as const, url: 'https://cdn.test/2.jpg' },
        { kind: 'video' as const, url: 'https://cdn.test/tour.mp4', caption: 'Tour' },
      ],
    }
    const chat = new Chat(makeServices({ explore }))
    await chat.send('Hi')
    const res = await chat.send('5')
    expect(res.replies.map((r) => r.type)).toEqual(['text', 'media', 'media', 'media', 'choices'])
    expect(text([res.replies[0]])).toContain('https://vfarms.in/')
    expect(res.replies.slice(1, 4)).toEqual([
      { type: 'media', kind: 'image', url: 'https://cdn.test/1.jpg', caption: 'From above' },
      { type: 'media', kind: 'image', url: 'https://cdn.test/2.jpg' },
      { type: 'media', kind: 'video', url: 'https://cdn.test/tour.mp4', caption: 'Tour' },
    ])
    expect(optionIds(res.replies)).toContain('x_photos')
    expect(chat.state.step).toBe('menu')

    const more = await chat.send('', 'x_amenities')
    expect(more.replies.some((r) => r.type === 'media')).toBe(false)
    await chat.send('', 'ex_menu')
    const again = await chat.send('', 'x_photos')
    expect(again.replies.filter((r) => r.type === 'media')).toHaveLength(3)
  })

  it('Explore without configured media stays text-only', async () => {
    const chat = new Chat(makeServices())
    await chat.send('Hi')
    const res = await chat.send('', 'm_explore')
    expect(res.replies.some((r) => r.type === 'media')).toBe(false)
  })
})

describe('WhatsApp bot — automation gating', () => {
  it('hands a disabled flow to the team instead of running it', async () => {
    const chat = new Chat(makeServices({ automations: automations(['stay_enquiry']) }))
    await chat.send('Hi')
    const res = await chat.send('1')
    expect(res.handoff).toBe(true)
    expect(res.handoffReason).toBe('automation_disabled:stay_enquiry')
    expect(res.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'stay_enquiry', status: 'skipped' }),
      expect.objectContaining({ key: 'human_escalation', status: 'success' }),
    ]))
    expect(chat.svc.submitStay).not.toHaveBeenCalled()
  })

  it('cannot disable human escalation', () => {
    expect(automations(['human_escalation']).enabled.human_escalation).toBe(true)
  })

  it('does not suggest alternatives when the availability automation is off', async () => {
    const svc = makeServices({
      automations: automations(['availability_check']),
      submitStay: vi.fn(async () => ({ ref: 'VF-261027-ABCDE', bookingId: 'b1', availability: 'unavailable' as const, quote: { status: 'not_configured' as const, missing: [] }, link: null })),
    })
    const chat = new Chat(svc)
    await chat.send('Hi')
    await chat.send('', 'm_stay')
    await chat.send('', 'st_family')
    for (const m of ['15/11/2026', '2 nights', '4']) await chat.send(m)
    await chat.send('', 'n0')
    await chat.send('', 'skip')
    await chat.send('Asha Rao')
    await chat.send('', 's_confirm')
    expect(svc.alternatives).not.toHaveBeenCalled()
  })
})

describe('WhatsApp bot — cancellation and rescheduling', () => {
  const stay: GuestBooking = {
    id: 'b9', ref: 'VF-261027-AAAAA', type: 'stay', status: 'confirmed', check_in: '2026-12-10', check_out: '2026-12-12',
    event_date: null, start_time: null, end_time: null, amount_paid_paise: 1_000_000,
  }

  it('records a cancellation request for a paid booking without claiming it is cancelled', async () => {
    const svc = makeServices({ guestBookings: vi.fn(async () => [stay]) })
    const chat = new Chat(svc)
    await chat.send('Hi')
    const res1 = await chat.send('I want to cancel my booking')
    expect(text(res1.replies)).toContain(stay.ref)
    const res2 = await chat.send('', 'mg_cancel')
    expect(text(res2.replies)).toMatch(/cancellation policy hasn't been published/i)
    expect(text(res2.replies)).not.toMatch(/₹\s?\d/)
    const res3 = await chat.send('', 'mc_yes')
    expect(svc.requestCancellation).toHaveBeenCalledWith('b9')
    expect(text(res3.replies)).toContain('No refund has been processed')
    expect(text(res3.replies)).not.toMatch(/has been cancelled/)
    expect(res3.handoff).toBe(true)
    expect(res3.events).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'cancel_reschedule', status: 'success' })]))
  })

  it('quotes a refund only from configured cancellation rules', async () => {
    const rules = { cancellation_rules: [{ days_before: 30, refund_pct: 100 }, { days_before: 7, refund_pct: 50 }], min_nights: 1 } as unknown as PricingRules
    const svc = makeServices({ guestBookings: vi.fn(async () => [stay]), pricing: { rules, seasonal: [], packages: [], addons: [], now: new Date() } })
    const chat = new Chat(svc)
    await chat.send('cancel my booking')
    const res = await chat.send('', 'mg_cancel')
    expect(text(res.replies)).toContain('100% refund')
    expect(text(res.replies)).toContain('no refund has been processed yet')
  })

  it('rechecks availability for new dates and only sends a request', async () => {
    const svc = makeServices({
      guestBookings: vi.fn(async () => [stay]),
      checkReschedule: vi.fn(async () => ({ availability: 'available' as const, total_paise: 2_400_000, quote_snapshot: {} })),
    })
    const chat = new Chat(svc)
    await chat.send('I need to reschedule')
    await chat.send('', 'mg_change')
    await chat.send('20/12/2026')
    const res = await chat.send('2 nights')
    expect(svc.checkReschedule).toHaveBeenCalledWith('b9', { check_in: '2026-12-20', check_out: '2026-12-22' })
    expect(text(res.replies)).toContain('stays unchanged')
    const done = await chat.send('', 'mr_send')
    expect(svc.requestReschedule).toHaveBeenCalledTimes(1)
    expect(done.handoff).toBe(true)
  })

  it('does not offer to send a change for unavailable dates', async () => {
    const svc = makeServices({
      guestBookings: vi.fn(async () => [stay]),
      checkReschedule: vi.fn(async () => ({ availability: 'unavailable' as const, total_paise: null, quote_snapshot: null })),
    })
    const chat = new Chat(svc)
    await chat.send('change my booking dates')
    await chat.send('', 'mg_change')
    await chat.send('20/12/2026')
    const res = await chat.send('2 nights')
    expect(optionIds(res.replies)).not.toContain('mr_send')
    await chat.send('send')
    expect(svc.requestReschedule).not.toHaveBeenCalled()
  })

  it('asks for a reference when no booking is linked, and only accepts the guest’s own', async () => {
    const svc = makeServices({ findGuestBooking: vi.fn(async () => null) })
    const chat = new Chat(svc)
    const res1 = await chat.send('cancel my booking')
    expect(chat.state.step).toBe('ref')
    expect(text(res1.replies)).toContain("couldn't find an upcoming booking")
    const res2 = await chat.send('VF-261027-ZZZZZ')
    expect(svc.findGuestBooking).toHaveBeenCalledWith('VF-261027-ZZZZZ')
    expect(chat.state.step).toBe('ref')
    expect(text(res2.replies)).toContain('for this WhatsApp number')
    expect(svc.requestCancellation).not.toHaveBeenCalled()
  })

  it('hands over to the team when the automation is disabled', async () => {
    const svc = makeServices({ automations: automations(['cancel_reschedule']), guestBookings: vi.fn(async () => [stay]) })
    const chat = new Chat(svc)
    const res = await chat.send('please cancel my booking')
    expect(res.handoffReason).toBe('automation_disabled:cancel_reschedule')
    expect(svc.guestBookings).not.toHaveBeenCalled()
  })
})

describe('asksForMenu', () => {
  it('treats greetings and MENU as starting over', () => {
    for (const text of ['Hi', 'hello', 'Good morning', 'MENU', 'start over']) {
      expect(asksForMenu({ text, replyId: null, messageId: 'm' })).toBe(true)
    }
  })

  it('ignores other messages and button replies', () => {
    expect(asksForMenu({ text: 'Is the farm free on Saturday?', replyId: null, messageId: 'm' })).toBe(false)
    expect(asksForMenu({ text: 'Hi', replyId: 'stay', messageId: 'm' })).toBe(false)
  })
})

describe('instant greetings', () => {
  it.each(['Hi', 'Hello', 'Hey', 'Good morning', 'Good afternoon', 'Good evening', 'MENU', 'START', 'hi!'])(
    '"%s" gets the welcome menu deterministically, with no lookups, in well under 50ms',
    async (greeting) => {
      const svc = makeServices()
      const started = performance.now()
      const res = await handleInbound(svc, initialState(), { text: greeting, replyId: null, messageId: 'wamid.g' })
      const elapsed = performance.now() - started
      expect(optionIds(res.replies)).toEqual(['m_stay', 'm_event', 'm_pricing', 'm_avail', 'm_explore', 'm_location', 'm_human'])
      for (const fn of [svc.faqs, svc.checkStay, svc.checkEvent, svc.guestBookings, svc.findGuestBooking, svc.alternatives]) {
        expect(fn).not.toHaveBeenCalled()
      }
      expect(elapsed).toBeLessThan(50)
    },
  )
})
