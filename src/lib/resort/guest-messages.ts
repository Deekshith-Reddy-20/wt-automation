import type { SupabaseClient } from '@supabase/supabase-js'
import { engineSendTemplate } from '@/lib/automations/meta-send'
import { loadOptedOutAt } from '@/lib/contacts/opt-out'
import { engineSendText } from '@/lib/flows/meta-send'
import { msg91Configured } from '@/lib/msg91/env'
import { Msg91Provider } from '@/lib/msg91/provider'
import { automationSettingsFrom, type AutomationSettings } from './automations/definitions'
import {
  JOB_AUTOMATION,
  armFeedbackCapture,
  checkConfirmation,
  checkFeedback,
  checkFollowUp,
  checkPaymentReminder,
  guestMessageBody,
  type PreSendCheck,
} from './automations/scheduled'
import { loadAutomationSettings, recordAutomationRun } from './automations/store'
import { coerceBooking } from './bookings'
import { dryRunForced } from './bot/provider'
import { alertStaff } from './notify'
import { loadPropertyBundle } from './property-store'
import { applyResortTags } from './tags'
import { ticketUrl } from './ticket'
import type { Booking, PropertySettings } from './types'

/** Meta's customer-service window: free-form messages need an inbound message this recent. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000
const INACTIVE = new Set(['cancelled', 'rejected', 'expired', 'completed', 'checked_out', 'cancellation_requested'])

export interface GuestJobRow {
  id: string
  account_id: string
  kind: string
  channel: string
  contact_id: string | null
  conversation_id: string | null
  booking_id: string | null
  lead_id?: string | null
  template_name: string | null
  payload: Record<string, unknown>
  attempts: number
  max_attempts: number
  created_at?: string
}

export type JobOutcome = 'sent' | 'simulated' | 'skipped' | 'cancelled' | 'retry' | 'failed'

/**
 * Plain-text body for a guest message. Only configured property details are
 * used. Without automation settings the defaults apply (all copy fields
 * have defaults; nothing is invented).
 */
export function guestMessageText(
  kind: string,
  p: Record<string, unknown>,
  settings: PropertySettings | null,
  automations: AutomationSettings = automationSettingsFrom([]),
): string | null {
  return guestMessageBody(kind, p, settings, automations)
}

async function lastCustomerMessageAt(db: SupabaseClient, conversationId: string): Promise<Date | null> {
  const { data, error } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Window lookup failed: ${error.message}`)
  return data?.created_at ? new Date(data.created_at as string) : null
}

async function finish(db: SupabaseClient, job: GuestJobRow, status: 'sent' | 'skipped' | 'cancelled' | 'failed', lastError: string | null) {
  await db
    .from('notification_jobs')
    .update({ status, last_error: lastError, locked_at: null, ...(status === 'sent' ? { sent_at: new Date().toISOString() } : {}) })
    .eq('id', job.id)
}

async function record(db: SupabaseClient, job: GuestJobRow, outcome: JobOutcome, error: string | null, detail: Record<string, unknown> = {}) {
  const key = JOB_AUTOMATION[job.kind]
  if (!key || outcome === 'retry') return
  const status = outcome === 'sent' || outcome === 'simulated' ? 'success' : outcome === 'failed' ? 'failed' : 'skipped'
  await recordAutomationRun(db, {
    accountId: job.account_id,
    key,
    trigger: job.kind === 'enquiry_followup' ? 'follow_up_due' : 'scheduled',
    status,
    dedupeKey: `job:${job.id}`,
    conversationId: job.conversation_id,
    contactId: job.contact_id,
    bookingId: job.booking_id,
    leadId: job.lead_id ?? null,
    detail: { kind: job.kind, outcome, ...detail },
    error: status === 'success' ? null : error,
  })
}

/** Kind-specific checks against live data, run just before sending. */
async function preSendCheck(
  db: SupabaseClient,
  job: GuestJobRow,
  booking: (Booking & Record<string, unknown>) | null,
  automations: AutomationSettings,
): Promise<PreSendCheck> {
  if (job.kind === 'enquiry_followup') return checkFollowUp(db, job, automations)
  if (!booking) return { ok: false, status: 'cancelled', reason: job.booking_id ? 'booking_missing' : 'no_booking' }
  switch (job.kind) {
    case 'booking_confirmed':
      return checkConfirmation(db, booking)
    case 'payment_reminder':
      return checkPaymentReminder(db, booking)
    case 'post_stay_feedback':
      return checkFeedback(db, booking)
    default:
      if (INACTIVE.has(booking.status)) return { ok: false, status: 'cancelled', reason: 'booking_inactive' }
      return { ok: true, extra: {} }
  }
}

/**
 * Send one claimed guest job. Re-checks at send time: the owning automation
 * is still enabled, the booking / lead is still in a state where the
 * message is true (see preSendCheck), the guest hasn't opted out (STOP),
 * and WhatsApp's 24-hour window — outside it only the configured approved
 * template is used. Honours test mode / WHATSAPP_DRY_RUN exactly like the bot.
 */
export async function processGuestJob(db: SupabaseClient, job: GuestJobRow, now = new Date()): Promise<JobOutcome> {
  if (job.channel !== 'whatsapp' || !job.contact_id || !job.conversation_id) {
    await finish(db, job, 'skipped', 'missing_contact_or_conversation')
    await record(db, job, 'skipped', 'missing_contact_or_conversation')
    return 'skipped'
  }
  const stop = async (status: 'skipped' | 'cancelled', reason: string) => {
    await finish(db, job, status, reason)
    await record(db, job, status, reason)
    return status
  }
  try {
    const automations = await loadAutomationSettings(db, job.account_id)
    const key = JOB_AUTOMATION[job.kind]
    if (key && !automations.enabled[key]) return stop('cancelled', 'automation_disabled')

    let booking: (Booking & Record<string, unknown>) | null = null
    if (job.booking_id) {
      const { data } = await db.from('bookings').select('*').eq('id', job.booking_id).maybeSingle()
      booking = data ? ({ ...data, ...coerceBooking(data) } as Booking & Record<string, unknown>) : null
    }
    const check = await preSendCheck(db, job, booking, automations)
    if (!check.ok) {
      if (check.alertStaff) {
        await alertStaff(db, job.account_id, {
          kind: 'message_failed',
          title: `Confirmation not sent ${String(job.payload?.booking_ref ?? '')}`.trim(),
          body: `The booking confirmation was held back: ${check.reason.replace(/_/g, ' ')}. Fix it, then resend from the booking page.`,
          linkPath: job.booking_id ? `/resort/bookings/${job.booking_id}` : '/resort',
          conversationId: job.conversation_id,
          bookingId: job.booking_id,
          dedupeKey: `confirmation_held:${job.id}`,
        })
      }
      return stop(check.status, check.reason)
    }

    if (await loadOptedOutAt(db, job.account_id, job.contact_id)) return stop('skipped', 'guest_opted_out')

    const bundle = await loadPropertyBundle(db, job.account_id)
    const settings = bundle.settings
    const text = guestMessageText(job.kind, { ...(job.payload ?? {}), ...check.extra }, settings, automations)
    const last = await lastCustomerMessageAt(db, job.conversation_id)
    const inWindow = last !== null && now.getTime() - last.getTime() < SERVICE_WINDOW_MS

    const viaMsg91 = msg91Configured()
    // Approved templates live in Meta's catalogue; none are configured on MSG91, so outside the window MSG91 cannot send.
    if (!inWindow && viaMsg91) return stop('skipped', 'outside_24h_window_msg91_no_template')
    if (!inWindow && !job.template_name) return stop('skipped', 'outside_24h_window_no_template')
    if (inWindow && !text) return stop('skipped', 'details_not_configured')

    const { data: account } = await db.from('accounts').select('owner_user_id').eq('id', job.account_id).single()
    const target = {
      accountId: job.account_id,
      userId: account?.owner_user_id as string,
      conversationId: job.conversation_id,
      contactId: job.contact_id,
    }
    const { data: contact } = await db.from('contacts').select('phone').eq('id', job.contact_id).maybeSingle()
    const e164 = contact?.phone ? `+${String(contact.phone).replace(/\D/g, '')}` : null
    const dryRun = dryRunForced() || Boolean(settings?.test_mode && !(e164 && settings.test_phone_numbers.includes(e164)))

    if (viaMsg91) {
      if (!contact?.phone) return stop('skipped', 'missing_contact_phone')
      const provider = new Msg91Provider(db, target, String(contact.phone))
      provider.setDryRun(dryRun)
      const ticket = job.kind === 'booking_confirmed' && job.booking_id ? ticketUrl(job.booking_id) : null
      await provider.send(
        ticket
          ? { kind: 'buttons', body: text!.slice(0, 1024), headerImage: ticket, buttons: [{ id: 'c_menu', title: 'Main menu' }] }
          : { kind: 'text', text: text! },
      )
      const outcome: JobOutcome = dryRun ? 'simulated' : 'sent'
      await finish(db, job, 'sent', dryRun ? 'simulated (test mode / dry run)' : null)
      await afterSend(db, job, now)
      await record(db, job, outcome, null, { channel: 'msg91', ticket: Boolean(ticket), dry_run: dryRun })
      return outcome
    }

    const send = () =>
      inWindow
        ? engineSendText({ ...target, text: text! })
        : engineSendTemplate({ ...target, templateName: job.template_name! })

    let outcome: JobOutcome
    if (dryRun) {
      const { withSimulatedMetaSends } = await import('@/lib/whatsapp/send-simulation')
      await withSimulatedMetaSends(send)
      await finish(db, job, 'sent', 'simulated (test mode / dry run)')
      outcome = 'simulated'
    } else {
      await send()
      await finish(db, job, 'sent', null)
      outcome = 'sent'
    }
    await afterSend(db, job, now)
    await record(db, job, outcome, null, { channel: inWindow ? 'text' : 'template', dry_run: dryRun })
    return outcome
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500)
    if (/opted out/i.test(message)) return stop('skipped', 'guest_opted_out')
    if (job.attempts < job.max_attempts) {
      const backoffMin = 5 * 2 ** Math.max(0, job.attempts - 1)
      await db
        .from('notification_jobs')
        .update({ status: 'pending', last_error: message, locked_at: null, scheduled_for: new Date(now.getTime() + backoffMin * 60_000).toISOString() })
        .eq('id', job.id)
      return 'retry'
    }
    await finish(db, job, 'failed', message)
    await record(db, job, 'failed', message)
    await alertStaff(db, job.account_id, {
      kind: 'message_failed',
      title: `Guest message failed (${job.kind.replace(/_/g, ' ')})`,
      body: message,
      linkPath: job.booking_id ? `/resort/bookings/${job.booking_id}` : '/resort/inbox',
      conversationId: job.conversation_id,
      bookingId: job.booking_id,
      dedupeKey: `message_failed:${job.id}`,
    })
    return 'failed'
  }
}

/** Bookkeeping once a guest message has gone out (or been simulated). */
async function afterSend(db: SupabaseClient, job: GuestJobRow, now: Date): Promise<void> {
  try {
    if (job.kind === 'post_stay_feedback' && job.booking_id && job.conversation_id && job.contact_id) {
      await armFeedbackCapture(db, {
        account_id: job.account_id,
        conversation_id: job.conversation_id,
        contact_id: job.contact_id,
        booking_id: job.booking_id,
      })
    }
    if (job.kind === 'enquiry_followup' && job.lead_id) {
      const { data: lead } = await db.from('leads').select('follow_up_count').eq('id', job.lead_id).maybeSingle()
      await db
        .from('leads')
        .update({ follow_up_count: Number(lead?.follow_up_count ?? 0) + 1, last_follow_up_at: now.toISOString() })
        .eq('id', job.lead_id)
      await applyResortTags(db, job.account_id, job.contact_id, { add: ['follow_up_due'] })
    }
  } catch (err) {
    console.error('[resort] post-send bookkeeping failed:', err instanceof Error ? err.message : err)
  }
}
