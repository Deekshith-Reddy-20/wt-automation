import type { SupabaseClient } from '@supabase/supabase-js'
import {
  RESORT_AUTOMATIONS,
  automationSettingsFrom,
  defaultAutomationConfig,
  disabledAutomationSettings,
  type AutomationSettings,
  type ResortAutomationKey,
} from './definitions'

export interface ResortAutomationRow {
  id: string
  account_id: string
  key: ResortAutomationKey
  name: string
  description: string | null
  trigger_type: string
  is_enabled: boolean
  config: Record<string, unknown>
  execution_count: number
  success_count: number
  failure_count: number
  skipped_count: number
  last_executed_at: string | null
  last_status: 'success' | 'failed' | 'skipped' | null
  last_error: string | null
  updated_at: string
}

const CHECK_VIOLATION = '23514'

export const AUTOMATION_ROW_COLUMNS =
  'id, account_id, key, name, description, trigger_type, is_enabled, config, execution_count, success_count, failure_count, skipped_count, last_executed_at, last_status, last_error, updated_at'

/**
 * Create any missing registry rows for the account — always disabled, with
 * default config. Existing rows (and their enabled state) are untouched.
 */
export async function ensureResortAutomations(db: SupabaseClient, accountId: string): Promise<ResortAutomationRow[]> {
  const { data: existing, error } = await db
    .from('resort_automations')
    .select(AUTOMATION_ROW_COLUMNS)
    .eq('account_id', accountId)
  if (error) throw new Error(`Could not load resort automations: ${error.message}`)
  const have = new Set((existing ?? []).map((r) => r.key as string))
  const missing = RESORT_AUTOMATIONS.filter((d) => !have.has(d.key))
  if (missing.length > 0) {
    const rowFor = (d: (typeof missing)[number]) => ({
      account_id: accountId,
      key: d.key,
      name: d.name,
      description: d.description,
      trigger_type: d.trigger_type,
      is_enabled: false,
      config: defaultAutomationConfig(d.key),
    })
    const insert = (rows: ReturnType<typeof rowFor>[]) =>
      db.from('resort_automations').upsert(rows, { onConflict: 'account_id,key', ignoreDuplicates: true })
    const { error: insErr } = await insert(missing.map(rowFor))
    if (insErr && (insErr as { code?: string }).code === CHECK_VIOLATION) {
      // A newer automation whose key migration isn't applied yet: create the others, skip it.
      for (const d of missing) {
        const { error: oneErr } = await insert([rowFor(d)])
        if (!oneErr) continue
        if ((oneErr as { code?: string }).code !== CHECK_VIOLATION) throw new Error(`Could not create resort automations: ${oneErr.message}`)
        console.warn(`[resort-automations] "${d.key}" needs a database migration before it can be enabled`)
      }
    } else if (insErr) throw new Error(`Could not create resort automations: ${insErr.message}`)
    const { data: all, error: reErr } = await db
      .from('resort_automations')
      .select(AUTOMATION_ROW_COLUMNS)
      .eq('account_id', accountId)
    if (reErr) throw new Error(`Could not load resort automations: ${reErr.message}`)
    return sortRows((all ?? []) as ResortAutomationRow[])
  }
  return sortRows((existing ?? []) as ResortAutomationRow[])
}

function sortRows(rows: ResortAutomationRow[]): ResortAutomationRow[] {
  const order = new Map(RESORT_AUTOMATIONS.map((d, i) => [d.key, i]))
  return [...rows].sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99))
}

/**
 * Enabled flags and configs for the engine. A read failure (e.g. the
 * migration isn't applied yet) means every optional automation is off.
 */
export async function loadAutomationSettings(db: SupabaseClient, accountId: string): Promise<AutomationSettings> {
  const { data, error } = await db
    .from('resort_automations')
    .select('key, is_enabled, config')
    .eq('account_id', accountId)
  if (error) {
    console.error('[resort-automations] registry unavailable:', error.message)
    return disabledAutomationSettings()
  }
  return automationSettingsFrom((data ?? []) as { key: string; is_enabled: boolean; config: unknown }[])
}

export type RunStatus = 'success' | 'failed' | 'skipped' | 'test'

export interface AutomationRunInput {
  accountId: string
  key: ResortAutomationKey
  trigger: string
  status: RunStatus
  /** Same key ⇒ recorded once (webhook retries, repeated cron passes). */
  dedupeKey?: string | null
  conversationId?: string | null
  contactId?: string | null
  bookingId?: string | null
  leadId?: string | null
  detail?: Record<string, unknown>
  error?: string | null
}

/**
 * Append to the execution history (the counters update in the database).
 * Returns false when the dedupe key was already recorded. Never throws:
 * history must not break the guest-facing action it describes.
 */
export async function recordAutomationRun(db: SupabaseClient, run: AutomationRunInput): Promise<boolean> {
  const { error } = await db.from('resort_automation_runs').insert({
    account_id: run.accountId,
    automation_key: run.key,
    trigger: run.trigger,
    status: run.status,
    dedupe_key: run.dedupeKey ?? null,
    conversation_id: run.conversationId ?? null,
    contact_id: run.contactId ?? null,
    booking_id: run.bookingId ?? null,
    lead_id: run.leadId ?? null,
    detail: run.detail ?? {},
    error: run.error ? run.error.slice(0, 1000) : null,
  })
  if (!error) return true
  if ((error as { code?: string }).code === '23505') return false
  console.error('[resort-automations] could not record run:', error.message)
  return false
}
