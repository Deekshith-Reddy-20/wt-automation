"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CheckCircle2, CircleSlash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useCan } from "@/hooks/use-can";
import { FieldForm, type FieldDef } from "@/components/resort-admin/field-form";
import { ErrorBlock, LoadingBlock, Section, adminSend, useAdminData } from "@/components/resort-admin/shared";
import type { IntegrationStatus } from "@/lib/resort/integrations";

/* eslint-disable @typescript-eslint/no-explicit-any */

const FLAG_FIELDS: FieldDef[] = [
  { key: "is_published", label: "Publish the public website", type: "bool", hint: "While off, visitors see a holding page and search engines are told not to index." },
  { key: "bot_enabled", label: "WhatsApp assistant on", type: "bool", hint: "Answers incoming WhatsApp messages with the V-Farms menu and flows." },
  { key: "test_mode", label: "Test mode", type: "bool", hint: "Bot replies are simulated (saved in the inbox, not sent) except to the test numbers below." },
  { key: "test_phone_numbers", label: "Test numbers that get real replies", type: "list", wide: true, hint: "Comma-separated, international format: +919876543210" },
  { key: "payments_enabled", label: "Online advance payments", type: "bool", hint: "Requires Razorpay keys and an advance rule in Pricing." },
  { key: "manual_approval_required", label: "Staff confirm every booking", type: "bool", hint: "Even after a verified payment, a team member confirms. Recommended." },
  { key: "holds_enabled", label: "Hold dates while the guest pays", type: "bool" },
  { key: "hold_duration_minutes", label: "Hold length (minutes)", type: "number", required: true },
  { key: "event_buffer_minutes", label: "Setup / cleanup buffer around events (minutes)", type: "number", required: true },
];

const NOTIFY_KINDS: { key: string; label: string }[] = [
  { key: "new_enquiry", label: "New enquiry" },
  { key: "qualified_lead", label: "Qualified lead" },
  { key: "booking_requested", label: "Booking requested" },
  { key: "payment_verified", label: "Payment verified" },
  { key: "event_approval_required", label: "Event needs approval" },
  { key: "cancellation_requested", label: "Cancellation requested" },
  { key: "handoff_requested", label: "Guest wants a person" },
  { key: "message_failed", label: "Message failed" },
];

export default function ResortSettingsPage() {
  const canEdit = useCan("manage-resort");
  const prop = useAdminData<{ settings: Record<string, any> | null }>("/api/admin/property");
  const integ = useAdminData<IntegrationStatus>(canEdit ? "/api/admin/settings/integrations" : null);

  const save = async (changes: Record<string, unknown>) => {
    try {
      await adminSend("/api/admin/property", "PATCH", changes);
      toast.success("Saved");
      prop.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    }
  };

  if (prop.loading && !prop.data) return <LoadingBlock />;
  if (prop.error || !prop.data) return <ErrorBlock message={prop.error ?? "Failed"} code={prop.errorCode} onRetry={prop.reload} />;
  const s = prop.data.settings;

  return (
    <div className="space-y-6">
      {!canEdit && <p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">Read-only — only owners and admins can change these settings.</p>}
      <Section title="Booking & automation" description="Every change is recorded in the audit log.">
        <FieldForm fields={FLAG_FIELDS} initial={s} disabled={!canEdit} onSubmit={save} />
      </Section>

      <NotificationSettings initial={(s?.notification_settings ?? {}) as Record<string, boolean>} disabled={!canEdit} onSave={(v) => save({ notification_settings: v })} />
      <ReminderSettings initial={(s?.reminder_settings ?? {}) as Record<string, any>} disabled={!canEdit} onSave={(v) => save({ reminder_settings: v })} />

      {canEdit && (
        <Section title="Integrations" description="Secrets are kept in server environment variables or encrypted storage and are never shown here.">
          {integ.loading && !integ.data ? <LoadingBlock /> : integ.error || !integ.data ? <ErrorBlock message={integ.error ?? "Failed"} code={integ.errorCode} onRetry={integ.reload} /> : (
            <div className="grid gap-4 md:grid-cols-2">
              <Integration
                title="WhatsApp (MSG91)"
                rows={[
                  ["MSG91 in this CRM", true, "/api/msg91/webhook → Inbox + resort bot"],
                  ["Meta Cloud API", false, "Not used for MSG91"],
                ]}
                footer={
                  <>
                    Set <code>MSG91_AUTHKEY</code> and <code>MSG91_INTEGRATED_NUMBER</code> in the repo root <code>.env.local</code>, run this app on port 3000, then point the MSG91 inbound webhook at <code>…/api/msg91/webhook</code> (see{' '}
                    <Link className="text-primary hover:underline" href="/settings?tab=whatsapp">
                      Settings → WhatsApp
                    </Link>
                    ).
                  </>
                }
              />
              <Integration title="Razorpay" rows={[
                ["Key ID", Boolean(integ.data.razorpay.key_id), integ.data.razorpay.key_id ? `${integ.data.razorpay.key_id} (${integ.data.razorpay.mode})` : undefined],
                ["Key secret", integ.data.razorpay.key_secret_configured],
                ["Webhook secret", integ.data.razorpay.webhook_secret_configured],
              ]} footer={<>Used for refunds. There is no guest payment page, so the WhatsApp bot sends no payment links: booking requests wait for staff to confirm them under Bookings, and the team shares payment details with the guest.</>} />
              <Integration title="Server" rows={[
                ["Supabase URL", integ.data.supabase.url_configured],
                ["Service role key (server only)", integ.data.supabase.service_role_configured],
                ["Cron secret (reminders, hold expiry)", integ.data.cron.secret_configured],
                ["App URL (NEXT_PUBLIC_SITE_URL)", Boolean(integ.data.site_url), integ.data.site_url ?? undefined],
              ]} />
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

function Integration({ title, rows, footer }: { title: string; rows: [string, boolean, string?][]; footer?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <p className="mb-2 text-sm font-semibold">{title}</p>
      <ul className="space-y-1 text-sm">
        {rows.map(([label, ok, detail]) => (
          <li key={label} className="flex items-center gap-2">
            {ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <CircleSlash className="h-4 w-4 text-muted-foreground" />}
            <span>{label}</span>
            <span className="ml-auto text-xs text-muted-foreground">{detail ?? (ok ? "Configured" : "Not configured")}</span>
          </li>
        ))}
      </ul>
      {footer && <p className="mt-3 text-xs text-muted-foreground">{footer}</p>}
    </div>
  );
}

function NotificationSettings({ initial, disabled, onSave }: { initial: Record<string, boolean>; disabled: boolean; onSave: (v: Record<string, boolean>) => Promise<void> }) {
  const [v, setV] = useState<Record<string, boolean>>(initial);
  return (
    <Section title="Team alerts" description="In-app notifications for owners, admins and reservation managers.">
      <div className="grid gap-2 md:grid-cols-2">
        {NOTIFY_KINDS.map((k) => (
          <label key={k.key} className="flex items-center justify-between rounded-lg border border-border p-2.5 text-sm">
            {k.label}
            <Switch checked={v[k.key] !== false} disabled={disabled} onCheckedChange={(c) => setV((s) => ({ ...s, [k.key]: c }))} />
          </label>
        ))}
      </div>
      {!disabled && <div className="mt-3 flex justify-end"><Button size="sm" onClick={() => onSave(v)}>Save alerts</Button></div>}
    </Section>
  );
}

function ReminderSettings({ initial, disabled, onSave }: { initial: Record<string, any>; disabled: boolean; onSave: (v: Record<string, unknown>) => Promise<void> }) {
  const [v, setV] = useState<Record<string, string>>({
    arrival_reminder_hours: initial.arrival_reminder_hours?.toString() ?? "",
    checkout_reminder_hours: initial.checkout_reminder_hours?.toString() ?? "",
    confirmation_template: initial.confirmation_template ?? "",
    arrival_template: initial.arrival_template ?? "",
    checkout_template: initial.checkout_template ?? "",
  });
  const field = (key: string, label: string, type = "text") => (
    <div>
      <Label className="text-xs">{label}</Label>
      <Input type={type} value={v[key]} disabled={disabled} onChange={(e) => setV((s) => ({ ...s, [key]: e.target.value }))} className="h-8" />
    </div>
  );
  return (
    <Section
      title="Guest confirmations & reminders"
      description="Sent only to guests with a confirmed booking who have not opted out. Within 24 hours of the guest's last message a normal WhatsApp message is used; outside it, only the approved template named here. Without a template, the message is skipped and shown as such."
    >
      <div className="grid gap-3 md:grid-cols-2">
        {field("arrival_reminder_hours", "Arrival reminder — hours before check-in / event (blank = off)", "number")}
        {field("checkout_reminder_hours", "Check-out reminder — hours before check-out (blank = off)", "number")}
        {field("confirmation_template", "Confirmation template name (approved in Meta)")}
        {field("arrival_template", "Arrival reminder template name")}
        {field("checkout_template", "Check-out reminder template name")}
      </div>
      {!disabled && (
        <div className="mt-3 flex justify-end">
          <Button size="sm" onClick={() => {
            const out: Record<string, unknown> = {};
            for (const [k, val] of Object.entries(v)) {
              if (!val.trim()) continue;
              out[k] = k.endsWith("_hours") ? Number(val) : val.trim();
            }
            onSave(out);
          }}>Save reminders</Button>
        </div>
      )}
    </Section>
  );
}
