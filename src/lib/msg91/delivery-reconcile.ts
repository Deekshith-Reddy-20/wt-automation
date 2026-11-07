import type { SupabaseClient } from '@supabase/supabase-js'
import { applyDeliveryStatus } from './delivery-status'
import { msg91Configured, msg91Env } from './env'
import type { DeliveryStatus } from './inbound'

/**
 * MSG91's outbound delivery webhook does not carry the send request id unless
 * `{{requestId}}` is added to its payload, so accepted replies can sit at
 * 'sending' forever. This pulls the real status from MSG91's WhatsApp log
 * (the same report the MSG91 dashboard shows) and moves the inbox copy
 * forward. Statuses only ever advance (see applyDeliveryStatus).
 */
const LOGS_URL = 'https://control.msg91.com/api/v5/report/logs/wa'
/** MSG91 serves the log for at most a 3-day window. */
const LOG_WINDOW_DAYS = 3

export interface Msg91LogRow {
  requestId?: string
  direction?: number | string
  status?: string
  requestedAt?: string
  sentTime?: { value?: string } | null
  deliveryTime?: { value?: string } | null
  readTime?: { value?: string } | null
  failureReason?: string | null
}

const istDate = (d: Date) => new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10)

/** The furthest status MSG91 has recorded; null while MSG91 has not processed the message yet. */
export function msg91LogStatus(row: Msg91LogRow): DeliveryStatus | null {
  const s = (row.status ?? '').toLowerCase()
  if (s === 'failed' || s === 'rejected' || s === 'undelivered' || row.failureReason) return 'failed'
  if (s === 'read' || row.readTime?.value) return 'read'
  if (s === 'delivered' || row.deliveryTime?.value) return 'delivered'
  if (s === 'sent' || row.sentTime?.value) return 'sent'
  return null
}

export async function fetchMsg91OutboundLog(
  since: Date,
  opts: { requestId?: string; timeoutMs?: number; now?: Date } = {},
): Promise<Map<string, Msg91LogRow>> {
  const { authkey } = msg91Env()
  const now = opts.now ?? new Date()
  const earliest = new Date(now.getTime() - (LOG_WINDOW_DAYS - 1) * 86400_000)
  const start = since < earliest ? earliest : since
  const params = new URLSearchParams({ startDate: istDate(start), endDate: istDate(now), limit: '1000' })
  if (opts.requestId) params.set('requestId', opts.requestId)
  const res = await fetch(`${LOGS_URL}?${params}`, {
    headers: { authkey, accept: 'application/json' },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    cache: 'no-store',
  })
  const body = (await res.json().catch(() => null)) as { data?: Msg91LogRow[] } | null
  if (!res.ok || !Array.isArray(body?.data)) throw new Error(`MSG91 log lookup failed (HTTP ${res.status})`)
  const rows = new Map<string, Msg91LogRow>()
  for (const row of body.data) {
    if (String(row.direction) === '1' && row.requestId) rows.set(row.requestId, row)
  }
  return rows
}

export interface ReconcileResult {
  checked: number
  updated: number
  stillQueued: string[]
}

/**
 * Bring pending MSG91 replies ('sending' / 'sent') up to date from MSG91's log.
 * Ids we minted ourselves (`msg91-…`) were never accepted by MSG91 and are skipped.
 */
export async function reconcileMsg91Deliveries(
  db: SupabaseClient,
  opts: { conversationId?: string; minAgeMs?: number; limit?: number; timeoutMs?: number; now?: Date } = {},
): Promise<ReconcileResult> {
  if (!msg91Configured()) return { checked: 0, updated: 0, stillQueued: [] }
  const now = opts.now ?? new Date()
  const oldest = new Date(now.getTime() - LOG_WINDOW_DAYS * 86400_000)
  let query = db
    .from('messages')
    .select('message_id, status, created_at')
    .in('sender_type', ['bot', 'agent'])
    .in('status', ['sending', 'sent'])
    .not('message_id', 'like', 'msg91-%')
    .gte('created_at', oldest.toISOString())
    .lte('created_at', new Date(now.getTime() - (opts.minAgeMs ?? 5000)).toISOString())
    .order('created_at', { ascending: true })
    .limit(opts.limit ?? 200)
  if (opts.conversationId) query = query.eq('conversation_id', opts.conversationId)
  const { data, error } = await query
  if (error) throw new Error(`pending reply lookup failed: ${error.message}`)
  const pending = (data ?? []) as { message_id: string; status: string; created_at: string }[]
  if (pending.length === 0) return { checked: 0, updated: 0, stillQueued: [] }

  const log = await fetchMsg91OutboundLog(new Date(pending[0].created_at), {
    timeoutMs: opts.timeoutMs,
    now,
    ...(pending.length === 1 ? { requestId: pending[0].message_id } : {}),
  })
  let updated = 0
  const stillQueued: string[] = []
  for (const msg of pending) {
    const row = log.get(msg.message_id)
    const status = row ? msg91LogStatus(row) : null
    if (!status) {
      stillQueued.push(msg.message_id)
      continue
    }
    updated += await applyDeliveryStatus(db, msg.message_id, status)
  }
  return { checked: pending.length, updated, stillQueued }
}
