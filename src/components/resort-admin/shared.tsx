"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export class AdminApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** JSON request to an /api/admin route. Throws AdminApiError with the server's message. */
export async function adminSend<T = Record<string, unknown>>(
  url: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const issues = Array.isArray(json.issues)
      ? (json.issues as { path: string; message: string }[]).map((i) => `${i.path ? `${i.path}: ` : ""}${i.message}`).join("; ")
      : "";
    throw new AdminApiError(
      [String(json.error ?? `Request failed (${res.status})`), issues].filter(Boolean).join(" — "),
      res.status,
      json,
    );
  }
  return json as T;
}

/** GET an admin route with loading / error state and a reload function. */
export function useAdminData<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    try {
      const res = await fetch(url, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorCode(typeof json.code === "string" ? json.code : res.status === 401 ? "unauthenticated" : undefined);
        throw new Error(json.error ?? `Request failed (${res.status})`);
      }
      setData(json as T);
      setError(null);
      setErrorCode(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, errorCode, loading, reload, setData };
}

interface HealthCheck {
  id: string;
  label: string;
  status: "ok" | "config_error" | "missing_table" | "rls_error" | "connection_error" | "query_error";
  detail?: string;
}

const HEALTH_LABEL: Record<HealthCheck["status"], string> = {
  ok: "OK",
  config_error: "Configuration",
  missing_table: "Migration missing",
  rls_error: "Access denied",
  connection_error: "Connection failed",
  query_error: "Query failed",
};

/** Read-only diagnosis via /api/admin/health. */
export function HealthCheckButton() {
  const [checks, setChecks] = useState<HealthCheck[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/health", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (res.status === 401) {
        setChecks(null);
        setMessage("Authentication failed: your session has expired. Sign in again.");
      } else if (!res.ok) {
        setChecks(null);
        setMessage(json.error ?? `Health check failed (${res.status})`);
      } else {
        setChecks(json.checks as HealthCheck[]);
      }
    } catch {
      setMessage("Could not reach the server.");
    } finally {
      setRunning(false);
    }
  }, []);

  return (
    <div className="w-full max-w-xl space-y-2 text-left">
      <Button variant="outline" size="sm" onClick={run} disabled={running}>
        {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Run health check
      </Button>
      {message && <p className="text-xs text-destructive">{message}</p>}
      {checks && (
        <ul className="space-y-1 rounded-lg border border-border bg-muted/30 p-3 text-xs">
          {checks.map((c) => (
            <li key={c.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className={cn("font-medium", c.status === "ok" ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>
                {HEALTH_LABEL[c.status]}
              </span>
              <span className="text-foreground">{c.label}</span>
              {c.detail && <span className="text-muted-foreground">— {c.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LoadingBlock() {
  return (
    <div className="flex h-48 items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
    </div>
  );
}

const SETUP_TITLE: Record<string, string> = {
  migration_required: "Database setup incomplete",
  config_missing: "Supabase is not configured",
  permission_denied: "Access denied",
  connection_failed: "Database unreachable",
  unauthenticated: "Signed out",
};

export function ErrorBlock({ message, code, onRetry }: { message: string; code?: string; onRetry?: () => void }) {
  const title = code ? SETUP_TITLE[code] : undefined;
  return (
    <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border p-6 text-center">
      {title && <p className="text-sm font-semibold text-foreground">{title}</p>}
      <p className="max-w-xl text-sm text-destructive">{message}</p>
      <div className="flex gap-2">
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
      {code && code !== "unauthenticated" && <HealthCheckButton />}
    </div>
  );
}

export function EmptyBlock({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-36 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/30 p-6 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {children && <div className="mt-1 text-xs text-muted-foreground">{children}</div>}
    </div>
  );
}

export function NotConfigured({ label = "Not configured" }: { label?: string }) {
  return <span className="text-xs font-medium italic text-amber-600 dark:text-amber-400">{label}</span>;
}

export function Section({ title, description, actions, children }: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function inr(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value));
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const [y, m, day] = d.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function fmtDateTime(d: string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

export function fmtTime(t: string | null | undefined): string {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${m ? `:${String(m).padStart(2, "0")}` : ""}${suffix}`;
}

const STATUS_TONE: Record<string, string> = {
  confirmed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  checked_in: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  checked_out: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  completed: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  payment_verified: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  payment_pending: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  hold: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  booking_requested: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  cancellation_requested: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  cancelled: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
  rejected: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
  expired: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
  hot: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
  warm: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  nurture: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  failed: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
  sent: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  paid: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  refund_pending: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
};

export function StatusPill({ value, label }: { value: string; label?: string }) {
  return (
    <Badge variant="secondary" className={cn("whitespace-nowrap font-medium", STATUS_TONE[value])}>
      {label ?? value.replace(/_/g, " ")}
    </Badge>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: "warn" | "ok" }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold", tone === "warn" && "text-amber-600 dark:text-amber-400")}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function bookingWhen(b: {
  booking_type: string;
  check_in?: string | null;
  check_out?: string | null;
  event_date?: string | null;
  event_start_time?: string | null;
  event_end_time?: string | null;
}): string {
  if (b.booking_type === "stay") return `${fmtDate(b.check_in)} → ${fmtDate(b.check_out)}`;
  return `${fmtDate(b.event_date)} ${fmtTime(b.event_start_time)}–${fmtTime(b.event_end_time)}`;
}
