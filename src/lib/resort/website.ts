// Base URL of a guest-facing V-Farms website that serves /booking/<ref>
// (online advance payment) and /gallery. This app has no such pages, so
// RESORT_WEBSITE_URL stays unset: the bot sends no links and bookings go
// to staff confirmation instead of waiting for an online payment.
// NEXT_PUBLIC_SITE_URL is the CRM's own URL and is not used here.
export function resortWebsiteUrl(): string | null {
  const raw = process.env.RESORT_WEBSITE_URL?.trim().replace(/\/+$/, '')
  if (!raw) return null
  return /^https:\/\//.test(raw) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(raw) ? raw : null
}
