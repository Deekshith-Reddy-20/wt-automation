/**
 * Short-lived in-process cache for read-mostly configuration (account,
 * property settings, pricing tables, automation flags, amenities) on the
 * WhatsApp hot path. Never use it for availability, bookings, holds or
 * conversation state: those are always read from the database.
 *
 * Concurrent misses share one in-flight load. Failed loads are not cached.
 * Disabled under Vitest so tests see every query they set up.
 */
interface Entry {
  value: Promise<unknown>
  expires: number
  refreshing?: boolean
}

/** In an entry's last minute, a read starts a background reload and still gets the cached value at once. */
const REFRESH_AHEAD_MS = 60_000

const store = new Map<string, Entry>()
const enabled = () => !process.env.VITEST || process.env.RESORT_CONFIG_CACHE === 'on'
export const configCacheEnabled = enabled

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  if (!enabled() || ttlMs <= 0) return load()
  const now = Date.now()
  const hit = store.get(key)
  if (hit && hit.expires > now) {
    if (!hit.refreshing && ttlMs > REFRESH_AHEAD_MS && hit.expires - now < REFRESH_AHEAD_MS) {
      hit.refreshing = true
      const next = load()
      next.then(
        () => {
          if (store.get(key) === hit) store.set(key, { value: next, expires: Date.now() + ttlMs })
        },
        () => {
          hit.refreshing = false
        },
      )
    }
    return hit.value as Promise<T>
  }
  const value = load()
  store.set(key, { value, expires: now + ttlMs })
  value.catch(() => {
    if (store.get(key)?.value === value) store.delete(key)
  })
  return value
}

/** Drop cached config for one account (after an admin edit), or everything. */
export function invalidateConfigCache(accountId?: string): void {
  if (!accountId) {
    store.clear()
    return
  }
  for (const key of store.keys()) if (key.includes(accountId)) store.delete(key)
}

/**
 * Upper bound for a settings edit made outside the admin routes (which
 * invalidate at once) to reach the bot. warmup.ts refreshes before expiry.
 */
export const CONFIG_TTL_MS = 5 * 60_000
/** The MSG91 number's account mapping changes only when env changes. */
export const ACCOUNT_TTL_MS = 5 * 60_000
