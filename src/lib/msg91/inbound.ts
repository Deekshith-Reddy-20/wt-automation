import { z } from 'zod'

/**
 * MSG91 "Webhook (New)" payloads vary by event and account settings.
 * Docs show both numeric direction (0=in, 1=out) and string ("inbound"/"outbound").
 * If we reject unknown shapes, the handler returns 200 with skipped=invalid_payload and the guest gets no reply.
 */

const looseRowSchema = z
  .object({
    direction: z.unknown().optional(),
    customerNumber: z.string().optional(),
    customer_number: z.string().optional(),
    /** MSG91 usually sends a stringified JSON object; some payloads send a plain object. */
    content: z.unknown().optional(),
    /** Plain message text; present when the webhook payload template includes "text": "{{text}}". */
    text: z.unknown().optional(),
    button: z.unknown().optional(),
    /** Tap on an interactive reply button / list row (Meta shape: button_reply | list_reply). */
    interactive: z.unknown().optional(),
    requestId: z.string().optional(),
    request_id: z.string().optional(),
    uuid: z.string().optional(),
    integratedNumber: z.string().optional(),
    eventName: z.string().optional(),
    contentType: z.string().optional(),
    messageType: z.string().optional(),
    reason: z.string().optional(),
    dryRun: z.unknown().optional(),
  })
  .passthrough()

export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed'

export type ParsedInbound =
  | {
      kind: 'inbound'
      customerNumber: string
      text: string
      buttonText: string | null
      /** Id of the tapped interactive button / list row, when the guest tapped one. */
      replyId: string | null
      requestId: string | null
      /** Stable per-message id (Meta wamid, else MSG91 requestId) used to drop webhook retries. */
      messageId: string | null
      /** Message type the bot cannot read (image, audio, location …); `text` is a placeholder. */
      unsupported: string | null
    }
  | {
      /** MSG91 delivery report for a message we sent; `requestId` is the id the send API returned. */
      kind: 'status'
      requestId: string
      status: DeliveryStatus
      reason: string | null
    }
  | { kind: 'ignore'; reason: string }

const TEXT_TYPES = new Set(['', 'text', 'interactive', 'button'])

function deliveryStatusOf(eventName: string | undefined): DeliveryStatus | null {
  const e = (eventName ?? '').trim().toLowerCase()
  if (e === 'sent' || e === 'delivered' || e === 'read' || e === 'failed') return e
  return null
}

/** Map MSG91 direction values to inbound vs outbound. Unknown → null (caller decides). */
export function normalizeMsg91Direction(raw: unknown): 'inbound' | 'outbound' | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'number') {
    if (raw === 0) return 'inbound'
    if (raw === 1) return 'outbound'
    return null
  }
  const s = String(raw).trim().toLowerCase()
  if (s === '0' || s === 'inbound') return 'inbound'
  if (s === '1' || s === 'outbound') return 'outbound'
  return null
}

function parseContentText(raw: unknown): string {
  if (raw == null) return ''
  if (typeof raw === 'object' && raw !== null && 'text' in raw && typeof (raw as { text: unknown }).text === 'string') {
    return (raw as { text: string }).text.trim()
  }
  if (typeof raw !== 'string') return ''

  const content = raw
  if (!content.trim()) return ''
  try {
    const j = JSON.parse(content) as unknown
    if (j && typeof j === 'object') {
      const o = j as { text?: unknown; caption?: unknown }
      if (typeof o.text === 'string') return o.text.trim()
      if (typeof o.caption === 'string') return o.caption.trim()
      return ''
    }
  } catch {
    return content.trim()
  }
  return content.trim()
}

function parseButtonText(raw: unknown): string | null {
  if (raw == null) return null
  if (typeof raw === 'object' && raw !== null) {
    const o = raw as { text?: unknown; payload?: unknown }
    const t = typeof o.text === 'string' ? o.text.trim() : ''
    const p = typeof o.payload === 'string' ? o.payload.trim() : ''
    const out = t || p
    return out || null
  }
  if (typeof raw !== 'string') return null
  const button = raw
  if (!button.trim()) return null
  try {
    const j = JSON.parse(button) as { text?: string; payload?: string }
    return (j.text ?? j.payload ?? '').trim() || null
  } catch {
    return button.trim() || null
  }
}

function asObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw.trim().startsWith('{')) return null
  try {
    const j = JSON.parse(raw) as unknown
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** `bare`: accept a plain {id, title} object (the `interactive` field); `content` must name button_reply / list_reply. */
function parseInteractiveReply(raw: unknown, bare: boolean): { id: string; title: string } | null {
  const o = asObject(raw)
  if (!o) return null
  const inner = asObject(o.interactive) ?? o
  const reply = asObject(inner.button_reply) ?? asObject(inner.list_reply) ?? (bare ? inner : null)
  if (!reply) return null
  const id = typeof reply.id === 'string' ? reply.id.trim() : ''
  const title = typeof reply.title === 'string' ? reply.title.trim() : ''
  return id ? { id, title } : null
}

/** Digits only; '' for a masked sample number such as "9181588XXXXX" or anything too short to message. */
function customerNumberFrom(row: z.infer<typeof looseRowSchema>): string {
  const raw = (row.customerNumber ?? row.customer_number ?? '').trim()
  if (/[a-z]/i.test(raw)) return ''
  const digits = raw.replace(/\D/g, '')
  return digits.length >= 10 ? digits : ''
}

export function parseMsg91Webhook(body: unknown): ParsedInbound {
  const parsed = looseRowSchema.safeParse(body)
  if (!parsed.success) return { kind: 'ignore', reason: 'invalid_payload' }

  const row = parsed.data
  // MSG91's webhook "Test Run" posts a sample marked dryRun: true; it is not a guest.
  if (row.dryRun === true || row.dryRun === 'true') return { kind: 'ignore', reason: 'msg91_test_run' }
  const dirNorm = normalizeMsg91Direction(row.direction)
  const requestId = row.requestId?.trim() || row.request_id?.trim() || null
  if (dirNorm === 'outbound') {
    const status = deliveryStatusOf(row.eventName)
    if (!status || !requestId) return { kind: 'ignore', reason: 'outbound_report' }
    return { kind: 'status', requestId, status, reason: row.reason?.trim() || null }
  }

  const customerNumber = customerNumberFrom(row)
  if (!customerNumber) return { kind: 'ignore', reason: 'no_customer_number' }

  const text = parseContentText(row.content) || parseContentText(row.text)
  const buttonText = parseButtonText(row.button)
  const reply = parseInteractiveReply(row.interactive, true) ?? parseInteractiveReply(row.content, false)
  const effectiveText = reply?.title || buttonText || text || reply?.id || ''
  const messageId = row.uuid?.trim() || requestId
  const type = (row.contentType ?? row.messageType ?? '').trim().toLowerCase()

  if (!effectiveText) {
    if (TEXT_TYPES.has(type)) return { kind: 'ignore', reason: 'empty_message' }
    return { kind: 'inbound', customerNumber, text: `[${type}]`, buttonText: null, replyId: null, requestId, messageId, unsupported: type }
  }

  return {
    kind: 'inbound',
    customerNumber,
    text: effectiveText,
    buttonText,
    replyId: reply?.id ?? null,
    requestId,
    messageId,
    unsupported: null,
  }
}
