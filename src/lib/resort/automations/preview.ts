import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { checkOccupancy } from '../availability'
import { renderReply, type RenderedMessage } from '../bot/provider'
import { handleInbound, initialState } from '../bot/machine'
import type { BotServices } from '../bot/types'
import { stayOccupancy, validateStayDates } from '../occupancy'
import { describeRates, formatQuoteText, quoteStay } from '../pricing'
import { loadPropertyBundle, missingPricing } from '../property-store'
import { isIsoDate } from '../time'
import { automationDefinition, type AutomationSettings, type ResortAutomationKey } from './definitions'
import { guestMessageBody } from './scheduled'

export const previewInputSchema = z
  .object({
    check_in: z.string().refine(isIsoDate, 'Invalid date').optional(),
    check_out: z.string().refine(isIsoDate, 'Invalid date').optional(),
    adults: z.number().int().min(1).max(500).optional(),
  })
  .strict()
export type PreviewInput = z.infer<typeof previewInputSchema>

export interface PreviewCheck {
  label: string
  ok: boolean
  detail?: string
}

export interface AutomationPreview {
  key: ResortAutomationKey
  /** Always true: a test never sends a message, creates a booking or changes data. */
  read_only: true
  summary: string
  checks: PreviewCheck[]
  messages: RenderedMessage[]
  data?: Record<string, unknown>
}

function sampleBookingPayload() {
  return {
    booking_ref: 'VF-000000-SAMPL',
    guest_name: 'Sample Guest',
    booking_type: 'stay',
    check_in: '2030-01-10',
    check_out: '2030-01-12',
    guest_count: 6,
    total_paise: null,
    paid_paise: 0,
    balance_paise: null,
    due_date: '2030-01-03',
  }
}

/** Services that refuse every write, so the machine can be exercised without side effects. */
function sandboxServices(base: Pick<BotServices, 'settings' | 'pricing' | 'automations'>): BotServices {
  const refuse = async (): Promise<never> => {
    throw new Error('preview: writes are disabled')
  }
  return {
    ...base,
    now: () => new Date(),
    contactName: null,
    contactPhone: null,
    amenities: [],
    siteUrl: null,
    faqs: async () => [],
    checkStay: async () => 'unknown',
    checkEvent: async () => 'unknown',
    alternatives: async () => null,
    submitStay: refuse,
    submitEvent: refuse,
    reserve: refuse,
    handoff: async () => {},
    noteInterest: async () => {},
    guestBookings: async () => [],
    findGuestBooking: async () => null,
    requestCancellation: refuse,
    checkReschedule: refuse,
    requestReschedule: refuse,
    recordFeedback: async () => false,
  }
}

/**
 * "Run Test" for one automation: shows what it would send and whether its
 * prerequisites are configured. Reads data (including a live availability
 * check when dates are given) but never sends, books or writes.
 */
export async function previewAutomation(
  db: SupabaseClient,
  accountId: string,
  key: ResortAutomationKey,
  automations: AutomationSettings,
  input: PreviewInput,
): Promise<AutomationPreview> {
  const def = automationDefinition(key)
  const bundle = await loadPropertyBundle(db, accountId)
  const settings = bundle.settings
  const checks: PreviewCheck[] = [
    { label: 'Automation enabled', ok: automations.enabled[key], detail: automations.enabled[key] ? undefined : 'Disabled — nothing runs until an admin enables it.' },
    { label: 'Resort profile set up', ok: Boolean(settings) },
  ]
  const out: AutomationPreview = { key, read_only: true, summary: def.description, checks, messages: [] }
  if (!settings) return out

  const conversation = async (steps: { text: string; replyId?: string }[], autos: AutomationSettings = automations) => {
    const svc = sandboxServices({ settings, pricing: bundle.pricing, automations: autos })
    let state = initialState()
    let replies: RenderedMessage[] = []
    for (const [i, s] of steps.entries()) {
      const res = await handleInbound(svc, state, { text: s.text, replyId: s.replyId ?? null, messageId: `preview.${i}` })
      state = res.state
      replies = res.replies.map(renderReply)
    }
    return replies
  }

  switch (key) {
    case 'welcome_menu':
      checks.push({ label: 'WhatsApp bot switched on (Resort settings)', ok: settings.bot_enabled })
      checks.push({ label: 'Test mode (replies only to test numbers)', ok: settings.test_mode, detail: settings.test_mode ? 'On — guests get no real replies.' : 'Off — guests get real replies once enabled.' })
      out.messages = await conversation([{ text: 'Hi' }])
      break
    case 'stay_enquiry':
      checks.push({ label: 'Maximum overnight guests configured', ok: settings.max_stay_guests !== null, detail: settings.max_stay_guests === null ? 'Not configured — every stay goes to manual review.' : undefined })
      out.messages = await conversation([{ text: 'Hi' }, { text: '1' }])
      break
    case 'stay_booking_enquiry':
      checks.push({ label: 'Maximum overnight guests configured', ok: settings.max_stay_guests !== null, detail: settings.max_stay_guests === null ? 'Not configured — every enquiry is reviewed by the team.' : undefined })
      // Shown as it will run once enabled, even while it is still off.
      out.messages = await conversation([{ text: 'BOOK STAY' }], {
        ...automations,
        enabled: { ...automations.enabled, welcome_menu: true, stay_booking_enquiry: true },
      })
      break
    case 'availability_check': {
      if (input.check_in && input.check_out) {
        const err = validateStayDates(input.check_in, input.check_out)
        if (err) {
          checks.push({ label: 'Dates valid', ok: false, detail: err.replace(/_/g, ' ') })
        } else {
          const r = await checkOccupancy(db, accountId, stayOccupancy(input.check_in, input.check_out, settings), {
            needsManualReview: settings.manual_approval_required || settings.max_stay_guests === null,
          })
          out.data = { check_in: input.check_in, check_out: input.check_out, status: r.status, conflicts: r.conflicts?.length ?? 0 }
          checks.push({ label: 'Live calendar read', ok: r.status !== 'unknown', detail: `Result: ${r.status.replace('_', ' ')}` })
        }
      } else {
        checks.push({ label: 'Live calendar read', ok: true, detail: 'Give check-in and check-out dates to run a read-only availability check.' })
      }
      break
    }
    case 'pricing_quote': {
      const missing = missingPricing(bundle.pricing.rules)
      checks.push({ label: 'Stay rates configured', ok: missing.length === 0, detail: missing.length ? `Not configured: ${missing.join(', ')}` : undefined })
      out.data = { rates: describeRates(bundle.pricing) }
      if (input.check_in && input.check_out) {
        const q = quoteStay({ ...bundle.pricing, now: new Date() }, { check_in: input.check_in, check_out: input.check_out, adults: input.adults ?? 2, children: 0 })
        out.data.quote = q
        if (q.status === 'ok') out.messages = [{ kind: 'text', text: formatQuoteText(q.quote) }]
        checks.push({ label: 'Sample quote', ok: q.status === 'ok', detail: q.status === 'ok' ? undefined : `Cannot price: ${q.status.replace(/_/g, ' ')} — the team would be asked to quote.` })
      }
      break
    }
    case 'event_enquiry':
      checks.push({ label: 'Maximum event guests configured', ok: settings.max_event_guests !== null })
      checks.push({ label: 'Event packages published', ok: bundle.pricing.packages.length > 0, detail: bundle.pricing.packages.length ? undefined : 'None — events are priced by the team after review.' })
      out.messages = await conversation([{ text: 'Hi' }, { text: '2' }])
      break
    case 'human_escalation': {
      const { count } = await db.from('profiles').select('user_id', { count: 'exact', head: true }).eq('account_id', accountId).in('account_role', ['owner', 'admin', 'agent'])
      checks.push({ label: 'Staff who receive alerts', ok: (count ?? 0) > 0, detail: `${count ?? 0} member(s)` })
      checks.push({ label: 'Auto-assign', ok: true, detail: automations.config.human_escalation.assign_to_user_id ? 'Assigns to the configured staff member' : 'Off — conversations stay unassigned; all staff are alerted' })
      out.messages = await conversation([{ text: 'Hi' }, { text: 'human' }])
      break
    }
    case 'booking_confirmation':
    case 'payment_reminder':
    case 'pre_arrival_reminder':
    case 'post_stay_feedback':
    case 'abandoned_followup': {
      const kind = {
        booking_confirmation: 'booking_confirmed',
        payment_reminder: 'payment_reminder',
        pre_arrival_reminder: 'upcoming_arrival',
        post_stay_feedback: 'post_stay_feedback',
        abandoned_followup: 'enquiry_followup',
      }[key]
      const cfg = automations.config[key] as { template_name?: string | null }
      checks.push({
        label: 'Approved template for messages outside 24 hours',
        ok: Boolean(cfg.template_name),
        detail: cfg.template_name ? cfg.template_name : 'Not configured — outside the 24-hour window the message is skipped.',
      })
      if (key === 'payment_reminder') {
        const due = automations.config.payment_reminder.balance_due_days_before
        checks.push({ label: 'Balance due date configured', ok: due !== null, detail: due === null ? 'Not configured — no reminders are scheduled.' : `${due} day(s) before arrival` })
      }
      if (key === 'pre_arrival_reminder') {
        const hours = automations.config.pre_arrival_reminder.hours_before ?? settings.reminder_settings?.arrival_reminder_hours ?? null
        checks.push({ label: 'Reminder timing configured', ok: hours !== null, detail: hours === null ? 'Not configured — no reminders are scheduled.' : `${hours} hour(s) before arrival` })
      }
      if (key === 'abandoned_followup') {
        const hours = automations.config.abandoned_followup.after_hours
        checks.push({ label: 'Follow-up period configured', ok: hours !== null, detail: hours === null ? 'Not configured — no follow-ups are sent.' : `After ${hours} hour(s) of silence, up to ${automations.config.abandoned_followup.max_follow_ups}` })
      }
      const body = guestMessageBody(kind, sampleBookingPayload(), settings, automations)
      checks.push({ label: 'Message content available', ok: body !== null, detail: body === null ? 'Needs details that are not configured yet.' : 'Sample below uses a made-up booking.' })
      if (body) out.messages = [{ kind: 'text', text: body }]
      break
    }
    case 'cancel_reschedule':
      checks.push({ label: 'Cancellation policy published', ok: Boolean(settings.cancellation_policy) })
      checks.push({
        label: 'Cancellation refund rules configured',
        ok: Boolean(bundle.pricing.rules?.cancellation_rules?.length),
        detail: bundle.pricing.rules?.cancellation_rules?.length ? undefined : 'Not configured — guests are told the team will explain any charges.',
      })
      out.messages = await conversation([{ text: 'I want to cancel my booking' }])
      break
  }
  return out
}
