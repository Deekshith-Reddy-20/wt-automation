import { z } from 'zod'
import { EVENT_TYPES, LEAD_PRIORITIES, LEAD_STAGES } from './types'
import { normalizeTime } from './time'

const text = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null))
const money = z.number().min(0).max(100_000_000)
const pct = z.number().min(0).max(100)
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const timeOfDay = z
  .string()
  .nullable()
  .optional()
  .refine((v) => v == null || v === '' || normalizeTime(v) !== null, 'Use HH:MM (24-hour)')
  .transform((v) => (v ? normalizeTime(v) : null))
const e164 = z.string().regex(/^\+[1-9][0-9]{7,14}$/, 'Use international format, e.g. +919876543210')

/** Property settings an admin may edit. Unknown keys are rejected. */
export const propertySettingsPatchSchema = z
  .object({
    resort_name: z.string().trim().min(1).max(120),
    tagline: text(200),
    description: text(4000),
    farm_description: text(4000),
    building_description: text(4000),
    room_count: z.number().int().positive().max(100).nullable(),
    property_area_acres: z.number().positive().max(10_000).nullable(),
    address: text(500),
    locality: text(200),
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
    map_url: z.string().url().startsWith('https://').nullable().or(z.literal('').transform(() => null)),
    directions: text(4000),
    contact_phone: e164.nullable().or(z.literal('').transform(() => null)),
    contact_email: z.string().email().nullable().or(z.literal('').transform(() => null)),
    whatsapp_number: e164.nullable().or(z.literal('').transform(() => null)),
    check_in_time: timeOfDay,
    check_out_time: timeOfDay,
    max_stay_guests: z.number().int().positive().max(500).nullable(),
    max_event_guests: z.number().int().positive().max(5000).nullable(),
    guest_policies: text(8000),
    event_policies: text(8000),
    cancellation_policy: text(8000),
    refund_policy: text(8000),
    food_info: text(4000),
    activities_info: text(4000),
    accessibility_info: text(4000),
    parking_info: text(4000),
    privacy_policy: text(20000),
    terms: text(20000),
    is_published: z.boolean(),
    bot_enabled: z.boolean(),
    test_mode: z.boolean(),
    test_phone_numbers: z.array(e164).max(20),
    payments_enabled: z.boolean(),
    manual_approval_required: z.boolean(),
    holds_enabled: z.boolean(),
    hold_duration_minutes: z.number().int().min(5).max(2880),
    event_buffer_minutes: z.number().int().min(0).max(720),
    notification_settings: z.record(z.string(), z.boolean()),
    reminder_settings: z
      .object({
        arrival_reminder_hours: z.number().int().min(1).max(336).optional(),
        checkout_reminder_hours: z.number().int().min(1).max(48).optional(),
        arrival_template: z.string().max(512).optional(),
        checkout_template: z.string().max(512).optional(),
        confirmation_template: z.string().max(512).optional(),
      })
      .strict(),
  })
  .partial()
  .strict()

export const pricingRulesPatchSchema = z
  .object({
    weekday_night_rate: money.nullable(),
    weekend_night_rate: money.nullable(),
    weekend_nights: z.array(z.number().int().min(1).max(7)).max(7),
    base_guests_included: z.number().int().positive().max(500).nullable(),
    extra_adult_rate_per_night: money.nullable(),
    extra_child_rate_per_night: money.nullable(),
    child_age_limit: z.number().int().min(0).max(17).nullable(),
    min_nights: z.number().int().min(1).max(60),
    extended_stay_min_nights: z.number().int().min(2).max(365).nullable(),
    extended_stay_discount_pct: pct.nullable(),
    tax_label: z.string().trim().min(1).max(40),
    tax_pct: pct.nullable(),
    prices_include_tax: z.boolean(),
    deposit_pct: pct.nullable(),
    deposit_fixed_amount: money.nullable(),
    quote_validity_hours: z.number().int().positive().max(24 * 60).nullable(),
    max_staff_discount_pct: pct,
    cancellation_rules: z
      .array(z.object({ days_before: z.number().int().min(0).max(365), refund_pct: pct }).strict())
      .max(10)
      .nullable(),
  })
  .partial()
  .strict()
  .refine((v) => !(v.deposit_pct != null && v.deposit_fixed_amount != null), {
    message: 'Use either a deposit percentage or a fixed deposit, not both.',
  })

const seasonalRateSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(120),
    kind: z.enum(['season', 'special_date', 'holiday']),
    start_date: isoDate,
    end_date: isoDate,
    nightly_rate: money,
    weekend_nightly_rate: money.nullable().optional(),
    min_nights: z.number().int().min(1).max(60).nullable().optional(),
    is_active: z.boolean().default(true),
  })
  .strict()
  .refine((v) => v.end_date >= v.start_date, { message: 'End date must be on or after the start date.' })

const eventPackageSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(120),
    description: text(2000),
    event_types: z.array(z.enum(EVENT_TYPES)).max(EVENT_TYPES.length).nullable().optional(),
    base_price: money,
    included_hours: z.number().positive().max(48).nullable().optional(),
    extra_hour_rate: money.nullable().optional(),
    max_guests: z.number().int().positive().max(5000).nullable().optional(),
    includes_accommodation: z.boolean().default(false),
    is_active: z.boolean().default(false),
    sort_order: z.number().int().min(0).max(1000).default(0),
  })
  .strict()

const addonSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(120),
    description: text(2000),
    price: money,
    unit: z.enum(['per_booking', 'per_night', 'per_guest', 'per_guest_per_night']),
    applies_to: z.enum(['stay', 'event', 'both']),
    is_active: z.boolean().default(false),
  })
  .strict()

export const pricingWriteSchema = z.discriminatedUnion('entity', [
  z.object({ entity: z.literal('rules'), data: pricingRulesPatchSchema }),
  z.object({ entity: z.literal('seasonal_rate'), data: seasonalRateSchema }),
  z.object({ entity: z.literal('event_package'), data: eventPackageSchema }),
  z.object({ entity: z.literal('addon'), data: addonSchema }),
])

export const PRICING_TABLES = {
  seasonal_rate: 'seasonal_rates',
  event_package: 'event_packages',
  addon: 'addons',
} as const

const amenitySchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(120),
    description: text(1000),
    applies_to: z.enum(['stay', 'event', 'both']).default('both'),
    is_approved: z.boolean().default(false),
    sort_order: z.number().int().min(0).max(1000).default(0),
  })
  .strict()

const faqSchema = z
  .object({
    id: z.string().uuid().optional(),
    question: z.string().trim().min(1).max(300),
    answer: z.string().trim().min(1).max(4000),
    is_published: z.boolean().default(false),
    sort_order: z.number().int().min(0).max(1000).default(0),
  })
  .strict()

const mediaSchema = z
  .object({
    id: z.string().uuid().optional(),
    public_url: z.string().url().regex(/^https:\/\//i, 'Use an https:// URL'),
    caption: text(300),
    alt_text: text(300),
    category: z.enum(['farm', 'building', 'rooms', 'event_space', 'amenities', 'food', 'other']).default('other'),
    is_verified_property_photo: z.boolean().default(false),
    is_approved: z.boolean().default(false),
    sort_order: z.number().int().min(0).max(1000).default(0),
  })
  .strict()
  .refine((m) => !m.is_approved || m.is_verified_property_photo, {
    message: 'Only photos confirmed to show V-Farms can be published.',
  })

export const contentWriteSchema = z.discriminatedUnion('entity', [
  z.object({ entity: z.literal('amenity'), data: amenitySchema }),
  z.object({ entity: z.literal('faq'), data: faqSchema }),
  z.object({ entity: z.literal('media'), data: mediaSchema }),
])

export const CONTENT_TABLES = {
  amenity: 'amenities',
  faq: 'property_faqs',
  media: 'property_media',
} as const

export const blockCreateSchema = z
  .object({
    block_type: z.enum(['manual_block', 'maintenance']),
    start_date: isoDate,
    end_date: isoDate,
    reason: z.string().trim().max(300).optional(),
  })
  .strict()
  .refine((v) => v.end_date >= v.start_date, { message: 'End date must be on or after the start date.' })

export const leadPatchSchema = z
  .object({
    stage: z.enum(LEAD_STAGES),
    priority: z.enum(LEAD_PRIORITIES),
    assigned_to: z.string().uuid().nullable(),
    next_follow_up_at: z.string().datetime({ offset: true }).nullable(),
    notes: text(4000),
    customer_name: text(120),
    email: z.string().email().nullable().or(z.literal('').transform(() => null)),
  })
  .partial()
  .strict()

export const leadNoteSchema = z.object({ body: z.string().trim().min(1).max(4000) }).strict()

export const conversationModeSchema = z
  .object({ mode: z.enum(['human', 'bot']), reason: z.string().max(200).optional() })
  .strict()
