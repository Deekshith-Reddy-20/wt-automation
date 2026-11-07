import { createHmac } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findAlternativeStays, nightStatuses } from './availability'
import { maskSecret, envIntegrationStatus } from './integrations'
import { advanceLeadStage, canTransition, maxPriority, scoreLeadPriority } from './lifecycle'
import { razorpayVerifySchema } from './schemas'
import { verifyCheckoutSignature, verifyWebhookSignature } from './razorpay'
import { generateAccessToken, generateBookingRef, hashToken, normalizePhoneE164, tokenMatches, waIdToE164 } from './refs'
import { canManageRefunds, canManageReservations, canManageResortSettings } from '@/lib/auth/roles'

describe('Razorpay signatures', () => {
  const secret = 'test_secret_not_real'
  it('accepts a correct checkout signature and rejects tampering', () => {
    const sig = createHmac('sha256', secret).update('order_ABC123|pay_XYZ789').digest('hex')
    expect(verifyCheckoutSignature('order_ABC123', 'pay_XYZ789', sig, secret)).toBe(true)
    expect(verifyCheckoutSignature('order_ABC123', 'pay_OTHER1', sig, secret)).toBe(false)
    expect(verifyCheckoutSignature('order_ABC123', 'pay_XYZ789', sig, 'wrong')).toBe(false)
    expect(verifyCheckoutSignature('order_ABC123', 'pay_XYZ789', 'zz', secret)).toBe(false)
    expect(verifyCheckoutSignature('order_ABC123', 'pay_XYZ789', '', secret)).toBe(false)
  })
  it('verifies the webhook signature over the exact raw body', () => {
    const body = '{"event":"payment.captured","payload":{}}'
    const sig = createHmac('sha256', secret).update(body).digest('hex')
    expect(verifyWebhookSignature(body, sig, secret)).toBe(true)
    expect(verifyWebhookSignature(body + ' ', sig, secret)).toBe(false)
    expect(verifyWebhookSignature(body, null, secret)).toBe(false)
  })
  it('validates the verify payload shape', () => {
    const ok = razorpayVerifySchema.safeParse({
      ref: 'VF-261027-7K3Q9',
      token: 'x'.repeat(43),
      razorpay_order_id: 'order_ABC123',
      razorpay_payment_id: 'pay_XYZ789',
      razorpay_signature: 'a'.repeat(64),
    })
    expect(ok.success).toBe(true)
    const bad = razorpayVerifySchema.safeParse({ ref: 'VF-261027-ILOU0', token: 'short', razorpay_order_id: 'x', razorpay_payment_id: 'y', razorpay_signature: 'z' })
    expect(bad.success).toBe(false)
  })
})

describe('booking references and guest links', () => {
  it('generates readable refs dated in IST', () => {
    const ref = generateBookingRef(new Date('2026-10-27T20:00:00Z'))
    expect(ref).toMatch(/^VF-261028-[0-9A-HJKMNP-TV-Z]{5}$/)
  })
  it('stores only a hash of the guest token and compares in constant time', () => {
    const { token, hash } = generateAccessToken()
    expect(token.length).toBeGreaterThanOrEqual(43)
    expect(hash).toBe(hashToken(token))
    expect(hash).not.toContain(token)
    expect(tokenMatches(token, hash)).toBe(true)
    expect(tokenMatches(token + 'x', hash)).toBe(false)
    expect(tokenMatches(token, null)).toBe(false)
  })
  it('normalises Indian and international phone numbers', () => {
    expect(normalizePhoneE164('98765 43210')).toBe('+919876543210')
    expect(normalizePhoneE164('09876543210')).toBe('+919876543210')
    expect(normalizePhoneE164('12345')).toBeNull()
    expect(waIdToE164('919876543210')).toBe('+919876543210')
  })
})

describe('lifecycle rules', () => {
  it('only allows defined transitions', () => {
    expect(canTransition('payment_pending', 'payment_verified')).toBe(true)
    expect(canTransition('enquiry', 'checked_in')).toBe(false)
    expect(canTransition('cancelled', 'confirmed')).toBe(false)
    expect(canTransition('completed', 'cancelled')).toBe(false)
  })
  it('never moves a lead backwards', () => {
    expect(advanceLeadStage('quote_sent', 'contacted')).toBe('quote_sent')
    expect(advanceLeadStage('new', 'qualified')).toBe('qualified')
    expect(maxPriority('warm', 'hot')).toBe('hot')
  })
  it('scores priority from signals', () => {
    const none = { has_dates: false, dates_within_days: null, requested_quote: false, requested_booking: false, requested_human: false, availability_confirmed: false }
    expect(scoreLeadPriority({ ...none, requested_booking: true })).toBe('hot')
    expect(scoreLeadPriority(none)).not.toBe('hot')
  })
})

describe('role mapping', () => {
  it('maps owner/admin to resort admin and agent to reservation manager', () => {
    expect(canManageResortSettings('admin')).toBe(true)
    expect(canManageResortSettings('agent')).toBe(false)
    expect(canManageReservations('agent')).toBe(true)
    expect(canManageReservations('viewer')).toBe(false)
    expect(canManageRefunds('owner')).toBe(true)
    expect(canManageRefunds('agent')).toBe(false)
  })
})

describe('availability helpers', () => {
  const times = { check_in_time: '14:00', check_out_time: '11:00' }
  // Booked 2026-11-10 14:00 → 2026-11-12 11:00 IST
  const blocks = [{ starts_at: '2026-11-10T08:30:00Z', ends_at: '2026-11-12T05:30:00Z' }]
  it('marks booked and past nights unavailable', () => {
    const nights = nightStatuses(blocks, '2026-11-08', 6, times, '2026-11-09')
    expect(nights.map((n) => n.available)).toEqual([false, true, false, false, true, true])
  })
  it('suggests only free alternatives from the calendar it was given', () => {
    const alts = findAlternativeStays(blocks, '2026-11-10', 2, times, { today: '2026-11-01', windowDays: 3 })
    for (const a of alts) {
      expect(a.check_in >= '2026-11-12' || a.check_out <= '2026-11-10').toBe(true)
    }
    expect(alts.length).toBeGreaterThan(0)
  })
})

describe('secrets never reach the browser', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('masks identifiers and reports secrets only as configured', () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_ABCDEFGH1234'
    process.env.RAZORPAY_KEY_SECRET = 'super-secret-value'
    process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec-value'
    const status = envIntegrationStatus()
    const serialised = JSON.stringify(status)
    expect(serialised).not.toContain('super-secret-value')
    expect(serialised).not.toContain('whsec-value')
    expect(serialised).not.toContain('ABCDEFGH1234')
    expect(status.razorpay.key_id).toBe('rzp_test_••••••••1234')
    expect(status.razorpay.mode).toBe('test')
    expect(status.razorpay.key_secret_configured).toBe(true)
    expect(maskSecret(null)).toBeNull()
    expect(maskSecret('abc')).toBe('•••')
  })

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name)) out.push(p)
    }
    return out
  }

  it('no client component reads a server secret or imports a server-only module', () => {
    const root = join(process.cwd(), 'src')
    const offenders: string[] = []
    const secretEnv = /process\.env\.(SUPABASE_SERVICE_ROLE_KEY|RAZORPAY_KEY_SECRET|RAZORPAY_WEBHOOK_SECRET|META_APP_SECRET|ENCRYPTION_KEY|CRON_SECRET|WHATSAPP_VERIFY_TOKEN|MSG91_AUTHKEY|MSG91_WEBHOOK_SECRET|TICKET_SIGNING_SECRET)/
    const serverImports = /from ['"](@\/lib\/|\.\.?\/)*(supabase\/service-env|(flows|automations|ai)\/admin-client|msg91\/(client|env|provider|inbound-pipeline)|resort\/(razorpay|payments|admin-actions|guest-messages|bookings|leads|notify|ticket|bot\/runtime))['"]/
    for (const file of walk(root)) {
      const src = readFileSync(file, 'utf8')
      if (!/^\s*['"]use client['"]/.test(src)) continue
      if (secretEnv.test(src) || serverImports.test(src)) offenders.push(file.replace(root, 'src'))
    }
    expect(offenders).toEqual([])
  })

  it('.env.example contains placeholders only', () => {
    let text = ''
    try {
      text = readFileSync(join(process.cwd(), '.env.example'), 'utf8')
    } catch {
      return
    }
    expect(text).not.toMatch(/rzp_(live|test)_[A-Za-z0-9]{8,}/)
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\./) // JWT-shaped keys
    expect(text).not.toMatch(/EAA[A-Za-z0-9]{20,}/) // Meta access tokens
  })
})
