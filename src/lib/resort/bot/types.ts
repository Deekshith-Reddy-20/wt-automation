import type { AvailabilityStatus } from '../availability'
import type { QuoteResult } from '../pricing'
import type { PricingContext } from '../pricing'
import type { BookingStatus, BookingType, PropertySettings } from '../types'
import type { AutomationSettings, ResortAutomationKey } from '../automations/definitions'

export type BotFlow =
  | 'menu' | 'stay' | 'booking' | 'event' | 'pricing' | 'availability' | 'explore' | 'location' | 'manage' | 'human'

export interface BotOption {
  id: string
  title: string
  description?: string
  /** Extra words that select this option when typed. */
  aliases?: string[]
}

export type BotReply =
  | { type: 'text'; text: string }
  | {
      type: 'choices'
      text: string
      options: BotOption[]
      button?: string
      /** Public https image shown above the text (reply buttons only, ≤ 3 options). */
      image?: string
    }
  | { type: 'media'; kind: 'image' | 'video'; url: string; caption?: string }

/** Photos and video sent when a guest explores the estate; urls are public https links. */
export interface ExploreContent {
  website: string | null
  media: { kind: 'image' | 'video'; url: string; caption?: string }[]
}

export interface BotState {
  flow: BotFlow
  step: string
  data: Record<string, unknown>
  history: { flow: BotFlow; step: string }[]
  lastInboundAt: string | null
}

export interface BotInput {
  text: string
  /** button_reply.id / list_reply.id for interactive taps. */
  replyId: string | null
  messageId: string
  /** Set when the guest sent something the bot cannot read (image, voice note, location …). */
  unsupported?: string | null
}

export interface StaySubmission {
  check_in: string
  check_out: string
  adults: number
  children: number
  children_ages: number[] | null
  purpose: string | null
  special_requirements: string | null
  name: string
  /** Customer Information & Stay Booking Enquiry flow: saved as a new enquiry, no quote shown. */
  enquiry_only?: boolean
}

export interface EventSubmission {
  event_type: string
  event_type_other: string | null
  event_date: string
  start_time: string
  end_time: string
  guest_count: number
  accommodation_required: boolean | null
  catering_required: boolean | null
  decoration_requirements: string | null
  budget_inr: number | null
  name: string
  contact_phone: string
}

export interface SubmitResult {
  ref: string
  bookingId: string
  availability: AvailabilityStatus
  quote: QuoteResult
  link: string | null
}

export type ReserveResult =
  | { outcome: 'payment_required'; holdExpiresAt: string | null; paymentLink: string | null }
  | { outcome: 'requested'; holdExpiresAt: string | null }
  | { outcome: 'requested_review' }
  | { outcome: 'unavailable' }
  | { outcome: 'not_eligible'; reason: string }

/** A booking that belongs to the guest on this WhatsApp number. */
export interface GuestBooking {
  id: string
  ref: string
  type: BookingType
  status: BookingStatus
  check_in: string | null
  check_out: string | null
  event_date: string | null
  start_time: string | null
  end_time: string | null
  amount_paid_paise: number
}

export interface DateChange {
  check_in?: string
  check_out?: string
  event_date?: string
}

export interface RescheduleCheck {
  availability: AvailabilityStatus
  /** Total for the new dates from configured pricing, or null when it can't be priced. */
  total_paise: number | null
  quote_snapshot: Record<string, unknown> | null
}

/** Something an automation did while handling a message; the runtime records it. */
export interface AutomationEvent {
  key: ResortAutomationKey
  status: 'success' | 'failed' | 'skipped'
  detail?: Record<string, unknown>
  error?: string
}

/**
 * Everything the state machine may do to the outside world. The runtime
 * implements these against the database; tests inject fakes. The machine
 * never decides availability, prices or policy itself — it only relays
 * what these services return.
 */
export interface BotServices {
  now(): Date
  settings: PropertySettings
  pricing: PricingContext
  contactName: string | null
  contactPhone: string | null
  /** Approved amenities only. */
  amenities: { name: string; description: string | null }[]
  faqs(): Promise<{ question: string; answer: string }[]>
  checkStay(checkIn: string, checkOut: string): Promise<AvailabilityStatus>
  checkEvent(date: string, start: string, end: string): Promise<AvailabilityStatus>
  alternatives(checkIn: string, nights: number): Promise<{ check_in: string; check_out: string }[] | null>
  submitStay(data: StaySubmission, idempotencyKey: string): Promise<SubmitResult>
  submitEvent(data: EventSubmission, idempotencyKey: string): Promise<SubmitResult>
  reserve(bookingId: string): Promise<ReserveResult>
  handoff(reason: string, summary: string): Promise<void>
  noteInterest(category: 'stay' | 'event' | 'pricing' | 'general'): Promise<void>
  siteUrl: string | null
  /** Website link and media for Explore; absent = text-only explore. */
  explore?: ExploreContent
  /** Which resort automations are enabled, and their configs. */
  automations: AutomationSettings
  /** Upcoming active bookings for this contact. */
  guestBookings(): Promise<GuestBooking[]>
  /** A booking by reference — only if it belongs to this contact. */
  findGuestBooking(ref: string): Promise<GuestBooking | null>
  requestCancellation(bookingId: string): Promise<'cancelled' | 'cancellation_requested'>
  checkReschedule(bookingId: string, change: DateChange): Promise<RescheduleCheck>
  requestReschedule(bookingId: string, change: DateChange, check: RescheduleCheck): Promise<void>
  /** Store post-stay feedback; false when the booking isn't this guest's or feedback already exists. */
  recordFeedback(bookingId: string, rating: number | null, comment: string | null): Promise<boolean>
}

export interface BotResult {
  state: BotState
  replies: BotReply[]
  events: AutomationEvent[]
  /** Set when the conversation must switch to a human. */
  handoff: boolean
  handoffReason: string | null
}
