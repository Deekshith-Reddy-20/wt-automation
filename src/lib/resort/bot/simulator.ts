import { randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkOccupancy, suggestAlternativeStays } from '../availability'
import { loadAutomationSettings } from '../automations/store'
import { BookingError } from '../bookings'
import { eventDurationHours, eventOccupancy, stayOccupancy, validateEventDate, validateEventGuests, validateStayDates, validateStayGuests } from '../occupancy'
import { quoteEvent, quoteStay } from '../pricing'
import { exploreContent } from '../explore-media'
import { loadPropertyBundle, loadPublishedFaqs } from '../property-store'
import type { EventType } from '../types'
import { handleInbound, initialState } from './machine'
import { renderReply, type RenderedMessage } from './provider'
import type { AutomationEvent, BotServices, BotState } from './types'

/** What the staff test chat shows for one guest message. */
export interface SimulatedTurn {
  state: BotState
  messages: RenderedMessage[]
  events: AutomationEvent[]
  handoff: boolean
  /** Side effects a real conversation would have had; none were performed. */
  simulated: string[]
}

export class SimulatorSetupError extends Error {}

/**
 * Run one guest message through the real bot against this account's live
 * property settings, pricing rules, automation switches and calendar.
 * Reads only: no WhatsApp message is sent, and no enquiry, booking, hold,
 * lead, staff alert or handoff is written. Those steps are reported in
 * `simulated` instead, with references marked TEST.
 */
export async function simulateTurn(
  db: SupabaseClient,
  accountId: string,
  prev: BotState | null,
  input: { text: string; replyId: string | null },
  now: Date = new Date(),
): Promise<SimulatedTurn> {
  const bundle = await loadPropertyBundle(db, accountId)
  const settings = bundle.settings
  if (!settings) throw new SimulatorSetupError('No property settings yet. Use "Turn all on" or save the Property page first.')
  const automations = await loadAutomationSettings(db, accountId)
  const { data: amenities } = await db
    .from('amenities')
    .select('name, description')
    .eq('account_id', accountId)
    .eq('is_approved', true)
    .order('sort_order')

  const simulated: string[] = []
  const testRef = () => `TEST-${randomBytes(3).toString('hex').toUpperCase()}`

  const svc: BotServices = {
    now: () => now,
    settings,
    pricing: bundle.pricing,
    contactName: null,
    contactPhone: null,
    amenities: amenities ?? [],
    siteUrl: null,
    explore: exploreContent(),
    automations,
    faqs: () => loadPublishedFaqs(db, accountId),
    async checkStay(checkIn, checkOut) {
      const r = await checkOccupancy(db, accountId, stayOccupancy(checkIn, checkOut, settings), {
        needsManualReview: settings.manual_approval_required || settings.max_stay_guests === null,
      })
      return r.status
    },
    async checkEvent(date, start, end) {
      const r = await checkOccupancy(db, accountId, eventOccupancy(date, start, end, settings.event_buffer_minutes), { needsManualReview: true })
      return r.status
    },
    alternatives: (checkIn, nights) => suggestAlternativeStays(db, accountId, checkIn, nights, settings, { now }),
    async submitStay(d) {
      const dateErr = validateStayDates(d.check_in, d.check_out, { now })
      if (dateErr) throw new BookingError(dateErr)
      const guestErr = validateStayGuests(d.adults, d.children, d.children_ages, settings.max_stay_guests)
      if (guestErr) throw new BookingError(guestErr)
      const availability = await checkOccupancy(db, accountId, stayOccupancy(d.check_in, d.check_out, settings), {
        needsManualReview: settings.max_stay_guests === null,
      })
      const quote = quoteStay({ ...bundle.pricing, now }, {
        check_in: d.check_in, check_out: d.check_out, adults: d.adults, children: d.children, children_ages: d.children_ages,
      })
      const ref = testRef()
      simulated.push(`Stay enquiry ${ref} would be saved (${d.check_in} → ${d.check_out}, ${d.adults} adults, ${d.children} children, name "${d.name}") — availability ${availability.status}, quote ${quote.status}`)
      return { ref, bookingId: `simulated:${ref}`, availability: availability.status, quote, link: null }
    },
    async submitEvent(d) {
      const dateErr = validateEventDate(d.event_date, { now })
      if (dateErr) throw new BookingError(dateErr)
      const guestErr = validateEventGuests(d.guest_count, settings.max_event_guests)
      if (guestErr) throw new BookingError(guestErr)
      const availability = await checkOccupancy(db, accountId, eventOccupancy(d.event_date, d.start_time, d.end_time, settings.event_buffer_minutes), { needsManualReview: true })
      const quote = quoteEvent({ ...bundle.pricing, now }, {
        event_type: d.event_type as EventType, event_hours: eventDurationHours(d.start_time, d.end_time), guest_count: d.guest_count,
      })
      const ref = testRef()
      simulated.push(`Event request ${ref} would be saved (${d.event_type}, ${d.event_date} ${d.start_time}–${d.end_time}, ${d.guest_count} guests) — availability ${availability.status}, quote ${quote.status}`)
      return { ref, bookingId: `simulated:${ref}`, availability: availability.status, quote, link: null }
    },
    async reserve(bookingId) {
      simulated.push(`Booking request for ${bookingId.replace('simulated:', '')} would go to your team for review (no hold placed in the test)`)
      return { outcome: 'requested_review' }
    },
    async handoff(reason) {
      simulated.push(`Conversation would be handed to your team (${reason.replace(/_/g, ' ')}); the bot would then stay silent`)
    },
    async noteInterest(category) {
      simulated.push(`Lead interest would be noted: ${category}`)
    },
    guestBookings: async () => [],
    findGuestBooking: async () => null,
    async requestCancellation() {
      simulated.push('Cancellation request would be sent to your team')
      return 'cancellation_requested'
    },
    checkReschedule: async () => ({ availability: 'pending_manual', total_paise: null, quote_snapshot: null }),
    async requestReschedule() {
      simulated.push('Date-change request would be sent to your team')
    },
    async recordFeedback() {
      simulated.push('Feedback would be saved')
      return true
    },
  }

  const result = await handleInbound(svc, prev ?? initialState(), {
    text: input.text,
    replyId: input.replyId,
    messageId: `simulated.${now.getTime()}.${randomBytes(4).toString('hex')}`,
  })
  return {
    state: result.state,
    messages: result.replies.map(renderReply),
    events: result.events,
    handoff: result.handoff,
    simulated,
  }
}
