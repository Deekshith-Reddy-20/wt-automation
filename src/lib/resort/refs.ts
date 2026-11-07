import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils'

// Crockford base32 without I, L, O, U — readable over the phone.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function randomCode(length: number): string {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}

/** e.g. VF-261227-7K3Q9 (IST creation date + random suffix). */
export function generateBookingRef(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + 330 * 60_000).toISOString()
  const ymd = ist.slice(2, 4) + ist.slice(5, 7) + ist.slice(8, 10)
  return `VF-${ymd}-${randomCode(5)}`
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Guest booking-link token: 256 bits, URL-safe; only its hash is stored. */
export function generateAccessToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashToken(token) }
}

export function tokenMatches(token: string, storedHash: string | null | undefined): boolean {
  if (!token || !storedHash) return false
  const a = Buffer.from(hashToken(token), 'hex')
  const b = Buffer.from(storedHash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Normalise a phone number to E.164 (+919876543210). Accepts an explicit
 * international number, or an Indian mobile number in national form
 * (98765 43210, 09876543210, 919876543210). Returns null otherwise.
 */
export function normalizePhoneE164(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (trimmed.startsWith('+')) {
    const digits = parseInternationalPhone(trimmed)
    return digits ? `+${digits}` : null
  }
  const digits = trimmed.replace(/[\s().-]/g, '')
  if (!/^\d+$/.test(digits)) return null
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`
  if (/^0[6-9]\d{9}$/.test(digits)) return `+91${digits.slice(1)}`
  if (/^91[6-9]\d{9}$/.test(digits)) return `+${digits}`
  return null
}

/** WhatsApp sends the sender's number as digits with country code. */
export function waIdToE164(waId: string | null | undefined): string | null {
  if (!waId) return null
  const digits = waId.replace(/\D/g, '')
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null
}

/** "+91 98••• ••210" — enough for staff to recognise, not to harvest. */
export function maskPhone(e164: string | null | undefined): string {
  if (!e164) return ''
  if (e164.length < 8) return '••••'
  return `${e164.slice(0, 5)}••• ••${e164.slice(-3)}`
}
