"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  AlertTriangle,
  CheckCircle2,
  History,
  Loader2,
  MessageCircle,
  MoreVertical,
  Pencil,
  PlayCircle,
  Power,
  RotateCcw,
  Settings2,
  Sprout,
  XCircle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { HealthCheckButton, adminSend, fmtDateTime } from "@/components/resort-admin/shared"
import { useCan } from "@/hooks/use-can"
import {
  defaultAutomationConfig,
} from "@/lib/resort/automations/definitions"
import { cn } from "@/lib/utils"
import { BotTestChat } from "./bot-test-chat"
import { fetchResortAutomations, groupAutomations, type LoadResult, type ResortAutomation } from "./resort-automations-data"

interface Run {
  id: string
  trigger: string
  status: "success" | "failed" | "skipped" | "test"
  booking_id: string | null
  conversation_id: string | null
  detail: Record<string, unknown>
  error: string | null
  created_at: string
}

interface Preview {
  summary: string
  checks: { label: string; ok: boolean; detail?: string }[]
  messages: ({ kind: "text"; text: string } | { kind: "buttons"; body: string; buttons: { id: string; title: string }[] } | { kind: "list"; body: string; button: string; sections: { rows: { id: string; title: string }[] }[] })[]
  data?: Record<string, unknown>
}

const FIELD_LABELS: Record<string, { label: string; hint?: string }> = {
  welcome_text: { label: "Welcome message", hint: "The seven menu options are added automatically as a WhatsApp list (with a numbered fallback)." },
  intro_text: { label: "Stay menu message", hint: "Keep the numbered options 1–7 in this order." },
  booking_welcome_text: { label: "Booking welcome message", hint: "Start Booking Enquiry, Talk to Our Team and Main Menu buttons are added automatically." },
  suggest_alternatives: { label: "Suggest open alternative dates" },
  notify_team_when_unpriced: { label: "Ask the team to quote when rates are incomplete" },
  assign_to_user_id: { label: "Assign to staff user ID", hint: "Optional. Leave empty to alert the whole team without assigning." },
  template_name: { label: "Approved WhatsApp template name", hint: "Used outside the 24-hour window. Leave empty to skip messages outside the window." },
  balance_due_days_before: { label: "Balance due (days before arrival)", hint: "Leave empty for no payment reminders." },
  remind_days_before_due: { label: "Remind (days before the due date)" },
  hours_before: { label: "Send (hours before arrival)", hint: "Leave empty to use Resort settings → reminders." },
  arrival_instructions: { label: "Check-in instructions", hint: "Added to the confirmation and arrival reminder." },
  message_text: { label: "Message" },
  delay_hours: { label: "Send (hours after completion)" },
  after_hours: { label: "Follow up after (hours of silence)", hint: "Leave empty to send no follow-ups." },
  max_follow_ups: { label: "Maximum follow-ups per enquiry (1–3)" },
}

const NULLABLE_NUMBERS = new Set(["balance_due_days_before", "hours_before", "after_hours"])
const NULLABLE_STRINGS = new Set(["template_name", "assign_to_user_id", "arrival_instructions"])

const LOAD_ERROR_TITLE: Record<string, string> = {
  migration_required: "Database setup needed",
  config_missing: "Supabase is not configured",
  permission_denied: "Access denied",
  connection_failed: "Database unreachable",
  unauthenticated: "Signed out",
}

export function ResortAutomationsSection({ variant = "automations" }: { variant?: "automations" | "flows" }) {
  const canManage = useCan("manage-resort")
  const [items, setItems] = useState<ResortAutomation[] | null>(null)
  const [error, setError] = useState<{ message: string; code?: string } | null>(null)
  const [editing, setEditing] = useState<ResortAutomation | null>(null)
  const [testing, setTesting] = useState<ResortAutomation | null>(null)
  const [history, setHistory] = useState<ResortAutomation | null>(null)

  const apply = useCallback((result: LoadResult) => {
    if ("items" in result) {
      setError(null)
      setItems(result.items)
    } else {
      setError(result.error)
    }
  }, [])

  const load = useCallback(() => fetchResortAutomations().then(apply), [apply])
  const [retrying, setRetrying] = useState(false)
  async function retry() {
    setRetrying(true)
    await load()
    setRetrying(false)
  }

  useEffect(() => {
    let cancelled = false
    fetchResortAutomations().then((result) => {
      if (!cancelled) apply(result)
    })
    return () => {
      cancelled = true
    }
  }, [apply])

  async function toggle(a: ResortAutomation, next: boolean) {
    setItems((prev) => prev?.map((x) => (x.key === a.key ? { ...x, is_enabled: next } : x)) ?? prev)
    try {
      await adminSend(`/api/admin/resort-automations/${a.key}`, "PATCH", { is_enabled: next })
      toast.success(`${a.name} ${next ? "enabled" : "disabled"}`)
    } catch (e) {
      setItems((prev) => prev?.map((x) => (x.key === a.key ? { ...x, is_enabled: !next } : x)) ?? prev)
      toast.error(e instanceof Error ? e.message : "Could not update the automation")
    }
  }

  const [chatOpen, setChatOpen] = useState(false)
  const [enablingAll, setEnablingAll] = useState(false)
  async function enableAll() {
    if (!window.confirm("Turn on every resort automation and the WhatsApp bot? Test mode stays as it is, so while it is on only your staff test numbers get real replies.")) return
    setEnablingAll(true)
    try {
      const r = await adminSend<{ enabled: number; test_mode: boolean }>("/api/admin/resort-automations/enable-all", "POST", {})
      toast.success(`${r.enabled} automations and the bot are on${r.test_mode ? " (test mode on)" : ""}`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not turn everything on")
    } finally {
      setEnablingAll(false)
    }
  }

  async function resetConfig(a: ResortAutomation) {
    if (!window.confirm(`Reset ${a.name} settings to the defaults?`)) return
    try {
      await adminSend(`/api/admin/resort-automations/${a.key}`, "PATCH", { config: defaultAutomationConfig(a.key) })
      toast.success("Settings reset")
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not reset")
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Sprout className="h-4 w-4 text-primary" /> {variant === "flows" ? "V-Farms resort flows" : "V-Farms resort automations"}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Run on the live booking engine: availability, quotes, holds and confirmations are always checked against the database. All start disabled.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {canManage && items && items.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => void enableAll()} disabled={enablingAll}>
              {enablingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />} Turn all on
            </Button>
          )}
          <Button size="sm" onClick={() => setChatOpen(true)}>
            <MessageCircle className="h-3.5 w-3.5" /> Test the bot
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            <RotateCcw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
      </div>

      {error ? (
        <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-medium">{LOAD_ERROR_TITLE[error.code ?? ""] ?? "Could not load resort flows"}</p>
          <p className="mt-1 text-xs">{error.message}</p>
          <p className="mt-1 text-xs">Nothing is shown in place of the real records until they load.</p>
          <div className="mt-2 flex flex-wrap items-start gap-2">
            <Button size="sm" variant="outline" onClick={() => void retry()} disabled={retrying}>
              {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Retry
            </Button>
            <HealthCheckButton />
          </div>
        </div>
      ) : items === null ? (
        <div className="flex h-24 items-center justify-center" aria-label="Loading resort flows">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No resort flow records exist for this account yet. Press Refresh to create them (they start disabled).
        </div>
      ) : (
        groupAutomations(items, variant)
          .map((group) => (
            <div key={group.title ?? "main"} className="space-y-2">
              {group.title && <h3 className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.title}</h3>}
              <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                {group.rows.map((a) => (
                  <ResortAutomationCard
                    key={a.key}
                    a={a}
                    badge={variant === "flows" && a.flow_number != null ? String(a.flow_number) : a.letter}
                    canManage={canManage}
                    onToggle={(next) => void toggle(a, next)}
                    onEdit={() => setEditing(a)}
                    onTest={() => setTesting(a)}
                    onHistory={() => setHistory(a)}
                    onReset={() => void resetConfig(a)}
                  />
                ))}
              </ul>
            </div>
          ))
      )}

      {editing && (
        <ConfigDialog
          a={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await load()
          }}
        />
      )}
      {testing && <TestDialog a={testing} onClose={() => setTesting(null)} />}
      {history && <HistoryDialog a={history} onClose={() => setHistory(null)} />}
      {chatOpen && <BotTestChat onClose={() => setChatOpen(false)} />}
    </section>
  )
}

function ResortAutomationCard({
  a,
  badge,
  canManage,
  onToggle,
  onEdit,
  onTest,
  onHistory,
  onReset,
}: {
  a: ResortAutomation
  badge: string
  canManage: boolean
  onToggle: (next: boolean) => void
  onEdit: () => void
  onTest: () => void
  onHistory: () => void
  onReset: () => void
}) {
  const router = useRouter()
  const hasConfig = Object.keys(a.config ?? {}).length > 0
  return (
    <li className="flex flex-col rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-sm font-bold text-primary" aria-hidden>
          {badge}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{a.name}</span>
            {a.required && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">Always on</span>}
            {a.proactive && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">Sends to guests</span>}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{a.description}</p>
        </div>
        <Switch
          checked={a.is_enabled}
          disabled={!canManage || a.required}
          onCheckedChange={(v) => onToggle(!!v)}
          aria-label={a.is_enabled ? `Disable ${a.name}` : `Enable ${a.name}`}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium">{a.trigger_label}</span>
        <span className="tabular-nums">{a.execution_count} run{a.execution_count === 1 ? "" : "s"}</span>
        <span aria-hidden>·</span>
        <span className="tabular-nums text-emerald-700 dark:text-emerald-400">{a.success_count} ok</span>
        <span className="tabular-nums text-rose-700 dark:text-rose-400">{a.failure_count} failed</span>
        <span className="tabular-nums">{a.skipped_count} skipped</span>
        <span aria-hidden>·</span>
        <span>last {a.last_executed_at ? fmtDateTime(a.last_executed_at) : "never"}</span>
        {a.last_status && <LastStatus status={a.last_status} />}
      </div>
      {a.last_status === "failed" && a.last_error && (
        <p className="mt-2 flex items-start gap-1.5 rounded-md bg-rose-50 px-2 py-1.5 text-xs text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" /> {a.last_error}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {hasConfig && (
          <Button size="sm" variant="outline" onClick={onEdit} disabled={!canManage}>
            <Pencil className="h-3.5 w-3.5" /> Edit
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onTest}>
          <PlayCircle className="h-3.5 w-3.5" /> Run Test
        </Button>
        <Button size="sm" variant="ghost" onClick={onHistory}>
          <History className="h-3.5 w-3.5" /> Execution History
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="More actions"
            className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <MoreVertical className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => router.push("/resort/settings")}>
              <Settings2 className="h-4 w-4" /> Resort settings
            </DropdownMenuItem>
            {hasConfig && canManage && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onReset}>
                  <RotateCcw className="h-4 w-4" /> Reset settings to defaults
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  )
}

function LastStatus({ status }: { status: "success" | "failed" | "skipped" }) {
  const Icon = status === "success" ? CheckCircle2 : status === "failed" ? XCircle : AlertTriangle
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-medium",
        status === "success" && "text-emerald-700 dark:text-emerald-400",
        status === "failed" && "text-rose-700 dark:text-rose-400",
        status === "skipped" && "text-amber-700 dark:text-amber-400",
      )}
    >
      <Icon className="h-3.5 w-3.5" /> {status}
    </span>
  )
}

function ConfigDialog({ a, onClose, onSaved }: { a: ResortAutomation; onClose: () => void; onSaved: () => Promise<void> }) {
  const [values, setValues] = useState<Record<string, unknown>>(a.config)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      await adminSend(`/api/admin/resort-automations/${a.key}`, "PATCH", { config: values })
      toast.success("Settings saved")
      await onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{a.letter}. {a.name}</DialogTitle>
          <DialogDescription>Settings are validated on the server. Business details (rates, policies, address) live in Resort settings.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {Object.entries(values).map(([field, value]) => {
            const meta = FIELD_LABELS[field] ?? { label: field.replace(/_/g, " ") }
            const id = `cfg-${field}`
            if (typeof value === "boolean") {
              return (
                <div key={field} className="flex items-center justify-between gap-3">
                  <Label htmlFor={id}>{meta.label}</Label>
                  <Switch id={id} checked={value} onCheckedChange={(v) => setValues((p) => ({ ...p, [field]: !!v }))} />
                </div>
              )
            }
            const isNumber = typeof value === "number" || NULLABLE_NUMBERS.has(field)
            const isLongText = typeof value === "string" && (value.length > 80 || field.endsWith("_text") || field === "arrival_instructions")
            return (
              <div key={field} className="space-y-1.5">
                <Label htmlFor={id}>{meta.label}</Label>
                {isLongText ? (
                  <Textarea
                    id={id}
                    rows={field === "welcome_text" || field === "intro_text" || field === "booking_welcome_text" ? 12 : 4}
                    value={String(value ?? "")}
                    onChange={(e) => setValues((p) => ({ ...p, [field]: NULLABLE_STRINGS.has(field) && !e.target.value.trim() ? null : e.target.value }))}
                  />
                ) : (
                  <Input
                    id={id}
                    type={isNumber ? "number" : "text"}
                    value={value === null || value === undefined ? "" : String(value)}
                    onChange={(e) => {
                      const raw = e.target.value
                      setValues((p) => ({
                        ...p,
                        [field]: isNumber
                          ? raw === "" ? (NULLABLE_NUMBERS.has(field) ? null : p[field]) : Number(raw)
                          : NULLABLE_STRINGS.has(field) && !raw.trim() ? null : raw,
                      }))
                    }}
                  />
                )}
                {meta.hint && <p className="text-xs text-muted-foreground">{meta.hint}</p>}
              </div>
            )
          })}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TestDialog({ a, onClose }: { a: ResortAutomation; onClose: () => void }) {
  const wantsDates = a.key === "availability_check" || a.key === "pricing_quote"
  const [checkIn, setCheckIn] = useState("")
  const [checkOut, setCheckOut] = useState("")
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<Preview | null>(null)

  async function run() {
    setRunning(true)
    try {
      const body = wantsDates && checkIn && checkOut ? { check_in: checkIn, check_out: checkOut } : {}
      setResult(await adminSend<Preview>(`/api/admin/resort-automations/${a.key}/test`, "POST", body))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Test failed")
    } finally {
      setRunning(false)
    }
  }

  useEffect(() => {
    if (!wantsDates) void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Test: {a.name}</DialogTitle>
          <DialogDescription>Read-only. Nothing is sent to WhatsApp and no enquiry, hold or booking is created.</DialogDescription>
        </DialogHeader>
        {wantsDates && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="t-in">Check-in</Label>
              <Input id="t-in" type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="t-out">Check-out</Label>
              <Input id="t-out" type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
            </div>
            <Button onClick={() => void run()} disabled={running}>
              {running && <Loader2 className="h-4 w-4 animate-spin" />} Run Test
            </Button>
          </div>
        )}
        {running && !result && (
          <div className="flex h-20 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
        )}
        {result && (
          <div className="space-y-4">
            <ul className="space-y-1.5">
              {result.checks.map((c, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  {c.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" /> : <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600" />}
                  <span>
                    {c.label}
                    {c.detail && <span className="block text-xs text-muted-foreground">{c.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
            {result.messages.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">What the guest would see</p>
                {result.messages.map((m, i) => (
                  <div key={i} className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
                    <p className="whitespace-pre-wrap">{m.kind === "text" ? m.text : m.body}</p>
                    {m.kind === "buttons" && (
                      <div className="mt-2 flex flex-wrap gap-1.5">{m.buttons.map((b) => <span key={b.id} className="rounded-md border border-border bg-background px-2 py-1 text-xs">{b.title}</span>)}</div>
                    )}
                    {m.kind === "list" && (
                      <div className="mt-2 space-y-1">
                        <span className="text-xs font-medium text-primary">[{m.button}]</span>
                        {m.sections.flatMap((s) => s.rows).map((r) => <div key={r.id} className="text-xs text-muted-foreground">• {r.title}</div>)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {result.data && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">Data used</summary>
                <pre className="mt-2 max-h-60 overflow-auto rounded-md bg-muted p-2">{JSON.stringify(result.data, null, 2)}</pre>
              </details>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function HistoryDialog({ a, onClose }: { a: ResortAutomation; onClose: () => void }) {
  const [runs, setRuns] = useState<Run[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/admin/resort-automations/${a.key}/runs`, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`)
        setRuns(json.runs as Run[])
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load history"))
  }, [a.key])

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Execution history: {a.name}</DialogTitle>
          <DialogDescription>The latest 100 runs. Tests are listed but not counted.</DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-rose-600">{error}</p>
        ) : runs === null ? (
          <div className="flex h-20 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {runs.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <div className="min-w-0">
                  <span
                    className={cn(
                      "mr-2 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium",
                      r.status === "success" && "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
                      r.status === "failed" && "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
                      r.status === "skipped" && "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
                      r.status === "test" && "bg-muted text-muted-foreground",
                    )}
                  >
                    {r.status}
                  </span>
                  <span className="text-xs text-muted-foreground">{r.trigger.replace(/_/g, " ")}</span>
                  {Boolean(r.error || r.detail?.outcome || r.detail?.reason) && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {r.error ?? String(r.detail?.reason ?? r.detail?.outcome)}
                      {r.detail?.dry_run ? " · dry run" : ""}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  {r.booking_id && <Link className="underline" href={`/resort/bookings/${r.booking_id}`}>Booking</Link>}
                  {r.conversation_id && <Link className="underline" href={`/inbox?c=${r.conversation_id}`}>Conversation</Link>}
                  <span>{fmtDateTime(r.created_at)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
