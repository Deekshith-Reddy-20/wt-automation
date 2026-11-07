import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  Addon,
  Amenity,
  EventPackage,
  PricingRules,
  PropertyFaq,
  PropertyMedia,
  PropertySettings,
  SeasonalRate,
} from './types'
import type { PricingContext } from './pricing'

/**
 * Loads the estate's configuration. Numeric columns arrive from PostgREST
 * as strings for NUMERIC types, so every money / percentage field is
 * coerced here once.
 */

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v))

function coerceRules(row: Record<string, unknown> | null): PricingRules | null {
  if (!row) return null
  return {
    ...(row as unknown as PricingRules),
    weekday_night_rate: num(row.weekday_night_rate),
    weekend_night_rate: num(row.weekend_night_rate),
    weekend_nights: ((row.weekend_nights as number[] | null) ?? [5, 6]).map(Number),
    base_guests_included: num(row.base_guests_included),
    extra_adult_rate_per_night: num(row.extra_adult_rate_per_night),
    extra_child_rate_per_night: num(row.extra_child_rate_per_night),
    child_age_limit: num(row.child_age_limit),
    min_nights: Number(row.min_nights ?? 1),
    extended_stay_min_nights: num(row.extended_stay_min_nights),
    extended_stay_discount_pct: num(row.extended_stay_discount_pct),
    tax_pct: num(row.tax_pct),
    deposit_pct: num(row.deposit_pct),
    deposit_fixed_amount: num(row.deposit_fixed_amount),
    quote_validity_hours: num(row.quote_validity_hours),
    max_staff_discount_pct: Number(row.max_staff_discount_pct ?? 0),
  }
}

function coerceSeasonal(rows: Record<string, unknown>[]): SeasonalRate[] {
  return rows.map((r) => ({
    ...(r as unknown as SeasonalRate),
    nightly_rate: Number(r.nightly_rate),
    weekend_nightly_rate: num(r.weekend_nightly_rate),
    min_nights: num(r.min_nights),
  }))
}

function coercePackages(rows: Record<string, unknown>[]): EventPackage[] {
  return rows.map((r) => ({
    ...(r as unknown as EventPackage),
    base_price: Number(r.base_price),
    included_hours: num(r.included_hours),
    extra_hour_rate: num(r.extra_hour_rate),
    max_guests: num(r.max_guests),
  }))
}

function coerceAddons(rows: Record<string, unknown>[]): Addon[] {
  return rows.map((r) => ({ ...(r as unknown as Addon), price: Number(r.price) }))
}

function coerceSettings(row: Record<string, unknown> | null): PropertySettings | null {
  if (!row) return null
  return {
    ...(row as unknown as PropertySettings),
    room_count: num(row.room_count),
    property_area_acres: num(row.property_area_acres),
    latitude: num(row.latitude),
    longitude: num(row.longitude),
    max_stay_guests: num(row.max_stay_guests),
    max_event_guests: num(row.max_event_guests),
    test_phone_numbers: (row.test_phone_numbers as string[] | null) ?? [],
    notification_settings: (row.notification_settings as Record<string, unknown>) ?? {},
    reminder_settings: (row.reminder_settings as PropertySettings['reminder_settings']) ?? {},
  }
}

export interface PropertyBundle {
  settings: PropertySettings | null
  pricing: PricingContext
}

/** Everything the booking engine needs for one account. */
export async function loadPropertyBundle(db: SupabaseClient, accountId: string): Promise<PropertyBundle> {
  const [settings, rules, seasonal, packages, addons] = await Promise.all([
    db.from('property_settings').select('*').eq('account_id', accountId).maybeSingle(),
    db.from('pricing_rules').select('*').eq('account_id', accountId).maybeSingle(),
    db.from('seasonal_rates').select('*').eq('account_id', accountId).eq('is_active', true),
    db.from('event_packages').select('*').eq('account_id', accountId).order('sort_order'),
    db.from('addons').select('*').eq('account_id', accountId),
  ])
  for (const r of [settings, rules, seasonal, packages, addons]) {
    if (r.error) throw new Error(`Could not load property configuration: ${r.error.message}`)
  }
  return {
    settings: coerceSettings(settings.data),
    pricing: {
      rules: coerceRules(rules.data),
      seasonal: coerceSeasonal(seasonal.data ?? []),
      packages: coercePackages(packages.data ?? []),
      addons: coerceAddons(addons.data ?? []),
    },
  }
}

/** The account whose property is published on the public website. */
export async function getPublishedAccountId(db: SupabaseClient): Promise<string | null> {
  const { data, error } = await db
    .from('property_settings')
    .select('account_id')
    .eq('is_published', true)
    .limit(2)
  if (error) throw new Error(`Could not resolve published property: ${error.message}`)
  if (!data || data.length !== 1) return null
  return data[0].account_id as string
}

/**
 * The guest-facing view of the property: only published, approved
 * information. Fields the admin hasn't filled in are null and must be
 * rendered as absent, not guessed.
 */
export interface PublicProperty {
  resort_name: string
  tagline: string | null
  description: string | null
  farm_description: string | null
  building_description: string | null
  room_count: number | null
  property_area_acres: number | null
  address: string | null
  locality: string | null
  map_url: string | null
  directions: string | null
  contact_phone: string | null
  contact_email: string | null
  whatsapp_number: string | null
  check_in_time: string | null
  check_out_time: string | null
  max_stay_guests: number | null
  max_event_guests: number | null
  guest_policies: string | null
  event_policies: string | null
  cancellation_policy: string | null
  refund_policy: string | null
  food_info: string | null
  activities_info: string | null
  accessibility_info: string | null
  parking_info: string | null
  privacy_policy: string | null
  terms: string | null
  payments_enabled: boolean
  amenities: Pick<Amenity, 'id' | 'name' | 'description' | 'applies_to'>[]
  media: Pick<PropertyMedia, 'id' | 'public_url' | 'caption' | 'alt_text' | 'category'>[]
}

const PUBLIC_FIELDS = [
  'resort_name', 'tagline', 'description', 'farm_description', 'building_description',
  'room_count', 'property_area_acres', 'address', 'locality', 'map_url', 'directions',
  'contact_phone', 'contact_email', 'whatsapp_number', 'check_in_time', 'check_out_time',
  'max_stay_guests', 'max_event_guests', 'guest_policies', 'event_policies',
  'cancellation_policy', 'refund_policy', 'food_info', 'activities_info',
  'accessibility_info', 'parking_info', 'privacy_policy', 'terms', 'payments_enabled',
] as const

export async function loadPublicProperty(
  db: SupabaseClient,
): Promise<{ accountId: string; property: PublicProperty } | null> {
  const accountId = await getPublishedAccountId(db)
  if (!accountId) return null
  const [settings, amenities, media] = await Promise.all([
    db.from('property_settings').select(PUBLIC_FIELDS.join(', ')).eq('account_id', accountId).maybeSingle(),
    db
      .from('amenities')
      .select('id, name, description, applies_to')
      .eq('account_id', accountId)
      .eq('is_approved', true)
      .order('sort_order'),
    db
      .from('property_media')
      .select('id, public_url, caption, alt_text, category')
      .eq('account_id', accountId)
      .eq('is_approved', true)
      .eq('is_verified_property_photo', true)
      .order('sort_order'),
  ])
  if (settings.error || !settings.data) return null
  const s = coerceSettings(settings.data as unknown as Record<string, unknown>) as unknown as PublicProperty
  return {
    accountId,
    property: {
      ...s,
      amenities: (amenities.data ?? []) as PublicProperty['amenities'],
      media: (media.data ?? []) as PublicProperty['media'],
    },
  }
}

export async function loadPublishedFaqs(db: SupabaseClient, accountId: string): Promise<Pick<PropertyFaq, 'id' | 'question' | 'answer'>[]> {
  const { data, error } = await db
    .from('property_faqs')
    .select('id, question, answer')
    .eq('account_id', accountId)
    .eq('is_published', true)
    .order('sort_order')
  if (error) throw new Error(`Could not load FAQs: ${error.message}`)
  return data ?? []
}

/** Labels for the admin "Not configured" checklist. */
export const CONFIG_CHECKLIST: { field: keyof PropertySettings; label: string; affects: string }[] = [
  { field: 'description', label: 'Resort description', affects: 'Website home page, WhatsApp "Explore"' },
  { field: 'address', label: 'Address', affects: 'Location & directions' },
  { field: 'map_url', label: 'Map link', affects: 'Location & directions' },
  { field: 'directions', label: 'Directions', affects: 'Location & directions' },
  { field: 'contact_phone', label: 'Contact phone', affects: 'Contact page' },
  { field: 'check_in_time', label: 'Check-in time', affects: 'Guests are told times only when set' },
  { field: 'check_out_time', label: 'Check-out time', affects: 'Guests are told times only when set' },
  { field: 'max_stay_guests', label: 'Maximum overnight guests', affects: 'Occupancy limits (without it, requests go to manual review)' },
  { field: 'max_event_guests', label: 'Maximum event guests', affects: 'Event capacity checks' },
  { field: 'guest_policies', label: 'Guest policies', affects: 'Policies page, WhatsApp' },
  { field: 'event_policies', label: 'Event policies', affects: 'Events page, WhatsApp' },
  { field: 'cancellation_policy', label: 'Cancellation policy', affects: 'Required before taking payments' },
  { field: 'refund_policy', label: 'Refund policy', affects: 'Required before taking payments' },
  { field: 'privacy_policy', label: 'Privacy policy', affects: 'Privacy page' },
  { field: 'terms', label: 'Terms', affects: 'Terms page' },
]

export function missingSettings(settings: PropertySettings | null): typeof CONFIG_CHECKLIST {
  if (!settings) return CONFIG_CHECKLIST
  return CONFIG_CHECKLIST.filter((c) => {
    const v = settings[c.field]
    return v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
  })
}

export function missingPricing(rules: PricingRules | null): string[] {
  if (!rules) return ['Weekday night rate', 'Weekend night rate', 'Tax', 'Advance / deposit', 'Quote validity']
  const out: string[] = []
  if (rules.weekday_night_rate === null) out.push('Weekday night rate')
  if (rules.weekend_night_rate === null) out.push('Weekend night rate')
  if (rules.tax_pct === null) out.push('Tax')
  if (rules.deposit_pct === null && rules.deposit_fixed_amount === null) out.push('Advance / deposit')
  if (rules.quote_validity_hours === null) out.push('Quote validity')
  return out
}

/** Online payment requires policies the guest agrees to and a deposit rule. */
export function paymentsReady(settings: PropertySettings | null, rules: PricingRules | null): boolean {
  return Boolean(
    settings?.payments_enabled &&
      settings.cancellation_policy &&
      settings.refund_policy &&
      rules &&
      (rules.deposit_pct !== null || rules.deposit_fixed_amount !== null),
  )
}
