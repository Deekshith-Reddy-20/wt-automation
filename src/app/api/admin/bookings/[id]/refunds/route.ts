import { NextResponse } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { adminRoute, parseBody } from '@/lib/resort/admin-http'
import { RefundError, requestRefund } from '@/lib/resort/payments'
import { rupeesToPaise } from '@/lib/resort/pricing'

export const dynamic = 'force-dynamic'

const refundSchema = z
  .object({
    payment_id: z.string().uuid(),
    amount_inr: z.number().positive().max(10_000_000),
    reason: z.string().trim().min(3).max(300),
    mode: z.enum(['razorpay', 'manual']),
  })
  .strict()

/**
 * Refund a captured payment (owners / admins). Razorpay refunds are
 * reported as completed only when Razorpay says so (immediately or via
 * the refund.processed webhook); offline refunds are recorded by the
 * signed-in admin as the authorising operator.
 */
export const POST = adminRoute<{ id: string }>('admin', async ({ accountId, userId }, request, { id }) => {
  const parsed = await parseBody(request, refundSchema)
  if (!parsed.ok) return parsed.response
  try {
    const outcome = await requestRefund(supabaseAdmin(), {
      accountId,
      bookingId: id,
      paymentRowId: parsed.data.payment_id,
      amountPaise: rupeesToPaise(parsed.data.amount_inr),
      reason: parsed.data.reason,
      mode: parsed.data.mode,
      actorUserId: userId,
    })
    return NextResponse.json({ message: outcome.message, status: outcome.status, refund_id: outcome.refundId })
  } catch (err) {
    if (err instanceof RefundError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[resort-admin] refund failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'The refund could not be processed.' }, { status: 500 })
  }
})
