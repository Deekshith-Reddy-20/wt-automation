import { msg91Env } from './env'

/**
 * Session message (after guest has messaged you): MSG91 documents query params on POST,
 * not a JSON body — otherwise the API returns "content_type not found in request".
 * @see https://docs.msg91.com/whatsapp (Send message once session started)
 */
const OUTBOUND_BASE = 'https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/'

export interface SendTextInput {
  to: string
  text: string
}

/** Normalize guest number to digits with country code (no +). */
export function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '')
}

/**
 * Send a session text reply after the guest has messaged you (24h window).
 * Uses MSG91 WhatsApp outbound API — not Meta Graph.
 */
export type SendResult =
  | { ok: true; dryRun: boolean; messageId: string | null }
  | { ok: false; error: string }

export async function sendSessionText(input: SendTextInput): Promise<SendResult> {
  const { authkey, from, dryRun } = msg91Env()
  const to = normalizePhone(input.to)
  if (to.length < 10) return { ok: false, error: 'invalid_to' }

  const params = new URLSearchParams({
    content_type: 'text',
    recipient_number: to,
    integrated_number: from,
    text: input.text.slice(0, 4096),
  })
  const url = `${OUTBOUND_BASE}?${params.toString()}`

  if (dryRun) {
    console.log('[msg91] dry run send', url.replace(/text=[^&]+/, 'text=<redacted>'))
    return { ok: true, dryRun: true, messageId: null }
  }

  return postToMsg91(url, { authkey }, undefined, to)
}

/**
 * Session image / video: same endpoint and query-parameter style as text,
 * with a public https `attachment_url` MSG91 fetches (WhatsApp caps: image 5 MB, video 16 MB MP4).
 */
export async function sendSessionMedia(input: { to: string; kind: 'image' | 'video'; url: string; caption?: string }): Promise<SendResult> {
  const { authkey, from, dryRun } = msg91Env()
  const to = normalizePhone(input.to)
  if (to.length < 10) return { ok: false, error: 'invalid_to' }

  const params = new URLSearchParams({
    content_type: input.kind,
    recipient_number: to,
    integrated_number: from,
    attachment_url: input.url,
    ...(input.caption ? { caption: input.caption.slice(0, 1024) } : {}),
  })
  if (dryRun) {
    console.log('[msg91] dry run media send', input.kind, to)
    return { ok: true, dryRun: true, messageId: null }
  }
  return postToMsg91(`${OUTBOUND_BASE}?${params.toString()}`, { authkey }, undefined, to)
}

/** WhatsApp interactive object as documented by MSG91 ("Interactive Wa With Buttons" / "With List"). */
export type Msg91Interactive =
  | {
      type: 'button'
      header?: { type: 'image'; image: { link: string } }
      body: { text: string }
      action: { buttons: { type: 'reply'; reply: { id: string; title: string } }[] }
    }
  | {
      type: 'list'
      body: { text: string }
      action: {
        button: string
        sections: { title?: string; rows: { id: string; title: string; description?: string }[] }[]
      }
    }

/**
 * Session interactive message (reply buttons or list). Unlike plain text, MSG91
 * documents these with a JSON body on the same outbound endpoint.
 * @see https://docs.msg91.com/whatsapp/interactive-whatsapp-buttons
 * @see https://docs.msg91.com/whatsapp/interactive-whatsapp-list
 */
export async function sendSessionInteractive(input: { to: string; interactive: Msg91Interactive }): Promise<SendResult> {
  const { authkey, from, dryRun } = msg91Env()
  const to = normalizePhone(input.to)
  if (to.length < 10) return { ok: false, error: 'invalid_to' }

  if (dryRun) {
    console.log('[msg91] dry run interactive send', input.interactive.type, to)
    return { ok: true, dryRun: true, messageId: null }
  }

  const body = JSON.stringify({
    recipient_number: to,
    integrated_number: from,
    content_type: 'interactive',
    interactive: input.interactive,
  })
  return postToMsg91(OUTBOUND_BASE, { authkey }, body, to)
}

export const SEND_TIMEOUT_MS = 15_000
/** Statuses where MSG91 / its gateway did not accept the message, so one retry cannot duplicate it. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])
const RETRY_DELAY_MS = 1_000

/** Connection failures where the request never reached MSG91, so a retry cannot duplicate it. */
const PRE_SEND_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'])

function errorCode(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause
  const code = cause?.code ?? (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * True when MSG91 may have accepted the message even though we saw a
 * failure (timeout, connection dropped mid-request, 5xx). Sending again —
 * including a plain-text fallback — could give the guest a duplicate.
 */
export function isAmbiguousSendError(error: string): boolean {
  return error === 'msg91_timeout' || error === 'msg91_network_error' || /^msg91_5\d\d\b/.test(error)
}

/**
 * POST with a timeout and at most one retry, only when MSG91 provably did
 * not get the message (connection refused / DNS failure, 429, gateway
 * 502–504). Timeouts, dropped connections and 500s are never retried: MSG91
 * may already have queued the message. Node's fetch reuses keep-alive
 * connections across sends.
 */
async function postToMsg91(url: string, auth: { authkey: string }, body: string | undefined, to: string): Promise<SendResult> {
  const init = (): RequestInit => ({
    method: 'POST',
    headers: { accept: 'application/json', authkey: auth.authkey, 'content-type': 'application/json' },
    ...(body !== undefined ? { body } : {}),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  })
  for (let attempt = 1; ; attempt++) {
    let res: Response
    try {
      res = await fetch(url, init())
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      if (timedOut) {
        console.error('[msg91] send timed out', JSON.stringify({ to, attempt }))
        return { ok: false, error: 'msg91_timeout' }
      }
      const code = errorCode(err)
      if (attempt < 2 && code && PRE_SEND_ERROR_CODES.has(code)) {
        console.warn('[msg91] connection failed before send, retrying', JSON.stringify({ to, attempt, code }))
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
        continue
      }
      console.error('[msg91] network error', JSON.stringify({ to, attempt, code, error: String(err).slice(0, 200) }))
      return { ok: false, error: code && PRE_SEND_ERROR_CODES.has(code) ? 'msg91_unreachable' : 'msg91_network_error' }
    }
    if (RETRYABLE_STATUS.has(res.status) && attempt < 2) {
      console.warn('[msg91] retryable status, retrying', JSON.stringify({ to, attempt, status: res.status }))
      await res.text().catch(() => '')
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
      continue
    }
    return readSendResponse(res, to)
  }
}

async function readSendResponse(res: Response, to: string): Promise<SendResult> {
  const text = await res.text()
  if (!res.ok) {
    const detail = text.slice(0, 500)
    console.error('[msg91] send failed', res.status, detail)
    return { ok: false, error: `msg91_${res.status}:${detail.slice(0, 120)}` }
  }
  // MSG91 can answer HTTP 200 with { hasError: true } in the body.
  let messageId: string | null = null
  try {
    const j = JSON.parse(text) as {
      hasError?: boolean
      status?: string
      errors?: unknown
      data?: { message_uuid?: string } | null
    }
    if (j.hasError === true || j.status === 'fail') {
      console.error('[msg91] send rejected', text.slice(0, 500))
      return { ok: false, error: `msg91_rejected:${JSON.stringify(j.errors ?? j).slice(0, 120)}` }
    }
    messageId = j.data?.message_uuid ?? null
  } catch {
    // non-JSON success body
  }
  console.log('[msg91] send accepted', to, messageId ?? text.slice(0, 200))
  return { ok: true, dryRun: false, messageId }
}
