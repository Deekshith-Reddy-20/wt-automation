import type { Addon, EventPackage, EventType, PricingRules, SeasonalRate } from './types'
import { isoWeekday, nightsOf } from './time'

/**
 * Quote engine. Pure and deterministic: given the configured pricing and a
 * request it either produces an itemised quote or says exactly which rule
 * is missing. It never fills a gap with an assumed amount.
 *
 * All arithmetic is in integer paise. Percentages are applied with
 * half-up rounding to the paisa, once per line.
 */

export type Paise = number

export function rupeesToPaise(rupees: number): Paise {
  return Math.round(rupees * 100)
}

export function paiseToRupees(paise: Paise): number {
  return paise / 100
}

export function formatINR(paise: Paise): string {
  const rupees = paise / 100
  return `₹${rupees.toLocaleString('en-IN', {
    minimumFractionDigits: rupees % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`
}

function pct(amount: Paise, percent: number): Paise {
  return Math.round((amount * percent) / 100)
}

export interface QuoteLine {
  code: string
  label: string
  quantity: number
  unit_amount: Paise
  amount: Paise
}

export interface Quote {
  booking_type: 'stay' | 'event'
  nights: number | null
  event_hours: number | null
  lines: QuoteLine[]
  /** Sum of the lines before discount and tax. */
  subtotal: Paise
  discount: Paise
  discount_reason: string | null
  /** Tax added on top (or the included portion when prices include tax). */
  tax: Paise
  tax_label: string
  tax_included: boolean
  total: Paise
  /** null when no deposit rule is configured — online advance unavailable. */
  advance: Paise | null
  balance: Paise | null
  valid_until: string | null
}

export type QuoteResult =
  | { status: 'ok'; quote: Quote }
  | { status: 'not_configured'; missing: string[] }
  | { status: 'below_min_nights'; min_nights: number }
  | { status: 'exceeds_package_capacity'; max_guests: number }
  | { status: 'needs_package_selection'; packages: { id: string; name: string }[] }
  | { status: 'invalid'; reason: string }

export interface StayQuoteRequest {
  check_in: string
  check_out: string
  adults: number
  children: number
  children_ages?: number[] | null
  addon_ids?: string[]
}

export interface EventQuoteRequest {
  event_type: EventType
  event_hours: number
  guest_count: number
  package_id?: string | null
  addon_ids?: string[]
}

/** A staff-authorised discount; checked against discountWithinLimit first. */
export interface ManualDiscount {
  amount: Paise
  reason: string
}

export interface PricingContext {
  rules: PricingRules | null
  seasonal: SeasonalRate[]
  packages: EventPackage[]
  addons: Addon[]
  now?: Date
}

function nightlyRate(
  night: string,
  rules: PricingRules,
  seasonal: SeasonalRate[],
): { amount: number | null; source: string; minNights: number | null } {
  const isWeekend = rules.weekend_nights.includes(isoWeekday(night))
  const active = seasonal
    .filter((s) => s.is_active && s.start_date <= night && night <= s.end_date)
    .sort((a, b) => tier(b) - tier(a))
  const season = active[0]
  if (season) {
    const amount = isWeekend && season.weekend_nightly_rate !== null ? season.weekend_nightly_rate : season.nightly_rate
    return { amount, source: season.name, minNights: season.min_nights }
  }
  if (isWeekend) {
    return { amount: rules.weekend_night_rate, source: 'weekend', minNights: null }
  }
  return { amount: rules.weekday_night_rate, source: 'weekday', minNights: null }
}

function tier(s: SeasonalRate): number {
  return s.kind === 'season' ? 1 : 2
}

function applyAddons(
  addonIds: string[] | undefined,
  addons: Addon[],
  appliesTo: 'stay' | 'event',
  nights: number,
  guests: number,
): { lines: QuoteLine[]; missing: string[] } {
  const lines: QuoteLine[] = []
  const missing: string[] = []
  for (const id of addonIds ?? []) {
    const addon = addons.find((a) => a.id === id)
    if (!addon || !addon.is_active || (addon.applies_to !== 'both' && addon.applies_to !== appliesTo)) {
      missing.push(`addon:${id}`)
      continue
    }
    const unit = rupeesToPaise(addon.price)
    const quantity =
      addon.unit === 'per_night' ? nights
        : addon.unit === 'per_guest' ? guests
          : addon.unit === 'per_guest_per_night' ? guests * nights
            : 1
    lines.push({ code: `addon:${addon.id}`, label: addon.name, quantity, unit_amount: unit, amount: unit * quantity })
  }
  return { lines, missing }
}

function finalise(
  ctx: { rules: PricingRules; now?: Date },
  base: Omit<Quote, 'subtotal' | 'discount' | 'discount_reason' | 'tax' | 'tax_label' | 'tax_included' | 'total' | 'advance' | 'balance' | 'valid_until'>,
  automaticDiscount: { amount: Paise; reason: string } | null,
  manual: ManualDiscount | null,
): QuoteResult {
  const { rules } = ctx
  const subtotal = base.lines.reduce((sum, l) => sum + l.amount, 0)
  let discount = 0
  const reasons: string[] = []
  if (automaticDiscount && automaticDiscount.amount > 0) {
    discount += automaticDiscount.amount
    reasons.push(automaticDiscount.reason)
  }
  if (manual && manual.amount > 0) {
    discount += manual.amount
    reasons.push(manual.reason)
  }
  if (discount > subtotal) return { status: 'invalid', reason: 'discount_exceeds_subtotal' }

  const afterDiscount = subtotal - discount
  let tax = 0
  let total = afterDiscount
  if (rules.tax_pct !== null && rules.tax_pct > 0) {
    if (rules.prices_include_tax) {
      tax = Math.round((afterDiscount * rules.tax_pct) / (100 + rules.tax_pct))
    } else {
      tax = pct(afterDiscount, rules.tax_pct)
      total = afterDiscount + tax
    }
  }

  let advance: Paise | null = null
  if (rules.deposit_pct !== null) advance = pct(total, rules.deposit_pct)
  else if (rules.deposit_fixed_amount !== null) advance = Math.min(total, rupeesToPaise(rules.deposit_fixed_amount))

  const now = ctx.now ?? new Date()
  const validUntil = rules.quote_validity_hours
    ? new Date(now.getTime() + rules.quote_validity_hours * 3_600_000).toISOString()
    : null

  return {
    status: 'ok',
    quote: {
      ...base,
      subtotal,
      discount,
      discount_reason: reasons.length ? reasons.join('; ') : null,
      tax,
      tax_label: rules.tax_label,
      tax_included: rules.prices_include_tax,
      total,
      advance,
      balance: advance === null ? null : total - advance,
      valid_until: validUntil,
    },
  }
}

export function quoteStay(
  ctx: PricingContext,
  req: StayQuoteRequest,
  manual: ManualDiscount | null = null,
): QuoteResult {
  const { rules } = ctx
  if (!rules) return { status: 'not_configured', missing: ['pricing_rules'] }
  const nights = nightsOf(req.check_in, req.check_out)
  if (nights.length === 0) return { status: 'invalid', reason: 'no_nights' }

  const missing: string[] = []
  const lines: QuoteLine[] = []
  let minNights = rules.min_nights
  const grouped = new Map<string, { label: string; unit: Paise; qty: number }>()
  for (const night of nights) {
    const rate = nightlyRate(night, rules, ctx.seasonal)
    if (rate.minNights) minNights = Math.max(minNights, rate.minNights)
    if (rate.amount === null) {
      missing.push(rate.source === 'weekend' ? 'weekend_night_rate' : 'weekday_night_rate')
      continue
    }
    const unit = rupeesToPaise(rate.amount)
    const label =
      rate.source === 'weekday' ? 'Estate — weekday night'
        : rate.source === 'weekend' ? 'Estate — weekend night'
          : `Estate — ${rate.source}`
    const key = `${label}|${unit}`
    const g = grouped.get(key)
    if (g) g.qty += 1
    else grouped.set(key, { label, unit, qty: 1 })
  }
  for (const [key, g] of grouped) {
    lines.push({ code: `night:${key.split('|')[0]}`, label: g.label, quantity: g.qty, unit_amount: g.unit, amount: g.unit * g.qty })
  }

  if (missing.length) return { status: 'not_configured', missing: [...new Set(missing)] }
  if (nights.length < minNights) return { status: 'below_min_nights', min_nights: minNights }

  // Extra guests beyond those included in the estate rate.
  if (rules.base_guests_included !== null) {
    const ages = req.children_ages ?? []
    const childLimit = rules.child_age_limit
    let pricedAdults = req.adults
    let pricedChildren = req.children
    if (childLimit !== null && ages.length === req.children) {
      const olderChildren = ages.filter((a) => a > childLimit).length
      pricedAdults += olderChildren
      pricedChildren -= olderChildren
    }
    // Included places cover adults first, then children.
    const extraAdults = Math.max(0, pricedAdults - rules.base_guests_included)
    const placesLeft = Math.max(0, rules.base_guests_included - pricedAdults)
    const extraChildren = Math.max(0, pricedChildren - placesLeft)
    if (extraAdults > 0) {
      if (rules.extra_adult_rate_per_night === null) return { status: 'not_configured', missing: ['extra_adult_rate_per_night'] }
      const unit = rupeesToPaise(rules.extra_adult_rate_per_night)
      const qty = extraAdults * nights.length
      lines.push({ code: 'extra_adult', label: 'Extra adult (per night)', quantity: qty, unit_amount: unit, amount: unit * qty })
    }
    if (extraChildren > 0) {
      if (rules.extra_child_rate_per_night === null) return { status: 'not_configured', missing: ['extra_child_rate_per_night'] }
      const unit = rupeesToPaise(rules.extra_child_rate_per_night)
      const qty = extraChildren * nights.length
      lines.push({ code: 'extra_child', label: 'Extra child (per night)', quantity: qty, unit_amount: unit, amount: unit * qty })
    }
  }

  const addons = applyAddons(req.addon_ids, ctx.addons, 'stay', nights.length, req.adults + req.children)
  if (addons.missing.length) return { status: 'not_configured', missing: addons.missing }
  lines.push(...addons.lines)

  let automatic: { amount: Paise; reason: string } | null = null
  if (
    rules.extended_stay_min_nights !== null &&
    rules.extended_stay_discount_pct !== null &&
    nights.length >= rules.extended_stay_min_nights
  ) {
    const nightTotal = lines.filter((l) => l.code.startsWith('night:')).reduce((s, l) => s + l.amount, 0)
    automatic = {
      amount: pct(nightTotal, rules.extended_stay_discount_pct),
      reason: `Extended stay (${rules.extended_stay_discount_pct}% off estate nights)`,
    }
  }

  return finalise(
    { rules, now: ctx.now },
    { booking_type: 'stay', nights: nights.length, event_hours: null, lines },
    automatic,
    manual,
  )
}

export function quoteEvent(
  ctx: PricingContext,
  req: EventQuoteRequest,
  manual: ManualDiscount | null = null,
): QuoteResult {
  const { rules } = ctx
  if (!rules) return { status: 'not_configured', missing: ['pricing_rules'] }
  const candidates = ctx.packages.filter(
    (p) => p.is_active && (!p.event_types || p.event_types.length === 0 || p.event_types.includes(req.event_type)),
  )
  let pkg: EventPackage | undefined
  if (req.package_id) {
    pkg = candidates.find((p) => p.id === req.package_id)
    if (!pkg) return { status: 'not_configured', missing: ['event_package'] }
  } else if (candidates.length === 1) {
    pkg = candidates[0]
  } else if (candidates.length === 0) {
    return { status: 'not_configured', missing: ['event_package'] }
  } else {
    return { status: 'needs_package_selection', packages: candidates.map((p) => ({ id: p.id, name: p.name })) }
  }

  if (pkg.max_guests !== null && req.guest_count > pkg.max_guests) {
    return { status: 'exceeds_package_capacity', max_guests: pkg.max_guests }
  }

  const lines: QuoteLine[] = []
  const base = rupeesToPaise(pkg.base_price)
  lines.push({ code: `package:${pkg.id}`, label: pkg.name, quantity: 1, unit_amount: base, amount: base })

  if (pkg.included_hours !== null && req.event_hours > pkg.included_hours) {
    const extraHours = Math.ceil(req.event_hours - pkg.included_hours)
    if (pkg.extra_hour_rate === null) return { status: 'not_configured', missing: ['extra_hour_rate'] }
    const unit = rupeesToPaise(pkg.extra_hour_rate)
    lines.push({ code: 'extra_hours', label: 'Additional hours', quantity: extraHours, unit_amount: unit, amount: unit * extraHours })
  }

  const addons = applyAddons(req.addon_ids, ctx.addons, 'event', 1, req.guest_count)
  if (addons.missing.length) return { status: 'not_configured', missing: addons.missing }
  lines.push(...addons.lines)

  return finalise(
    { rules, now: ctx.now },
    { booking_type: 'event', nights: null, event_hours: req.event_hours, lines },
    null,
    manual,
  )
}

/** Discount ceiling check for staff-authorised discounts. */
export function discountWithinLimit(subtotal: Paise, discount: Paise, maxPct: number): boolean {
  if (discount <= 0) return true
  return discount <= pct(subtotal, maxPct)
}

/** Plain-text quote breakdown for WhatsApp and emails. */
export function formatQuoteText(q: Quote): string {
  const rows: string[] = []
  for (const l of q.lines) {
    rows.push(l.quantity > 1 ? `• ${l.label} × ${l.quantity}: ${formatINR(l.amount)}` : `• ${l.label}: ${formatINR(l.amount)}`)
  }
  if (q.nights) rows.push(`Nights: ${q.nights}`)
  if (q.event_hours) rows.push(`Duration: ${q.event_hours} hours`)
  rows.push(`Subtotal: ${formatINR(q.subtotal)}`)
  if (q.discount > 0) rows.push(`Discount${q.discount_reason ? ` (${q.discount_reason})` : ''}: −${formatINR(q.discount)}`)
  if (q.tax > 0) rows.push(q.tax_included ? `${q.tax_label} included: ${formatINR(q.tax)}` : `${q.tax_label}: ${formatINR(q.tax)}`)
  rows.push(`*Total payable: ${formatINR(q.total)}*`)
  if (q.advance !== null && q.balance !== null) {
    rows.push(`Advance to reserve: ${formatINR(q.advance)}`)
    rows.push(`Balance: ${formatINR(q.balance)}`)
  } else {
    rows.push('Advance: our team will share payment details.')
  }
  rows.push(q.valid_until ? `Quote valid until: ${formatValidity(q.valid_until)}` : 'Quote validity: confirmed by our team.')
  return rows.join('\n')
}

function formatValidity(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** What a pricing category can tell a guest right now. */
export function describeRates(ctx: PricingContext): {
  weekday: Paise | null
  weekend: Paise | null
  seasonal: { name: string; kind: SeasonalRate['kind']; start: string; end: string; nightly: Paise }[]
  extended: { min_nights: number; pct: number } | null
  packages: { name: string; base: Paise; hours: number | null; max_guests: number | null }[]
  addons: { name: string; price: Paise; unit: Addon['unit'] }[]
  min_nights: number | null
} {
  const r = ctx.rules
  return {
    weekday: r?.weekday_night_rate != null ? rupeesToPaise(r.weekday_night_rate) : null,
    weekend: r?.weekend_night_rate != null ? rupeesToPaise(r.weekend_night_rate) : null,
    seasonal: ctx.seasonal
      .filter((s) => s.is_active)
      .map((s) => ({ name: s.name, kind: s.kind, start: s.start_date, end: s.end_date, nightly: rupeesToPaise(s.nightly_rate) })),
    extended:
      r && r.extended_stay_min_nights !== null && r.extended_stay_discount_pct !== null
        ? { min_nights: r.extended_stay_min_nights, pct: r.extended_stay_discount_pct }
        : null,
    packages: ctx.packages
      .filter((p) => p.is_active)
      .map((p) => ({ name: p.name, base: rupeesToPaise(p.base_price), hours: p.included_hours, max_guests: p.max_guests })),
    addons: ctx.addons.filter((a) => a.is_active).map((a) => ({ name: a.name, price: rupeesToPaise(a.price), unit: a.unit })),
    min_nights: r ? r.min_nights : null,
  }
}
