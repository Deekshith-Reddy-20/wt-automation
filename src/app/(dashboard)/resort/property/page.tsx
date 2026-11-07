"use client";

import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCan } from "@/hooks/use-can";
import { FieldForm, type FieldDef } from "@/components/resort-admin/field-form";
import { ErrorBlock, LoadingBlock, Section, adminSend, useAdminData } from "@/components/resort-admin/shared";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface PropertyData {
  settings: Record<string, any> | null;
  amenities: Record<string, any>[];
  faqs: Record<string, any>[];
  media: Record<string, any>[];
  checklist: { field: string; label: string; affects: string }[];
  missing: string[];
}

const GROUPS: { title: string; description?: string; fields: FieldDef[] }[] = [
  {
    title: "About the estate",
    fields: [
      { key: "resort_name", label: "Name", type: "text", required: true },
      { key: "tagline", label: "Tagline", type: "text" },
      { key: "room_count", label: "Guest rooms", type: "number" },
      { key: "property_area_acres", label: "Area (acres)", type: "number" },
      { key: "description", label: "Overview", type: "textarea" },
      { key: "farm_description", label: "The farm", type: "textarea" },
      { key: "building_description", label: "The building & rooms", type: "textarea" },
    ],
  },
  {
    title: "Contact & location",
    description: "The bot shares location only when these are filled in; otherwise it hands the guest to the team.",
    fields: [
      { key: "whatsapp_number", label: "WhatsApp number (+91…)", type: "text" },
      { key: "contact_phone", label: "Phone (+91…)", type: "text" },
      { key: "contact_email", label: "Email", type: "text" },
      { key: "locality", label: "Locality", type: "text" },
      { key: "address", label: "Address", type: "textarea" },
      { key: "map_url", label: "Google Maps link (https://…)", type: "text" },
      { key: "latitude", label: "Latitude", type: "number" },
      { key: "longitude", label: "Longitude", type: "number" },
      { key: "directions", label: "Directions", type: "textarea" },
      { key: "parking_info", label: "Parking", type: "textarea" },
    ],
  },
  {
    title: "Stays & events",
    fields: [
      { key: "check_in_time", label: "Check-in time", type: "time" },
      { key: "check_out_time", label: "Check-out time", type: "time" },
      { key: "max_stay_guests", label: "Maximum overnight guests", type: "number", hint: "Until set, stay requests go to manual review instead of being auto-accepted." },
      { key: "max_event_guests", label: "Maximum event guests", type: "number" },
      { key: "food_info", label: "Food & meals", type: "textarea", hint: "Leave empty if not offered or not decided — the bot will not mention meals." },
      { key: "activities_info", label: "Activities", type: "textarea" },
      { key: "accessibility_info", label: "Accessibility", type: "textarea" },
    ],
  },
  {
    title: "Policies",
    description: "Shown on the website and booking pages exactly as written. Empty policies are shown as “to be confirmed with the team”.",
    fields: [
      { key: "guest_policies", label: "House rules", type: "textarea" },
      { key: "event_policies", label: "Event rules", type: "textarea" },
      { key: "cancellation_policy", label: "Cancellation policy", type: "textarea" },
      { key: "refund_policy", label: "Refund policy", type: "textarea" },
      { key: "privacy_policy", label: "Privacy policy", type: "textarea" },
      { key: "terms", label: "Terms", type: "textarea" },
    ],
  },
];

const AMENITY_FIELDS: FieldDef[] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "applies_to", label: "Applies to", type: "select", required: true, options: [{ value: "both", label: "Stays & events" }, { value: "stay", label: "Stays" }, { value: "event", label: "Events" }] },
  { key: "description", label: "Description", type: "textarea" },
  { key: "sort_order", label: "Order", type: "number", required: true },
  { key: "is_approved", label: "Approved — confirmed to exist at V-Farms", type: "bool" },
];
const FAQ_FIELDS: FieldDef[] = [
  { key: "question", label: "Question", type: "text", required: true, wide: true },
  { key: "answer", label: "Answer", type: "textarea", required: true },
  { key: "sort_order", label: "Order", type: "number", required: true },
  { key: "is_published", label: "Published", type: "bool" },
];
const MEDIA_FIELDS: FieldDef[] = [
  { key: "public_url", label: "Image URL (https://)", type: "text", required: true, wide: true, hint: "Upload to Supabase Storage (public bucket) or another host, then paste the URL." },
  { key: "category", label: "Category", type: "select", required: true, options: ["farm", "building", "rooms", "event_space", "amenities", "food", "other"].map((v) => ({ value: v, label: v.replace("_", " ") })) },
  { key: "alt_text", label: "Alt text", type: "text" },
  { key: "caption", label: "Caption", type: "text" },
  { key: "sort_order", label: "Order", type: "number", required: true },
  { key: "is_verified_property_photo", label: "This photo shows V-Farms itself (not stock)", type: "bool" },
  { key: "is_approved", label: "Show on the website", type: "bool" },
];

export default function PropertyPage() {
  const { data, error, errorCode, loading, reload } = useAdminData<PropertyData>("/api/admin/property");
  const canEdit = useCan("manage-resort");
  if (loading && !data) return <LoadingBlock />;
  if (error || !data) return <ErrorBlock message={error ?? "Failed"} code={errorCode} onRetry={reload} />;

  const saveSettings = async (changes: Record<string, unknown>) => {
    try {
      await adminSend("/api/admin/property", "PATCH", changes);
      toast.success("Saved");
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    }
  };

  const missing = data.checklist.filter((c) => data.missing.includes(c.field));

  return (
    <div className="space-y-6">
      {!canEdit && <p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">Read-only — only owners and admins can edit property information.</p>}
      {missing.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" /> Not configured</p>
          <ul className="mt-1 list-disc pl-5">{missing.map((m) => <li key={m.field}><strong>{m.label}</strong> — {m.affects}</li>)}</ul>
        </div>
      )}
      {GROUPS.map((g) => (
        <Section key={g.title} title={g.title} description={g.description}>
          <FieldForm fields={g.fields} initial={data.settings} disabled={!canEdit} showNotConfigured onSubmit={saveSettings} />
        </Section>
      ))}
      <ContentList title="Amenities" description="Only approved amenities are shown on the website or mentioned by the bot." entity="amenity" fields={AMENITY_FIELDS} items={data.amenities} canEdit={canEdit} onChanged={reload}
        label={(a) => a.name} sub={(a) => `${a.applies_to}${a.is_approved ? "" : " · not approved"}`} defaults={{ applies_to: "both", sort_order: 0, is_approved: false }} />
      <ContentList title="FAQs" entity="faq" fields={FAQ_FIELDS} items={data.faqs} canEdit={canEdit} onChanged={reload}
        label={(f) => f.question} sub={(f) => (f.is_published ? "Published" : "Draft")} defaults={{ sort_order: 0, is_published: false }} />
      <ContentList title="Photos" description="Only photos marked as genuine V-Farms photos and approved are shown. Never publish stock images as the property." entity="media" fields={MEDIA_FIELDS} items={data.media} canEdit={canEdit} onChanged={reload}
        label={(m) => m.caption || m.alt_text || m.public_url} sub={(m) => `${m.category}${m.is_verified_property_photo ? " · genuine" : " · unverified"}${m.is_approved ? " · shown" : " · hidden"}`} defaults={{ category: "other", sort_order: 0, is_verified_property_photo: false, is_approved: false }} />
    </div>
  );
}

function ContentList({ title, description, entity, fields, items, canEdit, onChanged, label, sub, defaults }: {
  title: string; description?: string; entity: string; fields: FieldDef[]; items: Record<string, any>[]; canEdit: boolean;
  onChanged: () => void; label: (i: Record<string, any>) => string; sub: (i: Record<string, any>) => string; defaults: Record<string, any>;
}) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const current = editing === "new" ? null : items.find((i) => i.id === editing) ?? null;
  return (
    <Section title={title} description={description} actions={canEdit && editing === null ? <Button size="sm" variant="outline" onClick={() => setEditing("new")}><Plus className="h-3.5 w-3.5" /> Add</Button> : undefined}>
      {items.length === 0 && editing !== "new" && <p className="text-sm text-muted-foreground">None yet.</p>}
      <ul className="divide-y divide-border">
        {items.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-3 py-2">
            <div className="flex min-w-0 items-center gap-3">
              {entity === "media" && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={i.public_url} alt={i.alt_text ?? ""} className="h-10 w-14 flex-shrink-0 rounded object-cover" />
              )}
              <div className="min-w-0"><p className="truncate text-sm font-medium">{label(i)}</p><p className="text-xs text-muted-foreground">{sub(i)}</p></div>
            </div>
            {canEdit && (
              <div className="flex gap-1">
                <Button size="icon" variant="ghost" aria-label="Edit" onClick={() => setEditing(i.id)}><Pencil className="h-3.5 w-3.5" /></Button>
                <Button size="icon" variant="ghost" aria-label="Delete" onClick={async () => {
                  if (!window.confirm("Delete this item?")) return;
                  try { await adminSend(`/api/admin/property/content?entity=${entity}&id=${i.id}`, "DELETE"); toast.success("Deleted"); onChanged(); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
                }}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {editing !== null && (
        <div className="mt-4 rounded-lg border border-border p-4">
          <FieldForm
            fields={fields}
            initial={current}
            submitLabel={editing === "new" ? "Add" : "Save"}
            onSubmit={async (changes) => {
              const base = current ? Object.fromEntries(fields.map((f) => [f.key, f.type === "number" && current[f.key] != null ? Number(current[f.key]) : current[f.key]])) : defaults;
              try {
                await adminSend("/api/admin/property/content", "PUT", { entity, data: { ...base, ...changes, ...(current ? { id: current.id } : {}) } });
                toast.success("Saved");
                setEditing(null);
                onChanged();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Save failed");
              }
            }}
          />
          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
        </div>
      )}
    </Section>
  );
}
