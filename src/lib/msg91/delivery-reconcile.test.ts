import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { msg91LogStatus, reconcileMsg91Deliveries } from './delivery-reconcile'

describe('msg91LogStatus', () => {
  it('never reports more than MSG91 has recorded', () => {
    expect(msg91LogStatus({ status: 'submitted' })).toBeNull()
    expect(msg91LogStatus({ status: '' })).toBeNull()
    expect(msg91LogStatus({ status: 'sent', sentTime: { value: '2026-11-07 17:20:05' } })).toBe('sent')
    expect(msg91LogStatus({ status: 'delivered', deliveryTime: { value: '2026-11-07 17:20:06' } })).toBe('delivered')
    expect(msg91LogStatus({ status: 'read', readTime: { value: '2026-11-07 17:21:00' } })).toBe('read')
    expect(msg91LogStatus({ status: 'failed', failureReason: 'Re-engagement message' })).toBe('failed')
  })
})

describe('reconcileMsg91Deliveries (mocked MSG91 log + DB)', () => {
  const updates: { id: string; status: string; from: string[] }[] = []
  let pending: { message_id: string; status: string; created_at: string }[] = []

  function db() {
    const q: Record<string, unknown> = {}
    const chain = () => q
    let update: { status: string } | null = null
    let id = ''
    Object.assign(q, {
      select: chain,
      not: chain,
      gte: chain,
      lte: chain,
      order: chain,
      eq: (col: string, v: string) => {
        if (col === 'message_id') id = v
        return q
      },
      update: (row: { status: string }) => {
        update = row
        return q
      },
      in: (col: string, values: string[]) => {
        if (update && col === 'status') {
          updates.push({ id, status: update.status, from: values })
          return { select: async () => ({ data: [{ id }], error: null }) }
        }
        return q
      },
      limit: async () => ({ data: pending, error: null }),
    })
    return { from: () => q } as never
  }

  beforeEach(() => {
    updates.length = 0
    vi.stubEnv('MSG91_AUTHKEY', 'test-key')
    vi.stubEnv('MSG91_INTEGRATED_NUMBER', '919908627778')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('moves accepted replies forward from MSG91\'s log and leaves queued ones at accepted', async () => {
    pending = [
      { message_id: 'req-delivered', status: 'sending', created_at: '2026-11-07T11:45:40Z' },
      { message_id: 'req-queued', status: 'sending', created_at: '2026-11-07T11:46:00Z' },
      { message_id: 'req-read', status: 'sent', created_at: '2026-11-07T11:46:10Z' },
    ]
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { direction: 1, requestId: 'req-delivered', status: 'delivered', deliveryTime: { value: '2026-11-07 17:20:05' } },
            { direction: 1, requestId: 'req-read', status: 'read', readTime: { value: '2026-11-07 17:21:05' } },
            { direction: 0, requestId: 'req-queued', status: 'read' },
          ],
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const r = await reconcileMsg91Deliveries(db(), { now: new Date('2026-11-07T12:00:00Z') })
    expect(r).toEqual({ checked: 3, updated: 2, stillQueued: ['req-queued'] })
    expect(updates.map((u) => [u.id, u.status])).toEqual([
      ['req-delivered', 'delivered'],
      ['req-read', 'read'],
    ])
    expect(updates[0].from).toEqual(['sending', 'sent'])
    const url = String((fetchMock.mock.calls[0] as unknown as [string])[0])
    expect(url).toContain('/api/v5/report/logs/wa?')
    expect(url).not.toContain('test-key')
  })

  it('does nothing (and calls nothing) when no reply is pending', async () => {
    pending = []
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await reconcileMsg91Deliveries(db())).toEqual({ checked: 0, updated: 0, stillQueued: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces a MSG91 log error instead of guessing a status', async () => {
    pending = [{ message_id: 'req-1', status: 'sending', created_at: '2026-11-07T11:45:40Z' }]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'fail' }), { status: 401 })))
    await expect(reconcileMsg91Deliveries(db())).rejects.toThrow('MSG91 log lookup failed (HTTP 401)')
    expect(updates).toEqual([])
  })
})
