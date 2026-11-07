import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { SignJWT } from 'jose'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it } from 'vitest'
import { istToInstant } from './time'

// ============================================================
// V-Farms resort database guarantees, against a DISPOSABLE local database.
// Skipped unless WACRM_DISPOSABLE_DB=1 and the stack from
// scripts/disposable-db/up.ps1 is running (Postgres 127.0.0.1:55432,
// PostgREST 127.0.0.1:55433). Never touches a hosted project.
// ============================================================

const ENABLED = process.env.WACRM_DISPOSABLE_DB === '1'
const CONTAINER = 'wacrm058-db'
const REST = 'http://127.0.0.1:55433'
const JWT_SECRET = 'disposable-local-only-jwt-secret-not-for-prod-0001'
const OWNER = '00000000-0000-4000-8000-000000000001'
const AGENT = '00000000-0000-4000-8000-000000000002'
const OUTSIDER = '00000000-0000-4000-8000-0000000000a9'

function psql(query: string, user = 'postgres'): string {
  return execFileSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-AtqX', '-f', '-'],
    { input: query, encoding: 'utf8' },
  ).trim()
}

const jwt = (claims: Record<string, unknown>) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET))

// supabase-js prefixes /rest/v1; the bare PostgREST container serves from /.
const restFetch: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return fetch(url.replace(`${REST}/rest/v1/`, `${REST}/`), init)
}
const client = (key: string) =>
  createClient(REST, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: restFetch } })

let svc: SupabaseClient
let ownerDb: SupabaseClient
let agentDb: SupabaseClient
let outsiderDb: SupabaseClient
let anonDb: SupabaseClient
let accountId = ''

// Each run uses its own far-future window so reruns never collide.
const BASE_DAY = Date.UTC(2031, 0, 1) + (Math.floor(Date.now() / 1000) % 3000) * 7 * 86_400_000
let slot = 0
function nextWindow() {
  const start = new Date(BASE_DAY + slot++ * 5 * 86_400_000)
  const day = (offset: number) => new Date(start.getTime() + offset * 86_400_000)
  return { day, iso: (offset: number) => day(offset).toISOString().slice(0, 10) }
}

async function newStay(checkIn: string, checkOut: string, extra: Record<string, unknown> = {}) {
  const { data, error } = await svc
    .from('bookings')
    .insert({
      account_id: accountId,
      booking_ref: `VF-TEST-${randomUUID().slice(0, 8)}`,
      booking_type: 'stay',
      status: 'booking_requested',
      check_in: checkIn,
      check_out: checkOut,
      adults: 2,
      guest_count: 2,
      ...extra,
    })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  return data.id as string
}

const range = (a: Date, b: Date) => ({ p_start: a.toISOString(), p_end: b.toISOString() })

describe.skipIf(!ENABLED)('resort database (disposable)', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    // The image's auth.uid() stub only reads request.jwt.claim.sub, which this
    // PostgREST no longer sets; hosted Supabase also reads request.jwt.claims.
    psql(
      `CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
         SELECT COALESCE(
           NULLIF(current_setting('request.jwt.claim.sub', true), ''),
           (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
         )::uuid
       $$;`,
      'supabase_admin',
    )
    psql(
      `INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
       VALUES ('${OUTSIDER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
               'outsider@disposable.example.invalid', '{"full_name":"Other Account"}', now(), now())
       ON CONFLICT (id) DO NOTHING;`,
      'supabase_admin',
    )
    accountId = psql(`SELECT account_id FROM public.profiles WHERE user_id = '${OWNER}';`)
    expect(accountId).toMatch(/^[0-9a-f-]{36}$/)
    svc = client(await jwt({ role: 'service_role' }))
    ownerDb = client(await jwt({ role: 'authenticated', sub: OWNER }))
    agentDb = client(await jwt({ role: 'authenticated', sub: AGENT }))
    outsiderDb = client(await jwt({ role: 'authenticated', sub: OUTSIDER }))
    anonDb = client(await jwt({ role: 'anon' }))
  })

  describe('double-booking prevention', () => {
    it('rejects an overlapping reservation with estate_unavailable', async () => {
      const w = nextWindow()
      const a = await newStay(w.iso(0), w.iso(2))
      const b = await newStay(w.iso(1), w.iso(3))
      const first = await svc.rpc('resort_reserve', { p_account: accountId, p_block_type: 'booking', p_booking: a, ...range(w.day(0), w.day(2)) })
      expect(first.error).toBeNull()
      const second = await svc.rpc('resort_reserve', { p_account: accountId, p_block_type: 'booking', p_booking: b, ...range(w.day(1), w.day(3)) })
      expect(second.error?.message).toBe('estate_unavailable')
      expect(second.error?.code).toBe('23P01')
    })

    it('allows back-to-back stays (half-open ranges)', async () => {
      const w = nextWindow()
      const a = await newStay(w.iso(0), w.iso(2))
      const b = await newStay(w.iso(2), w.iso(4))
      expect((await svc.rpc('resort_reserve', { p_account: accountId, p_block_type: 'booking', p_booking: a, ...range(w.day(0), w.day(2)) })).error).toBeNull()
      expect((await svc.rpc('resort_reserve', { p_account: accountId, p_block_type: 'booking', p_booking: b, ...range(w.day(2), w.day(4)) })).error).toBeNull()
    })

    it('the exclusion constraint holds even for direct inserts', async () => {
      const w = nextWindow()
      expect((await svc.rpc('resort_reserve', { p_account: accountId, p_block_type: 'manual_block', ...range(w.day(0), w.day(1)), p_reason: 'test' })).error).toBeNull()
      const direct = await svc.from('availability_blocks').insert({
        account_id: accountId,
        period: `[${w.day(0).toISOString()},${w.day(1).toISOString()})`,
        block_type: 'maintenance',
      })
      expect(direct.error?.code).toBe('23P01')
    })

    it('an event during a reserved stay is rejected; one ending before check-in (IST) is allowed', async () => {
      const w = nextWindow()
      const ist = (offset: number, hhmm: string) => istToInstant(w.iso(offset), hhmm)
      const stay = await newStay(w.iso(1), w.iso(2))
      const reserved = await svc.rpc('resort_reserve', { p_account: accountId, p_block_type: 'booking', p_booking: stay, ...range(ist(1, '14:00'), ist(2, '11:00')) })
      expect(reserved.error).toBeNull()
      const event = async (start: string, end: string) => {
        const id = await newStay(w.iso(1), w.iso(2), { booking_type: 'event', check_in: null, check_out: null, event_date: w.iso(1), event_start_time: start, event_end_time: end })
        return svc.rpc('resort_reserve', { p_account: accountId, p_block_type: 'booking', p_booking: id, ...range(ist(1, start), ist(1, end)) })
      }
      const evening = await event('18:00', '22:00')
      expect(evening.error?.message).toBe('estate_unavailable')
      const morning = await event('09:00', '12:00')
      expect(morning.error).toBeNull()
    })

    it('a manual block stops a stay from being reserved', async () => {
      const w = nextWindow()
      expect((await svc.rpc('resort_reserve', { p_account: accountId, p_block_type: 'manual_block', ...range(w.day(1), w.day(2)), p_reason: 'owner use' })).error).toBeNull()
      const id = await newStay(w.iso(0), w.iso(3))
      const r = await svc.rpc('resort_reserve', { p_account: accountId, p_block_type: 'booking', p_booking: id, ...range(w.day(0), w.day(3)) })
      expect(r.error?.message).toBe('estate_unavailable')
    })

    it('confirming the same booking twice is a no-op the second time (one calendar block)', async () => {
      const w = nextWindow()
      const id = await newStay(w.iso(0), w.iso(2))
      const hold = await svc.rpc('resort_reserve', { p_account: accountId, p_block_type: 'hold', p_booking: id, ...range(w.day(0), w.day(2)), p_expires_at: new Date(Date.now() + 600_000).toISOString() })
      expect(hold.error).toBeNull()
      const first = await svc.rpc('resort_confirm_booking', { p_account: accountId, p_booking: id, p_actor: OWNER })
      expect(first.error).toBeNull()
      const second = await svc.rpc('resort_confirm_booking', { p_account: accountId, p_booking: id, p_actor: OWNER })
      expect(second.error).toBeNull()
      expect(second.data).toMatchObject({ booking_status: 'confirmed', already_confirmed: true })
      const { data: blocks } = await svc.from('availability_blocks').select('id, block_type').eq('booking_id', id).eq('status', 'active')
      expect(blocks).toEqual([expect.objectContaining({ block_type: 'booking' })])
    })

    it('exactly one of many concurrent requests for the same dates wins', async () => {
      const w = nextWindow()
      const ids = await Promise.all(Array.from({ length: 12 }, () => newStay(w.iso(0), w.iso(2))))
      const results = await Promise.all(
        ids.map((id) => svc.rpc('resort_reserve', { p_account: accountId, p_block_type: 'hold', p_booking: id, ...range(w.day(0), w.day(2)), p_expires_at: new Date(Date.now() + 600_000).toISOString() })),
      )
      expect(results.filter((r) => !r.error)).toHaveLength(1)
      expect(results.filter((r) => r.error?.message === 'estate_unavailable')).toHaveLength(11)
    })
  })

  describe('holds', () => {
    it('refuses a hold without a future expiry', async () => {
      const w = nextWindow()
      const id = await newStay(w.iso(0), w.iso(1))
      const r = await svc.rpc('resort_reserve', { p_account: accountId, p_block_type: 'hold', p_booking: id, ...range(w.day(0), w.day(1)), p_expires_at: new Date(Date.now() - 1000).toISOString() })
      expect(r.error?.message).toBe('hold_requires_future_expiry')
    })

    it('expired holds free the dates and expire the unpaid booking', async () => {
      const w = nextWindow()
      const held = await newStay(w.iso(0), w.iso(2), { status: 'payment_pending' })
      const r = await svc.rpc('resort_reserve', { p_account: accountId, p_block_type: 'hold', p_booking: held, ...range(w.day(0), w.day(2)), p_expires_at: new Date(Date.now() + 600_000).toISOString() })
      expect(r.error).toBeNull()
      psql(`UPDATE availability_blocks SET expires_at = now() - interval '1 minute' WHERE booking_id = '${held}' AND status = 'active';`)

      const other = await newStay(w.iso(0), w.iso(2))
      const r2 = await svc.rpc('resort_reserve', { p_account: accountId, p_block_type: 'booking', p_booking: other, ...range(w.day(0), w.day(2)) })
      expect(r2.error).toBeNull()
      expect(psql(`SELECT status FROM bookings WHERE id = '${held}';`)).toBe('expired')
    })
  })

  describe('payments never bypass availability', () => {
    async function orderFor(bookingId: string, amountPaise: number) {
      const orderId = `order_TEST${randomUUID().replace(/-/g, '').slice(0, 14)}`
      const { error } = await svc.from('payments').insert({ account_id: accountId, booking_id: bookingId, provider: 'razorpay', amount_paise: amountPaise, provider_order_id: orderId })
      if (error) throw new Error(error.message)
      return orderId
    }

    it('records money but flags a conflict when the hold lapsed and the dates were taken', async () => {
      const w = nextWindow()
      const late = await newStay(w.iso(0), w.iso(2), { status: 'payment_pending' })
      await svc.rpc('resort_reserve', { p_account: accountId, p_block_type: 'hold', p_booking: late, ...range(w.day(0), w.day(2)), p_expires_at: new Date(Date.now() + 600_000).toISOString() })
      const order = await orderFor(late, 500_000)
      psql(`UPDATE availability_blocks SET expires_at = now() - interval '1 minute' WHERE booking_id = '${late}' AND status = 'active';`)
      const winner = await newStay(w.iso(1), w.iso(3))
      expect((await svc.rpc('resort_reserve', { p_account: accountId, p_block_type: 'booking', p_booking: winner, ...range(w.day(1), w.day(3)) })).error).toBeNull()
      psql(`UPDATE bookings SET status = 'payment_pending' WHERE id = '${late}';`)

      const res = await svc.rpc('resort_apply_verified_payment', { p_provider_order_id: order, p_provider_payment_id: `pay_${randomUUID().slice(0, 12)}`, p_amount_paise: 500_000, p_via: 'webhook' })
      expect(res.error).toBeNull()
      expect(res.data).toMatchObject({ availability_conflict: true, booking_status: 'payment_verified' })
      expect(psql(`SELECT status || ',' || availability_conflict || ',' || amount_paid FROM bookings WHERE id = '${late}';`)).toBe('payment_verified,true,5000.00')
      expect(psql(`SELECT count(*) FROM availability_blocks WHERE booking_id = '${late}' AND status = 'active';`)).toBe('0')
    })

    it('is idempotent and rejects mismatched amounts or a second payment', async () => {
      const w = nextWindow()
      const id = await newStay(w.iso(0), w.iso(1), { status: 'payment_pending' })
      await svc.rpc('resort_reserve', { p_account: accountId, p_block_type: 'hold', p_booking: id, ...range(w.day(0), w.day(1)), p_expires_at: new Date(Date.now() + 600_000).toISOString() })
      const order = await orderFor(id, 100_000)
      const bad = await svc.rpc('resort_apply_verified_payment', { p_provider_order_id: order, p_provider_payment_id: 'pay_mismatch01', p_amount_paise: 99_999, p_via: 'webhook' })
      expect(bad.error?.message).toBe('amount_mismatch')
      const payId = `pay_${randomUUID().slice(0, 12)}`
      const once = await svc.rpc('resort_apply_verified_payment', { p_provider_order_id: order, p_provider_payment_id: payId, p_amount_paise: 100_000, p_via: 'checkout_signature' })
      expect(once.data).toMatchObject({ already_processed: false, availability_conflict: false })
      const again = await svc.rpc('resort_apply_verified_payment', { p_provider_order_id: order, p_provider_payment_id: payId, p_amount_paise: 100_000, p_via: 'webhook' })
      expect(again.data).toMatchObject({ already_processed: true })
      const other = await svc.rpc('resort_apply_verified_payment', { p_provider_order_id: order, p_provider_payment_id: 'pay_someoneelse', p_amount_paise: 100_000, p_via: 'webhook' })
      expect(other.error?.message).toBe('order_already_paid_by_other_payment')
      expect(psql(`SELECT count(*) FROM payments WHERE provider_order_id = '${order}' AND status = 'captured';`)).toBe('1')
    })
  })

  describe('row-level security', () => {
    it('lets account members read their bookings', async () => {
      const w = nextWindow()
      const id = await newStay(w.iso(0), w.iso(1))
      const owner = await ownerDb.from('bookings').select('id').eq('id', id)
      expect(owner.data).toHaveLength(1)
      const agent = await agentDb.from('bookings').select('id').eq('id', id)
      expect(agent.data).toHaveLength(1)
    })

    it('hides bookings, payments and blocks from other accounts and anonymous users', async () => {
      const w = nextWindow()
      const id = await newStay(w.iso(0), w.iso(1))
      for (const db of [outsiderDb, anonDb]) {
        const b = await db.from('bookings').select('id').eq('id', id)
        expect(b.data ?? []).toHaveLength(0)
        const p = await db.from('payments').select('id').eq('account_id', accountId)
        expect(p.data ?? []).toHaveLength(0)
        const blocks = await db.from('availability_blocks').select('id').eq('account_id', accountId)
        expect(blocks.data ?? []).toHaveLength(0)
      }
    })

    it('does not let signed-in users or anonymous callers run privileged RPCs', async () => {
      const w = nextWindow()
      const id = await newStay(w.iso(0), w.iso(1))
      for (const db of [ownerDb, outsiderDb, anonDb]) {
        const r = await db.rpc('resort_reserve', { p_account: accountId, p_block_type: 'booking', p_booking: id, ...range(w.day(0), w.day(1)) })
        expect(r.error).not.toBeNull()
        const pay = await db.rpc('resort_apply_verified_payment', { p_provider_order_id: 'order_x', p_provider_payment_id: 'pay_x', p_amount_paise: 1, p_via: 'webhook' })
        expect(pay.error).not.toBeNull()
      }
      expect(psql(`SELECT count(*) FROM availability_blocks WHERE booking_id = '${id}';`)).toBe('0')
    })

    it('does not let an outsider write into another account', async () => {
      const w = nextWindow()
      const ins = await outsiderDb.from('bookings').insert({
        account_id: accountId, booking_ref: `VF-TEST-${randomUUID().slice(0, 8)}`, booking_type: 'stay',
        check_in: w.iso(0), check_out: w.iso(1), adults: 1, guest_count: 1,
      })
      expect(ins.error).not.toBeNull()
      const upd = await outsiderDb.from('property_settings').update({ resort_name: 'hijacked' }).eq('account_id', accountId).select('id')
      expect(upd.data ?? []).toHaveLength(0)
    })
  })
})
