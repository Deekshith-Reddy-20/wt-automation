import type { BotOption } from './types'

/** WhatsApp limits for interactive messages. */
export const LIMITS = {
  buttons: 3,
  buttonTitle: 20,
  listRows: 10,
  rowTitle: 24,
  rowDescription: 72,
  body: 1024,
  listButton: 20,
} as const

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

export function normalizeInput(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}\s:'/.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Resolve a reply to one of the offered options: an interactive tap id,
 * the option's number ("2", "2."), its title, or one of its aliases.
 */
export function matchOption(options: BotOption[], text: string, replyId: string | null): BotOption | null {
  if (replyId) {
    const byId = options.find((o) => o.id === replyId)
    if (byId) return byId
  }
  const norm = normalizeInput(text)
  if (!norm) return null
  const num = /^(\d{1,2})\.?$/.exec(norm)
  if (num) {
    const idx = Number(num[1]) - 1
    return options[idx] ?? null
  }
  return (
    options.find((o) => normalizeInput(o.title) === norm) ??
    options.find((o) => (o.aliases ?? []).some((a) => normalizeInput(a) === norm)) ??
    null
  )
}

/** Body text with a numbered fallback for clients that don't render interactive lists. */
export function withNumberedFallback(text: string, options: BotOption[]): string {
  if (options.length <= LIMITS.buttons) return text
  if (/^\s*1\.\s/m.test(text) && /^\s*2\.\s/m.test(text)) return text
  const lines = options.map((o, i) => `${i + 1}. ${o.title}`)
  return `${text}\n\n${lines.join('\n')}\n\nReply with a number, or tap the menu below.`
}

const YES = ['yes', 'y', 'yeah', 'yep', 'sure', 'ok', 'okay', 'haan', 'ha', 'avunu', 'confirm']
const NO = ['no', 'n', 'nope', 'nah', 'not needed', 'none', 'kaadu', 'nahi']

export function parseYesNo(text: string, replyId: string | null): boolean | null {
  if (replyId === 'yes') return true
  if (replyId === 'no') return false
  const norm = normalizeInput(text)
  if (YES.includes(norm)) return true
  if (NO.includes(norm)) return false
  return null
}

const SKIP = ['skip', 'no', 'none', 'nothing', 'na', 'n/a', 'nil', 'no thanks', '-']

export function isSkip(text: string, replyId: string | null): boolean {
  return replyId === 'skip' || SKIP.includes(normalizeInput(text))
}

/** Whole number from a reply ("4", "4 adults", "four"). */
export function parseCount(text: string): number | null {
  const norm = normalizeInput(text)
  const words: Record<string, number> = {
    zero: 0, none: 0, no: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
  }
  const m = /^(\d{1,4})\b/.exec(norm)
  if (m) return Number(m[1])
  const first = norm.split(' ')[0]
  return first in words ? words[first] : null
}

export function parseAges(text: string): number[] | null {
  const nums = normalizeInput(text).match(/\d{1,2}/g)
  if (!nums) return null
  const ages = nums.map(Number)
  return ages.every((a) => a >= 0 && a <= 17) ? ages : null
}

/** Rupee amount ("50000", "50,000", "₹50k", "1.5 lakh"). */
export function parseAmount(text: string): number | null {
  const t = text.toLowerCase().replace(/[₹,\s]/g, '').replace(/rs\.?|inr/g, '')
  const m = /^(\d+(?:\.\d+)?)(k|l|lakh|lakhs|lac)?$/.exec(t)
  if (!m) return null
  const n = Number(m[1])
  const mult = m[2] === 'k' ? 1_000 : m[2] ? 100_000 : 1
  const value = Math.round(n * mult)
  return value > 0 && value <= 100_000_000 ? value : null
}
