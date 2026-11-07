// Row shapes for the V-Farms tables (migrations 059 / 060). Nullable
// business fields mean "Not configured" — never substitute a default.

export type BookingType = 'stay' | 'event'

export const BOOKING_STATUSES = [
  'enquiry', 'qualified', 'availability_checked', 'quote_created',
  'booking_requested', 'hold', 'payment_pending', 'payment_verified',
  'confirmed', 'checked_in', 'checked_out', 'completed',
  'cancellation_requested', 'cancelled', 'rejected', 'expired',
] as const
export type BookingStatus = (typeof BOOKING_STATUSES)[number]

export const LEAD_STAGES = [
  'new', 'contacted', 'qualified', 'quote_sent', 'awaiting_customer',
  'booking_requested', 'confirmed', 'completed', 'cancelled', 'lost',
] as const
export type LeadStage = (typeof LEAD_STAGES)[number]

export const LEAD_PRIORITIES = ['hot', 'warm', 'nurture'] as const
export type LeadPriority = (typeof LEAD_PRIORITIES)[number]

export const LEAD_SOURCES = [
  'website', 'whatsapp', 'qr_code', 'instagram', 'facebook_ads', 'referral', 'manual',
] as const
export type LeadSource = (typeof LEAD_SOURCES)[number]

export const EVENT_TYPES = [
  'birthday', 'anniversary', 'family_gathering', 'private_celebration', 'corporate', 'other',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  birthday: 'Birthday',
  anniversary: 'Anniversary',
  family_gathering: 'Family gathering',
  private_celebration: 'Private celebration',
  corporate: 'Corporate gathering',
  other: 'Other',
}

export interface PropertySettings {
  id: string
  account_id: string
  resort_name: string
  tagline: string | null
  description: string | null
  farm_description: string | null
  building_description: string | null
  room_count: number | null
  property_area_acres: number | null
  address: string | null
  locality: string | null
  latitude: number | null
  longitude: number | null
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
  timezone: string
  currency: string
  is_published: boolean
  bot_enabled: boolean
  test_mode: boolean
  payments_enabled: boolean
  manual_approval_required: boolean
  holds_enabled: boolean
  /** E.164 numbers that receive real bot replies while test_mode is on. */
  test_phone_numbers: string[]
  hold_duration_minutes: number
  event_buffer_minutes: number
  business_hours: Record<string, { open: string; close: string } | null> | null
  notification_settings: Record<string, unknown>
  reminder_settings: ReminderSettings
  updated_at: string
}

export interface ReminderSettings {
  arrival_reminder_hours?: number
  checkout_reminder_hours?: number
  arrival_template?: string
  checkout_template?: string
  confirmation_template?: string
}

export interface PricingRules {
  id: string
  account_id: string
  weekday_night_rate: number | null
  weekend_night_rate: number | null
  weekend_nights: number[]
  base_guests_included: number | null
  extra_adult_rate_per_night: number | null
  extra_child_rate_per_night: number | null
  child_age_limit: number | null
  min_nights: number
  extended_stay_min_nights: number | null
  extended_stay_discount_pct: number | null
  tax_label: string
  tax_pct: number | null
  prices_include_tax: boolean
  deposit_pct: number | null
  deposit_fixed_amount: number | null
  quote_validity_hours: number | null
  max_staff_discount_pct: number
  cancellation_rules: { days_before: number; refund_pct: number }[] | null
  updated_at?: string
}

export interface SeasonalRate {
  id: string
  account_id?: string
  name: string
  kind: 'season' | 'special_date' | 'holiday'
  start_date: string
  end_date: string
  nightly_rate: number
  weekend_nightly_rate: number | null
  min_nights: number | null
  is_active: boolean
}

export interface EventPackage {
  id: string
  account_id?: string
  name: string
  description: string | null
  event_types: EventType[] | null
  base_price: number
  included_hours: number | null
  extra_hour_rate: number | null
  max_guests: number | null
  includes_accommodation: boolean
  is_active: boolean
  sort_order?: number
}

export interface Addon {
  id: string
  account_id?: string
  name: string
  description: string | null
  price: number
  unit: 'per_booking' | 'per_night' | 'per_guest' | 'per_guest_per_night'
  applies_to: 'stay' | 'event' | 'both'
  is_active: boolean
}

export interface Amenity {
  id: string
  name: string
  description: string | null
  applies_to: 'stay' | 'event' | 'both'
  is_approved: boolean
  sort_order: number
}

export interface PropertyMedia {
  id: string
  public_url: string
  caption: string | null
  alt_text: string | null
  category: string
  is_verified_property_photo: boolean
  is_approved: boolean
  sort_order: number
}

export interface PropertyFaq {
  id: string
  question: string
  answer: string
  is_published: boolean
  sort_order: number
}

export interface Booking {
  id: string
  account_id: string
  booking_ref: string
  lead_id: string | null
  contact_id: string | null
  conversation_id: string | null
  booking_type: BookingType
  status: BookingStatus
  source: LeadSource
  check_in: string | null
  check_out: string | null
  event_date: string | null
  event_start_time: string | null
  event_end_time: string | null
  adults: number
  children: number
  children_ages: number[] | null
  guest_count: number
  purpose: string | null
  special_requirements: string | null
  guest_name: string | null
  guest_phone: string | null
  guest_email: string | null
  active_quote_id: string | null
  quoted_total: number | null
  advance_due: number | null
  amount_paid: number
  amount_refunded: number
  payment_status: 'unpaid' | 'partially_paid' | 'paid' | 'refund_pending' | 'partially_refunded' | 'refunded'
  availability_conflict: boolean
  staff_notes: string | null
  occupancy: string | null
  confirmed_at: string | null
  cancelled_at: string | null
  cancellation_reason: string | null
  created_at: string
  updated_at: string
}

export interface Lead {
  id: string
  lead_number: number
  account_id: string
  contact_id: string | null
  conversation_id: string | null
  customer_name: string | null
  phone_e164: string | null
  email: string | null
  preferred_language: string
  source: LeadSource
  category: 'stay' | 'event' | 'pricing' | 'general'
  stage: LeadStage
  priority: LeadPriority
  check_in: string | null
  check_out: string | null
  event_date: string | null
  event_start_time: string | null
  event_end_time: string | null
  adults: number | null
  children: number | null
  children_ages: number[] | null
  guest_count: number | null
  purpose: string | null
  special_requirements: string | null
  budget_inr: number | null
  estimated_quote_inr: number | null
  assigned_to: string | null
  last_interaction_at: string | null
  next_follow_up_at: string | null
  notes: string | null
  consent_status: 'unknown' | 'granted' | 'revoked'
  created_at: string
  updated_at: string
}
