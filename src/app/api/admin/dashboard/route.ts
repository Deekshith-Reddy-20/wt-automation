import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { adminRoute } from '@/lib/resort/admin-http'
import { fetchBlocks, nightStatuses } from '@/lib/resort/availability'
import { loadPropertyBundle, missingPricing, missingSettings, paymentsReady } from '@/lib/resort/property-store'
import { addDays, istToInstant, todayIST } from '@/lib/resort/time'

export const dynamic = 'force-dynamic'

/** Overview numbers for the resort dashboard. Read-only; any member. */
export const GET = adminRoute('viewer', async ({ supabase, accountId }) => {
  const today = todayIST()
  const in14 = addDays(today, 14)
  const monthStart = `${today.slice(0, 7)}-01`

  // A failed count must surface as an error, never as 0. Not a head request:
  // supabase-js reports a HEAD 404 (missing table) as success with no count.
  type Counted = { count: number | null; error: unknown }
  const count = async (q: { limit: (n: number) => PromiseLike<Counted> }) => {
    const r = await q.limit(1)
    if (r.error) throw r.error
    return r.count ?? 0
  }
  const rows = <T extends { error: unknown }>(r: T) => {
    if (r.error) throw r.error
    return r
  }

  const [
    newLeads,
    hotLeads,
    needsAction,
    pendingEvents,
    conflicts,
    humanQueue,
    failedJobs,
    upcomingStays,
    upcomingEvents,
    paidThisMonth,
    bundle,
  ] = await Promise.all([
    count(supabase.from('leads').select('id', { count: 'exact' }).eq('account_id', accountId).eq('stage', 'new')),
    count(supabase.from('leads').select('id', { count: 'exact' }).eq('account_id', accountId).eq('priority', 'hot').not('stage', 'in', '(completed,cancelled,lost)')),
    count(supabase.from('bookings').select('id', { count: 'exact' }).eq('account_id', accountId).in('status', ['booking_requested', 'payment_verified', 'cancellation_requested'])),
    count(supabase.from('event_requests').select('id', { count: 'exact' }).eq('account_id', accountId).eq('status', 'pending_review')),
    count(supabase.from('bookings').select('id', { count: 'exact' }).eq('account_id', accountId).eq('availability_conflict', true).not('status', 'in', '(cancelled,rejected,completed)')),
    count(supabase.from('conversation_states').select('id', { count: 'exact' }).eq('account_id', accountId).eq('bot_mode', 'human')),
    count(supabase.from('notification_jobs').select('id', { count: 'exact' }).eq('account_id', accountId).eq('status', 'failed')),
    supabase.from('bookings').select('id, booking_ref, guest_name, check_in, check_out, guest_count, status, payment_status')
      .eq('account_id', accountId).eq('booking_type', 'stay').in('status', ['confirmed', 'checked_in', 'payment_verified'])
      .gte('check_in', today).lte('check_in', in14).order('check_in').limit(10).then(rows),
    supabase.from('bookings').select('id, booking_ref, guest_name, event_date, event_start_time, event_end_time, guest_count, status, payment_status')
      .eq('account_id', accountId).eq('booking_type', 'event').in('status', ['confirmed', 'payment_verified', 'booking_requested'])
      .gte('event_date', today).lte('event_date', in14).order('event_date').limit(10).then(rows),
    supabase.from('payments').select('amount_paise').eq('account_id', accountId).eq('status', 'captured').gte('verified_at', `${monthStart}T00:00:00+05:30`).then(rows),
    loadPropertyBundle(supabase, accountId),
  ])

  const collectedPaise = (paidThisMonth.data ?? []).reduce((s, p) => s + Number(p.amount_paise ?? 0), 0)

  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const [newStays, newEvents, pendingQuotes, confirmedUpcoming, pendingPayments, automationRows, calendar] = await Promise.all([
    count(supabase.from('bookings').select('id', { count: 'exact' }).eq('account_id', accountId).eq('booking_type', 'stay').gte('created_at', weekAgo)),
    count(supabase.from('bookings').select('id', { count: 'exact' }).eq('account_id', accountId).eq('booking_type', 'event').gte('created_at', weekAgo)),
    count(supabase.from('bookings').select('id', { count: 'exact' }).eq('account_id', accountId).in('status', ['enquiry', 'qualified', 'availability_checked']).is('active_quote_id', null)),
    count(supabase.from('bookings').select('id', { count: 'exact' }).eq('account_id', accountId).eq('status', 'confirmed').or(`check_in.gte.${today},event_date.gte.${today}`)),
    count(supabase.from('bookings').select('id', { count: 'exact' }).eq('account_id', accountId).in('status', ['hold', 'payment_pending', 'confirmed']).in('payment_status', ['unpaid', 'partially_paid']).not('quoted_total', 'is', null)),
    supabase.from('resort_automations').select('success_count, failure_count').eq('account_id', accountId),
    (async () => {
      try {
        const start = istToInstant(today, '00:00')
        const end = istToInstant(addDays(today, 31), '00:00')
        const blocks = await fetchBlocks(supabaseAdmin(), accountId, start, end)
        const nights = nightStatuses(blocks, today, 30, {
          check_in_time: bundle.settings?.check_in_time ?? null,
          check_out_time: bundle.settings?.check_out_time ?? null,
        }, today)
        const free = nights.filter((n) => n.available).length
        return { available: free, occupied: nights.length - free }
      } catch {
        return null
      }
    })(),
  ])
  const automationTotals = automationRows.error
    ? null
    : (automationRows.data ?? []).reduce(
        (acc, r) => ({ success: acc.success + Number(r.success_count ?? 0), failed: acc.failed + Number(r.failure_count ?? 0) }),
        { success: 0, failed: 0 },
      )

  return NextResponse.json({
    counts: {
      new_leads: newLeads,
      hot_leads: hotLeads,
      needs_action: needsAction,
      events_pending_review: pendingEvents,
      availability_conflicts: conflicts,
      human_queue: humanQueue,
      failed_messages: failedJobs,
      new_stay_enquiries_7d: newStays,
      new_event_enquiries_7d: newEvents,
      pending_quotes: pendingQuotes,
      upcoming_arrivals_14d: (upcomingStays.data ?? []).length,
      confirmed_upcoming: confirmedUpcoming,
      pending_payments: pendingPayments,
    },
    /** Next 30 nights; null when the calendar couldn't be read. */
    calendar_30d: calendar,
    /** Totals across the V-Farms automations; null before migration 063 is applied. */
    automation_runs: automationTotals,
    upcoming_stays: upcomingStays.data ?? [],
    upcoming_events: upcomingEvents.data ?? [],
    collected_this_month_inr: collectedPaise / 100,
    setup: {
      property_configured: Boolean(bundle.settings),
      missing_settings: missingSettings(bundle.settings).map((m) => m.label),
      missing_pricing: missingPricing(bundle.pricing.rules),
      payments_ready: paymentsReady(bundle.settings, bundle.pricing.rules),
      is_published: bundle.settings?.is_published ?? false,
      bot_enabled: bundle.settings?.bot_enabled ?? false,
      test_mode: bundle.settings?.test_mode ?? true,
    },
  })
})
