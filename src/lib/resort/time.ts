/**
 * Calendar helpers for the estate. All business dates are Asia/Kolkata
 * calendar dates ("YYYY-MM-DD"). India has used a fixed +05:30 offset with
 * no daylight saving since 1945, so converting an IST wall-clock time to an
 * instant is a constant shift.
 */

export const RESORT_TIMEZONE = 'Asia/Kolkata'
export const IST_OFFSET = '+05:30'
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** True for a real calendar date in YYYY-MM-DD form. */
export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

function toUtcMidnight(date: string): number {
  if (!isIsoDate(date)) throw new Error(`Invalid date: ${date}`)
  const [y, m, d] = date.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

function fromUtcMidnight(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Today's calendar date in India. */
export function todayIST(now: Date = new Date()): string {
  return fromUtcMidnight(now.getTime() + IST_OFFSET_MS)
}

/** Current IST wall-clock time as HH:MM. */
export function nowTimeIST(now: Date = new Date()): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(11, 16)
}

export function addDays(date: string, days: number): string {
  return fromUtcMidnight(toUtcMidnight(date) + days * DAY_MS)
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMidnight(to) - toUtcMidnight(from)) / DAY_MS)
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const dow = new Date(toUtcMidnight(date)).getUTCDay()
  return dow === 0 ? 7 : dow
}

/** Each night's start date for a stay [checkIn, checkOut). */
export function nightsOf(checkIn: string, checkOut: string): string[] {
  const n = daysBetween(checkIn, checkOut)
  return Array.from({ length: Math.max(0, n) }, (_, i) => addDays(checkIn, i))
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/

/** Normalise "HH:MM" / "HH:MM:SS" (Postgres TIME) to "HH:MM"; null if invalid. */
export function normalizeTime(value: string | null | undefined): string | null {
  if (!value) return null
  const m = TIME.exec(value.trim())
  return m ? `${m[1]}:${m[2]}` : null
}

/** The instant of an IST wall-clock date + time. */
export function istToInstant(date: string, time: string): Date {
  const t = normalizeTime(time)
  if (!t) throw new Error(`Invalid time: ${time}`)
  return new Date(`${date}T${t}:00${IST_OFFSET}`)
}

export function minutesOfDay(time: string): number {
  const t = normalizeTime(time)
  if (!t) throw new Error(`Invalid time: ${time}`)
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Sat, 25 Dec 2026" — unambiguous for guests regardless of locale. */
export function formatDateHuman(date: string): string {
  const d = new Date(toUtcMidnight(date))
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** "4:30 PM" from "16:30". */
export function formatTimeHuman(time: string | null | undefined): string {
  const t = normalizeTime(time)
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  const suffix = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`
}

/**
 * Parse a guest-typed time: "4pm", "4:30 pm", "16:00", "1630", "noon",
 * "midnight". Returns HH:MM or null when it can't be read unambiguously
 * (a bare "4" could be 4 AM or 4 PM).
 */
export function parseTimeInput(raw: string): string | null {
  const text = raw.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ')
  if (!text) return null
  if (text === 'noon' || text === '12 noon') return '12:00'
  if (text === 'midnight' || text === '12 midnight') return '00:00'

  const ampm = /^(\d{1,2})(?::?(\d{2}))?\s*(am|pm|a m|p m)$/.exec(text)
  if (ampm) {
    let h = Number(ampm[1])
    const m = ampm[2] ? Number(ampm[2]) : 0
    if (h < 1 || h > 12 || m > 59) return null
    const pm = ampm[3].startsWith('p')
    if (h === 12) h = pm ? 12 : 0
    else if (pm) h += 12
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  }

  const h24 = /^(\d{1,2}):(\d{2})$/.exec(text) ?? /^(\d{2})(\d{2})$/.exec(text)
  if (h24) {
    const h = Number(h24[1])
    const m = Number(h24[2])
    if (h > 23 || m > 59) return null
    // "9:00" without am/pm could be morning or evening; "09:00", "0900"
    // and 12–23 are read as 24-hour.
    if (h >= 1 && h <= 11 && !h24[1].startsWith('0') && !/^\d{4}$/.test(text)) return null
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  }
  return null
}
