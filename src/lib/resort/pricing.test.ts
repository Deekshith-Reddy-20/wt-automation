import { describe, expect, it } from 'vitest'
import { describeRates, discountWithinLimit, formatQuoteText, quoteEvent, quoteStay, type PricingContext } from './pricing'
import type { EventPackage, PricingRules, SeasonalRate } from './types'

// Synthetic test rates — not V-Farms business data.
function rules(over: Partial<PricingRules> = {}): PricingRules {
  return {
    id: 'r1',
    account_id: 'a1',
    weekday_night_rate: 10000,
    weekend_night_rate: 15000,
    weekend_nights: [5, 6],
    base_guests_included: null,
    extra_adult_rate_per_night: null,
    extra_child_rate_per_night: null,
    child_age_limit: null,
    min_nights: 1,
    extended_stay_min_nights: null,
    extended_stay_discount_pct: null,
    tax_label: 'GST',
    tax_pct: null,
    prices_include_tax: false,
    deposit_pct: null,
    deposit_fixed_amount: null,
    quote_validity_hours: null,
    max_staff_discount_pct: 0,
    cancellation_rules: null,
    ...over,
  }
}

const ctx = (r: PricingRules | null, extra: Partial<PricingContext> = {}): PricingContext => ({
  rules: r,
  seasonal: [],
  packages: [],
  addons: [],
  now: new Date('2026-10-27T04:30:00Z'),
  ...extra,
})

// 2026-11-05 is a Thursday → nights Thu, Fri, Sat
const STAY = { check_in: '2026-11-05', check_out: '2026-11-08', adults: 4, children: 0 }

describe('quoteStay', () => {
  it('refuses to quote without configured pricing', () => {
    expect(quoteStay(ctx(null), STAY)).toEqual({ status: 'not_configured', missing: ['pricing_rules'] })
    expect(quoteStay(ctx(rules({ weekend_night_rate: null })), STAY)).toEqual({ status: 'not_configured', missing: ['weekend_night_rate'] })
  })

  it('prices weekday and weekend nights separately, in paise', () => {
    const r = quoteStay(ctx(rules()), STAY)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.quote.nights).toBe(3)
    expect(r.quote.subtotal).toBe((10000 + 15000 * 2) * 100)
    expect(r.quote.total).toBe(r.quote.subtotal)
    expect(r.quote.advance).toBeNull() // no deposit rule → no online advance
  })

  it('applies tax, deposit and validity from the rules only', () => {
    const r = quoteStay(ctx(rules({ tax_pct: 18, deposit_pct: 30, quote_validity_hours: 48 })), STAY)
    if (r.status !== 'ok') throw new Error(r.status)
    expect(r.quote.tax).toBe(Math.round(4_000_000 * 0.18))
    expect(r.quote.total).toBe(4_000_000 + 720_000)
    expect(r.quote.advance).toBe(Math.round(4_720_000 * 0.3))
    expect(r.quote.balance).toBe(r.quote.total - r.quote.advance!)
    expect(r.quote.valid_until).toBe('2026-10-29T04:30:00.000Z')
  })

  it('extracts included tax instead of adding it', () => {
    const r = quoteStay(ctx(rules({ tax_pct: 18, prices_include_tax: true })), STAY)
    if (r.status !== 'ok') throw new Error(r.status)
    expect(r.quote.total).toBe(4_000_000)
    expect(r.quote.tax).toBe(Math.round((4_000_000 * 18) / 118))
  })

  it('lets special dates override seasons', () => {
    const seasonal: SeasonalRate[] = [
      { id: 's1', name: 'Winter', kind: 'season', start_date: '2026-11-01', end_date: '2026-11-30', nightly_rate: 12000, weekend_nightly_rate: null, min_nights: null, is_active: true },
      { id: 's2', name: 'Festival', kind: 'special_date', start_date: '2026-11-06', end_date: '2026-11-06', nightly_rate: 20000, weekend_nightly_rate: null, min_nights: 2, is_active: true },
    ]
    const r = quoteStay(ctx(rules(), { seasonal }), STAY)
    if (r.status !== 'ok') throw new Error(r.status)
    expect(r.quote.subtotal).toBe((12000 * 2 + 20000) * 100)
    const short = quoteStay(ctx(rules(), { seasonal }), { ...STAY, check_in: '2026-11-06', check_out: '2026-11-07' })
    expect(short).toEqual({ status: 'below_min_nights', min_nights: 2 })
  })

  it('charges extra guests only beyond those included, with child age limit', () => {
    const r = quoteStay(
      ctx(rules({ base_guests_included: 4, extra_adult_rate_per_night: 1000, extra_child_rate_per_night: 500, child_age_limit: 10 })),
      { ...STAY, adults: 5, children: 2, children_ages: [6, 12] },
    )
    if (r.status !== 'ok') throw new Error(r.status)
    const extraAdult = r.quote.lines.find((l) => l.code === 'extra_adult')!
    const extraChild = r.quote.lines.find((l) => l.code === 'extra_child')!
    expect(extraAdult.quantity).toBe(2 * 3) // 5 adults + one 12-year-old priced as adult, 4 included
    expect(extraChild.quantity).toBe(1 * 3)
  })

  it('reports a missing extra-guest rate rather than assuming one', () => {
    const r = quoteStay(ctx(rules({ base_guests_included: 2 })), STAY)
    expect(r).toEqual({ status: 'not_configured', missing: ['extra_adult_rate_per_night'] })
  })

  it('applies the extended-stay discount and staff discounts', () => {
    const r = quoteStay(
      ctx(rules({ extended_stay_min_nights: 3, extended_stay_discount_pct: 10 })),
      STAY,
      { amount: 100_000, reason: 'Repeat guest' },
    )
    if (r.status !== 'ok') throw new Error(r.status)
    expect(r.quote.discount).toBe(400_000 + 100_000)
    expect(r.quote.discount_reason).toContain('Repeat guest')
    expect(quoteStay(ctx(rules()), STAY, { amount: 999_999_999, reason: 'x' })).toEqual({ status: 'invalid', reason: 'discount_exceeds_subtotal' })
  })
})

describe('quoteEvent', () => {
  const pkg = (over: Partial<EventPackage> = {}): EventPackage => ({
    id: 'p1', name: 'Day celebration', description: null, event_types: null, base_price: 50000,
    included_hours: 6, extra_hour_rate: 5000, max_guests: 60, includes_accommodation: false, is_active: true, ...over,
  })

  it('needs an active package', () => {
    expect(quoteEvent(ctx(rules()), { event_type: 'birthday', event_hours: 4, guest_count: 30 })).toEqual({ status: 'not_configured', missing: ['event_package'] })
    expect(quoteEvent(ctx(rules(), { packages: [pkg({ is_active: false })] }), { event_type: 'birthday', event_hours: 4, guest_count: 30 }).status).toBe('not_configured')
  })
  it('adds extra hours and enforces package capacity', () => {
    const r = quoteEvent(ctx(rules(), { packages: [pkg()] }), { event_type: 'birthday', event_hours: 7.5, guest_count: 40 })
    if (r.status !== 'ok') throw new Error(r.status)
    expect(r.quote.subtotal).toBe(50000_00 + 2 * 5000_00)
    expect(quoteEvent(ctx(rules(), { packages: [pkg()] }), { event_type: 'birthday', event_hours: 4, guest_count: 80 }))
      .toEqual({ status: 'exceeds_package_capacity', max_guests: 60 })
  })
  it('asks the guest to choose when several packages fit', () => {
    const r = quoteEvent(ctx(rules(), { packages: [pkg(), pkg({ id: 'p2', name: 'Evening' })] }), { event_type: 'birthday', event_hours: 4, guest_count: 20 })
    expect(r.status).toBe('needs_package_selection')
  })
})

describe('discounts and display', () => {
  it('caps staff discounts at the configured percentage', () => {
    expect(discountWithinLimit(100_000, 0, 0)).toBe(true)
    expect(discountWithinLimit(100_000, 1, 0)).toBe(false)
    expect(discountWithinLimit(100_000, 10_000, 10)).toBe(true)
    expect(discountWithinLimit(100_000, 10_001, 10)).toBe(false)
  })
  it('says when no advance or validity is configured', () => {
    const r = quoteStay(ctx(rules()), STAY)
    if (r.status !== 'ok') throw new Error(r.status)
    const text = formatQuoteText(r.quote)
    expect(text).toContain('Advance: our team will share payment details.')
    expect(text).toContain('Quote validity: confirmed by our team.')
  })
  it('describes only configured rates', () => {
    const d = describeRates(ctx(rules({ weekday_night_rate: null })))
    expect(d.weekday).toBeNull()
    expect(d.weekend).toBe(1_500_000)
    expect(describeRates(ctx(null)).min_nights).toBeNull()
  })
})
