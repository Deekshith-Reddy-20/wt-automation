import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

export type TraceStage =
  | 'WEBHOOK_RECEIVED'
  | 'PAYLOAD_PARSED'
  | 'CUSTOMER_IDENTIFIED'
  | 'MESSAGE_SAVED'
  | 'BOT_PROCESSING_STARTED'
  | 'BOT_RESPONSE_GENERATED'
  | 'BOT_SKIPPED'
  | 'MSG91_SEND_REQUESTED'
  | 'MSG91_API_ACCEPTED'
  | 'DELIVERY_CONFIRMED'
  | 'PROCESSING_FAILED'
  | 'TIMING'

/** Milliseconds since the webhook was received, on the monotonic clock. Only the first mark of each name is kept. */
export type TimingMark =
  | 'validation_completed_ms'
  | 'conversation_lookup_ms'
  | 'message_saved_ms'
  | 'bot_decision_ms'
  | 'msg91_request_started_ms'
  | 'msg91_response_received_ms'
  | 'total_application_processing_ms'

export interface Trace {
  readonly cid: string
  log(stage: TraceStage, detail?: Record<string, unknown>): void
  mark(name: TimingMark): void
  timings(): Partial<Record<TimingMark | 'webhook_received_ms', number>>
}

export function maskNumber(n: string): string {
  const digits = n.replace(/\D/g, '')
  return digits.length > 4 ? `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}` : digits
}

const SECRET_KEY = /auth|token|secret|password|key/i
const PHONE_KEY = /^(to|from|phone|customer|customerNumber|recipient)$/i

function clean(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(detail)) {
    if (v === undefined || SECRET_KEY.test(k)) continue
    out[k] = typeof v === 'string' && PHONE_KEY.test(k) ? maskNumber(v) : v
  }
  return out
}

const round = (ms: number) => Math.round(ms * 10) / 10

/**
 * One JSON line per pipeline stage, keyed by a correlation id, so a guest
 * message can be followed from MSG91's webhook to MSG91's send API and
 * matched against MSG91's own logs. Each line carries `ms` since receipt
 * (monotonic clock). Phone numbers are masked; anything that looks like a
 * credential is dropped.
 */
export function createTrace(cid: string = randomUUID()): Trace {
  const start = performance.now()
  const marks: Partial<Record<TimingMark, number>> = {}
  return {
    cid,
    log(stage, detail = {}) {
      const line = JSON.stringify({ msg91: stage, cid, at: new Date().toISOString(), ms: round(performance.now() - start), ...clean(detail) })
      if (stage === 'PROCESSING_FAILED') console.error(line)
      else console.log(line)
    },
    mark(name) {
      if (marks[name] === undefined) marks[name] = round(performance.now() - start)
    },
    timings() {
      return { webhook_received_ms: 0, ...marks }
    },
  }
}

export const noopTrace: Trace = { cid: 'none', log() {}, mark() {}, timings: () => ({}) }
