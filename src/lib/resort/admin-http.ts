import { NextResponse } from 'next/server'
import type { z } from 'zod'
import { requireRole, toErrorResponse, type AccountContext } from '@/lib/auth/account'
import type { AccountRole } from '@/lib/auth/roles'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { BookingError, bookingErrorMessage } from './bookings'
import { invalidateConfigCache } from './config-cache'
import { classifyDbError } from './db-errors'
import { originAllowed } from './http'

/**
 * Wrap an admin route: authenticate, enforce the minimum role, reject
 * cross-site writes, rate-limit writes per user, and turn thrown auth
 * errors into the right status. The handler receives the RLS-scoped
 * context — the service-role client must only be used after this check.
 */
export function adminRoute<P = Record<string, never>>(
  minRole: AccountRole,
  handler: (ctx: AccountContext, request: Request, params: P) => Promise<Response>,
) {
  return async (request: Request, routeCtx?: { params: Promise<P> }) => {
    try {
      const isWrite = request.method !== 'GET' && request.method !== 'HEAD'
      if (isWrite && !originAllowed(request)) {
        return NextResponse.json({ error: 'Cross-site requests are not allowed.' }, { status: 403 })
      }
      const ctx = await requireRole(minRole)
      if (isWrite) {
        const rl = checkRateLimit(`resort-admin:${ctx.userId}`, RATE_LIMITS.adminAction)
        if (!rl.success) return rateLimitResponse(rl)
      }
      const params = routeCtx ? await routeCtx.params : ({} as P)
      const response = await handler(ctx, request, params)
      if (isWrite && response.ok) invalidateConfigCache(ctx.accountId)
      return response
    } catch (err) {
      const problem = classifyDbError(err)
      if (problem.code === 'config_missing' || problem.code === 'migration_required' || problem.code === 'connection_failed') {
        console.error(`[resort-admin] ${problem.code}:`, err instanceof Error ? err.message : err)
        return NextResponse.json({ error: problem.message, code: problem.code, missing: problem.missing }, { status: problem.status })
      }
      return toErrorResponse(err)
    }
  }
}

export async function parseBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: NextResponse }> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: 'Validation failed',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        { status: 422 },
      ),
    }
  }
  return { ok: true, data: parsed.data }
}

/** Staff-facing error for a failed booking operation (more detail than guests see). */
export function bookingActionError(err: unknown): NextResponse {
  if (err instanceof BookingError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'estate_unavailable' ? 409 : 422
    const message = err.message && err.message !== err.code ? err.message : bookingErrorMessage(err)
    return NextResponse.json({ error: message, code: err.code }, { status })
  }
  console.error('[resort-admin] booking action failed:', err instanceof Error ? err.message : err)
  return NextResponse.json({ error: 'The action failed. Please try again.' }, { status: 500 })
}

export function dbError(message: string, err: { message?: string; code?: string } | null) {
  console.error(`[resort-admin] ${message}:`, err?.message)
  const problem = classifyDbError(err)
  if (problem.code === 'query_failed') {
    return NextResponse.json({ error: `${message}. The database query failed — try again, and check the server log if it persists.`, code: problem.code }, { status: 500 })
  }
  return NextResponse.json({ error: `${message}: ${problem.message}`, code: problem.code, missing: problem.missing }, { status: problem.status })
}
