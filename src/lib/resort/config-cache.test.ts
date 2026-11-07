import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cached, invalidateConfigCache } from './config-cache'

beforeEach(() => {
  vi.stubEnv('RESORT_CONFIG_CACHE', 'on')
  invalidateConfigCache()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('resort config cache', () => {
  it('serves repeat reads from memory within the TTL', async () => {
    const load = vi.fn(async () => 'v')
    await cached('k:acc', 1000, load)
    await cached('k:acc', 1000, load)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight load between concurrent callers', async () => {
    const load = vi.fn(() => new Promise((r) => setTimeout(() => r('v'), 5)))
    await Promise.all([cached('k:acc', 1000, load), cached('k:acc', 1000, load)])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('reloads after the TTL', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async () => 'v')
    await cached('k:acc', 1000, load)
    vi.advanceTimersByTime(1001)
    await cached('k:acc', 1000, load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed load', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce('v')
    await expect(cached('k:acc', 1000, load)).rejects.toThrow('db down')
    await expect(cached('k:acc', 1000, load)).resolves.toBe('v')
  })

  it('an admin edit for one account drops only that account', async () => {
    const a = vi.fn(async () => 'a')
    const b = vi.fn(async () => 'b')
    await cached('bundle:acc-a', 1000, a)
    await cached('bundle:acc-b', 1000, b)
    invalidateConfigCache('acc-a')
    await cached('bundle:acc-a', 1000, a)
    await cached('bundle:acc-b', 1000, b)
    expect(a).toHaveBeenCalledTimes(2)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('is bypassed under the test runner unless switched on', async () => {
    vi.stubEnv('RESORT_CONFIG_CACHE', '')
    const load = vi.fn(async () => 'v')
    await cached('k:acc', 1000, load)
    await cached('k:acc', 1000, load)
    expect(load).toHaveBeenCalledTimes(2)
  })
})
