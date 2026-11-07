import type { SupabaseClient } from '@supabase/supabase-js'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { checkOccupancy, type AvailabilityResult } from './availability'
import { canTransition } from './lifecycle'
import { alertStaff, cancelPendingJobsForBooking, writeAudit } from './notify'
import {
  DATE_ERROR_MESSAGES,
  eventDurationHours,
  eventOccupancy,
  stayOccupancy,
  toRangeLiteral,
  validateEventDate,
  validateEventGuests,
  validateStayDates,
  validateStayGuests,
  type DateValidationError,
  type GuestValidationError,
  type Occupancy,
} from './occupancy'
import { paiseToRupees, quoteEvent, quoteStay, type Quote, type QuoteResult } from './pricing'
import { paymentsReady, type PropertyBundle } from './property-store'
import { generateAccessToken, generateBookingRef } from './refs'
import { upsertLead } from './leads'
import type { Booking, BookingStatus, EventType, LeadSource } from './types'
import { resortWebsiteUrl } from './website'

export class BookingError extends Error {
  constructor(
    readonly code:
      | DateValidationError
      | GuestValidationError
      | 'not_found'
      | 'invalid_transition'
      | 'estate_unavailable'
      | 'property_not_configured'
      | 'invalid_time',
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'BookingError'
  }
}

const GUEST_ERROR_MESSAGES: Record<BookingError['code'], string> = {
  ...DATE_ERROR_MESSAGES,
  no_adults: 'At least one adult is required.',
  exceeds_capacity: 'That is more guests than the estate can host. Our team can advise on options.',
  invalid_count: 'Please check the number of guests.',
  children_ages_mismatch: "Please give an age for each child.",
  not_found: 'Booking not found.',
  invalid_transition: 'This booking cannot be changed that way in its current state.',
  estate_unavailable: 'Sorry, those dates are no longer available.',
  property_not_configured: 'Online booking is not available yet. Please message us on WhatsApp.',
  invalid_time: 'Please check the start and end times.',
}

export function bookingErrorMessage(err: BookingError): string {
  return GUEST_ERROR_MESSAGES[err.code] ?? 'Something went wrong.'
}

interface CommonEnquiry {
  accountId: string
  source: LeadSource
  contactId?: string | null
  conversationId?: string | null
  guestName: string | null
  guestPhone: string | null
  guestEmail?: string | null
  specialRequirements?: string | null
  addonIds?: string[]
  idempotencyKey?: string | null
  createdBy?: string | null
  now?: Date
}

export interface StayEnquiry extends CommonEnquiry {
  checkIn: string
  checkOut: string
  adults: number
  children: number
  childrenAges?: number[] | null
  purpose?: string | null
  /** Keep the booking a new enquiry for staff review whatever the availability check found. */
  initialStatus?: 'enquiry'
}

export interface EventEnquiry extends CommonEnquiry {
  eventType: EventType
  eventTypeOther?: string | null
  eventDate: string
  startTime: string
  endTime: string
  guestCount: number
  accommodationRequired?: boolean | null
  cateringRequired?: boolean | null
  decorationRequirements?: string | null
  budgetInr?: number | null
}

export interface EnquiryOutcome {
  booking: Booking
  /** The guest's private link token — only returned when the booking was just created. */
  accessToken: string | null
  availability: AvailabilityResult
  quote: QuoteResult
  /** Why the request cannot be confirmed automatically (capacity not configured, event approval…). */
  reviewReasons: string[]
  created: boolean
  leadId: string | null
}

const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v))

export function coerceBooking(row: Record<string, unknown>): Booking {
  return {
    ...(row as unknown as Booking),
    quoted_total: numOrNull(row.quoted_total),
    advance_due: numOrNull(row.advance_due),
    amount_paid: Number(row.amount_paid ?? 0),
    amount_refunded: Number(row.amount_refunded ?? 0),
  }
}

async function findByIdempotencyKey(db: SupabaseClient, accountId: string, key: string): Promise<Booking | null> {
  const { data, error } = await db
    .from('bookings')
    .select('*')
    .eq('account_id', accountId)
    .eq('idempotency_key', key)
    .maybeSingle()
  if (error) throw new Error(`Booking lookup failed: ${error.message}`)
  return data ? coerceBooking(data) : null
}

async function insertBooking(
  db: SupabaseClient,
  row: Record<string, unknown>,
  now: Date,
): Promise<{ booking: Booking; token: string }> {
  const { token, hash } = generateAccessToken()
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, error } = await db
      .from('bookings')
      .insert({ ...row, booking_ref: generateBookingRef(now), access_token_hash: hash })
      .select('*')
      .single()
    if (!error) return { booking: coerceBooking(data), token }
    if (isUniqueViolation(error) && String(error.message).includes('booking_ref')) continue
    throw Object.assign(new Error(`Could not save booking: ${error.message}`), { code: (error as { code?: string }).code })
  }
  throw new Error('Could not allocate a booking reference')
}

async function saveQuote(
  db: SupabaseClient,
  booking: Booking,
  quote: Quote,
  snapshot: unknown,
  createdBy: string | null,
  discountAuthorizedBy: string | null = null,
): Promise<string> {
  await db
    .from('booking_quotes')
    .update({ status: 'superseded' })
    .eq('booking_id', booking.id)
    .in('status', ['draft', 'sent'])

  const { data, error } = await db
    .from('booking_quotes')
    .insert({
      account_id: booking.account_id,
      booking_id: booking.id,
      lead_id: booking.lead_id,
      booking_type: booking.booking_type,
      line_items: quote.lines,
      nights: quote.nights,
      event_hours: quote.event_hours,
      subtotal: paiseToRupees(quote.subtotal),
      discount_amount: paiseToRupees(quote.discount),
      discount_reason: quote.discount_reason,
      discount_authorized_by: quote.discount > 0 ? (discountAuthorizedBy ?? createdBy) : null,
      tax_amount: paiseToRupees(quote.tax),
      total_amount: paiseToRupees(quote.total),
      advance_amount: quote.advance === null ? 0 : paiseToRupees(quote.advance),
      balance_amount: quote.balance === null ? paiseToRupees(quote.total) : paiseToRupees(quote.balance),
      valid_until: quote.valid_until,
      status: 'sent',
      pricing_snapshot: snapshot ?? {},
      created_by: createdBy,
    })
    .select('id')
    .single()
  if (error) throw new Error(`Could not save quote: ${error.message}`)

  const { error: upErr } = await db
    .from('bookings')
    .update({
      active_quote_id: data.id,
      quoted_total: paiseToRupees(quote.total),
      advance_due: quote.advance === null ? null : paiseToRupees(quote.advance),
    })
    .eq('id', booking.id)
  if (upErr) throw new Error(`Could not attach quote: ${upErr.message}`)
  return data.id as string
}

function statusAfterCheck(availability: AvailabilityResult, quote: QuoteResult): BookingStatus {
  if (availability.status === 'unavailable' || availability.status === 'unknown') return 'enquiry'
  return quote.status === 'ok' ? 'quote_created' : 'availability_checked'
}

export async function createStayEnquiry(
  db: SupabaseClient,
  bundle: PropertyBundle,
  input: StayEnquiry,
): Promise<EnquiryOutcome> {
  const now = input.now ?? new Date()
  const settings = bundle.settings
  if (!settings) throw new BookingError('property_not_configured')

  const dateErr = validateStayDates(input.checkIn, input.checkOut, { now })
  if (dateErr) throw new BookingError(dateErr)
  const guestErr = validateStayGuests(input.adults, input.children, input.childrenAges, settings.max_stay_guests)
  if (guestErr) throw new BookingError(guestErr)

  if (input.idempotencyKey) {
    const existing = await findByIdempotencyKey(db, input.accountId, input.idempotencyKey)
    if (existing) return replayOutcome(db, bundle, existing)
  }

  const reviewReasons: string[] = []
  if (settings.max_stay_guests === null) reviewReasons.push('capacity_not_configured')

  const occupancy = stayOccupancy(input.checkIn, input.checkOut, settings)
  const availability = await checkOccupancy(db, input.accountId, occupancy, {
    needsManualReview: reviewReasons.length > 0,
  })
  const quote = quoteStay(
    { ...bundle.pricing, now },
    {
      check_in: input.checkIn,
      check_out: input.checkOut,
      adults: input.adults,
      children: input.children,
      children_ages: input.childrenAges,
      addon_ids: input.addonIds,
    },
  )

  const lead = await upsertLead(db, {
    accountId: input.accountId,
    contactId: input.contactId,
    conversationId: input.conversationId,
    phoneE164: input.guestPhone,
    customerName: input.guestName,
    email: input.guestEmail,
    source: input.source,
    category: 'stay',
    fields: {
      check_in: input.checkIn,
      check_out: input.checkOut,
      adults: input.adults,
      children: input.children,
      children_ages: input.childrenAges ?? null,
      guest_count: input.adults + input.children,
      purpose: input.purpose ?? null,
      special_requirements: input.specialRequirements ?? null,
      estimated_quote_inr: quote.status === 'ok' ? paiseToRupees(quote.quote.total) : undefined,
    },
    stage: quote.status === 'ok' && availability.status !== 'unavailable' ? 'quote_sent' : 'qualified',
    signals: {
      requested_quote: true,
      availability_confirmed: availability.status === 'available',
    },
    now,
  })

  let inserted: { booking: Booking; token: string }
  try {
    inserted = await insertBooking(
      db,
      {
        account_id: input.accountId,
        lead_id: lead.id,
        contact_id: input.contactId ?? null,
        conversation_id: input.conversationId ?? null,
        booking_type: 'stay',
        status: input.initialStatus ?? statusAfterCheck(availability, quote),
        source: input.source,
        check_in: input.checkIn,
        check_out: input.checkOut,
        adults: input.adults,
        children: input.children,
        children_ages: input.childrenAges ?? null,
        guest_count: input.adults + input.children,
        purpose: input.purpose ?? null,
        special_requirements: input.specialRequirements ?? null,
        guest_name: input.guestName,
        guest_phone: input.guestPhone,
        guest_email: input.guestEmail ?? null,
        occupancy: toRangeLiteral(occupancy),
        idempotency_key: input.idempotencyKey ?? null,
        created_by: input.createdBy ?? null,
      },
      now,
    )
  } catch (err) {
    // Two identical submissions raced on the idempotency key.
    if (input.idempotencyKey && (err as { code?: string }).code === '23505') {
      const existing = await findByIdempotencyKey(db, input.accountId, input.idempotencyKey)
      if (existing) return replayOutcome(db, bundle, existing)
    }
    throw err
  }
  let booking = inserted.booking

  if (input.childrenAges && input.childrenAges.length > 0) {
    await db.from('booking_guests').insert(
      input.childrenAges.map((age) => ({
        account_id: input.accountId,
        booking_id: booking.id,
        age,
        is_child: true,
      })),
    )
  }

  if (quote.status === 'ok') {
    await saveQuote(db, booking, quote.quote, { rules: bundle.pricing.rules, seasonal: bundle.pricing.seasonal }, input.createdBy ?? null)
    booking = (await getBooking(db, input.accountId, booking.id)) ?? booking
  }

  await alertStaff(db, input.accountId, {
    kind: 'new_enquiry',
    title: `New stay enquiry ${booking.booking_ref}`,
    body: `${input.guestName ?? 'Guest'} · ${input.checkIn} → ${input.checkOut} · ${input.adults + input.children} guests · ${availabilityLabel(availability)}`,
    linkPath: `/resort/bookings/${booking.id}`,
    conversationId: input.conversationId,
    contactId: input.contactId,
    bookingId: booking.id,
    leadId: lead.id,
    dedupeKey: `new_enquiry:${booking.id}`,
  })

  return { booking, accessToken: inserted.token, availability, quote, reviewReasons, created: true, leadId: lead.id }
}

export async function createEventEnquiry(
  db: SupabaseClient,
  bundle: PropertyBundle,
  input: EventEnquiry,
): Promise<EnquiryOutcome> {
  const now = input.now ?? new Date()
  const settings = bundle.settings
  if (!settings) throw new BookingError('property_not_configured')

  const dateErr = validateEventDate(input.eventDate, { now })
  if (dateErr) throw new BookingError(dateErr)
  if (input.startTime === input.endTime) throw new BookingError('invalid_time')
  const guestErr = validateEventGuests(input.guestCount, settings.max_event_guests)
  if (guestErr) throw new BookingError(guestErr)

  if (input.idempotencyKey) {
    const existing = await findByIdempotencyKey(db, input.accountId, input.idempotencyKey)
    if (existing) return replayOutcome(db, bundle, existing)
  }

  // Every event is reviewed by the team before it is confirmed.
  const reviewReasons = ['event_requires_approval']
  if (settings.max_event_guests === null) reviewReasons.push('capacity_not_configured')
  if (!settings.event_policies) reviewReasons.push('event_rules_not_configured')

  const occupancy = eventOccupancy(input.eventDate, input.startTime, input.endTime, settings.event_buffer_minutes)
  const availability = await checkOccupancy(db, input.accountId, occupancy, { needsManualReview: true })
  const hours = eventDurationHours(input.startTime, input.endTime)
  const quote = quoteEvent(
    { ...bundle.pricing, now },
    { event_type: input.eventType, event_hours: hours, guest_count: input.guestCount, addon_ids: input.addonIds },
  )

  const lead = await upsertLead(db, {
    accountId: input.accountId,
    contactId: input.contactId,
    conversationId: input.conversationId,
    phoneE164: input.guestPhone,
    customerName: input.guestName,
    email: input.guestEmail,
    source: input.source,
    category: 'event',
    fields: {
      event_date: input.eventDate,
      event_start_time: input.startTime,
      event_end_time: input.endTime,
      guest_count: input.guestCount,
      purpose: input.eventType,
      special_requirements: input.specialRequirements ?? input.decorationRequirements ?? null,
      budget_inr: input.budgetInr ?? null,
      estimated_quote_inr: quote.status === 'ok' ? paiseToRupees(quote.quote.total) : undefined,
    },
    stage: 'qualified',
    signals: { requested_quote: true, availability_confirmed: false },
    now,
  })

  let inserted: { booking: Booking; token: string }
  try {
    inserted = await insertBooking(
      db,
      {
        account_id: input.accountId,
        lead_id: lead.id,
        contact_id: input.contactId ?? null,
        conversation_id: input.conversationId ?? null,
        booking_type: 'event',
        status: statusAfterCheck(availability, quote),
        source: input.source,
        event_date: input.eventDate,
        event_start_time: input.startTime,
        event_end_time: input.endTime,
        adults: 0,
        children: 0,
        guest_count: input.guestCount,
        purpose: input.eventType,
        special_requirements: input.specialRequirements ?? null,
        guest_name: input.guestName,
        guest_phone: input.guestPhone,
        guest_email: input.guestEmail ?? null,
        occupancy: toRangeLiteral(occupancy),
        idempotency_key: input.idempotencyKey ?? null,
        created_by: input.createdBy ?? null,
      },
      now,
    )
  } catch (err) {
    if (input.idempotencyKey && (err as { code?: string }).code === '23505') {
      const existing = await findByIdempotencyKey(db, input.accountId, input.idempotencyKey)
      if (existing) return replayOutcome(db, bundle, existing)
    }
    throw err
  }
  let booking = inserted.booking

  const { error: evErr } = await db.from('event_requests').insert({
    account_id: input.accountId,
    booking_id: booking.id,
    event_type: input.eventType,
    event_type_other: input.eventTypeOther ?? null,
    accommodation_required: input.accommodationRequired ?? null,
    catering_required: input.cateringRequired ?? null,
    decoration_requirements: input.decorationRequirements ?? null,
    budget_inr: input.budgetInr ?? null,
    contact_phone: input.guestPhone,
    contact_email: input.guestEmail ?? null,
    status: 'pending_review',
  })
  if (evErr) throw new Error(`Could not save event details: ${evErr.message}`)

  if (quote.status === 'ok') {
    await saveQuote(db, booking, quote.quote, { rules: bundle.pricing.rules, packages: bundle.pricing.packages }, input.createdBy ?? null)
    booking = (await getBooking(db, input.accountId, booking.id)) ?? booking
  }

  await alertStaff(db, input.accountId, {
    kind: 'event_approval_required',
    title: `Event request ${booking.booking_ref} needs review`,
    body: `${input.guestName ?? 'Guest'} · ${input.eventType.replace('_', ' ')} on ${input.eventDate} ${input.startTime}–${input.endTime} · ${input.guestCount} guests · ${availabilityLabel(availability)}`,
    linkPath: `/resort/bookings/${booking.id}`,
    conversationId: input.conversationId,
    contactId: input.contactId,
    bookingId: booking.id,
    leadId: lead.id,
    dedupeKey: `event_review:${booking.id}`,
  })

  return { booking, accessToken: inserted.token, availability, quote, reviewReasons, created: true, leadId: lead.id }
}

/** A repeated submission: report the stored booking without creating anything. */
async function replayOutcome(db: SupabaseClient, bundle: PropertyBundle, booking: Booking): Promise<EnquiryOutcome> {
  const occ = bookingOccupancy(booking, bundle)
  const availability = occ
    ? await checkOccupancy(db, booking.account_id, occ, { excludeBookingId: booking.id })
    : { status: 'unknown' as const, conflicts: [] }
  const quote = await quoteForBooking(db, booking)
  return {
    booking,
    accessToken: null,
    availability,
    quote,
    reviewReasons: [],
    created: false,
    leadId: booking.lead_id,
  }
}

async function quoteForBooking(db: SupabaseClient, booking: Booking): Promise<QuoteResult> {
  if (!booking.active_quote_id) return { status: 'not_configured', missing: ['quote'] }
  const { data } = await db.from('booking_quotes').select('*').eq('id', booking.active_quote_id).maybeSingle()
  if (!data) return { status: 'not_configured', missing: ['quote'] }
  return { status: 'ok', quote: quoteRowToQuote(data) }
}

export function quoteRowToQuote(row: Record<string, unknown>): Quote {
  const toP = (v: unknown) => Math.round(Number(v ?? 0) * 100)
  const advance = toP(row.advance_amount)
  return {
    booking_type: row.booking_type as 'stay' | 'event',
    nights: (row.nights as number | null) ?? null,
    event_hours: row.event_hours === null || row.event_hours === undefined ? null : Number(row.event_hours),
    lines: (row.line_items as Quote['lines']) ?? [],
    subtotal: toP(row.subtotal),
    discount: toP(row.discount_amount),
    discount_reason: (row.discount_reason as string | null) ?? null,
    tax: toP(row.tax_amount),
    tax_label: ((row.pricing_snapshot as { rules?: { tax_label?: string } } | null)?.rules?.tax_label) ?? 'GST',
    tax_included: Boolean((row.pricing_snapshot as { rules?: { prices_include_tax?: boolean } } | null)?.rules?.prices_include_tax),
    total: toP(row.total_amount),
    advance: advance > 0 ? advance : null,
    balance: advance > 0 ? toP(row.balance_amount) : null,
    valid_until: (row.valid_until as string | null) ?? null,
  }
}

export function bookingOccupancy(booking: Booking, bundle: PropertyBundle): Occupancy | null {
  const s = bundle.settings
  if (!s) return null
  if (booking.booking_type === 'stay' && booking.check_in && booking.check_out) {
    return stayOccupancy(booking.check_in, booking.check_out, s)
  }
  if (booking.booking_type === 'event' && booking.event_date && booking.event_start_time && booking.event_end_time) {
    return eventOccupancy(booking.event_date, booking.event_start_time, booking.event_end_time, s.event_buffer_minutes)
  }
  return null
}

export async function getBooking(db: SupabaseClient, accountId: string, id: string): Promise<Booking | null> {
  const { data, error } = await db.from('bookings').select('*').eq('account_id', accountId).eq('id', id).maybeSingle()
  if (error) throw new Error(`Booking lookup failed: ${error.message}`)
  return data ? coerceBooking(data) : null
}

export async function getBookingByRef(db: SupabaseClient, ref: string): Promise<Booking | null> {
  const { data, error } = await db.from('bookings').select('*').eq('booking_ref', ref).maybeSingle()
  if (error) throw new Error(`Booking lookup failed: ${error.message}`)
  return data ? coerceBooking(data) : null
}

function availabilityLabel(a: AvailabilityResult): string {
  switch (a.status) {
    case 'available': return 'dates available'
    case 'pending_manual': return 'dates free — needs manual review'
    case 'unavailable': return 'dates unavailable'
    default: return 'availability could not be verified'
  }
}

function isEstateUnavailable(error: { code?: string; message?: string } | null): boolean {
  return Boolean(error && (error.code === '23P01' || /estate_unavailable/.test(error.message ?? '')))
}

export type ReservationOutcome =
  | { outcome: 'payment_required'; booking: Booking; holdExpiresAt: string | null }
  | { outcome: 'requested'; booking: Booking; holdExpiresAt: string | null }
  | { outcome: 'requested_review'; booking: Booking }
  | { outcome: 'unavailable'; booking: Booking }
  | { outcome: 'not_eligible'; booking: Booking; reason: string }

/**
 * The guest asks to reserve. Re-checks the live calendar, then either
 * places a temporary hold and asks for the advance (online payment ready),
 * or places a hold and hands the request to staff (manual approval).
 * Nothing here confirms a booking.
 */
export async function requestReservation(
  db: SupabaseClient,
  bundle: PropertyBundle,
  accountId: string,
  bookingId: string,
  opts: { actorUserId?: string | null; now?: Date } = {},
): Promise<ReservationOutcome> {
  const now = opts.now ?? new Date()
  const settings = bundle.settings
  if (!settings) throw new BookingError('property_not_configured')
  const booking = await getBooking(db, accountId, bookingId)
  if (!booking) throw new BookingError('not_found')

  if (['booking_requested', 'hold', 'payment_pending'].includes(booking.status)) {
    const { data: hold } = await db
      .from('availability_blocks')
      .select('expires_at')
      .eq('booking_id', booking.id)
      .eq('status', 'active')
      .maybeSingle()
    return booking.status === 'payment_pending'
      ? { outcome: 'payment_required', booking, holdExpiresAt: hold?.expires_at ?? null }
      : { outcome: 'requested', booking, holdExpiresAt: hold?.expires_at ?? null }
  }
  if (!canTransition(booking.status, 'booking_requested')) {
    return { outcome: 'not_eligible', booking, reason: booking.status }
  }

  if (booking.booking_type === 'event') {
    const { data } = await db
      .from('bookings')
      .update({ status: 'booking_requested' })
      .eq('id', booking.id)
      .select('*')
      .single()
    await markLeadRequested(db, booking)
    await alertStaff(db, accountId, {
      kind: 'booking_requested',
      title: `Event reservation requested ${booking.booking_ref}`,
      body: `${booking.guest_name ?? 'Guest'} asked to reserve their event. Review and approve before confirming.`,
      linkPath: `/resort/bookings/${booking.id}`,
      conversationId: booking.conversation_id,
      bookingId: booking.id,
      leadId: booking.lead_id,
      dedupeKey: `booking_requested:${booking.id}`,
    })
    return { outcome: 'requested_review', booking: data ? coerceBooking(data) : booking }
  }

  const occ = bookingOccupancy(booking, bundle)
  if (!occ) return { outcome: 'not_eligible', booking, reason: 'missing_dates' }
  const quote = await quoteForBooking(db, booking)
  const canPayOnline =
    resortWebsiteUrl() !== null &&
    paymentsReady(settings, bundle.pricing.rules) &&
    quote.status === 'ok' &&
    quote.quote.advance !== null &&
    quote.quote.advance > 0 &&
    settings.max_stay_guests !== null &&
    (!quote.quote.valid_until || new Date(quote.quote.valid_until) > now)

  let holdExpiresAt: string | null = null
  if (settings.holds_enabled) {
    holdExpiresAt = new Date(now.getTime() + settings.hold_duration_minutes * 60_000).toISOString()
    const { error } = await db.rpc('resort_reserve', {
      p_account: accountId,
      p_block_type: 'hold',
      p_booking: booking.id,
      p_start: occ.start.toISOString(),
      p_end: occ.end.toISOString(),
      p_expires_at: holdExpiresAt,
      p_reason: 'guest_reservation_request',
      p_actor: opts.actorUserId ?? null,
    })
    if (error) {
      if (isEstateUnavailable(error)) return { outcome: 'unavailable', booking }
      throw new Error(`Could not place hold: ${error.message}`)
    }
  } else {
    const live = await checkOccupancy(db, accountId, occ, { excludeBookingId: booking.id })
    if (live.status === 'unavailable') return { outcome: 'unavailable', booking }
    if (live.status === 'unknown') throw new Error('Availability could not be verified')
  }

  const nextStatus: BookingStatus = canPayOnline ? 'payment_pending' : 'booking_requested'
  const { data, error } = await db
    .from('bookings')
    .update({ status: nextStatus })
    .eq('id', booking.id)
    .select('*')
    .single()
  if (error) throw new Error(`Could not update booking: ${error.message}`)

  await markLeadRequested(db, booking)
  await alertStaff(db, accountId, {
    kind: 'booking_requested',
    title: `Reservation requested ${booking.booking_ref}`,
    body: `${booking.guest_name ?? 'Guest'} · ${booking.check_in} → ${booking.check_out}. ${
      canPayOnline ? 'Awaiting online advance payment.' : 'Needs staff confirmation.'
    }${holdExpiresAt ? ` Hold expires ${new Date(holdExpiresAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.` : ''}`,
    linkPath: `/resort/bookings/${booking.id}`,
    conversationId: booking.conversation_id,
    bookingId: booking.id,
    leadId: booking.lead_id,
    dedupeKey: `booking_requested:${booking.id}`,
  })

  return canPayOnline
    ? { outcome: 'payment_required', booking: coerceBooking(data), holdExpiresAt }
    : { outcome: 'requested', booking: coerceBooking(data), holdExpiresAt }
}

async function markLeadRequested(db: SupabaseClient, booking: Booking): Promise<void> {
  if (!booking.lead_id) return
  await upsertLead(db, {
    accountId: booking.account_id,
    contactId: booking.contact_id,
    phoneE164: booking.guest_phone,
    source: booking.source,
    stage: 'booking_requested',
    signals: { requested_booking: true },
  }).catch((err) => console.error('[resort] lead stage update failed:', err))
}

/** Staff confirmation (manual approval). The database re-checks the calendar. */
export async function confirmBooking(
  db: SupabaseClient,
  accountId: string,
  bookingId: string,
  actorUserId: string,
): Promise<{ status: BookingStatus; alreadyConfirmed: boolean }> {
  const { data, error } = await db.rpc('resort_confirm_booking', {
    p_account: accountId,
    p_booking: bookingId,
    p_actor: actorUserId,
  })
  if (error) {
    if (isEstateUnavailable(error)) throw new BookingError('estate_unavailable')
    if (/booking_not_found/.test(error.message)) throw new BookingError('not_found')
    if (/invalid_transition|event_not_approved|occupancy_missing/.test(error.message)) {
      throw new BookingError('invalid_transition', error.message)
    }
    throw new Error(error.message)
  }
  const result = data as { booking_status: BookingStatus; already_confirmed: boolean }
  return { status: result.booking_status, alreadyConfirmed: result.already_confirmed }
}

/**
 * Cancel. A guest's request on a paid or confirmed booking becomes a
 * cancellation request for staff; staff cancellations free the calendar
 * and stop reminders. Refunds are handled separately and only recorded
 * as complete when the provider or an authorised operator confirms them.
 */
export async function cancelBooking(
  db: SupabaseClient,
  accountId: string,
  bookingId: string,
  opts: { actorUserId?: string | null; reason?: string | null; byGuest?: boolean },
): Promise<BookingStatus> {
  const booking = await getBooking(db, accountId, bookingId)
  if (!booking) throw new BookingError('not_found')
  if (booking.status === 'cancelled') return 'cancelled'

  const needsStaff =
    opts.byGuest && (booking.amount_paid > 0 || ['confirmed', 'payment_verified'].includes(booking.status))
  const target: BookingStatus = needsStaff ? 'cancellation_requested' : 'cancelled'
  if (!canTransition(booking.status, target)) throw new BookingError('invalid_transition', `cannot cancel from ${booking.status}`)

  if (target === 'cancelled') {
    const { error: relErr } = await db.rpc('resort_release_booking', { p_account: accountId, p_booking: bookingId })
    if (relErr) throw new Error(`Could not release dates: ${relErr.message}`)
  }
  const { error } = await db
    .from('bookings')
    .update({
      status: target,
      cancellation_reason: opts.reason ?? null,
      cancelled_at: target === 'cancelled' ? new Date().toISOString() : null,
    })
    .eq('id', bookingId)
  if (error) throw new Error(`Could not cancel booking: ${error.message}`)

  if (target === 'cancelled') {
    await cancelPendingJobsForBooking(db, bookingId, 'booking_cancelled')
    if (booking.lead_id) {
      await db.from('leads').update({ stage: 'cancelled' }).eq('id', booking.lead_id).not('stage', 'in', '(completed,lost)')
    }
  } else {
    await alertStaff(db, accountId, {
      kind: 'cancellation_requested',
      title: `Cancellation requested ${booking.booking_ref}`,
      body: `${booking.guest_name ?? 'Guest'} asked to cancel. Paid so far: ₹${booking.amount_paid}. Review the refund policy before responding.`,
      linkPath: `/resort/bookings/${booking.id}`,
      conversationId: booking.conversation_id,
      bookingId: booking.id,
      dedupeKey: `cancellation_requested:${booking.id}`,
    })
  }
  await writeAudit(db, {
    accountId,
    actorUserId: opts.actorUserId ?? null,
    actorType: opts.byGuest ? 'bot' : opts.actorUserId ? 'user' : 'system',
    action: target === 'cancelled' ? 'booking.cancelled' : 'booking.cancellation_requested',
    entityType: 'booking',
    entityId: bookingId,
    before: { status: booking.status },
    after: { status: target, reason: opts.reason ?? null },
  })
  return target
}

export { saveQuote }
