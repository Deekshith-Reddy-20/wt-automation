"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCan } from "@/hooks/use-can";
import { ErrorBlock, LoadingBlock, Section, adminSend, fmtDateTime, useAdminData } from "@/components/resort-admin/shared";
import { cn } from "@/lib/utils";

interface Block {
  id: string;
  period: string;
  block_type: "booking" | "hold" | "manual_block" | "maintenance";
  booking_id: string | null;
  expires_at: string | null;
  reason: string | null;
  bookings: { booking_ref: string; booking_type: string; guest_name: string | null; status: string } | null;
}

const IST_MS = 5.5 * 3600_000;
const TONE: Record<Block["block_type"], string> = {
  booking: "bg-emerald-600 text-white",
  hold: "bg-amber-400 text-amber-950",
  manual_block: "bg-slate-500 text-white",
  maintenance: "bg-rose-500 text-white",
};
const LABEL: Record<Block["block_type"], string> = {
  booking: "Booked",
  hold: "Hold",
  manual_block: "Blocked",
  maintenance: "Maintenance",
};

function parseRange(period: string): [Date, Date] | null {
  const m = /^[[(]"?([^",]+)"?,"?([^",)\]]+)"?[)\]]$/.exec(period.trim());
  if (!m) return null;
  return [new Date(m[1].replace(" ", "T").replace(/\+00$/, "Z")), new Date(m[2].replace(" ", "T").replace(/\+00$/, "Z"))];
}

function istDate(d: Date): string {
  return new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export default function CalendarPage() {
  const today = istDate(new Date());
  const [month, setMonth] = useState(today.slice(0, 7));
  const first = `${month}-01`;
  const startOffset = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const gridStart = addDays(first, -startOffset);
  const { data, error, errorCode, loading, reload } = useAdminData<{ blocks: Block[] }>(`/api/admin/availability?from=${gridStart}&days=42`);
  const canEdit = useCan("manage-reservations");

  const byDay = useMemo(() => {
    const map = new Map<string, Block[]>();
    for (const b of data?.blocks ?? []) {
      const r = parseRange(b.period);
      if (!r) continue;
      // A day is marked when the block covers any part of it (IST).
      let d = istDate(r[0]);
      const lastInstant = new Date(r[1].getTime() - 1);
      const last = istDate(lastInstant);
      for (let i = 0; i < 400 && d <= last; i++, d = addDays(d, 1)) {
        map.set(d, [...(map.get(d) ?? []), b]);
      }
    }
    return map;
  }, [data]);

  const shift = (n: number) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setMonth(d.toISOString().slice(0, 7));
  };

  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Section
        title={new Date(`${first}T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" })}
        description="The whole estate is one unit: any booking, hold or block makes it unavailable for that time."
        actions={
          <div className="flex gap-1">
            <Button size="icon" variant="outline" onClick={() => shift(-1)} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></Button>
            <Button size="sm" variant="outline" onClick={() => setMonth(today.slice(0, 7))}>Today</Button>
            <Button size="icon" variant="outline" onClick={() => shift(1)} aria-label="Next month"><ChevronRight className="h-4 w-4" /></Button>
          </div>
        }
      >
        {loading && !data ? <LoadingBlock /> : error ? <ErrorBlock message={error} code={errorCode ?? "query_failed"} onRetry={reload} /> : (
          <>
            {(data?.blocks.length ?? 0) === 0 && (
              <p className="mb-2 text-xs text-muted-foreground">No bookings, holds or blocks in these six weeks — every date is open.</p>
            )}
            <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-border bg-border text-xs">
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="bg-muted/60 p-1.5 text-center font-medium text-muted-foreground">{d}</div>)}
              {days.map((d) => {
                const blocks = byDay.get(d) ?? [];
                return (
                  <div key={d} className={cn("min-h-20 bg-card p-1", !d.startsWith(month) && "opacity-40", d === today && "ring-2 ring-inset ring-primary")}>
                    <p className="mb-0.5 text-[11px] text-muted-foreground">{Number(d.slice(8))}</p>
                    <div className="space-y-0.5">
                      {blocks.slice(0, 3).map((b) => (
                        b.booking_id ? (
                          <Link key={b.id} href={`/resort/bookings/${b.booking_id}`} className={cn("block truncate rounded px-1 py-0.5 text-[10px]", TONE[b.block_type])} title={`${LABEL[b.block_type]} · ${b.bookings?.booking_ref ?? ""}`}>
                            {b.bookings?.guest_name ?? b.bookings?.booking_ref ?? LABEL[b.block_type]}
                          </Link>
                        ) : (
                          <span key={b.id} className={cn("block truncate rounded px-1 py-0.5 text-[10px]", TONE[b.block_type])} title={b.reason ?? LABEL[b.block_type]}>{LABEL[b.block_type]}</span>
                        )
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex flex-wrap gap-3 text-xs">
              {(Object.keys(LABEL) as Block["block_type"][]).map((k) => <span key={k} className="flex items-center gap-1"><span className={cn("h-3 w-3 rounded", TONE[k])} />{LABEL[k]}</span>)}
            </div>
          </>
        )}
      </Section>

      <div className="space-y-6">
        <BlockForm canEdit={canEdit} onCreated={reload} />
        <Section title="Manual blocks this view">
          {error ? <p className="text-sm text-muted-foreground">Unavailable until the calendar loads.</p> : loading && !data ? <p className="text-sm text-muted-foreground">Loading…</p> : (data?.blocks ?? []).filter((b) => !b.booking_id).length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
            <ul className="space-y-2 text-sm">
              {(data?.blocks ?? []).filter((b) => !b.booking_id).map((b) => {
                const r = parseRange(b.period);
                return (
                  <li key={b.id} className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{LABEL[b.block_type]}{b.reason ? ` — ${b.reason}` : ""}</p>
                      {r && <p className="text-xs text-muted-foreground">{fmtDateTime(r[0].toISOString())} → {fmtDateTime(r[1].toISOString())}</p>}
                    </div>
                    {canEdit && (
                      <Button size="sm" variant="ghost" onClick={async () => {
                        if (!window.confirm("Remove this block and reopen the dates?")) return;
                        try { await adminSend(`/api/admin/availability?id=${b.id}`, "DELETE"); toast.success("Block removed"); reload(); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
                      }}>Remove</Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

function BlockForm({ canEdit, onCreated }: { canEdit: boolean; onCreated: () => void }) {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [type, setType] = useState<"manual_block" | "maintenance">("manual_block");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <Section title="Block dates" description="Whole days in IST, first to last day inclusive. Fails if the dates overlap a booking or hold.">
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div><Label className="text-xs">From</Label><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} disabled={!canEdit} className="h-8" /></div>
          <div><Label className="text-xs">To</Label><Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} disabled={!canEdit} className="h-8" /></div>
        </div>
        <select className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs" value={type} onChange={(e) => setType(e.target.value as typeof type)} disabled={!canEdit}>
          <option value="manual_block">Owner / private use</option>
          <option value="maintenance">Maintenance</option>
        </select>
        <Input placeholder="Reason (internal)" value={reason} onChange={(e) => setReason(e.target.value)} disabled={!canEdit} className="h-8" maxLength={300} />
        <Button size="sm" className="w-full" disabled={!canEdit || !start || !end || saving} onClick={async () => {
          setSaving(true);
          try {
            await adminSend("/api/admin/availability", "POST", { block_type: type, start_date: start, end_date: end, ...(reason ? { reason } : {}) });
            toast.success("Dates blocked");
            setStart(""); setEnd(""); setReason("");
            onCreated();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Failed");
          } finally {
            setSaving(false);
          }
        }}>{saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Block dates</Button>
      </div>
    </Section>
  );
}
