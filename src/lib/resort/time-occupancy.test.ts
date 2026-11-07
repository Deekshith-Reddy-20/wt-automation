import { describe, expect, it } from 'vitest'
import { parseGuestDate } from './date-parse'
import {
  eventDurationHours,
  eventOccupancy,
  stayOccupancy,
  toRangeLiteral,
  validateEventDate,
  validateEventGuests,
  validateStayDates,
  validateStayGuests,
} from './occupancy'
import { addDays, daysBetween, isIsoDate, isoWeekday, istToInstant, nightsOf, parseTimeInput, todayIST } from './time'

// 2026-10-27 10:00 IST
const NOW = new Date('2026-10-27T04:30:00Z')
const NO_TIMES = { check_in_time: null, check_out_time: null }

describe('time helpers (Asia/Kolkata)', () => {
  it('uses the IST calendar date, not UTC', () => {
    expect(todayIST(new Date('2026-10-27T19:00:00Z'))).toBe('2026-10-28') // 00:30 IST next day
    expect(todayIST(new Date('2026-10-27T18:00:00Z'))).toBe('2026-10-27') // 23:30 IST
  })
  it('validates real calendar dates', () => {
    expect(isIsoDate('2028-02-29')).toBe(true)
    expect(isIsoDate('2026-02-29')).toBe(false)
    expect(isIsoDate('2026-13-01')).toBe(false)
  })
  it('counts nights and weekdays', () => {
    expect(daysBetween('2026-12-30', '2027-01-02')).toBe(3)
    expect(nightsOf('2026-12-30', '2027-01-02')).toEqual(['2026-12-30', '2026-12-31', '2027-01-01'])
    expect(isoWeekday('2026-10-25')).toBe(7) // Sunday
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
  })
  it('converts IST wall-clock to an instant', () => {
    expect(istToInstant('2026-11-01', '12:00').toISOString()).toBe('2026-11-01T06:30:00.000Z')
  })
  it('parses guest-typed times and refuses ambiguous ones', () => {
    expect(parseTimeInput('4pm')).toBe('16:00')
    expect(parseTimeInput('4:30 PM')).toBe('16:30')
    expect(parseTimeInput('12 am')).toBe('00:00')
    expect(parseTimeInput('noon')).toBe('12:00')
    expect(parseTimeInput('18:00')).toBe('18:00')
    expect(parseTimeInput('9:00')).toBeNull() // morning or evening?
    expect(parseTimeInput('4')).toBeNull()
  })
})

describe('parseGuestDate', () => {
  it('reads relative and explicit dates', () => {
    expect(parseGuestDate('tomorrow', NOW)).toEqual({ kind: 'date', date: '2026-10-28' })
    expect(parseGuestDate('25/12/2026', NOW)).toEqual({ kind: 'date', date: '2026-12-25' })
    expect(parseGuestDate('25 Dec', NOW)).toEqual({ kind: 'date', date: '2026-12-25' })
    expect(parseGuestDate('Dec 25th', NOW)).toEqual({ kind: 'date', date: '2026-12-25' })
    expect(parseGuestDate('2027-01-05', NOW)).toEqual({ kind: 'date', date: '2027-01-05' })
  })
  it('rolls a past day/month to next year', () => {
    expect(parseGuestDate('5 Jan', NOW)).toEqual({ kind: 'date', date: '2027-01-05' })
  })
  it('asks instead of guessing', () => {
    expect(parseGuestDate('next weekend', NOW)).toMatchObject({ kind: 'ambiguous', reason: 'needs_specific_day' })
    expect(parseGuestDate('the 5th', NOW)).toMatchObject({ kind: 'ambiguous', reason: 'needs_month' })
    expect(parseGuestDate('25-27 Dec', NOW)).toMatchObject({ kind: 'ambiguous', reason: 'range_given' })
    const next = parseGuestDate('next saturday', NOW)
    expect(next).toMatchObject({ kind: 'ambiguous', reason: 'which_week', options: ['2026-10-31', '2026-11-07'] })
  })
  it('rejects impossible dates', () => {
    expect(parseGuestDate('31/02/2027', NOW)).toEqual({ kind: 'invalid' })
    expect(parseGuestDate('banana', NOW)).toEqual({ kind: 'invalid' })
  })
})

describe('occupancy (single estate)', () => {
  it('uses configured check-in/out times, else a calendar-only noon', () => {
    const configured = stayOccupancy('2026-11-01', '2026-11-03', { check_in_time: '14:00:00', check_out_time: '11:00' })
    expect(configured.start.toISOString()).toBe('2026-11-01T08:30:00.000Z')
    expect(configured.end.toISOString()).toBe('2026-11-03T05:30:00.000Z')
    const fallback = stayOccupancy('2026-11-01', '2026-11-03', NO_TIMES)
    expect(fallback.start.toISOString()).toBe('2026-11-01T06:30:00.000Z')
  })
  it('lets back-to-back stays touch without overlapping', () => {
    const times = { check_in_time: '14:00', check_out_time: '11:00' }
    const a = stayOccupancy('2026-11-01', '2026-11-03', times)
    const b = stayOccupancy('2026-11-03', '2026-11-05', times)
    expect(a.end.getTime()).toBeLessThanOrEqual(b.start.getTime())
  })
  it('adds the event buffer and handles events past midnight', () => {
    const e = eventOccupancy('2026-11-10', '18:00', '23:00', 60)
    expect(e.start.toISOString()).toBe('2026-11-10T11:30:00.000Z') // 17:00 IST
    expect(e.end.toISOString()).toBe('2026-11-10T18:30:00.000Z') // 00:00 IST
    const late = eventOccupancy('2026-11-10', '20:00', '01:00')
    expect(late.end.toISOString()).toBe('2026-11-10T19:30:00.000Z') // 01:00 IST on the 11th
    expect(eventDurationHours('20:00', '01:00')).toBe(5)
  })
  it('renders a half-open tstzrange literal', () => {
    expect(toRangeLiteral({ start: new Date('2026-11-01T06:30:00Z'), end: new Date('2026-11-02T06:30:00Z') }))
      .toBe('[2026-11-01T06:30:00.000Z,2026-11-02T06:30:00.000Z)')
  })
  it('validates stay dates', () => {
    expect(validateStayDates('2026-10-26', '2026-10-28', { now: NOW })).toBe('past_date')
    expect(validateStayDates('2026-11-02', '2026-11-02', { now: NOW })).toBe('checkout_not_after_checkin')
    expect(validateStayDates('2026-11-02', '2026-12-10', { now: NOW })).toBe('stay_too_long')
    expect(validateStayDates('2026-11-02', '2026-11-03', { now: NOW, minNights: 2 })).toBe('below_min_nights')
    expect(validateStayDates('2026-10-27', '2026-10-28', { now: NOW })).toBeNull()
    expect(validateEventDate('2029-01-01', { now: NOW })).toBe('too_far_ahead')
  })
  it('enforces capacity only when configured', () => {
    expect(validateStayGuests(12, 4, null, null)).toBeNull()
    expect(validateStayGuests(12, 4, null, 15)).toBe('exceeds_capacity')
    expect(validateStayGuests(0, 2, [3, 5], null)).toBe('no_adults')
    expect(validateStayGuests(2, 2, [3], null)).toBe('children_ages_mismatch')
    expect(validateEventGuests(80, null)).toBeNull()
    expect(validateEventGuests(80, 50)).toBe('exceeds_capacity')
  })
})
