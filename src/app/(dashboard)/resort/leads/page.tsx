"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCan } from "@/hooks/use-can";
import {
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  StatusPill,
  adminSend,
  fmtDate,
  fmtDateTime,
  inr,
  useAdminData,
} from "@/components/resort-admin/shared";
import { LEAD_STAGE_LABELS } from "@/lib/resort/lifecycle";
import { LEAD_PRIORITIES, LEAD_SOURCES, LEAD_STAGES, type Lead } from "@/lib/resort/types";

type LeadRow = Pick<Lead, "id" | "lead_number" | "customer_name" | "phone_e164" | "email" | "source" | "category" | "stage" | "priority" | "check_in" | "check_out" | "event_date" | "guest_count" | "next_follow_up_at" | "last_interaction_at" | "consent_status" | "conversation_id" | "updated_at"> & {
  estimated_quote_inr: number | string | null;
};

export default function LeadsPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <LeadsInner />
    </Suspense>
  );
}

function LeadsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get("id");
  const listParams = new URLSearchParams(params.toString());
  listParams.delete("id");
  const qs = listParams.toString();
  const { data, error, errorCode, loading, reload } = useAdminData<{ leads: LeadRow[]; total: number }>(`/api/admin/leads${qs ? `?${qs}` : ""}`);
  const [q, setQ] = useState(params.get("q") ?? "");

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(`/resort/leads?${next.toString()}`);
  };

  const filter = (name: string, options: readonly string[], labels?: Record<string, string>) => (
    <select aria-label={name} className="h-8 rounded-md border border-border bg-background px-2 text-xs capitalize" value={params.get(name) ?? ""} onChange={(e) => setParam(name, e.target.value)}>
      <option value="">Any {name}</option>
      {options.map((o) => <option key={o} value={o}>{labels?.[o] ?? o.replace(/_/g, " ")}</option>)}
    </select>
  );

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {filter("stage", LEAD_STAGES, LEAD_STAGE_LABELS)}
          {filter("priority", LEAD_PRIORITIES)}
          {filter("source", LEAD_SOURCES)}
          {filter("category", ["stay", "event", "pricing", "general"])}
          <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={params.get("open") === "1"} onChange={(e) => setParam("open", e.target.checked ? "1" : "")} /> Open only</label>
          <form onSubmit={(e) => { e.preventDefault(); setParam("q", q.trim()); }} className="ml-auto">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, phone, email" className="h-8 w-56 text-xs" />
          </form>
        </div>
        {loading && !data ? <LoadingBlock /> : error ? <ErrorBlock message={error} code={errorCode} onRetry={reload} /> : !data?.leads.length ? (
          <EmptyBlock title="No leads yet">Leads are created automatically from website enquiries and WhatsApp conversations.</EmptyBlock>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr><th className="px-3 py-2">Lead</th><th className="px-3 py-2">Interest</th><th className="px-3 py-2">Stage</th><th className="px-3 py-2">Follow-up</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.leads.map((l) => (
                  <tr key={l.id} onClick={() => setParam("id", l.id)} className={`cursor-pointer hover:bg-muted/30 ${selected === l.id ? "bg-primary/5" : ""}`}>
                    <td className="px-3 py-2">
                      <p className="font-medium">{l.customer_name ?? "Unnamed"} <span className="text-xs text-muted-foreground">#{l.lead_number}</span></p>
                      <p className="text-xs text-muted-foreground">{l.phone_e164 ?? l.email ?? "—"} · {l.source.replace(/_/g, " ")}</p>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <p className="capitalize">{l.category}</p>
                      <p className="text-muted-foreground">{l.check_in ? `${fmtDate(l.check_in)} → ${fmtDate(l.check_out)}` : l.event_date ? fmtDate(l.event_date) : ""}{l.guest_count ? ` · ${l.guest_count} guests` : ""}</p>
                    </td>
                    <td className="space-x-1 px-3 py-2"><StatusPill value={l.priority} /><StatusPill value={l.stage} label={LEAD_STAGE_LABELS[l.stage]} /></td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{l.next_follow_up_at ? fmtDateTime(l.next_follow_up_at) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{data.total} total</p>
          </div>
        )}
      </div>
      {selected && <LeadPanel id={selected} onClose={() => setParam("id", "")} onChanged={reload} />}
    </div>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function LeadPanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const canEdit = useCan("manage-reservations");
  const { data, error, errorCode, loading, reload } = useAdminData<{ lead: Record<string, any>; notes: any[]; bookings: any[] }>(`/api/admin/leads/${id}`);
  const [note, setNote] = useState("");
  const [followUp, setFollowUp] = useState("");

  useEffect(() => {
    const v = data?.lead.next_follow_up_at;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFollowUp(v ? new Date(new Date(v).getTime() + 5.5 * 3600_000).toISOString().slice(0, 16) : "");
  }, [data?.lead.next_follow_up_at]);

  const patch = async (body: Record<string, unknown>) => {
    try {
      await adminSend(`/api/admin/leads/${id}`, "PATCH", body);
      toast.success("Lead updated");
      reload();
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    }
  };

  return (
    <aside className="rounded-xl border border-border bg-card p-4 xl:sticky xl:top-4 xl:max-h-[calc(100vh-6rem)] xl:overflow-y-auto">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">Lead</h2>
        <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button>
      </div>
      {loading && !data ? <LoadingBlock /> : error || !data ? <ErrorBlock message={error ?? "Not found"} code={errorCode} /> : (
        <div className="space-y-4 text-sm">
          <div>
            <p className="text-base font-semibold">{data.lead.customer_name ?? "Unnamed"}</p>
            <p className="text-xs text-muted-foreground">{data.lead.phone_e164 ?? "—"} · {data.lead.email ?? "no email"} · consent: {data.lead.consent_status}</p>
            {data.lead.conversation_id && <Link href={`/inbox?c=${data.lead.conversation_id}`} className="text-xs text-primary hover:underline">Open WhatsApp conversation</Link>}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Stage</Label>
              <select disabled={!canEdit} className="block h-8 w-full rounded-md border border-border bg-background px-2 text-xs" value={data.lead.stage} onChange={(e) => patch({ stage: e.target.value })}>
                {LEAD_STAGES.map((s) => <option key={s} value={s}>{LEAD_STAGE_LABELS[s]}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-xs">Priority</Label>
              <select disabled={!canEdit} className="block h-8 w-full rounded-md border border-border bg-background px-2 text-xs capitalize" value={data.lead.priority} onChange={(e) => patch({ priority: e.target.value })}>
                {LEAD_PRIORITIES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <Label className="text-xs">Next follow-up (IST)</Label>
              <div className="flex gap-2">
                <Input type="datetime-local" disabled={!canEdit} value={followUp} onChange={(e) => setFollowUp(e.target.value)} className="h-8" />
                <Button size="sm" variant="outline" disabled={!canEdit} onClick={() => patch({ next_follow_up_at: followUp ? `${followUp}:00+05:30` : null })}>Save</Button>
              </div>
            </div>
          </div>
          <dl className="grid grid-cols-[110px_1fr] gap-y-1 text-xs">
            <dt className="text-muted-foreground">Interest</dt><dd className="capitalize">{data.lead.category}</dd>
            {data.lead.check_in && <><dt className="text-muted-foreground">Stay</dt><dd>{fmtDate(data.lead.check_in)} → {fmtDate(data.lead.check_out)}</dd></>}
            {data.lead.event_date && <><dt className="text-muted-foreground">Event</dt><dd>{fmtDate(data.lead.event_date)}</dd></>}
            {data.lead.guest_count != null && <><dt className="text-muted-foreground">Guests</dt><dd>{data.lead.guest_count}</dd></>}
            {data.lead.budget_inr != null && <><dt className="text-muted-foreground">Budget</dt><dd>{inr(data.lead.budget_inr)}</dd></>}
            {data.lead.estimated_quote_inr != null && <><dt className="text-muted-foreground">Quote</dt><dd>{inr(data.lead.estimated_quote_inr)}</dd></>}
            {data.lead.special_requirements && <><dt className="text-muted-foreground">Requests</dt><dd>{data.lead.special_requirements}</dd></>}
          </dl>
          {data.bookings.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Bookings</p>
              <ul className="space-y-1">{data.bookings.map((b) => (
                <li key={b.id} className="flex items-center justify-between text-xs"><Link className="text-primary hover:underline" href={`/resort/bookings/${b.id}`}>{b.booking_ref}</Link><StatusPill value={b.status} /></li>
              ))}</ul>
            </div>
          )}
          <div>
            <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Notes</p>
            {canEdit && (
              <div className="mb-2 space-y-1">
                <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} placeholder="Add a note" />
                <Button size="sm" variant="outline" disabled={!note.trim()} onClick={async () => {
                  try { await adminSend(`/api/admin/leads/${id}/notes`, "POST", { body: note }); setNote(""); reload(); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
                }}>Add note</Button>
              </div>
            )}
            <ul className="space-y-2">{data.notes.map((n) => (
              <li key={n.id} className="rounded-md bg-muted/40 p-2 text-xs"><p className="whitespace-pre-wrap">{n.body}</p><p className="mt-1 text-[10px] text-muted-foreground">{fmtDateTime(n.created_at)}</p></li>
            ))}</ul>
          </div>
        </div>
      )}
    </aside>
  );
}
