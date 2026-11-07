import type { SupabaseClient } from '@supabase/supabase-js'
import { addDays, todayIST } from './time'
import { stayOccupancy, type Occupancy } from './occupancy'

/**
 * The authoritative availability check. The website, the WhatsApp bot and
 * the admin calendar all call checkOccupancy, which asks the database
 * (resort_find_conflicts) — the same data the exclusion constraint guards.
 * A positive answer is advisory until a block is actually reserved.
 */

export type AvailabilityStatus = 'available' | 'unavailable' | 'pending_manual' | 'unknown'

export interface CalendarBlock {
  block_id: string
  block_type: 'booking' | 'hold' | 'manual_block' | 'maintenance'
  booking_id: string | null
  starts_at: string
  ends_at: string
}

export interface AvailabilityResult {
  status: AvailabilityStatus
  conflicts: CalendarBlock[]
  /** Set when status is 'unknown' — the check itself failed. */
  error?: string
}

export async function fetchBlocks(
  db: SupabaseClient,
  accountId: string,
  from: Date,
  to: Date,
  excludeBookingId: string | null = null,
): Promise<CalendarBlock[]> {
  const { data, error } = await db.rpc('resort_find_conflicts', {
    p_account: accountId,
    p_start: from.toISOString(),
    p_end: to.toISOString(),
    p_exclude_booking: excludeBookingId,
  })
  if (error) throw new Error(error.message)
  return (data ?? []) as CalendarBlock[]
}

export async function checkOccupancy(
  db: SupabaseClient,
  accountId: string,
  occupancy: Occupancy,
  opts: { excludeBookingId?: string | null; needsManualReview?: boolean } = {},
): Promise<AvailabilityResult> {
  try {
    const conflicts = await fetchBlocks(db, accountId, occupancy.start, occupancy.end, opts.excludeBookingId ?? null)
    if (conflicts.length > 0) return { status: 'unavailable', conflicts }
    return { status: opts.needsManualReview ? 'pending_manual' : 'available', conflicts: [] }
  } catch (err) {
    console.error('[resort] availability check failed:', err instanceof Error ? err.message : err)
    return { status: 'unknown', conflicts: [], error: 'availability_check_failed' }
  }
}

function overlaps(o: Occupancy, b: { starts_at: string; ends_at: string }): boolean {
  return o.start.getTime() < new Date(b.ends_at).getTime() && new Date(b.starts_at).getTime() < o.end.getTime()
}

/**
 * Night-by-night availability for the public calendar. A night is
 * unavailable when a one-night stay starting that day would collide with
 * any block. Reasons and guest details are never exposed.
 */
export function nightStatuses(
  blocks: Pick<CalendarBlock, 'starts_at' | 'ends_at'>[],
  from: string,
  days: number,
  times: { check_in_time: string | null; check_out_time: string | null },
  today: string,
): { date: string; available: boolean }[] {
  const out: { date: string; available: boolean }[] = []
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i)
    if (date < today) {
      out.push({ date, available: false })
      continue
    }
    const occ = stayOccupancy(date, addDays(date, 1), times)
    out.push({ date, available: !blocks.some((b) => overlaps(occ, b)) })
  }
  return out
}

/**
 * Nearby stays of the same length that are free in the given blocks,
 * closest to the requested check-in first. Only call with blocks fetched
 * for a window covering every candidate.
 */
export function findAlternativeStays(
  blocks: Pick<CalendarBlock, 'starts_at' | 'ends_at'>[],
  checkIn: string,
  nights: number,
  times: { check_in_time: string | null; check_out_time: string | null },
  opts: { today: string; windowDays?: number; limit?: number },
): { check_in: string; check_out: string }[] {
  const windowDays = opts.windowDays ?? 14
  const limit = opts.limit ?? 3
  const offsets: number[] = []
  for (let d = 1; d <= windowDays; d++) offsets.push(d, -d)
  const out: { check_in: string; check_out: string }[] = []
  for (const off of offsets) {
    const ci = addDays(checkIn, off)
    if (ci < opts.today) continue
    const co = addDays(ci, nights)
    const occ = stayOccupancy(ci, co, times)
    if (!blocks.some((b) => overlaps(occ, b))) {
      out.push({ check_in: ci, check_out: co })
      if (out.length >= limit) break
    }
  }
  return out.sort((a, b) => (a.check_in < b.check_in ? -1 : 1))
}

export async function suggestAlternativeStays(
  db: SupabaseClient,
  accountId: string,
  checkIn: string,
  nights: number,
  times: { check_in_time: string | null; check_out_time: string | null },
  opts: { now?: Date; windowDays?: number; limit?: number } = {},
): Promise<{ check_in: string; check_out: string }[] | null> {
  const windowDays = opts.windowDays ?? 14
  try {
    const from = stayOccupancy(addDays(checkIn, -windowDays - 1), addDays(checkIn, -windowDays), times).start
    const to = stayOccupancy(addDays(checkIn, windowDays + nights), addDays(checkIn, windowDays + nights + 1), times).end
    const blocks = await fetchBlocks(db, accountId, from, to)
    return findAlternativeStays(blocks, checkIn, nights, times, {
      today: todayIST(opts.now),
      windowDays,
      limit: opts.limit,
    })
  } catch (err) {
    // Without a live calendar we must not suggest dates at all.
    console.error('[resort] alternative-date lookup failed:', err instanceof Error ? err.message : err)
    return null
  }
}
