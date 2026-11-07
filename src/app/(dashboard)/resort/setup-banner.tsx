"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { HealthCheckButton } from "@/components/resort-admin/shared";

interface Health {
  ok: boolean;
  status: string;
  checks: { id: string; status: string; detail?: string }[];
}

/** Shown above every resort tab when the database or configuration is not ready. */
export function ResortSetupBanner() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/health", { cache: "no-store" })
      .then(async (res) => (res.ok ? ((await res.json()) as Health) : null))
      .then((h) => {
        if (!cancelled) setHealth(h);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!health || health.ok || (health.status !== "missing_table" && health.status !== "config_error")) return null;
  const problem = health.checks.find((c) => c.status === health.status);
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="space-y-2">
          <p className="font-semibold">
            {health.status === "missing_table" ? "The V-Farms database tables are not set up yet" : "Supabase server configuration is missing"}
          </p>
          {problem?.detail && <p className="text-xs">{problem.detail}</p>}
          <p className="text-xs">
            Until this is fixed the calendar, bookings and enquiries cannot load. Nothing is shown from sample data instead.
          </p>
          <HealthCheckButton />
        </div>
      </div>
    </div>
  );
}
