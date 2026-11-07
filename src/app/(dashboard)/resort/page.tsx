"use client";

import Link from "next/link";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import {
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  Section,
  Stat,
  StatusPill,
  bookingWhen,
  inr,
  useAdminData,
} from "@/components/resort-admin/shared";

interface DashboardData {
  counts: {
    new_leads: number;
    hot_leads: number;
    needs_action: number;
    events_pending_review: number;
    availability_conflicts: number;
    human_queue: number;
    failed_messages: number;
    new_stay_enquiries_7d: number;
    new_event_enquiries_7d: number;
    pending_quotes: number;
    upcoming_arrivals_14d: number;
    confirmed_upcoming: number;
    pending_payments: number;
  };
  calendar_30d: { available: number; occupied: number } | null;
  automation_runs: { success: number; failed: number } | null;
  upcoming_stays: Array<{ id: string; booking_ref: string; guest_name: string | null; check_in: string; check_out: string; guest_count: number; status: string }>;
  upcoming_events: Array<{ id: string; booking_ref: string; guest_name: string | null; event_date: string; event_start_time: string; event_end_time: string; guest_count: number; status: string }>;
  collected_this_month_inr: number;
  setup: {
    property_configured: boolean;
    missing_settings: string[];
    missing_pricing: string[];
    payments_ready: boolean;
    is_published: boolean;
    bot_enabled: boolean;
    test_mode: boolean;
  };
}

export default function ResortOverviewPage() {
  const { data, error, errorCode, loading, reload } = useAdminData<DashboardData>("/api/admin/dashboard");
  if (loading && !data) return <LoadingBlock />;
  if (error || !data) return <ErrorBlock message={error ?? "Failed to load"} code={errorCode ?? undefined} onRetry={reload} />;
  const { counts, setup } = data;
  const setupIssues = setup.missing_settings.length + setup.missing_pricing.length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Link href="/resort/bookings?view=action"><Stat label="Needs action" value={counts.needs_action} hint="Requests, verified payments, cancellations" tone={counts.needs_action ? "warn" : undefined} /></Link>
        <Link href="/resort/bookings?type=event"><Stat label="Events awaiting review" value={counts.events_pending_review} tone={counts.events_pending_review ? "warn" : undefined} /></Link>
        <Link href="/resort/leads?stage=new"><Stat label="New leads" value={counts.new_leads} hint={`${counts.hot_leads} hot`} /></Link>
        <Link href="/resort/inbox"><Stat label="Waiting for a person" value={counts.human_queue} hint="Bot paused (handoff)" tone={counts.human_queue ? "warn" : undefined} /></Link>
        <Link href="/resort/bookings?view=conflicts"><Stat label="Availability conflicts" value={counts.availability_conflicts} hint="Paid but dates not secured" tone={counts.availability_conflicts ? "warn" : undefined} /></Link>
        <Link href="/resort/inbox"><Stat label="Failed guest messages" value={counts.failed_messages} tone={counts.failed_messages ? "warn" : undefined} /></Link>
        <Stat label="Collected this month" value={inr(data.collected_this_month_inr)} hint="Verified Razorpay payments" />
        <Stat label="WhatsApp bot" value={setup.bot_enabled ? (setup.test_mode ? "Test mode" : "On") : "Off"} hint={setup.test_mode ? "Replies only to test numbers" : undefined} />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Link href="/resort/bookings?type=stay"><Stat label="New stay enquiries" value={counts.new_stay_enquiries_7d} hint="Last 7 days" /></Link>
        <Link href="/resort/bookings?type=event"><Stat label="New event enquiries" value={counts.new_event_enquiries_7d} hint="Last 7 days" /></Link>
        <Link href="/resort/calendar"><Stat label="Open nights" value={data.calendar_30d ? data.calendar_30d.available : "—"} hint={data.calendar_30d ? `${data.calendar_30d.occupied} occupied in the next 30` : "Calendar unavailable"} /></Link>
        <Link href="/resort/bookings"><Stat label="Pending quotes" value={counts.pending_quotes} tone={counts.pending_quotes ? "warn" : undefined} /></Link>
        <Stat label="Upcoming arrivals" value={counts.upcoming_arrivals_14d} hint="Next 14 days" />
        <Link href="/resort/bookings"><Stat label="Confirmed bookings" value={counts.confirmed_upcoming} hint="Upcoming" /></Link>
        <Link href="/resort/bookings"><Stat label="Pending payments" value={counts.pending_payments} tone={counts.pending_payments ? "warn" : undefined} /></Link>
        <Link href="/automations">
          <Stat
            label="Automation runs"
            value={data.automation_runs ? `${data.automation_runs.success} ok` : "—"}
            hint={data.automation_runs ? `${data.automation_runs.failed} failed` : "Apply migration 063"}
            tone={data.automation_runs?.failed ? "warn" : undefined}
          />
        </Link>
      </div>

      <Section
        title="Setup"
        description="The website and bot only show information you have entered and approved. Anything missing is reported as not configured — nothing is guessed."
        actions={<Link href="/resort/property" className="text-sm font-medium text-primary hover:underline">Open property settings</Link>}
      >
        {setupIssues === 0 && setup.payments_ready ? (
          <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4" /> Property details and pricing are configured.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Property — not configured</p>
              {setup.missing_settings.length === 0 ? <p className="text-sm">All set.</p> : (
                <ul className="space-y-0.5 text-sm">{setup.missing_settings.map((m) => <li key={m} className="flex gap-2"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-500" />{m}</li>)}</ul>
              )}
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pricing — not configured</p>
              {setup.missing_pricing.length === 0 ? <p className="text-sm">All set.</p> : (
                <ul className="space-y-0.5 text-sm">{setup.missing_pricing.map((m) => <li key={m} className="flex gap-2"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-500" />{m}</li>)}</ul>
              )}
              {!setup.payments_ready && <p className="mt-2 text-xs text-muted-foreground">Online advance payments stay off until payments are enabled, Razorpay keys are set and a deposit rule exists. Guests can still send booking requests.</p>}
            </div>
          </div>
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Upcoming stays (14 days)">
          {data.upcoming_stays.length === 0 ? <EmptyBlock title="No upcoming stays" /> : (
            <ul className="divide-y divide-border">
              {data.upcoming_stays.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 py-2">
                  <Link href={`/resort/bookings/${b.id}`} className="min-w-0">
                    <p className="truncate text-sm font-medium">{b.guest_name ?? "Guest"} · {b.guest_count} guests</p>
                    <p className="text-xs text-muted-foreground">{b.booking_ref} · {bookingWhen({ booking_type: "stay", ...b })}</p>
                  </Link>
                  <StatusPill value={b.status} />
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Upcoming events (14 days)">
          {data.upcoming_events.length === 0 ? <EmptyBlock title="No upcoming events" /> : (
            <ul className="divide-y divide-border">
              {data.upcoming_events.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 py-2">
                  <Link href={`/resort/bookings/${b.id}`} className="min-w-0">
                    <p className="truncate text-sm font-medium">{b.guest_name ?? "Guest"} · {b.guest_count} guests</p>
                    <p className="text-xs text-muted-foreground">{b.booking_ref} · {bookingWhen({ booking_type: "event", ...b })}</p>
                  </Link>
                  <StatusPill value={b.status} />
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
