import { addDays, isIsoDate, isoWeekday, todayIST } from './time'

/**
 * Natural-language date parsing for guest messages, anchored to today's
 * date in India. Deterministic: the same text and "today" always give the
 * same answer, and anything that could mean more than one date is
 * reported as ambiguous so the bot asks instead of guessing.
 *
 * Numeric dates follow the Indian day-first convention (25/12/2026). The
 * bot always echoes the understood date back in words ("Fri, 25 Dec
 * 2026") so a misread can be corrected.
 */

export type DateParseResult =
  | { kind: 'date'; date: string }
  | { kind: 'ambiguous'; reason: AmbiguityReason; options?: string[] }
  | { kind: 'invalid' }

export type AmbiguityReason =
  | 'needs_specific_day'   // "next week", "this weekend", "December"
  | 'needs_month'          // "the 5th"
  | 'range_given'          // "25-27 Dec" where one date was asked for
  | 'which_week'           // "next saturday" — options holds both dates

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
}

const WEEKDAYS: Record<string, number> = {
  mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5,
  sat: 6, saturday: 6, sun: 7, sunday: 7,
}

function iso(y: number, m: number, d: number): string | null {
  const s = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  return isIsoDate(s) ? s : null
}

/** A day/month with no year: this year, or next year once it has passed. */
function nextOccurrence(day: number, month: number, today: string): string | null {
  const year = Number(today.slice(0, 4))
  for (const y of [year, year + 1]) {
    const candidate = iso(y, month, day)
    if (candidate && candidate >= today) return candidate
  }
  return null
}

function expandYear(y: number): number {
  return y < 100 ? 2000 + y : y
}

function clean(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/[,]/g, ' ')
    .replace(/\bof\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseGuestDate(raw: string, now: Date = new Date()): DateParseResult {
  const today = todayIST(now)
  const text = clean(raw)
  if (!text) return { kind: 'invalid' }

  // Relative words.
  if (/^(today|tonight)$/.test(text)) return { kind: 'date', date: today }
  if (/^(tomorrow|tmrw|tmr|tom)$/.test(text)) return { kind: 'date', date: addDays(today, 1) }
  if (/^(day after tomorrow|day after tmrw)$/.test(text)) return { kind: 'date', date: addDays(today, 2) }
  const inDays = /^in (\d{1,3}) days?$/.exec(text)
  if (inDays) return { kind: 'date', date: addDays(today, Number(inDays[1])) }

  if (/\b(weekend|next week|this week|next month|this month|sometime|soon|anytime)\b/.test(text)) {
    return { kind: 'ambiguous', reason: 'needs_specific_day' }
  }

  // Weekdays: "saturday" / "this saturday" / "coming saturday" = the
  // coming one (today counts). "next saturday" is read both ways in
  // everyday English, so both candidates are offered.
  const wd = /^(this |next |coming )?([a-z]+)$/.exec(text)
  if (wd && WEEKDAYS[wd[2]] !== undefined) {
    const target = WEEKDAYS[wd[2]]
    const delta = (target - isoWeekday(today) + 7) % 7
    const coming = addDays(today, delta)
    if (wd[1]?.trim() === 'next') {
      return { kind: 'ambiguous', reason: 'which_week', options: [coming, addDays(coming, 7)] }
    }
    return { kind: 'date', date: coming }
  }

  // Ranges where a single date is expected.
  if (/^\d{1,2}\s*(-|to|–)\s*\d{1,2}\s+[a-z]+/.test(text) || /^[a-z]+\s+\d{1,2}\s*(-|to|–)\s*\d{1,2}$/.test(text)) {
    return { kind: 'ambiguous', reason: 'range_given' }
  }

  // ISO: 2026-12-25
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)
  if (isoMatch) {
    const d = iso(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]))
    return d ? { kind: 'date', date: d } : { kind: 'invalid' }
  }

  // Numeric day-first: 25/12/2026, 25-12-26, 25.12, 25/12
  const num = /^(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{2,4}))?$/.exec(text)
  if (num) {
    const day = Number(num[1])
    const month = Number(num[2])
    if (num[3]) {
      const d = iso(expandYear(Number(num[3])), month, day)
      return d ? { kind: 'date', date: d } : { kind: 'invalid' }
    }
    const d = nextOccurrence(day, month, today)
    return d ? { kind: 'date', date: d } : { kind: 'invalid' }
  }

  // "25 dec", "25 december 2026"
  const dm = /^(\d{1,2}) ([a-z]+)(?: (\d{2,4}))?$/.exec(text)
  if (dm && MONTHS[dm[2]] !== undefined) {
    const day = Number(dm[1])
    const month = MONTHS[dm[2]]
    if (dm[3]) {
      const d = iso(expandYear(Number(dm[3])), month, day)
      return d ? { kind: 'date', date: d } : { kind: 'invalid' }
    }
    const d = nextOccurrence(day, month, today)
    return d ? { kind: 'date', date: d } : { kind: 'invalid' }
  }

  // "dec 25", "december 25 2026"
  const md = /^([a-z]+) (\d{1,2})(?: (\d{2,4}))?$/.exec(text)
  if (md && MONTHS[md[1]] !== undefined) {
    const day = Number(md[2])
    const month = MONTHS[md[1]]
    if (md[3]) {
      const d = iso(expandYear(Number(md[3])), month, day)
      return d ? { kind: 'date', date: d } : { kind: 'invalid' }
    }
    const d = nextOccurrence(day, month, today)
    return d ? { kind: 'date', date: d } : { kind: 'invalid' }
  }

  // A month on its own, or "the 5th" with no month.
  if (MONTHS[text] !== undefined) return { kind: 'ambiguous', reason: 'needs_specific_day' }
  if (/^(the )?\d{1,2}$/.test(text)) return { kind: 'ambiguous', reason: 'needs_month' }

  return { kind: 'invalid' }
}
