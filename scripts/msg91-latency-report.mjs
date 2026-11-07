// Real-message latency report: joins MSG91's own WhatsApp log with the inbox.
//
//   node --env-file=.env.local scripts/msg91-latency-report.mjs [--since=2026-11-07T17:00:00+05:30] [--days=1] [--rows]
//
// Stages per bot reply (MSG91 log times have 1-second resolution):
//   A  guest message received by MSG91          (MSG91 log, inbound requestedAt)
//   B  guest message saved in our inbox          (messages.created_at, ≈ webhook + DB write)
//   G  MSG91 API accepted our reply              (messages.created_at of the reply)
//   Q  MSG91 started processing the reply        (MSG91 log, outbound requestedAt)
//   S  WhatsApp sent / D delivered / R read      (MSG91 log)
// Read-only. Never prints the authkey or message text.
import { createClient } from '@supabase/supabase-js'

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]))
const days = Math.min(3, Number(args.days ?? 1))
const since = args.since ? new Date(args.since) : null

const { MSG91_AUTHKEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env
if (!MSG91_AUTHKEY || !NEXT_PUBLIC_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('MSG91_AUTHKEY, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (use --env-file=.env.local).')
  process.exit(1)
}

const istDate = (d) => new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10)
const end = new Date()
const start = new Date(end.getTime() - (days - 1) * 86400_000)
const res = await fetch(
  `https://control.msg91.com/api/v5/report/logs/wa?startDate=${istDate(start)}&endDate=${istDate(end)}&limit=1000`,
  { headers: { authkey: MSG91_AUTHKEY, accept: 'application/json' } },
)
const body = await res.json()
if (!Array.isArray(body.data)) {
  console.error('MSG91 logs API error:', JSON.stringify(body).slice(0, 300))
  process.exit(1)
}
const ist = (s) => (s ? new Date(`${s.replace(' ', 'T')}+05:30`) : null)
const v = (o) => (o?.value ? new Date(`${o.value}+05:30`) : null)
const logIn = new Map()
const logOut = new Map()
for (const x of body.data) {
  if (String(x.direction) === '0' && x.uuid) logIn.set(x.uuid, x)
  if (String(x.direction) === '1' && x.requestId) logOut.set(x.requestId, x)
}

const db = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const { data: msgs, error } = await db
  .from('messages')
  .select('conversation_id, sender_type, message_id, status, created_at')
  .gte('created_at', (since ?? start).toISOString())
  .order('created_at', { ascending: true })
  .limit(5000)
if (error) throw new Error(error.message)

// First reply after each guest message, per conversation.
const pending = new Map()
const rows = []
for (const m of msgs) {
  if (m.sender_type === 'customer') {
    pending.set(m.conversation_id, m)
    continue
  }
  if (m.sender_type !== 'bot') continue
  const guest = pending.get(m.conversation_id)
  if (!guest) continue
  pending.delete(m.conversation_id)
  const inLog = logIn.get(guest.message_id)
  const outLog = logOut.get(m.message_id)
  const A = ist(inLog?.requestedAt)
  const B = new Date(guest.created_at)
  const G = new Date(m.created_at)
  const Q = ist(outLog?.requestedAt)
  const D = v(outLog?.deliveryTime)
  rows.push({
    at: guest.created_at,
    requestId: m.message_id,
    msg91Status: outLog?.status ?? (outLog ? 'queued' : m.message_id?.startsWith('msg91-') ? 'not sent' : 'not in MSG91 log'),
    failure: outLog?.failureReason ?? outLog?.metaErrorCode ?? null,
    app_ms: G - B,
    in_to_inbox_s: A ? (B - A) / 1000 : null,
    msg91_queue_s: Q ? (Q - G) / 1000 : null,
    whatsapp_send_s: Q && D ? (D - Q) / 1000 : null,
    customer_perceived_s: A && D ? (D - A) / 1000 : null,
    inbox_to_delivered_s: D ? (D - B) / 1000 : null,
  })
}

const pct = (xs, p) => {
  const s = xs.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b)
  if (!s.length) return null
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]
}
const stat = (key) => {
  const xs = rows.map((r) => r[key]).filter((x) => x !== null)
  return { n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: xs.length ? Math.max(...xs) : null }
}

console.log(`Bot replies analysed: ${rows.length} (MSG91 log ${istDate(start)}..${istDate(end)}, ${body.data.length} rows)`)
console.table({
  'app: inbox save → MSG91 accepted (ms)': stat('app_ms'),
  'MSG91 inbound → our inbox (s)': stat('in_to_inbox_s'),
  'MSG91 accepted → MSG91 processed (s)': stat('msg91_queue_s'),
  'MSG91 processed → delivered (s)': stat('whatsapp_send_s'),
  'inbox save → delivered (s)': stat('inbox_to_delivered_s'),
  'customer-perceived: MSG91 inbound → delivered (s)': stat('customer_perceived_s'),
})
const stuck = rows.filter((r) => r.msg91Status === 'queued' || r.msg91Status === 'not in MSG91 log')
if (stuck.length) console.log(`Still queued / not yet in MSG91's log: ${stuck.length} → ${stuck.map((r) => r.requestId).join(', ')}`)
if (args.rows) console.table(rows)
