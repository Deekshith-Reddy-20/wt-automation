import { NextResponse } from 'next/server'
import type { z } from 'zod'
import { checkRateLimit, getClientIp, rateLimitResponse, type RateLimitOptions } from '@/lib/rate-limit'
import { isSupabaseServiceConfigured } from '@/lib/supabase/service-env'

/** Small JSON bodies only — enquiry forms are a few hundred bytes. */
const MAX_BODY_BYTES = 16 * 1024

export function jsonError(status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, code, ...extra }, { status })
}

function allowedOrigins(request: Request): Set<string> {
  const out = new Set<string>()
  try {
    out.add(new URL(request.url).origin)
  } catch {
    /* ignore */
  }
  const site = process.env.NEXT_PUBLIC_SITE_URL
  if (site) {
    try {
      out.add(new URL(site).origin)
    } catch {
      /* ignore */
    }
  }
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  const proto = request.headers.get('x-forwarded-proto') ?? 'https'
  if (host) {
    out.add(`${proto}://${host}`)
    out.add(`https://${host}`)
  }
  return out
}

/**
 * CSRF defence for cookie-less public POSTs: browsers always send Origin
 * on cross-site POSTs, so a foreign Origin is rejected. Requests without
 * an Origin header (server-to-server, curl) are allowed through to the
 * rate limiter and validation like any other client.
 */
export function originAllowed(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true
  return allowedOrigins(request).has(origin)
}

export function rateLimit(request: Request, bucket: string, opts: RateLimitOptions): NextResponse | null {
  const result = checkRateLimit(`resort:${bucket}:${getClientIp(request)}`, opts)
  return result.success ? null : rateLimitResponse(result)
}

/**
 * Parse and validate a public JSON POST. Returns either the typed body or
 * a ready-to-return error response.
 */
export async function readPublicJson<S extends z.ZodType>(
  request: Request,
  schema: S,
  limit: { bucket: string; opts: RateLimitOptions },
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: NextResponse }> {
  if (!originAllowed(request)) {
    return { ok: false, response: jsonError(403, 'forbidden_origin', 'Cross-site requests are not allowed.') }
  }
  const limited = rateLimit(request, limit.bucket, limit.opts)
  if (limited) return { ok: false, response: limited }

  const type = request.headers.get('content-type') ?? ''
  if (!type.toLowerCase().startsWith('application/json')) {
    return { ok: false, response: jsonError(415, 'unsupported_media_type', 'Send JSON.') }
  }
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) {
    return { ok: false, response: jsonError(413, 'payload_too_large', 'Request is too large.') }
  }
  let raw: string
  try {
    raw = await request.text()
  } catch {
    return { ok: false, response: jsonError(400, 'invalid_body', 'Could not read the request.') }
  }
  if (raw.length > MAX_BODY_BYTES) {
    return { ok: false, response: jsonError(413, 'payload_too_large', 'Request is too large.') }
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return { ok: false, response: jsonError(400, 'invalid_json', 'Request body is not valid JSON.') }
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return {
      ok: false,
      response: jsonError(422, 'validation_failed', 'Some details are missing or invalid.', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      }),
    }
  }
  return { ok: true, data: parsed.data }
}

/** True when the server has what it needs to talk to the database. */
export function databaseConfigured(): boolean {
  return isSupabaseServiceConfigured()
}
