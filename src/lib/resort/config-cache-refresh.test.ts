import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cached, invalidateConfigCache } from './config-cache'

describe('config cache refresh-ahead', () => {
  beforeEach(() => {
    vi.stubEnv('RESORT_CONFIG_CACHE', 'on')
    vi.useFakeTimers()
    invalidateConfigCache()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('serves the cached value immediately and reloads in the background near expiry', async () => {
    let version = 0
    const load = vi.fn(async () => ++version)
    expect(await cached('k', 5 * 60_000, load)).toBe(1)

    vi.advanceTimersByTime(4.5 * 60_000)
    expect(await cached('k', 5 * 60_000, load)).toBe(1)
    expect(load).toHaveBeenCalledTimes(2)
    await vi.runAllTicks()
    await Promise.resolve()

    vi.advanceTimersByTime(60_000)
    expect(await cached('k', 5 * 60_000, load)).toBe(2)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('an admin edit (invalidate) is never overwritten by an older background reload', async () => {
    let release!: (v: string) => void
    const slow = vi.fn(() => new Promise<string>((r) => (release = r)))
    await cached('k2', 5 * 60_000, async () => 'old')
    vi.advanceTimersByTime(4.5 * 60_000)
    await cached('k2', 5 * 60_000, slow)
    invalidateConfigCache()
    expect(await cached('k2', 5 * 60_000, async () => 'edited')).toBe('edited')
    release('stale')
    await Promise.resolve()
    await Promise.resolve()
    expect(await cached('k2', 5 * 60_000, async () => 'unused')).toBe('edited')
  })
})
