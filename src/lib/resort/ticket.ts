import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Booking tickets are PNGs served from a public, signed URL so MSG91 / WhatsApp
 * can fetch them as an image header. The signature covers only the booking id;
 * the route itself refuses anything that is not a confirmed booking.
 */
function signingKey(): string | null {
  const dedicated = process.env.TICKET_SIGNING_SECRET?.trim()
  if (dedicated) return dedicated
  const fallback = process.env.ENCRYPTION_KEY?.trim()
  return fallback ? `ticket:${fallback}` : null
}

export function signTicket(bookingId: string): string | null {
  const key = signingKey()
  if (!key) return null
  return createHmac('sha256', key).update(`booking-ticket:${bookingId}`).digest('base64url')
}

export function verifyTicket(bookingId: string, sig: string | null): boolean {
  if (!sig) return false
  const expected = signTicket(bookingId)
  if (!expected) return false
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** WhatsApp only fetches media over public https; localhost URLs are useless to it. */
export function ticketBaseUrl(): string | null {
  const raw = (process.env.TICKET_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || '').trim().replace(/\/+$/, '')
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1') return null
    return raw
  } catch {
    return null
  }
}

export function ticketUrl(bookingId: string): string | null {
  const base = ticketBaseUrl()
  const sig = signTicket(bookingId)
  if (!base || !sig) return null
  return `${base}/api/resort/ticket/${encodeURIComponent(bookingId)}?sig=${sig}`
}
