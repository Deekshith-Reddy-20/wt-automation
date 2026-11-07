import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse, after } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { applyDeliveryStatus } from '@/lib/msg91/delivery-status'
import { Msg91ConfigError, msg91Env } from '@/lib/msg91/env'
import { parseMsg91Webhook } from '@/lib/msg91/inbound'
import { ingestMsg91Inbound, replyToMsg91Inbound } from '@/lib/msg91/inbound-pipeline'
import { createTrace } from '@/lib/msg91/trace'
import { recordMsg91WebhookPost } from '@/lib/msg91/webhook-health'

export const dynamic = 'force-dynamic'

/**
 * MSG91 does not sign webhooks; the only check it supports is a custom header
 * you add in the webhook configuration. Compared in constant time.
 */
function secretMatches(received: string | null, expected: string): boolean {
  if (!received) return false
  const a = createHash('sha256').update(received).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}
// The after() callback (resort bot + MSG91 replies) runs within this budget.
export const maxDuration = 60

/**
 * MSG91 Dashboard → WhatsApp → Webhook (New):
 *   - On Inbound Request Received → guest message → inbox + resort bot
 *   - On Outbound Request Received (optional) → delivery reports → message status
 */
export async function POST(request: Request) {
  try {
    const { webhookSecret } = msg91Env()
    if (webhookSecret && !secretMatches(request.headers.get('x-msg91-webhook-secret'), webhookSecret)) {
      recordMsg91WebhookPost('unauthorized')
      console.warn(JSON.stringify({ msg91: 'WEBHOOK_REJECTED', reason: 'secret_mismatch' }))
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  } catch (err) {
    if (err instanceof Msg91ConfigError) {
      return NextResponse.json({ error: err.message }, { status: 503 })
    }
    throw err
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    recordMsg91WebhookPost('invalid_json')
    console.warn(JSON.stringify({ msg91: 'PROCESSING_FAILED', reason: 'invalid_json' }))
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = parseMsg91Webhook(body)
  const raw = (body ?? {}) as Record<string, unknown>
  const providerId = typeof raw.uuid === 'string' ? raw.uuid : typeof raw.requestId === 'string' ? raw.requestId : undefined
  const trace = createTrace()
  trace.log('WEBHOOK_RECEIVED', {
    providerId,
    eventName: typeof raw.eventName === 'string' ? raw.eventName : undefined,
    direction: raw.direction === undefined ? undefined : String(raw.direction),
    contentType: typeof raw.contentType === 'string' ? raw.contentType : undefined,
  })

  if (parsed.kind === 'ignore') {
    trace.log('PAYLOAD_PARSED', { result: 'ignored', reason: parsed.reason })
    recordMsg91WebhookPost('skipped')
    return NextResponse.json({ ok: true, skipped: parsed.reason })
  }

  recordMsg91WebhookPost('accepted')

  if (parsed.kind === 'status') {
    trace.log('PAYLOAD_PARSED', { result: 'delivery_report', requestId: parsed.requestId, status: parsed.status })
    after(async () => {
      try {
        const updated = await applyDeliveryStatus(supabaseAdmin(), parsed.requestId, parsed.status)
        if (parsed.status === 'failed') trace.log('PROCESSING_FAILED', { stage: 'delivery', requestId: parsed.requestId, reason: parsed.reason, updated })
        else trace.log('DELIVERY_CONFIRMED', { requestId: parsed.requestId, status: parsed.status, updated })
      } catch (err) {
        trace.log('PROCESSING_FAILED', { stage: 'delivery_status', requestId: parsed.requestId, error: err instanceof Error ? err.message : String(err) })
      }
    })
    return NextResponse.json({ ok: true, accepted: true })
  }

  trace.log('PAYLOAD_PARSED', {
    result: 'inbound',
    customer: parsed.customerNumber,
    messageId: parsed.messageId,
    replyId: parsed.replyId,
    unsupported: parsed.unsupported,
    textLength: parsed.text.length,
  })
  trace.mark('validation_completed_ms')

  // MSG91 waits at most 8s, then redelivers. The message is written to the inbox
  // before we answer, so a crash later can never lose it: a failed write answers
  // 5xx and MSG91 retries; redeliveries are dropped by the (conversation_id,
  // message_id) unique index. The reply runs after the response.
  let ingest: Awaited<ReturnType<typeof ingestMsg91Inbound>>
  try {
    ingest = await ingestMsg91Inbound(parsed, trace)
  } catch (err) {
    ingest = { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
  if (ingest.status === 'failed') {
    trace.log('PROCESSING_FAILED', { stage: 'ingest', reason: ingest.reason })
    return NextResponse.json({ error: 'Could not save the message; please retry.' }, { status: 503 })
  }
  if (ingest.status === 'duplicate') {
    console.log(JSON.stringify({ msg91: 'OUTCOME', cid: trace.cid, status: 'duplicate' }))
    return NextResponse.json({ ok: true, duplicate: true })
  }

  const { ingested } = ingest
  after(async () => {
    try {
      const outcome = await replyToMsg91Inbound(ingested, trace)
      if (outcome.status === 'failed') trace.log('PROCESSING_FAILED', { stage: 'pipeline', ...outcome })
      else console.log(JSON.stringify({ msg91: 'OUTCOME', cid: trace.cid, ...outcome }))
    } catch (err) {
      trace.log('PROCESSING_FAILED', { stage: 'pipeline', error: err instanceof Error ? err.message : String(err) })
    } finally {
      trace.mark('total_application_processing_ms')
      trace.log('TIMING', trace.timings())
    }
  })

  return NextResponse.json({ ok: true, accepted: true })
}

export async function GET() {
  return NextResponse.json({
    service: 'V-Farms MSG91 WhatsApp webhook',
    provider: 'msg91',
    note: 'Configure POST in MSG91 → WhatsApp → Webhook (New) → On Inbound Request Received',
    path: '/api/msg91/webhook',
  })
}
