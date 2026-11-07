import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Minimal Razorpay REST client (server only). Keys come from server
 * environment variables and are never sent to the browser — the
 * checkout only ever receives the public key id and an order id.
 */

const API = 'https://api.razorpay.com/v1'
const TIMEOUT_MS = 15_000

export class RazorpayError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string | null = null,
  ) {
    super(message)
    this.name = 'RazorpayError'
  }
}

export interface RazorpayCredentials {
  keyId: string
  keySecret: string
}

export function razorpayCredentials(): RazorpayCredentials | null {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim()
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim()
  return keyId && keySecret ? { keyId, keySecret } : null
}

export function razorpayWebhookSecret(): string | null {
  return process.env.RAZORPAY_WEBHOOK_SECRET?.trim() || null
}

function hmacHex(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex')
}

function safeEqualHex(expected: string, actual: string): boolean {
  if (!/^[0-9a-f]+$/i.test(actual) || actual.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual.toLowerCase(), 'hex'))
}

/** Checkout handler signature: HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
export function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string, keySecret: string): boolean {
  if (!orderId || !paymentId || !signature) return false
  return safeEqualHex(hmacHex(keySecret, `${orderId}|${paymentId}`), signature)
}

/** Webhook signature: HMAC_SHA256(raw request body, webhook secret). */
export function verifyWebhookSignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false
  return safeEqualHex(hmacHex(secret, rawBody), signature)
}

async function call<T>(creds: RazorpayCredentials, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64')}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const err = (json.error ?? {}) as { description?: string; code?: string }
      throw new RazorpayError(err.description ?? `Razorpay request failed (${res.status})`, res.status, err.code ?? null)
    }
    return json as T
  } catch (err) {
    if (err instanceof RazorpayError) throw err
    throw new RazorpayError(err instanceof Error && err.name === 'AbortError' ? 'Razorpay timed out' : 'Could not reach Razorpay', 0)
  } finally {
    clearTimeout(timer)
  }
}

export interface RazorpayOrder {
  id: string
  amount: number
  currency: string
  status: string
  receipt: string | null
}

export function createOrder(
  creds: RazorpayCredentials,
  input: { amountPaise: number; receipt: string; notes: Record<string, string> },
): Promise<RazorpayOrder> {
  if (!Number.isInteger(input.amountPaise) || input.amountPaise < 100) {
    throw new RazorpayError('Amount must be at least ₹1', 400)
  }
  return call(creds, 'POST', '/orders', {
    amount: input.amountPaise,
    currency: 'INR',
    receipt: input.receipt.slice(0, 40),
    notes: input.notes,
  })
}

export interface RazorpayPayment {
  id: string
  order_id: string | null
  amount: number
  currency: string
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed'
  method: string | null
  error_code?: string | null
  error_description?: string | null
}

export function fetchPayment(creds: RazorpayCredentials, paymentId: string): Promise<RazorpayPayment> {
  if (!/^pay_[A-Za-z0-9]+$/.test(paymentId)) throw new RazorpayError('Invalid payment id', 400)
  return call(creds, 'GET', `/payments/${paymentId}`)
}

export interface RazorpayRefund {
  id: string
  payment_id: string
  amount: number
  status: 'pending' | 'processed' | 'failed'
}

export function createRefund(
  creds: RazorpayCredentials,
  paymentId: string,
  input: { amountPaise: number; notes: Record<string, string>; receipt?: string },
): Promise<RazorpayRefund> {
  if (!/^pay_[A-Za-z0-9]+$/.test(paymentId)) throw new RazorpayError('Invalid payment id', 400)
  return call(creds, 'POST', `/payments/${paymentId}/refund`, {
    amount: input.amountPaise,
    notes: input.notes,
    ...(input.receipt ? { receipt: input.receipt.slice(0, 40) } : {}),
  })
}
