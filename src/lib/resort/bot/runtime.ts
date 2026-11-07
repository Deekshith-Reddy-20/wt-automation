import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkOccupancy, suggestAlternativeStays } from '../availability'
import type { AutomationSettings } from '../automations/definitions'
import { loadAutomationSettings, recordAutomationRun } from '../automations/store'
import { cancelBooking, coerceBooking, createEventEnquiry, createStayEnquiry, getBooking, getBookingByRef, requestReservation } from '../bookings'
import { upsertLead } from '../leads'
import { alertStaff, writeAudit } from '../notify'
import { eventDurationHours, eventOccupancy, stayOccupancy } from '../occupancy'
import { quoteEvent, quoteStay } from '../pricing'
import { loadPropertyBundle, loadPublishedFaqs, type PropertyBundle } from '../property-store'
import { generateAccessToken, waIdToE164 } from '../refs'
import { applyResortTags, type ResortTag } from '../tags'
import { todayIST } from '../time'
import type { Booking, EventType, PropertySettings } from '../types'
import { resortWebsiteUrl } from '../website'
import { exploreContent } from '../explore-media'
import { asksForMenu, handleInbound, initialState } from './machine'
import { deliver, dryRunForced, MetaCloudProvider, type WhatsAppProvider } from './provider'
import type { AutomationEvent, BotInput, BotServices, BotState, GuestBooking, ReserveResult } from './types'
import { noopTrace, type Trace } from '@/lib/msg91/trace'
import { cached, CONFIG_TTL_MS } from '../config-cache'

export interface ResortInbound {
  accountId: string
  /** whatsapp_config owner — the user id bot messages are attributed to. */
  userId: string
  contactId: string
  conversationId: string
  contact: { phone: string | null; name: string | null }
  message: BotInput
  /** Tests inject a provider; production uses Meta Cloud. */
  provider?: WhatsAppProvider
  now?: Date
  trace?: Trace
  /**
   * Conversation state already being read by the caller (started alongside the
   * inbox write). Used for the first attempt only; saveState's version check
   * still rejects it if another message got there first.
   */
  prefetchedState?: Promise<unknown>
}

export interface DispatchResult {
  consumed: boolean
  /** Why the bot sent nothing for this message, when it didn't. */
  skipped?: string
}

interface StateRow {
  id: string
  flow: BotState['flow']
  step: string
  data: Record<string, unknown>
  history: BotState['history']
  bot_mode: 'bot' | 'human'
  handoff_at: string | null
  handoff_reason?: string | null
  handed_off_by?: string | null
  last_inbound_at: string | null
  last_processed_message_id: string | null
  version: number
}

export const siteBaseUrl = resortWebsiteUrl

/**
 * Hand an inbound WhatsApp message to the V-Farms bot. Returns
 * consumed=false when the bot is not enabled for this account, so the
 * existing flows / automations / AI reply keep working unchanged.
 * While a conversation is in human mode the bot stays silent but still
 * consumes the message, so no other automation answers over the team —
 * unless the guest starts over after the team has gone quiet (see
 * resumeQuietHandoff).
 */
function loadGate(db: SupabaseClient, accountId: string) {
  return cached(`gate:${accountId}`, CONFIG_TTL_MS, async () => {
    const r = await db.from('property_settings').select('bot_enabled').eq('account_id', accountId).maybeSingle()
    if (r.error) throw r.error
    return r
  })
}

type Amenity = { name: string; description: string | null }

function loadBotConfig(db: SupabaseClient, accountId: string) {
  return Promise.all([
    cached(`automations:${accountId}`, CONFIG_TTL_MS, () => loadAutomationSettings(db, accountId)),
    cached(`bundle:${accountId}`, CONFIG_TTL_MS, () => loadPropertyBundle(db, accountId)),
    cached(`amenities:${accountId}`, CONFIG_TTL_MS, async () => {
      const { data, error } = await db
        .from('amenities')
        .select('name, description')
        .eq('account_id', accountId)
        .eq('is_approved', true)
        .order('sort_order')
      if (error) throw new Error(`Could not load amenities: ${error.message}`)
      return (data ?? []) as Amenity[]
    }).catch(() => [] as Amenity[]),
  ])
}

/** Warm the bot's config cache while the inbox write is still running. Never throws. */
export function prefetchResortBotConfig(accountId: string): void {
  const db = supabaseAdmin()
  loadGate(db, accountId).catch(() => {})
  loadBotConfig(db, accountId).catch(() => {})
}

export async function dispatchInboundToResortBot(args: ResortInbound): Promise<DispatchResult> {
  const db = supabaseAdmin()
  const trace = args.trace ?? noopTrace
  const { data: gate, error: gateErr } = await loadGate(db, args.accountId)
    .catch((error: { message: string }) => ({ data: null, error }))
  if (gateErr || !gate?.bot_enabled) {
    const skipped = gateErr ? `settings_lookup_failed: ${gateErr.message}` : 'bot_disabled'
    trace.log('BOT_SKIPPED', { reason: skipped })
    return { consumed: false, skipped }
  }

  try {
    trace.log('BOT_PROCESSING_STARTED', { conversationId: args.conversationId, replyId: args.message.replyId, unsupported: args.message.unsupported ?? undefined })
    const result = await runBot(db, args, trace)
    if (result.skipped) trace.log('BOT_SKIPPED', { reason: result.skipped })
    return result
  } catch (err) {
    trace.log('PROCESSING_FAILED', { stage: 'bot', error: err instanceof Error ? err.message : String(err) })
    console.error('[resort-bot] failed:', err instanceof Error ? err.message : err)
    await alertStaff(db, args.accountId, {
      kind: 'message_failed',
      title: 'WhatsApp bot could not reply',
      body: 'The bot hit an error handling a guest message. Please reply from the inbox.',
      linkPath: `/inbox?c=${args.conversationId}`,
      conversationId: args.conversationId,
      contactId: args.contactId,
    })
    return { consumed: true }
  }
}

async function runBot(db: SupabaseClient, args: ResortInbound, trace: Trace): Promise<DispatchResult> {
  const now = args.now ?? new Date()
  // Conversation state is always read fresh; static config comes from the short-lived cache. All in parallel.
  const configLoad = loadBotConfig(db, args.accountId)
  configLoad.catch(() => {})
  let row = args.prefetchedState
    ? ((await args.prefetchedState.catch(() => loadState(db, args.conversationId))) as StateRow | null)
    : await loadState(db, args.conversationId)

  if (row?.bot_mode === 'human') {
    const resumed = await resumeQuietHandoff(db, row, args.message, now)
    if (!resumed) {
      await db.from('conversation_states').update({ last_inbound_at: now.toISOString() }).eq('id', row.id)
      return { consumed: true, skipped: 'human_mode' }
    }
    row = resumed
  }
  if (row?.last_processed_message_id === args.message.messageId) return { consumed: true, skipped: 'already_processed' }

  const [automations, bundle, amenities] = await configLoad
  // The welcome automation (A) is the entry point: while it is off the bot stays out of new conversations.
  if (!automations.enabled.welcome_menu) return { consumed: false, skipped: 'welcome_menu_disabled' }
  const isNewConversation = row === null
  const settings = bundle.settings
  if (!settings) return { consumed: false, skipped: 'property_settings_missing' }

  const contactPhone = waIdToE164(args.contact.phone)
  const svc = buildServices(db, args, bundle, settings, contactPhone, amenities, now, automations)

  for (let attempt = 0; attempt < 2; attempt++) {
    const prev: BotState = row
      ? { flow: row.flow, step: row.step, data: row.data ?? {}, history: row.history ?? [], lastInboundAt: row.last_inbound_at }
      : initialState()
    const decideStart = performance.now()
    const result = await handleInbound(svc, prev, args.message)
    const decisionOnlyMs = Math.round((performance.now() - decideStart) * 10) / 10

    const saved = await saveState(db, args, row, result.state, result.handoff ? (result.handoffReason ?? 'guest_requested') : null, now)
    if (!saved) {
      // Another message for this conversation was processed concurrently; re-run on the fresh state once.
      row = await loadState(db, args.conversationId)
      if (row?.bot_mode === 'human') return { consumed: true, skipped: 'human_mode' }
      continue
    }
    trace.mark('bot_decision_ms')
    trace.log('BOT_RESPONSE_GENERATED', { flow: result.state.flow, step: result.state.step, replies: result.replies.length, handoff: result.handoff, decision_only_ms: decisionOnlyMs })

    const provider = args.provider ?? new MetaCloudProvider({
      accountId: args.accountId,
      userId: args.userId,
      conversationId: args.conversationId,
      contactId: args.contactId,
    })
    const dryRun = dryRunForced() || (settings.test_mode && !(contactPhone && settings.test_phone_numbers.includes(contactPhone)))
    const { failed, errors } = await deliver(provider, result.replies, { dryRun })
    if (failed > 0) {
      trace.log('PROCESSING_FAILED', { stage: 'send', error: errors[0]?.slice(0, 200) })
      console.error('[resort-bot] reply delivery failed:', errors[0])
      await alertStaff(db, args.accountId, {
        kind: 'message_failed',
        title: 'WhatsApp reply failed to send',
        body: `A bot reply could not be delivered${errors[0] ? ` (${errors[0].slice(0, 120)})` : ''}. Please follow up from the inbox.`,
        linkPath: `/inbox?c=${args.conversationId}`,
        conversationId: args.conversationId,
        contactId: args.contactId,
        dedupeKey: `message_failed:${args.message.messageId}`,
      })
    }
    await recordBotEvents(db, args, result.events, { isNewConversation, dryRun, deliveryError: failed > 0 ? (errors[0] ?? 'delivery_failed') : null })
    return { consumed: true }
  }
  return { consumed: true }
}

/** Execution history + guest tags for what the automations did on this message. */
async function recordBotEvents(
  db: SupabaseClient,
  args: ResortInbound,
  events: AutomationEvent[],
  ctx: { isNewConversation: boolean; dryRun: boolean; deliveryError: string | null },
): Promise<void> {
  const seen = new Set<string>()
  for (const ev of events) {
    if (seen.has(ev.key)) continue
    seen.add(ev.key)
    const failedDelivery = ev.status === 'success' && ctx.deliveryError !== null
    await recordAutomationRun(db, {
      accountId: args.accountId,
      key: ev.key,
      trigger: 'inbound_message',
      status: failedDelivery ? 'failed' : ev.status,
      dedupeKey: `bot:${args.message.messageId}:${ev.key}`,
      conversationId: args.conversationId,
      contactId: args.contactId,
      bookingId: typeof ev.detail?.booking_id === 'string' ? ev.detail.booking_id : null,
      detail: { ...ev.detail, ...(ctx.dryRun ? { dry_run: true } : {}) },
      error: failedDelivery ? `Reply not delivered: ${ctx.deliveryError}` : ev.error ?? null,
    })
  }

  const add = new Set<ResortTag>()
  for (const ev of events) {
    if (ev.status === 'failed') continue
    if (ev.key === 'welcome_menu' && ctx.isNewConversation) add.add('new_guest')
    if ((ev.key === 'stay_enquiry' || ev.key === 'stay_booking_enquiry') && ev.detail?.ref) add.add('stay_enquiry')
    if (ev.key === 'event_enquiry' && ev.detail?.ref) add.add('event_enquiry')
    if (ev.key === 'availability_check') add.add('availability_requested')
    if (ev.key === 'pricing_quote' && ev.detail?.ref) add.add(ev.status === 'success' ? 'quote_sent' : 'quote_requested')
    if (ev.key === 'stay_enquiry' && ev.detail?.reserve === 'payment_required') add.add('pending_payment')
    else if (ev.key === 'booking_request' && typeof ev.detail?.reserve === 'string' && ev.detail.reserve.startsWith('requested')) add.add('booking_requested')
    if (ev.key === 'human_escalation') add.add('needs_human')
  }
  if (add.has('stay_enquiry') || add.has('event_enquiry')) {
    const { count } = await db
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', args.accountId)
      .eq('contact_id', args.contactId)
      .in('status', ['completed', 'checked_out'])
    if ((count ?? 0) > 0) add.add('returning_guest')
  }
  if (add.size > 0) await applyResortTags(db, args.accountId, args.contactId, { add: [...add] })
}

const INACTIVE_FOR_GUEST = ['cancelled', 'rejected', 'expired', 'completed', 'checked_out', 'cancellation_requested']

function toGuestBooking(b: Booking): GuestBooking {
  return {
    id: b.id,
    ref: b.booking_ref,
    type: b.booking_type,
    status: b.status,
    check_in: b.check_in,
    check_out: b.check_out,
    event_date: b.event_date,
    start_time: b.event_start_time,
    end_time: b.event_end_time,
    amount_paid_paise: Math.round(Number(b.amount_paid ?? 0) * 100),
  }
}

const STATE_COLUMNS = 'id, flow, step, data, history, bot_mode, handoff_at, handoff_reason, handed_off_by, last_inbound_at, last_processed_message_id, version'

/** How long staff must have been silent before a guest's greeting / MENU hands the chat back to the bot. */
export const HUMAN_QUIET_MS = 30 * 60 * 1000

/** Handoffs a person on the team made (took over, or replied); every other handoff was started by the bot. */
const STAFF_HANDOFF_REASONS = new Set(['staff_takeover', 'agent_replied'])

/**
 * Human mode ends when the guest starts over (greeting or MENU). If the bot
 * handed off (guest asked for a person, missing setting, …) that happens at
 * once, so the guest is never stuck talking to no one. If staff took over or
 * replied, it waits until they have been quiet for HUMAN_QUIET_MS
 * (`handoff_at` is refreshed on every staff reply), so an active staff
 * conversation is never interrupted. Returns the fresh bot-mode row, or null to stay silent.
 */
export async function resumeQuietHandoff(
  db: SupabaseClient,
  row: StateRow,
  input: BotInput,
  now: Date,
): Promise<StateRow | null> {
  if (!asksForMenu(input)) return null
  const handoffAt = row.handoff_at ? Date.parse(row.handoff_at) : NaN
  const staffHandoff = Boolean(row.handed_off_by) || STAFF_HANDOFF_REASONS.has(row.handoff_reason ?? 'staff_takeover')
  if (staffHandoff && Number.isFinite(handoffAt) && now.getTime() - handoffAt < HUMAN_QUIET_MS) return null
  const { data, error } = await db
    .from('conversation_states')
    .update({
      bot_mode: 'bot',
      flow: 'menu',
      step: 'start',
      data: {},
      history: [],
      resumed_at: now.toISOString(),
      resumed_by: null,
      version: row.version + 1,
    })
    .eq('id', row.id)
    .eq('version', row.version)
    .select(STATE_COLUMNS)
  if (error || !data?.length) return null
  return data[0] as StateRow
}

export function loadConversationState(db: SupabaseClient, conversationId: string): Promise<unknown> {
  return loadState(db, conversationId)
}

async function loadState(db: SupabaseClient, conversationId: string): Promise<StateRow | null> {
  const { data, error } = await db
    .from('conversation_states')
    .select(STATE_COLUMNS)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) throw new Error(`Could not load conversation state: ${error.message}`)
  return (data as StateRow | null) ?? null
}

/** Compare-and-swap on `version`, so two concurrent messages can't clobber each other. */
async function saveState(
  db: SupabaseClient,
  args: ResortInbound,
  row: StateRow | null,
  state: BotState,
  handoffReason: string | null,
  now: Date,
): Promise<boolean> {
  const fields = {
    flow: state.flow,
    step: state.step,
    data: state.data,
    history: state.history,
    last_inbound_at: now.toISOString(),
    last_processed_message_id: args.message.messageId,
    ...(handoffReason ? { bot_mode: 'human', handoff_at: now.toISOString(), handoff_reason: handoffReason } : {}),
  }
  if (!row) {
    const { error } = await db.from('conversation_states').insert({
      account_id: args.accountId,
      conversation_id: args.conversationId,
      contact_id: args.contactId,
      ...fields,
    })
    if (!error) return true
    if ((error as { code?: string }).code === '23505') return false
    throw new Error(`Could not save conversation state: ${error.message}`)
  }
  const { data, error } = await db
    .from('conversation_states')
    .update({ ...fields, version: row.version + 1 })
    .eq('id', row.id)
    .eq('version', row.version)
    .select('id')
  if (error) throw new Error(`Could not save conversation state: ${error.message}`)
  return (data ?? []).length === 1
}

function buildServices(
  db: SupabaseClient,
  args: ResortInbound,
  bundle: PropertyBundle,
  settings: PropertySettings,
  contactPhone: string | null,
  amenities: { name: string; description: string | null }[],
  now: Date,
  automations: AutomationSettings,
): BotServices {
  const siteUrl = siteBaseUrl()
  const link = (ref: string, token: string | null) => (siteUrl && token ? `${siteUrl}/booking/${ref}?t=${encodeURIComponent(token)}` : null)

  return {
    now: () => args.now ?? new Date(),
    settings,
    pricing: bundle.pricing,
    contactName: args.contact.name?.trim() || null,
    contactPhone,
    amenities,
    siteUrl,
    explore: exploreContent(),
    automations,
    faqs: () => loadPublishedFaqs(db, args.accountId),

    async checkStay(checkIn, checkOut) {
      const r = await checkOccupancy(db, args.accountId, stayOccupancy(checkIn, checkOut, settings), {
        needsManualReview: settings.manual_approval_required || settings.max_stay_guests === null,
      })
      return r.status
    },

    async checkEvent(date, start, end) {
      const r = await checkOccupancy(db, args.accountId, eventOccupancy(date, start, end, settings.event_buffer_minutes), {
        needsManualReview: true,
      })
      return r.status
    },

    alternatives: (checkIn, nights) => suggestAlternativeStays(db, args.accountId, checkIn, nights, settings, { now }),

    async submitStay(d, key) {
      const out = await createStayEnquiry(db, bundle, {
        accountId: args.accountId,
        source: 'whatsapp',
        contactId: args.contactId,
        conversationId: args.conversationId,
        guestName: d.name,
        guestPhone: contactPhone,
        specialRequirements: d.special_requirements,
        idempotencyKey: key,
        checkIn: d.check_in,
        checkOut: d.check_out,
        adults: d.adults,
        children: d.children,
        childrenAges: d.children_ages,
        purpose: d.purpose,
        ...(d.enquiry_only ? { initialStatus: 'enquiry' as const } : {}),
        now,
      })
      if (out.created && out.quote.status !== 'ok' && automations.enabled.pricing_quote && automations.config.pricing_quote.notify_team_when_unpriced) {
        await alertStaff(db, args.accountId, {
          kind: 'quote_requested',
          title: `Quote needed ${out.booking.booking_ref}`,
          body: `The pricing rules couldn't price ${d.check_in} → ${d.check_out} (${out.quote.status.replace(/_/g, ' ')}). Please send the guest a quote.`,
          linkPath: `/resort/bookings/${out.booking.id}`,
          conversationId: args.conversationId,
          contactId: args.contactId,
          bookingId: out.booking.id,
          dedupeKey: `quote_requested:${out.booking.id}`,
        })
      }
      return {
        ref: out.booking.booking_ref,
        bookingId: out.booking.id,
        availability: out.availability.status,
        quote: out.quote,
        link: link(out.booking.booking_ref, out.accessToken),
      }
    },

    async submitEvent(d, key) {
      const out = await createEventEnquiry(db, bundle, {
        accountId: args.accountId,
        source: 'whatsapp',
        contactId: args.contactId,
        conversationId: args.conversationId,
        guestName: d.name,
        guestPhone: d.contact_phone,
        idempotencyKey: key,
        eventType: d.event_type as EventType,
        eventTypeOther: d.event_type_other,
        eventDate: d.event_date,
        startTime: d.start_time,
        endTime: d.end_time,
        guestCount: d.guest_count,
        accommodationRequired: d.accommodation_required,
        cateringRequired: d.catering_required,
        decorationRequirements: d.decoration_requirements,
        budgetInr: d.budget_inr,
        now,
      })
      return {
        ref: out.booking.booking_ref,
        bookingId: out.booking.id,
        availability: out.availability.status,
        quote: out.quote,
        link: link(out.booking.booking_ref, out.accessToken),
      }
    },

    async reserve(bookingId): Promise<ReserveResult> {
      const r = await requestReservation(db, bundle, args.accountId, bookingId, { now })
      switch (r.outcome) {
        case 'payment_required': {
          // Issue a fresh private link for the payment page (only the hash is stored).
          let paymentLink: string | null = null
          if (siteUrl) {
            const { token, hash } = generateAccessToken()
            const { error } = await db.from('bookings').update({ access_token_hash: hash }).eq('id', r.booking.id)
            if (!error) paymentLink = link(r.booking.booking_ref, token)
          }
          return { outcome: 'payment_required', holdExpiresAt: r.holdExpiresAt, paymentLink }
        }
        case 'requested':
          return { outcome: 'requested', holdExpiresAt: r.holdExpiresAt }
        case 'requested_review':
          return { outcome: 'requested_review' }
        case 'unavailable':
          return { outcome: 'unavailable' }
        default:
          return { outcome: 'not_eligible', reason: r.reason }
      }
    },

    async handoff(reason, summary) {
      await upsertLead(db, {
        accountId: args.accountId,
        contactId: args.contactId,
        conversationId: args.conversationId,
        phoneE164: contactPhone,
        customerName: args.contact.name,
        source: 'whatsapp',
        signals: { requested_human: true },
        now,
      }).catch((err) => console.error('[resort-bot] lead update failed:', err))
      await alertStaff(db, args.accountId, {
        kind: 'handoff_requested',
        title: `Guest needs a person${args.contact.name ? `: ${args.contact.name}` : ''}`,
        body: `${reasonLabel(reason)}. ${summary}`,
        linkPath: `/inbox?c=${args.conversationId}`,
        conversationId: args.conversationId,
        contactId: args.contactId,
        dedupeKey: `handoff:${args.conversationId}:${args.message.messageId}`,
      })
      const assignee = automations.config.human_escalation.assign_to_user_id
      if (assignee) {
        await db
          .from('conversations')
          .update({ assigned_agent_id: assignee })
          .eq('id', args.conversationId)
          .is('assigned_agent_id', null)
      }
    },

    async guestBookings() {
      const today = todayIST(now)
      const { data, error } = await db
        .from('bookings')
        .select('*')
        .eq('account_id', args.accountId)
        .eq('contact_id', args.contactId)
        .not('status', 'in', `(${INACTIVE_FOR_GUEST.join(',')})`)
        .or(`check_out.gte.${today},event_date.gte.${today}`)
        .order('created_at', { ascending: false })
        .limit(9)
      if (error) throw new Error(`Could not load bookings: ${error.message}`)
      return (data ?? []).map((r) => toGuestBooking(coerceBooking(r)))
    },

    async findGuestBooking(ref) {
      const b = await getBookingByRef(db, ref)
      if (!b || b.account_id !== args.accountId) return null
      const ownsIt = b.contact_id === args.contactId || (contactPhone !== null && b.guest_phone === contactPhone)
      if (!ownsIt || INACTIVE_FOR_GUEST.includes(b.status)) return null
      const start = b.check_out ?? b.event_date
      if (start && start < todayIST(now)) return null
      return toGuestBooking(b)
    },

    async requestCancellation(bookingId) {
      const status = await cancelBooking(db, args.accountId, bookingId, { byGuest: true, reason: 'Guest requested via WhatsApp' })
      if (status === 'cancellation_requested') {
        const { error } = await db.from('booking_change_requests').insert({
          account_id: args.accountId,
          booking_id: bookingId,
          kind: 'cancel',
          reason: 'Guest requested via WhatsApp',
        })
        if (error && (error as { code?: string }).code !== '23505') {
          console.error('[resort-bot] could not record cancellation request:', error.message)
        }
        return 'cancellation_requested'
      }
      return 'cancelled'
    },

    async checkReschedule(bookingId, change) {
      const { data, error } = await db.from('bookings').select('*').eq('id', bookingId).eq('account_id', args.accountId).maybeSingle()
      if (error || !data) throw new Error('booking_not_found')
      const b = coerceBooking(data)
      if (b.booking_type === 'event') {
        if (!change.event_date || !b.event_start_time || !b.event_end_time) throw new Error('invalid_change')
        const occ = eventOccupancy(change.event_date, b.event_start_time, b.event_end_time, settings.event_buffer_minutes)
        const avail = await checkOccupancy(db, args.accountId, occ, { excludeBookingId: b.id, needsManualReview: true })
        const { data: ev } = await db.from('event_requests').select('event_type').eq('booking_id', b.id).maybeSingle()
        const q = quoteEvent({ ...bundle.pricing, now }, {
          event_type: (ev?.event_type ?? 'other') as EventType,
          event_hours: eventDurationHours(b.event_start_time, b.event_end_time),
          guest_count: b.guest_count,
        })
        return {
          availability: avail.status,
          total_paise: q.status === 'ok' ? q.quote.total : null,
          quote_snapshot: q.status === 'ok' ? (q.quote as unknown as Record<string, unknown>) : null,
        }
      }
      if (!change.check_in || !change.check_out) throw new Error('invalid_change')
      const occ = stayOccupancy(change.check_in, change.check_out, settings)
      const avail = await checkOccupancy(db, args.accountId, occ, {
        excludeBookingId: b.id,
        needsManualReview: settings.manual_approval_required || settings.max_stay_guests === null,
      })
      const q = quoteStay({ ...bundle.pricing, now }, {
        check_in: change.check_in,
        check_out: change.check_out,
        adults: b.adults,
        children: b.children,
        children_ages: b.children_ages,
      })
      return {
        availability: avail.status,
        total_paise: q.status === 'ok' ? q.quote.total : null,
        quote_snapshot: q.status === 'ok' ? (q.quote as unknown as Record<string, unknown>) : null,
      }
    },

    async recordFeedback(bookingId, rating, comment) {
      const { data: b } = await db
        .from('bookings')
        .select('id, contact_id')
        .eq('id', bookingId)
        .eq('account_id', args.accountId)
        .maybeSingle()
      if (!b || b.contact_id !== args.contactId) return false
      const { error } = await db.from('booking_feedback').insert({
        account_id: args.accountId,
        booking_id: bookingId,
        contact_id: args.contactId,
        rating,
        comment,
        source: 'whatsapp',
      })
      if (error) {
        if ((error as { code?: string }).code === '23505') return false
        throw new Error(`Could not save feedback: ${error.message}`)
      }
      return true
    },

    async requestReschedule(bookingId, change, check) {
      const { data: inserted, error } = await db
        .from('booking_change_requests')
        .insert({
          account_id: args.accountId,
          booking_id: bookingId,
          kind: 'reschedule',
          requested_check_in: change.check_in ?? null,
          requested_check_out: change.check_out ?? null,
          requested_event_date: change.event_date ?? null,
          availability_status: check.availability,
          quote_snapshot: check.quote_snapshot,
          reason: 'Guest requested via WhatsApp',
        })
        .select('id')
        .maybeSingle()
      if (error && (error as { code?: string }).code !== '23505') throw new Error(`Could not record the request: ${error.message}`)
      const when = change.event_date ?? `${change.check_in} → ${change.check_out}`
      await alertStaff(db, args.accountId, {
        kind: 'reschedule_requested',
        title: `Date change requested${args.contact.name ? `: ${args.contact.name}` : ''}`,
        body: `Guest asked to move their booking to ${when}. Live check: ${check.availability.replace('_', ' ')}${check.total_paise !== null ? ` · new total at current rates ₹${(check.total_paise / 100).toLocaleString('en-IN')}` : ' · price not configured'}. The booking is unchanged until you approve.`,
        linkPath: `/resort/bookings/${bookingId}`,
        conversationId: args.conversationId,
        contactId: args.contactId,
        bookingId,
        dedupeKey: `reschedule_requested:${inserted?.id ?? `${bookingId}:${args.message.messageId}`}`,
      })
      await writeAudit(db, {
        accountId: args.accountId,
        actorUserId: null,
        actorType: 'bot',
        action: 'booking.reschedule_requested',
        entityType: 'booking',
        entityId: bookingId,
        before: null,
        after: { ...change, availability: check.availability },
      })
    },

    async noteInterest(category) {
      await upsertLead(db, {
        accountId: args.accountId,
        contactId: args.contactId,
        conversationId: args.conversationId,
        phoneE164: contactPhone,
        customerName: args.contact.name,
        source: 'whatsapp',
        category,
        now,
      }).catch((err) => console.error('[resort-bot] lead update failed:', err))
    },
  }
}

function reasonLabel(reason: string): string {
  switch (reason) {
    case 'guest_requested': return 'Guest asked to talk to the team'
    case 'location_not_configured': return 'Guest asked for directions (location is not configured)'
    case 'bot_submit_failed': return 'The bot could not save the request'
    case 'reservation_failed': return 'The bot could not verify availability to reserve'
    case 'reservation_not_eligible': return 'Reservation request not eligible in its current state'
    case 'cancellation_requested': return 'Guest asked to cancel a booking'
    case 'reschedule_requested': return 'Guest asked to change booking dates'
    case 'cancellation_failed':
    case 'reschedule_failed': return 'The bot could not record a cancellation / date-change request'
    case 'booking_lookup_failed': return "The bot could not look up the guest's bookings"
    case 'low_feedback_rating': return 'Guest gave a low post-stay rating'
    default:
      if (reason.startsWith('automation_disabled:')) return `Guest chose an option whose automation is off (${reason.slice(20).replace(/_/g, ' ')})`
      return reason
  }
}
