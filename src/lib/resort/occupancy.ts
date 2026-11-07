import {
  addDays,
  daysBetween,
  isIsoDate,
  istToInstant,
  minutesOfDay,
  normalizeTime,
  todayIST,
} from './time'

/**
 * How a stay or event occupies the estate's calendar.
 *
 * Stays occupy [check-in date + check-in time, check-out date + check-out
 * time). When the admin has not configured those times, 12:00 IST is used
 * for the calendar only — it is never shown to guests as a check-in time.
 * Back-to-back stays (one checks out the day the next checks in) therefore
 * never collide, while a same-day event is checked against real times.
 *
 * Events occupy [date + start − buffer, date + end + buffer). An end time
 * at or before the start time means the event runs past midnight.
 */

export const CALENDAR_DEFAULT_TIME = '12:00'
/** Furthest ahead a guest may request, in days. */
export const MAX_BOOKING_HORIZON_DAYS = 730
/** Longest single stay accepted online; longer stays go to the team. */
export const MAX_STAY_NIGHTS = 30

export interface Occupancy {
  start: Date
  end: Date
}

export function stayOccupancy(
  checkIn: string,
  checkOut: string,
  times: { check_in_time: string | null; check_out_time: string | null },
): Occupancy {
  const start = istToInstant(checkIn, normalizeTime(times.check_in_time) ?? CALENDAR_DEFAULT_TIME)
  const end = istToInstant(checkOut, normalizeTime(times.check_out_time) ?? CALENDAR_DEFAULT_TIME)
  if (end <= start) throw new Error('Stay ends before it starts')
  return { start, end }
}

export function eventOccupancy(
  date: string,
  startTime: string,
  endTime: string,
  bufferMinutes = 0,
): Occupancy {
  const crossesMidnight = minutesOfDay(endTime) <= minutesOfDay(startTime)
  const start = istToInstant(date, startTime)
  const end = istToInstant(crossesMidnight ? addDays(date, 1) : date, endTime)
  const buffer = Math.max(0, bufferMinutes) * 60_000
  return { start: new Date(start.getTime() - buffer), end: new Date(end.getTime() + buffer) }
}

export function eventDurationHours(startTime: string, endTime: string): number {
  let minutes = minutesOfDay(endTime) - minutesOfDay(startTime)
  if (minutes <= 0) minutes += 24 * 60
  return Math.round((minutes / 60) * 100) / 100
}

/** Postgres tstzrange literal for an occupancy. */
export function toRangeLiteral(o: Occupancy): string {
  return `[${o.start.toISOString()},${o.end.toISOString()})`
}

export type DateValidationError =
  | 'invalid_date'
  | 'past_date'
  | 'checkout_not_after_checkin'
  | 'too_far_ahead'
  | 'stay_too_long'
  | 'below_min_nights'

export function validateStayDates(
  checkIn: string,
  checkOut: string,
  opts: { now?: Date; minNights?: number | null } = {},
): DateValidationError | null {
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut)) return 'invalid_date'
  const today = todayIST(opts.now)
  if (checkIn < today) return 'past_date'
  if (checkOut <= checkIn) return 'checkout_not_after_checkin'
  if (daysBetween(today, checkIn) > MAX_BOOKING_HORIZON_DAYS) return 'too_far_ahead'
  const nights = daysBetween(checkIn, checkOut)
  if (nights > MAX_STAY_NIGHTS) return 'stay_too_long'
  if (opts.minNights && nights < opts.minNights) return 'below_min_nights'
  return null
}

export function validateEventDate(date: string, opts: { now?: Date } = {}): DateValidationError | null {
  if (!isIsoDate(date)) return 'invalid_date'
  const today = todayIST(opts.now)
  if (date < today) return 'past_date'
  if (daysBetween(today, date) > MAX_BOOKING_HORIZON_DAYS) return 'too_far_ahead'
  return null
}

export type GuestValidationError = 'no_adults' | 'exceeds_capacity' | 'invalid_count' | 'children_ages_mismatch'

/**
 * Capacity is enforced only when the admin has configured it. When it
 * isn't, the caller treats the request as needing manual review rather
 * than promising the estate can host the group.
 */
export function validateStayGuests(
  adults: number,
  children: number,
  childrenAges: number[] | null | undefined,
  maxGuests: number | null,
): GuestValidationError | null {
  if (!Number.isInteger(adults) || !Number.isInteger(children) || adults < 0 || children < 0) {
    return 'invalid_count'
  }
  if (adults < 1) return 'no_adults'
  if (childrenAges && childrenAges.length > 0 && childrenAges.length !== children) {
    return 'children_ages_mismatch'
  }
  if (maxGuests !== null && adults + children > maxGuests) return 'exceeds_capacity'
  return null
}

export function validateEventGuests(guests: number, maxGuests: number | null): GuestValidationError | null {
  if (!Number.isInteger(guests) || guests < 1) return 'invalid_count'
  if (maxGuests !== null && guests > maxGuests) return 'exceeds_capacity'
  return null
}

export const DATE_ERROR_MESSAGES: Record<DateValidationError, string> = {
  invalid_date: 'That date could not be understood.',
  past_date: 'That date has already passed.',
  checkout_not_after_checkin: 'The check-out date must be after the check-in date.',
  too_far_ahead: `We accept requests up to ${MAX_BOOKING_HORIZON_DAYS} days ahead.`,
  stay_too_long: `Stays longer than ${MAX_STAY_NIGHTS} nights are arranged directly with our team.`,
  below_min_nights: 'The stay is shorter than the minimum number of nights for those dates.',
}
