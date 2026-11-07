"use client";

import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCan } from "@/hooks/use-can";
import { FieldForm, type FieldDef } from "@/components/resort-admin/field-form";
import { ErrorBlock, LoadingBlock, Section, adminSend, fmtDate, inr, useAdminData } from "@/components/resort-admin/shared";
import { EVENT_TYPES, EVENT_TYPE_LABELS } from "@/lib/resort/types";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface PricingData {
  rules: Record<string, any> | null;
  seasonal_rates: Record<string, any>[];
  event_packages: Record<string, any>[];
  addons: Record<string, any>[];
  missing: string[];
}

const RULE_FIELDS: FieldDef[] = [
  { key: "weekday_night_rate", label: "Weekday night rate (₹, whole estate)", type: "number" },
  { key: "weekend_night_rate", label: "Weekend night rate (₹, whole estate)", type: "number" },
  { key: "weekend_nights", label: "Weekend nights (ISO weekday of the night: 5 = Fri, 6 = Sat)", type: "numlist", hint: "Comma-separated, e.g. 5, 6" },
  { key: "base_guests_included", label: "Guests included in the nightly rate", type: "number" },
  { key: "extra_adult_rate_per_night", label: "Extra adult per night (₹)", type: "number" },
  { key: "extra_child_rate_per_night", label: "Extra child per night (₹)", type: "number" },
  { key: "child_age_limit", label: "Children up to this age are priced as children", type: "number" },
  { key: "min_nights", label: "Minimum nights", type: "number", required: true },
  { key: "extended_stay_min_nights", label: "Extended-stay discount from (nights)", type: "number" },
  { key: "extended_stay_discount_pct", label: "Extended-stay discount (%)", type: "number" },
  { key: "tax_label", label: "Tax label", type: "text", required: true },
  { key: "tax_pct", label: "Tax (%)", type: "number", hint: "Leave empty if no tax applies or it is not configured." },
  { key: "prices_include_tax", label: "Rates already include tax", type: "bool" },
  { key: "deposit_pct", label: "Advance payment (%)", type: "number", hint: "Use either a percentage or a fixed advance." },
  { key: "deposit_fixed_amount", label: "Advance payment (fixed ₹)", type: "number" },
  { key: "quote_validity_hours", label: "Quote valid for (hours)", type: "number" },
  { key: "max_staff_discount_pct", label: "Largest discount staff may give (%)", type: "number", required: true },
];

const SEASON_FIELDS: FieldDef[] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "kind", label: "Kind", type: "select", required: true, options: [{ value: "season", label: "Season" }, { value: "special_date", label: "Special date" }, { value: "holiday", label: "Holiday" }] },
  { key: "start_date", label: "First night", type: "date", required: true },
  { key: "end_date", label: "Last night", type: "date", required: true },
  { key: "nightly_rate", label: "Nightly rate (₹)", type: "number", required: true },
  { key: "weekend_nightly_rate", label: "Weekend nightly rate (₹)", type: "number" },
  { key: "min_nights", label: "Minimum nights", type: "number" },
  { key: "is_active", label: "Active", type: "bool" },
];

const PACKAGE_FIELDS: FieldDef[] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "base_price", label: "Base price (₹)", type: "number", required: true },
  { key: "included_hours", label: "Hours included", type: "number" },
  { key: "extra_hour_rate", label: "Extra hour (₹)", type: "number" },
  { key: "max_guests", label: "Maximum guests", type: "number" },
  { key: "event_types", label: `Event types (blank = all): ${EVENT_TYPES.join(", ")}`, type: "list", wide: true },
  { key: "description", label: "Description", type: "textarea" },
  { key: "includes_accommodation", label: "Includes overnight accommodation", type: "bool" },
  { key: "is_active", label: "Active (offered to guests)", type: "bool" },
];

const ADDON_FIELDS: FieldDef[] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "price", label: "Price (₹)", type: "number", required: true },
  { key: "unit", label: "Charged", type: "select", required: true, options: [
    { value: "per_booking", label: "Per booking" }, { value: "per_night", label: "Per night" },
    { value: "per_guest", label: "Per guest" }, { value: "per_guest_per_night", label: "Per guest per night" },
  ] },
  { key: "applies_to", label: "Applies to", type: "select", required: true, options: [{ value: "both", label: "Stays & events" }, { value: "stay", label: "Stays" }, { value: "event", label: "Events" }] },
  { key: "description", label: "Description", type: "textarea" },
  { key: "is_active", label: "Active (offered to guests)", type: "bool" },
];

export default function PricingPage() {
  const { data, error, errorCode, loading, reload } = useAdminData<PricingData>("/api/admin/pricing");
  const canEdit = useCan("manage-resort");
  if (loading && !data) return <LoadingBlock />;
  if (error || !data) return <ErrorBlock message={error ?? "Failed"} code={errorCode} onRetry={reload} />;

  const save = async (entity: string, payload: Record<string, unknown>) => {
    try {
      await adminSend("/api/admin/pricing", "PUT", { entity, data: payload });
      toast.success("Pricing saved — every change is recorded in the audit log.");
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
      throw e;
    }
  };

  return (
    <div className="space-y-6">
      {!canEdit && <p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">Read-only — only owners and admins can change pricing.</p>}
      {data.missing.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" /> Not configured</p>
          <p className="mt-1">Until these are set, the website and bot say pricing is available on request instead of quoting: {data.missing.join(", ")}.</p>
        </div>
      )}
      <Section title="Stay pricing (whole estate per night)" description="Only rates entered here are ever shown or quoted. Nothing is estimated.">
        <FieldForm fields={RULE_FIELDS} initial={data.rules} disabled={!canEdit} showNotConfigured columns={3} onSubmit={(c) => save("rules", c)} />
      </Section>
      <ItemList title="Seasonal & special-date rates" description="Special dates and holidays override seasons. Rates of the same kind may not overlap." entity="seasonal_rate" fields={SEASON_FIELDS} items={data.seasonal_rates} canEdit={canEdit} onSave={save} onDeleted={reload}
        summary={(r) => `${fmtDate(r.start_date)} → ${fmtDate(r.end_date)} · ${inr(r.nightly_rate)}${r.weekend_nightly_rate ? ` / weekend ${inr(r.weekend_nightly_rate)}` : ""}${r.is_active ? "" : " · inactive"}`}
        defaults={{ kind: "season", is_active: true }}
      />
      <ItemList title="Event packages" description="Events are always reviewed by the team; packages give the starting price." entity="event_package" fields={PACKAGE_FIELDS} items={data.event_packages} canEdit={canEdit} onSave={save} onDeleted={reload}
        summary={(p) => `${inr(p.base_price)}${p.included_hours ? ` · ${p.included_hours}h` : ""}${p.max_guests ? ` · up to ${p.max_guests}` : ""} · ${(p.event_types ?? []).map((t: string) => EVENT_TYPE_LABELS[t as keyof typeof EVENT_TYPE_LABELS] ?? t).join(", ") || "all events"}${p.is_active ? "" : " · inactive"}`}
        defaults={{ is_active: false, includes_accommodation: false }}
      />
      <ItemList title="Add-ons" entity="addon" fields={ADDON_FIELDS} items={data.addons} canEdit={canEdit} onSave={save} onDeleted={reload}
        summary={(a) => `${inr(a.price)} ${String(a.unit).replace(/_/g, " ")} · ${a.applies_to}${a.is_active ? "" : " · inactive"}`}
        defaults={{ unit: "per_booking", applies_to: "both", is_active: false }}
      />
    </div>
  );
}

function ItemList({ title, description, entity, fields, items, canEdit, onSave, onDeleted, summary, defaults }: {
  title: string; description?: string; entity: string; fields: FieldDef[]; items: Record<string, any>[];
  canEdit: boolean; onSave: (entity: string, payload: Record<string, unknown>) => Promise<void>; onDeleted: () => void;
  summary: (item: Record<string, any>) => string; defaults: Record<string, any>;
}) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const current = editing === "new" ? defaults : items.find((i) => i.id === editing) ?? null;
  return (
    <Section title={title} description={description} actions={canEdit && editing === null ? <Button size="sm" variant="outline" onClick={() => setEditing("new")}><Plus className="h-3.5 w-3.5" /> Add</Button> : undefined}>
      {items.length === 0 && editing !== "new" && <p className="text-sm text-muted-foreground">None configured.</p>}
      <ul className="divide-y divide-border">
        {items.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0"><p className="text-sm font-medium">{i.name}</p><p className="text-xs text-muted-foreground">{summary(i)}</p></div>
            {canEdit && (
              <div className="flex gap-1">
                <Button size="icon" variant="ghost" aria-label="Edit" onClick={() => setEditing(i.id)}><Pencil className="h-3.5 w-3.5" /></Button>
                <Button size="icon" variant="ghost" aria-label="Delete" onClick={async () => {
                  if (!window.confirm(`Delete “${i.name}”?`)) return;
                  try { await adminSend(`/api/admin/pricing?entity=${entity}&id=${i.id}`, "DELETE"); toast.success("Deleted"); onDeleted(); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
                }}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {editing !== null && current && (
        <div className="mt-4 rounded-lg border border-border p-4">
          <FieldForm
            fields={fields}
            initial={editing === "new" ? null : current}
            submitLabel={editing === "new" ? "Add" : "Save"}
            onSubmit={async (changes) => {
              const payload = editing === "new" ? { ...defaults, ...changes } : { ...pick(current, fields), ...changes, id: current.id };
              await onSave(entity, payload);
              setEditing(null);
            }}
          />
          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
        </div>
      )}
    </Section>
  );
}

/** Full object for an update (the item schemas validate whole rows). */
function pick(item: Record<string, any>, fields: FieldDef[]) {
  const out: Record<string, any> = {};
  for (const f of fields) {
    const v = item[f.key];
    out[f.key] = f.type === "number" && v !== null && v !== undefined ? Number(v) : v;
  }
  return out;
}
