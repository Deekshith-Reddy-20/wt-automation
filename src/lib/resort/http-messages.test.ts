import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { guestMessageText } from './guest-messages'
import { readPublicJson } from './http'
import type { PropertySettings } from './types'

const schema = z.object({ name: z.string().min(1) })
const limit = { bucket: 'test', opts: { limit: 1000, windowMs: 60_000 } }

function post(body: string, headers: Record<string, string> = {}) {
  return new Request('http://localhost:3000/api/x', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', host: 'localhost:3000', ...headers },
  })
}

describe('readPublicJson', () => {
  it('accepts same-origin JSON that matches the schema', async () => {
    const r = await readPublicJson(post('{"name":"A"}', { origin: 'http://localhost:3000' }), schema, limit)
    expect(r.ok).toBe(true)
  })
  it('rejects cross-site requests', async () => {
    const r = await readPublicJson(post('{"name":"A"}', { origin: 'https://evil.example' }), schema, limit)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.response.status).toBe(403)
  })
  it('rejects non-JSON, oversized and invalid bodies', async () => {
    const form = await readPublicJson(post('name=A', { 'content-type': 'application/x-www-form-urlencoded' }), schema, limit)
    if (!form.ok) expect(form.response.status).toBe(415)
    else throw new Error('expected rejection')
    const big = await readPublicJson(post(JSON.stringify({ name: 'x'.repeat(200_000) })), schema, limit)
    if (!big.ok) expect(big.response.status).toBe(413)
    else throw new Error('expected rejection')
    const invalid = await readPublicJson(post('{"name":""}'), schema, limit)
    expect(invalid.ok).toBe(false)
    const broken = await readPublicJson(post('{not json'), schema, limit)
    expect(broken.ok).toBe(false)
  })
})

describe('guestMessageText', () => {
  const base = { booking_ref: 'VF-261027-ABCDE', booking_type: 'stay', check_in: '2026-11-15', check_out: '2026-11-17' }
  const settings = (over: Partial<PropertySettings>) => ({ resort_name: 'Test Farm', check_in_time: null, check_out_time: null, map_url: null, ...over }) as PropertySettings

  it('omits times and directions that are not configured', () => {
    const text = guestMessageText('upcoming_arrival', base, settings({}))!
    expect(text).toContain('VF-261027-ABCDE')
    expect(text).not.toMatch(/Check-in from|Directions/)
  })
  it('includes configured details', () => {
    const text = guestMessageText('upcoming_arrival', base, settings({ check_in_time: '14:00', map_url: 'https://maps.example/x' }))!
    expect(text).toContain('Check-in from')
    expect(text).toContain('https://maps.example/x')
  })
  it('skips the checkout reminder when no checkout time is configured', () => {
    expect(guestMessageText('upcoming_checkout', base, settings({}))).toBeNull()
    expect(guestMessageText('unknown_kind', base, settings({}))).toBeNull()
  })
})
