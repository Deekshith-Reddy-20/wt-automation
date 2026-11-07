import { describe, expect, it } from 'vitest'
import { applyDeliveryStatus } from './delivery-status'

interface Row { message_id: string; sender_type: string; status: string }

function fakeDb(rows: Row[]) {
  return {
    from: () => {
      const filters: Array<(r: Row) => boolean> = []
      let patch: Partial<Row> = {}
      const q = {
        update: (p: Partial<Row>) => ((patch = p), q),
        eq: (col: keyof Row, v: string) => (filters.push((r) => r[col] === v), q),
        in: (col: keyof Row, vs: string[]) => (filters.push((r) => vs.includes(r[col])), q),
        select: async () => {
          const hit = rows.filter((r) => filters.every((f) => f(r)))
          for (const r of hit) Object.assign(r, patch)
          return { data: hit.map(() => ({ id: 'x' })), error: null }
        },
      }
      return q
    },
  } as never
}

describe('applyDeliveryStatus', () => {
  it('moves a sent bot reply forward to delivered and read', async () => {
    const rows = [{ message_id: 'r1', sender_type: 'bot', status: 'sent' }]
    expect(await applyDeliveryStatus(fakeDb(rows), 'r1', 'delivered')).toBe(1)
    expect(await applyDeliveryStatus(fakeDb(rows), 'r1', 'read')).toBe(1)
    expect(rows[0].status).toBe('read')
  })

  it('never moves a message backwards when reports arrive out of order', async () => {
    const rows = [{ message_id: 'r1', sender_type: 'bot', status: 'read' }]
    expect(await applyDeliveryStatus(fakeDb(rows), 'r1', 'delivered')).toBe(0)
    expect(await applyDeliveryStatus(fakeDb(rows), 'r1', 'failed')).toBe(0)
    expect(rows[0].status).toBe('read')
  })

  it('records a failed delivery and never touches guest messages', async () => {
    const rows = [
      { message_id: 'r1', sender_type: 'bot', status: 'sent' },
      { message_id: 'r1', sender_type: 'customer', status: 'delivered' },
    ]
    expect(await applyDeliveryStatus(fakeDb(rows), 'r1', 'failed')).toBe(1)
    expect(rows.map((r) => r.status)).toEqual(['failed', 'delivered'])
  })
})
