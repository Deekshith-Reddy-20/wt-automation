"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCan } from "@/hooks/use-can";
import {
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  Section,
  StatusPill,
  adminSend,
  bookingWhen,
  fmtDateTime,
  inr,
  useAdminData,
} from "@/components/resort-admin/shared";

interface ConvState {
  id: string;
  conversation_id: string;
  flow: string;
  step: string;
  bot_mode: "bot" | "human";
  handoff_reason: string | null;
  handoff_at: string | null;
  last_inbound_at: string | null;
  contacts: { name: string | null; phone: string | null } | null;
  booking: {
    id: string;
    booking_ref: string;
    booking_type: string;
    status: string;
    check_in: string | null;
    check_out: string | null;
    event_date: string | null;
    event_start_time: string | null;
    event_end_time: string | null;
    guest_count: number | null;
    quoted_total: number | string | null;
  } | null;
}

type WhatsAppMode = "not_connected" | "dry_run" | "test_mode" | "bot_off" | "live";

const MODE_BANNER: Record<WhatsAppMode, { title: string; body: string; tone: string }> = {
  not_connected: {
    title: "WhatsApp is not connected",
    body: "No messages are received or sent. Connect the WhatsApp Business account under Settings → WhatsApp, then turn the bot on in V-Farms Resort → Settings.",
    tone: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200",
  },
  dry_run: {
    title: "Mock mode (WHATSAPP_DRY_RUN)",
    body: "Messages are simulated and shown in the inbox; nothing is delivered to guests.",
    tone: "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-700 dark:bg-sky-950/40 dark:text-sky-200",
  },
  test_mode: {
    title: "Test mode",
    body: "The bot replies for real only to the staff test numbers; replies to everyone else are simulated.",
    tone: "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-700 dark:bg-sky-950/40 dark:text-sky-200",
  },
  bot_off: {
    title: "WhatsApp connected — bot off",
    body: "Guest messages arrive in the inbox; the V-Farms bot does not reply. Staff replies are delivered for real.",
    tone: "border-border bg-muted/40 text-foreground",
  },
  live: {
    title: "Live",
    body: "The bot and staff replies are delivered to guests on WhatsApp.",
    tone: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200",
  },
};

interface Job {
  id: string;
  kind: string;
  status: string;
  scheduled_for: string;
  attempts: number;
  last_error: string | null;
  booking_id: string | null;
  bookings: { booking_ref: string; guest_name: string | null } | null;
}

const REASONS: Record<string, string> = {
  guest_requested: "Guest asked for a person",
  agent_replied: "Staff replied in the inbox",
  staff_takeover: "Staff took over",
  bot_submit_failed: "Bot could not save the request",
  reservation_failed: "Reservation request failed",
  reservation_not_eligible: "Reservation needs staff",
  location_not_configured: "Location details not configured",
};

export default function ResortInboxPage() {
  const canAct = useCan("manage-reservations");
  const [mode, setMode] = useState<"human" | "bot" | "all">("human");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const convs = useAdminData<{ conversations: ConvState[]; whatsapp: { mode: WhatsAppMode } }>(
    `/api/admin/conversations?mode=${mode}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
  );
  const banner = convs.data ? MODE_BANNER[convs.data.whatsapp.mode] : null;
  const [jobStatus, setJobStatus] = useState("failed");
  const jobs = useAdminData<{ jobs: Job[] }>(`/api/admin/notifications?status=${jobStatus}`);

  const setBotMode = async (conversationId: string, next: "human" | "bot") => {
    try {
      await adminSend(`/api/admin/conversations/${conversationId}/mode`, "POST", { mode: next });
      toast.success(next === "bot" ? "Bot resumed — it will greet the guest with the main menu on their next message." : "You have taken over. The bot will stay silent.");
      convs.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  return (
    <div className="space-y-6">
      {banner && (
        <div className={`rounded-xl border p-3 text-sm ${banner.tone}`}>
          <p className="font-semibold">{banner.title}</p>
          <p className="mt-0.5 text-xs">{banner.body}</p>
          {convs.data?.whatsapp.mode === "not_connected" && (
            <Link href="/settings" className="mt-2 inline-flex h-7 items-center rounded-md border border-current px-2.5 text-xs font-medium">Open WhatsApp settings</Link>
          )}
        </div>
      )}
      <Section
        title="Conversations"
        description="In human mode the WhatsApp assistant stays silent until an authorised team member resumes it. Replying from the inbox automatically switches a conversation to human mode."
        actions={
          <div className="flex flex-wrap gap-1">
            <form
              className="flex gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                setQ(search.trim());
              }}
            >
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, phone or VF- reference" className="h-8 w-56 text-xs" aria-label="Search conversations" />
              <Button size="sm" variant="outline" type="submit">Search</Button>
            </form>
            <Button size="sm" variant={mode === "human" ? "default" : "outline"} onClick={() => setMode("human")}>Waiting for a person</Button>
            <Button size="sm" variant={mode === "bot" ? "default" : "outline"} onClick={() => setMode("bot")}>With the bot</Button>
            <Button size="sm" variant={mode === "all" ? "default" : "outline"} onClick={() => setMode("all")}>All</Button>
          </div>
        }
      >
        {convs.loading && !convs.data ? <LoadingBlock /> : convs.error ? <ErrorBlock message={convs.error} code={convs.errorCode} onRetry={convs.reload} /> : !convs.data?.conversations.length ? (
          <EmptyBlock title={q ? `No conversations match "${q}"` : mode === "human" ? "No one is waiting" : "No guest conversations yet"} />
        ) : (
          <ul className="divide-y divide-border">
            {convs.data.conversations.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{c.contacts?.name ?? (c.contacts?.phone ? `+${c.contacts.phone}` : "Guest")}</p>
                  <p className="text-xs text-muted-foreground">
                    {c.bot_mode === "human"
                      ? `${REASONS[c.handoff_reason ?? ""] ?? c.handoff_reason ?? "Handed off"} · ${fmtDateTime(c.handoff_at)}`
                      : `At ${c.flow} › ${c.step}`}
                    {c.last_inbound_at ? ` · last message ${fmtDateTime(c.last_inbound_at)}` : ""}
                  </p>
                  {c.booking && (
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                      <Link href={`/resort/bookings/${c.booking.id}`} className="font-medium text-primary hover:underline">{c.booking.booking_ref}</Link>
                      <StatusPill value={c.booking.status} />
                      <span className="text-muted-foreground">{bookingWhen(c.booking)}</span>
                      {c.booking.guest_count ? <span className="text-muted-foreground">{c.booking.guest_count} guests</span> : null}
                      <span className="text-muted-foreground">Quote: {c.booking.quoted_total === null ? "not priced" : inr(c.booking.quoted_total)}</span>
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Link href={`/inbox?c=${c.conversation_id}`} className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs hover:bg-muted">Open chat</Link>
                  {c.bot_mode === "human" ? (
                    <Button size="sm" disabled={!canAct} onClick={() => setBotMode(c.conversation_id, "bot")}>Resume bot</Button>
                  ) : (
                    <Button size="sm" variant="outline" disabled={!canAct} onClick={() => setBotMode(c.conversation_id, "human")}>Take over</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Guest messages"
        description="Confirmations and reminders. Before each send the system re-checks opt-out (STOP), booking status and WhatsApp's 24-hour window; outside the window only an approved template is used."
        actions={
          <select className="h-8 rounded-md border border-border bg-background px-2 text-xs" value={jobStatus} onChange={(e) => setJobStatus(e.target.value)}>
            {["failed", "skipped", "pending", "sent", "cancelled"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        }
      >
        {jobs.loading && !jobs.data ? <LoadingBlock /> : jobs.error ? <ErrorBlock message={jobs.error} code={jobs.errorCode} onRetry={jobs.reload} /> : !jobs.data?.jobs.length ? (
          <EmptyBlock title={`No ${jobStatus} messages`} />
        ) : (
          <ul className="divide-y divide-border text-sm">
            {jobs.data.jobs.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <div>
                  <p>{j.kind.replace(/_/g, " ")} {j.bookings && <Link className="text-primary hover:underline" href={`/resort/bookings/${j.booking_id}`}>{j.bookings.booking_ref}</Link>}</p>
                  <p className="text-xs text-muted-foreground">{fmtDateTime(j.scheduled_for)} · {j.attempts} attempt(s){j.last_error ? ` · ${j.last_error}` : ""}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill value={j.status} />
                  {["failed", "skipped"].includes(j.status) && (
                    <Button size="sm" variant="outline" disabled={!canAct} onClick={async () => {
                      try { await adminSend(`/api/admin/notifications/${j.id}/retry`, "POST"); toast.success("Queued for retry"); jobs.reload(); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
                    }}>Retry</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
