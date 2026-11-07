import type { BookingStatus, LeadPriority, LeadStage } from './types'

/**
 * Booking lifecycle:
 *
 *   enquiry → qualified → availability_checked → quote_created →
 *   booking_requested → hold → payment_pending → payment_verified →
 *   confirmed → checked_in → checked_out → completed
 *
 * with cancellation_requested / cancelled / rejected / expired exits.
 * Confirmation itself always runs through the resort_confirm_booking or
 * resort_apply_verified_payment database functions, which re-check the
 * calendar; this table only decides which transitions a request may ask for.
 */
const TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  enquiry: ['qualified', 'availability_checked', 'quote_created', 'booking_requested', 'confirmed', 'cancelled', 'rejected', 'expired'],
  qualified: ['availability_checked', 'quote_created', 'booking_requested', 'confirmed', 'cancelled', 'rejected', 'expired'],
  availability_checked: ['quote_created', 'booking_requested', 'confirmed', 'cancelled', 'rejected', 'expired'],
  quote_created: ['quote_created', 'booking_requested', 'hold', 'payment_pending', 'confirmed', 'cancelled', 'rejected', 'expired'],
  booking_requested: ['hold', 'payment_pending', 'payment_verified', 'confirmed', 'cancelled', 'rejected', 'expired'],
  hold: ['payment_pending', 'payment_verified', 'confirmed', 'cancelled', 'rejected', 'expired'],
  payment_pending: ['payment_verified', 'confirmed', 'cancelled', 'rejected', 'expired'],
  payment_verified: ['confirmed', 'cancellation_requested', 'cancelled', 'rejected'],
  confirmed: ['checked_in', 'cancellation_requested', 'cancelled', 'completed'],
  checked_in: ['checked_out'],
  checked_out: ['completed'],
  completed: [],
  cancellation_requested: ['cancelled', 'confirmed'],
  cancelled: [],
  rejected: [],
  // A lapsed request can be revived by staff once dates are re-checked.
  expired: ['booking_requested', 'confirmed', 'cancelled'],
}

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/** Statuses that occupy (or may soon occupy) the estate. */
export const ACTIVE_BOOKING_STATUSES: readonly BookingStatus[] = [
  'booking_requested', 'hold', 'payment_pending', 'payment_verified', 'confirmed', 'checked_in',
]

export const TERMINAL_BOOKING_STATUSES: readonly BookingStatus[] = ['completed', 'cancelled', 'rejected']

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  enquiry: 'New enquiry',
  qualified: 'Qualified',
  availability_checked: 'Availability checked',
  quote_created: 'Quote created',
  booking_requested: 'Booking requested',
  hold: 'Temporary hold',
  payment_pending: 'Payment pending',
  payment_verified: 'Payment verified',
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  checked_out: 'Checked out',
  completed: 'Completed',
  cancellation_requested: 'Cancellation requested',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
  expired: 'Expired',
}

export const LEAD_STAGE_LABELS: Record<LeadStage, string> = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  quote_sent: 'Quote Sent',
  awaiting_customer: 'Awaiting Customer',
  booking_requested: 'Booking Requested',
  confirmed: 'Confirmed',
  completed: 'Completed',
  cancelled: 'Cancelled',
  lost: 'Lost',
}

const STAGE_ORDER: LeadStage[] = [
  'new', 'contacted', 'qualified', 'quote_sent', 'awaiting_customer', 'booking_requested', 'confirmed', 'completed',
]

/** Move a lead forward automatically; never backwards, never out of a closed stage. */
export function advanceLeadStage(current: LeadStage, proposed: LeadStage): LeadStage {
  if (current === 'cancelled' || current === 'lost' || current === 'completed') return current
  if (proposed === 'cancelled' || proposed === 'lost') return proposed
  const ci = STAGE_ORDER.indexOf(current)
  const pi = STAGE_ORDER.indexOf(proposed)
  return pi > ci ? proposed : current
}

export interface PrioritySignals {
  has_dates: boolean
  dates_within_days: number | null
  requested_quote: boolean
  requested_booking: boolean
  requested_human: boolean
  availability_confirmed: boolean
}

/**
 * Priority comes only from explicit booking-intent signals the guest gave
 * us (dates, quote/booking requests) — never from who the guest is.
 *   HOT     : asked to book, or has available dates and asked for a quote
 *   WARM    : has specific dates, or asked for a quote / a person
 *   NURTURE : browsing
 */
export function scoreLeadPriority(s: PrioritySignals): LeadPriority {
  if (s.requested_booking) return 'hot'
  if (s.has_dates && s.requested_quote && s.availability_confirmed) return 'hot'
  if (s.has_dates && s.dates_within_days !== null && s.dates_within_days <= 14 && s.availability_confirmed) return 'hot'
  if (s.has_dates || s.requested_quote || s.requested_human) return 'warm'
  return 'nurture'
}

export const PRIORITY_RANK: Record<LeadPriority, number> = { hot: 3, warm: 2, nurture: 1 }

export function maxPriority(a: LeadPriority, b: LeadPriority): LeadPriority {
  return PRIORITY_RANK[a] >= PRIORITY_RANK[b] ? a : b
}
