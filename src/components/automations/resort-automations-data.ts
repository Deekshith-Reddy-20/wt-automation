import type { ResortAutomationKey } from "@/lib/resort/automations/definitions"

export interface ResortAutomation {
  id: string
  key: ResortAutomationKey
  letter: string
  /** Position in the 12 V-Farms flows; null for extra automations. */
  flow_number: number | null
  name: string
  description: string
  trigger_label: string
  kind: "conversation" | "scheduled"
  required: boolean
  proactive: boolean
  is_enabled: boolean
  config: Record<string, unknown>
  execution_count: number
  success_count: number
  failure_count: number
  skipped_count: number
  last_executed_at: string | null
  last_status: "success" | "failed" | "skipped" | null
  last_error: string | null
}

export type LoadResult = { items: ResortAutomation[] } | { error: { message: string; code?: string } }

/** Load the persisted registry. A failure is reported as an error, never as an empty or made-up list. */
export async function fetchResortAutomations(fetcher: typeof fetch = fetch): Promise<LoadResult> {
  try {
    const res = await fetcher("/api/admin/resort-automations", { cache: "no-store" })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { error: { message: json.error ?? `Request failed (${res.status})`, code: json.code ?? (res.status === 401 ? "unauthenticated" : undefined) } }
    }
    if (!Array.isArray(json.automations)) return { error: { message: "The server returned an unexpected response." } }
    return { items: json.automations as ResortAutomation[] }
  } catch {
    return { error: { message: "Could not reach the server. Check your connection and retry." } }
  }
}

export interface AutomationGroup {
  title: string | null
  rows: ResortAutomation[]
}

/** Flows page: the 12 numbered flows in order, then any extra automations. */
export function groupAutomations(items: ResortAutomation[], variant: "automations" | "flows"): AutomationGroup[] {
  if (variant === "automations") return items.length ? [{ title: null, rows: items }] : []
  return [
    { title: null, rows: items.filter((a) => a.flow_number != null).sort((x, y) => x.flow_number! - y.flow_number!) },
    { title: "Additional resort automations", rows: items.filter((a) => a.flow_number == null) },
  ].filter((g) => g.rows.length > 0)
}
