import { z } from 'zod'
import { EVENT_TYPES } from './types'
import { isIsoDate, normalizeTime } from './time'
import { normalizePhoneE164 } from './refs'

const isoDate = z.string().refine(isIsoDate, 'Use a valid date (YYYY-MM-DD).')
const time = z
  .string()
  .transform((v, ctx) => {
    const t = normalizeTime(v)
    if (!t) {
      ctx.addIssue({ code: 'custom', message: 'Use a valid time (HH:MM).' })
      return z.NEVER
    }
    return t
  })
const phone = z
  .string()
  .max(32)
  .transform((v, ctx) => {
    const e164 = normalizePhoneE164(v)
    if (!e164) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid mobile number (with country code if outside India).' })
      return z.NEVER
    }
    return e164
  })
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => v.trim() || null)
    .nullish()

const contactFields = {
  name: z.string().trim().min(2, 'Please enter your name.').max(100),
  phone,
  email: z.email().max(200).nullish().or(z.literal('').transform(() => null)),
  special_requirements: optionalText(1000),
  /** Explicit permission to reply on WhatsApp about this enquiry (service messages only). */
  whatsapp_consent: z.boolean().default(false),
  idempotency_key: z.uuid().nullish(),
  /** Campaign attribution from the landing link (?src=qr_code …). */
  source: z.enum(['website', 'qr_code', 'instagram', 'facebook_ads', 'referral']).default('website'),
  /** Honeypot — humans never see this field. */
  website: z.string().max(0, 'Invalid submission.').optional(),
}

export const stayRequestSchema = z.object({
  check_in: isoDate,
  check_out: isoDate,
  adults: z.number().int().min(1).max(200),
  children: z.number().int().min(0).max(200).default(0),
  children_ages: z.array(z.number().int().min(0).max(17)).max(200).nullish(),
  addon_ids: z.array(z.uuid()).max(20).optional(),
})

export const eventRequestSchema = z.object({
  event_type: z.enum(EVENT_TYPES),
  event_date: isoDate,
  start_time: time,
  end_time: time,
  guest_count: z.number().int().min(1).max(5000),
  addon_ids: z.array(z.uuid()).max(20).optional(),
})

export const stayEnquirySchema = stayRequestSchema.extend({
  type: z.literal('stay'),
  purpose: optionalText(200),
  ...contactFields,
})

export const eventEnquirySchema = eventRequestSchema.extend({
  type: z.literal('event'),
  event_type_other: optionalText(100),
  accommodation_required: z.boolean().nullish(),
  catering_required: z.boolean().nullish(),
  decoration_requirements: optionalText(500),
  budget_inr: z.number().min(0).max(100_000_000).nullish(),
  ...contactFields,
})

export const enquirySchema = z.discriminatedUnion('type', [stayEnquirySchema, eventEnquirySchema])
export type EnquiryBody = z.infer<typeof enquirySchema>

export const quoteSchema = z.discriminatedUnion('type', [
  stayRequestSchema.extend({ type: z.literal('stay') }),
  eventRequestSchema.extend({ type: z.literal('event') }),
])

export const bookingTokenSchema = z.object({
  ref: z.string().regex(/^VF-\d{6}-[0-9A-HJKMNP-TV-Z]{5}$/, 'Invalid booking reference.'),
  token: z.string().min(20).max(200),
})

export const guestCancelSchema = bookingTokenSchema.extend({
  reason: optionalText(500),
})

export const razorpayVerifySchema = bookingTokenSchema.extend({
  razorpay_order_id: z.string().regex(/^order_[A-Za-z0-9]{6,40}$/, 'Invalid order id.'),
  razorpay_payment_id: z.string().regex(/^pay_[A-Za-z0-9]{6,40}$/, 'Invalid payment id.'),
  razorpay_signature: z.string().regex(/^[0-9a-f]{64}$/i, 'Invalid signature.'),
})
