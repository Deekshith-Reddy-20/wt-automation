import { describe, expect, it } from 'vitest'
import { bookingActionSchema } from './admin-actions'

describe('record_payment action schema', () => {
  it('accepts a verified UPI payment and defaults the purpose to advance', () => {
    const r = bookingActionSchema.safeParse({ action: 'record_payment', amount_inr: 5000, method: 'upi', reference: 'UTR123456' })
    expect(r.success && r.data).toMatchObject({ action: 'record_payment', purpose: 'advance' })
  })

  it.each([
    { amount_inr: 0, method: 'upi' },
    { amount_inr: -10, method: 'upi' },
    { amount_inr: 100, method: 'crypto' },
    { amount_inr: 100, method: 'upi', reference: 'x' },
  ])('rejects %o', (body) => {
    expect(bookingActionSchema.safeParse({ action: 'record_payment', ...body }).success).toBe(false)
  })
})
