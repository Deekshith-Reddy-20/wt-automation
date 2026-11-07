import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { createFakeDb } from '../../flows/fake-db.test-helper'
import type { Booking } from '../types'
import { automationSettingsFrom } from './definitions'
import {
  checkConfirmation,
  checkFeedback,
  checkFollowUp,
  checkPaymentReminder,
  guestMessageBody,
  scanAbandonedEnquiries,
  scheduleFeedback,
  schedulePaymentReminder,
} from './scheduled'

type Tables = Record<string, Record<string, unknown>[]>

function dbWith(tables: Tables) {
  return createFakeDb(tables) as unknown as SupabaseClient
}

function booking(over: Partial<Booking> & Record<string, unknown> = {}): Booking & Record<string, unknown> {
  return {
    id: 'b1',
    account_id: 'acc',
    booking_ref: 'VF-261101-ABCDE',
    booking_type: 'stay',
    status: 'confirmed',
    contact_id: 'c1',
    conversation_id: 'conv1',
    lead_id: 'l1',
    guest_name: 'Asha',
    guest_count: 8,
    check_in: '2026-12-10',
    check_out: '2026-12-12',
    event_date: null,
    event_start_time: null,
    event_end_time: null,
    quoted_total: 30000,
    advance_due: 10000,
    amount_paid: 0,
    payment_exception_at: null,
    ...over,
  } as unknown as Booking & Record<string, unknown>
}

const payment = (paise: number, over: Record<string, unknown> = {}) => ({
  booking_id: 'b1',
  amount_paise: paise,
  amount_refunded_paise: 0,
  status: 'captured',
  verified_at: '2026-11-01T00:00:00Z',
  ...over,
})

const heldBlock = { booking_id: 'b1', block_type: 'booking', status: 'active' }

function settings(enabled: string[], config: Record<string, unknown> = {}) {
  return automationSettingsFrom(enabled.map((key) => ({ key, is_enabled: true, config: config[key] ?? {} })))
}

describe('booking confirmation checks (G)', () => {
  it('is blocked without a verified advance payment', async () => {
    const db = dbWith({ availability_blocks: [heldBlock], payments: [payment(500_000, { verified_at: null })] })
    expect(await checkConfirmation(db, booking())).toMatchObject({ ok: false, reason: 'payment_not_verified', alertStaff: true })
  })

  it('passes with the advance paid, and reports the balance', async () => {
    const db = dbWith({ availability_blocks: [heldBlock], payments: [payment(1_000_000)] })
    const res = await checkConfirmation(db, booking())
    expect(res).toMatchObject({ ok: true, extra: { paid_paise: 1_000_000, balance_paise: 2_000_000 } })
  })

  it('passes unpaid only with a recorded payment exception', async () => {
    const db = dbWith({ availability_blocks: [heldBlock], payments: [] })
    expect((await checkConfirmation(db, booking({ payment_exception_at: '2026-11-01T00:00:00Z' }))).ok).toBe(true)
  })

  it('is blocked when the estate is not held on the calendar', async () => {
    const db = dbWith({ availability_blocks: [], payments: [payment(1_000_000)] })
    expect(await checkConfirmation(db, booking())).toMatchObject({ ok: false, reason: 'estate_not_held' })
  })

  it('is blocked for an unapproved event', async () => {
    const db = dbWith({
      availability_blocks: [heldBlock],
      payments: [payment(1_000_000)],
      event_requests: [{ booking_id: 'b1', status: 'pending_review' }],
    })
    expect(await checkConfirmation(db, booking({ booking_type: 'event' }))).toMatchObject({ ok: false, reason: 'event_not_approved' })
  })

  it('is cancelled when the booking is no longer confirmed', async () => {
    const db = dbWith({})
    expect(await checkConfirmation(db, booking({ status: 'cancelled' }))).toMatchObject({ ok: false, status: 'cancelled' })
  })
})

describe('payment reminder (H)', () => {
  it('stops once the booking is fully paid', async () => {
    const db = dbWith({ payments: [payment(3_000_000)] })
    expect(await checkPaymentReminder(db, booking())).toMatchObject({ ok: false, reason: 'fully_paid' })
  })

  it('net of refunds, a balance keeps the reminder alive', async () => {
    const db = dbWith({ payments: [payment(3_000_000, { amount_refunded_paise: 500_000, status: 'partially_refunded' })] })
    expect(await checkPaymentReminder(db, booking())).toMatchObject({ ok: true, extra: { balance_paise: 500_000 } })
  })

  it('is not scheduled without a configured due date', async () => {
    const tables: Tables = { notification_jobs: [] }
    const ok = await schedulePaymentReminder(dbWith(tables), booking(), settings(['payment_reminder']), { now: new Date('2026-11-01T00:00:00Z') })
    expect(ok).toBe(false)
    expect(tables.notification_jobs).toHaveLength(0)
  })

  it('is scheduled at 10:00 IST before the due date when configured', async () => {
    const tables: Tables = { notification_jobs: [] }
    const s = settings(['payment_reminder'], { payment_reminder: { balance_due_days_before: 7, remind_days_before_due: 2 } })
    expect(await schedulePaymentReminder(dbWith(tables), booking(), s, { now: new Date('2026-11-01T00:00:00Z') })).toBe(true)
    expect(tables.notification_jobs[0]).toMatchObject({
      kind: 'payment_reminder',
      scheduled_for: '2026-12-01T04:30:00.000Z',
      dedupe_key: 'payment_reminder:b1',
      payload: expect.objectContaining({ due_date: '2026-12-03' }),
    })
  })
})

describe('post-stay feedback (J)', () => {
  it('is requested once per booking', async () => {
    const db = dbWith({ booking_feedback: [{ booking_id: 'b1', rating: 5 }] })
    expect(await checkFeedback(db, booking({ status: 'completed' }))).toMatchObject({ ok: false, reason: 'feedback_already_recorded' })
    expect((await checkFeedback(dbWith({ booking_feedback: [] }), booking({ status: 'completed' }))).ok).toBe(true)
  })

  it('is not scheduled while the automation is disabled', async () => {
    const tables: Tables = { notification_jobs: [] }
    expect(await scheduleFeedback(dbWith(tables), booking({ status: 'completed' }), settings([]))).toBe(false)
    expect(await scheduleFeedback(dbWith(tables), booking({ status: 'completed' }), settings(['post_stay_feedback']))).toBe(true)
    expect(tables.notification_jobs[0]).toMatchObject({ dedupe_key: 'post_stay_feedback:b1' })
  })
})

describe('abandoned enquiry follow-up (K)', () => {
  const job = { lead_id: 'l1', conversation_id: 'conv1', payload: { last_interaction_at: '2026-11-01T00:00:00Z' } }
  const base = (): Tables => ({
    leads: [{ id: 'l1', stage: 'quote_sent', consent_status: 'unknown', follow_up_count: 0 }],
    bookings: [],
    conversation_states: [{ conversation_id: 'conv1', bot_mode: 'bot' }],
    messages: [],
  })
  const s = settings(['abandoned_followup'], { abandoned_followup: { after_hours: 24, max_follow_ups: 1 } })

  it('sends when nothing has changed', async () => {
    expect((await checkFollowUp(dbWith(base()), job, s)).ok).toBe(true)
  })

  it('stops when the guest replied', async () => {
    const t = base()
    t.messages.push({ conversation_id: 'conv1', sender_type: 'customer', created_at: '2026-11-01T05:00:00Z' })
    expect(await checkFollowUp(dbWith(t), job, s)).toMatchObject({ ok: false, reason: 'guest_replied' })
  })

  it('stops on opt-out, the limit, a booking, or human takeover', async () => {
    const optOut = base(); optOut.leads[0].consent_status = 'revoked'
    expect(await checkFollowUp(dbWith(optOut), job, s)).toMatchObject({ reason: 'consent_revoked' })
    const limit = base(); limit.leads[0].follow_up_count = 1
    expect(await checkFollowUp(dbWith(limit), job, s)).toMatchObject({ reason: 'follow_up_limit' })
    const booked = base(); booked.bookings.push({ lead_id: 'l1', status: 'confirmed' })
    expect(await checkFollowUp(dbWith(booked), job, s)).toMatchObject({ reason: 'booking_exists' })
    const human = base(); human.conversation_states[0].bot_mode = 'human'
    expect(await checkFollowUp(dbWith(human), job, s)).toMatchObject({ reason: 'human_takeover' })
  })

  it('an enquiry-stage booking does not stop the follow-up', async () => {
    const t = base(); t.bookings.push({ lead_id: 'l1', status: 'quote_created' })
    expect((await checkFollowUp(dbWith(t), job, s)).ok).toBe(true)
  })

  it('scan queues nothing unless enabled and a period is configured', async () => {
    const tables: Tables = {
      leads: [{
        id: 'l1', account_id: 'acc', stage: 'contacted', consent_status: 'unknown', follow_up_count: 0,
        contact_id: 'c1', conversation_id: 'conv1', last_interaction_at: '2026-10-01T00:00:00Z', last_follow_up_at: null,
      }],
      notification_jobs: [],
    }
    const now = new Date('2026-11-01T00:00:00Z')
    expect(await scanAbandonedEnquiries(dbWith(tables), 'acc', settings(['abandoned_followup']), now)).toBe(0)
    expect(await scanAbandonedEnquiries(dbWith(tables), 'acc', settings([], { abandoned_followup: { after_hours: 24 } }), now)).toBe(0)
    expect(await scanAbandonedEnquiries(dbWith(tables), 'acc', s, now)).toBe(1)
    expect(tables.notification_jobs[0]).toMatchObject({ kind: 'enquiry_followup', dedupe_key: 'enquiry_followup:l1:1' })
  })
})

describe('guest message bodies', () => {
  const s = settings([])
  it('only includes configured details and never invents amounts', () => {
    const body = guestMessageBody('booking_confirmed', { booking_ref: 'VF-1', booking_type: 'stay', check_in: '2026-12-10', check_out: '2026-12-12' }, null, s)!
    expect(body).toContain('VF-1')
    expect(body).not.toMatch(/₹|Total|Check-in from|Cancellation policy/)
  })

  it('has no payment reminder without a balance', () => {
    expect(guestMessageBody('payment_reminder', { booking_ref: 'VF-1', booking_type: 'stay', check_in: '2026-12-10', check_out: '2026-12-12' }, null, s)).toBeNull()
  })
})
