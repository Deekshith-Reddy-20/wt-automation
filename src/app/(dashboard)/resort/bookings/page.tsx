"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import {
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  StatusPill,
  bookingWhen,
  fmtDateTime,
  inr,
  useAdminData,
} from "@/components/resort-admin/shared";
import { BOOKING_STATUS_LABELS } from "@/lib/resort/lifecycle";
import { BOOKING_STATUSES } from "@/lib/resort/types";

interface Row {
  id: string;
  booking_ref: string;
  booking_type: "stay" | "event";
  status: string;
  payment_status: string;
  source: string;
  guest_name: string | null;
  guest_phone: string | null;
  check_in: string | null;
  check_out: string | null;
  event_date: string | null;
  event_start_time: string | null;
  event_end_time: string | null;
  guest_count: number;
  quoted_total: number | string | null;
  amount_paid: number | string;
  availability_conflict: boolean;
  created_at: string;
}

const VIEWS = [
  { id: "", label: "All" },
  { id: "action", label: "Needs action" },
  { id: "conflicts", label: "Conflicts" },
  { id: "refunds", label: "Refunds pending" },
];

export default function BookingsPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <BookingsInner />
    </Suspense>
  );
}

function BookingsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const qs = params.toString();
  const { data, error, errorCode, loading, reload } = useAdminData<{ bookings: Row[]; total: number }>(`/api/admin/bookings${qs ? `?${qs}` : ""}`);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page");
    router.replace(`/resort/bookings?${next.toString()}`);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setParam("view", v.id)}
            className={`rounded-full border px-3 py-1 text-xs ${(params.get("view") ?? "") === v.id ? "border-primary bg-primary/10 font-semibold text-primary" : "border-border text-muted-foreground"}`}
          >
            {v.label}
          </button>
        ))}
        <select
          aria-label="Type"
          className="h-8 rounded-md border border-border bg-background px-2 text-xs"
          value={params.get("type") ?? ""}
          onChange={(e) => setParam("type", e.target.value)}
        >
          <option value="">Stays & events</option>
          <option value="stay">Stays</option>
          <option value="event">Events</option>
        </select>
        <select
          aria-label="Status"
          className="h-8 rounded-md border border-border bg-background px-2 text-xs"
          value={params.get("status") ?? ""}
          onChange={(e) => setParam("status", e.target.value)}
        >
          <option value="">Any status</option>
          {BOOKING_STATUSES.map((s) => <option key={s} value={s}>{BOOKING_STATUS_LABELS[s]}</option>)}
        </select>
        <form onSubmit={(e) => { e.preventDefault(); setParam("q", q.trim()); }} className="ml-auto">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ref, name, phone" className="h-8 w-56 text-xs" />
        </form>
      </div>

      {loading && !data ? <LoadingBlock /> : error ? <ErrorBlock message={error} code={errorCode} onRetry={reload} /> : !data?.bookings.length ? (
        <EmptyBlock title="No bookings match">Enquiries from the website and WhatsApp appear here.</EmptyBlock>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Booking</th>
                <th className="px-3 py-2">Guest</th>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Quote / paid</th>
                <th className="px-3 py-2">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.bookings.map((b) => (
                <tr key={b.id} className="hover:bg-muted/30">
                  <td className="px-3 py-2">
                    <Link href={`/resort/bookings/${b.id}`} className="font-medium text-primary hover:underline">{b.booking_ref}</Link>
                    <p className="text-xs capitalize text-muted-foreground">{b.booking_type} · {b.source.replace(/_/g, " ")}</p>
                  </td>
                  <td className="px-3 py-2">
                    <p>{b.guest_name ?? "—"}</p>
                    <p className="text-xs text-muted-foreground">{b.guest_phone ?? ""} · {b.guest_count} guests</p>
                  </td>
                  <td className="px-3 py-2 text-xs">{bookingWhen(b)}</td>
                  <td className="space-y-1 px-3 py-2">
                    <StatusPill value={b.status} label={BOOKING_STATUS_LABELS[b.status as keyof typeof BOOKING_STATUS_LABELS]} />
                    {b.availability_conflict && <p className="text-[11px] font-semibold text-rose-600">Availability conflict</p>}
                  </td>
                  <td className="px-3 py-2 text-right text-xs">
                    <p>{inr(b.quoted_total)}</p>
                    <p className="text-muted-foreground">{inr(b.amount_paid)} · {b.payment_status.replace(/_/g, " ")}</p>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{fmtDateTime(b.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{data.total} total</p>
        </div>
      )}
    </div>
  );
}
