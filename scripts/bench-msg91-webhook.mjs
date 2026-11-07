// Latency benchmark for the MSG91 inbound webhook. Sends simulated greetings to a
// server started with WHATSAPP_DRY_RUN=true (bot runs, nothing reaches WhatsApp),
// then reads that server's JSON trace log and the inbox to report timings,
// duplicates and errors.
//
//   node scripts/bench-msg91-webhook.mjs <baseUrl> <serverLogFile> [count] [label]
//   node scripts/bench-msg91-webhook.mjs --cleanup
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const BENCH_PHONE = '919000000001'
const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^"|"$/g, '')]),
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

async function benchConversation() {
  const { data: contacts } = await db.from('contacts').select('id').eq('phone', BENCH_PHONE)
  const ids = (contacts ?? []).map((c) => c.id)
  if (!ids.length) return { contactIds: [], conversationIds: [] }
  const { data: convs } = await db.from('conversations').select('id').in('contact_id', ids)
  return { contactIds: ids, conversationIds: (convs ?? []).map((c) => c.id) }
}

if (process.argv[2] === '--cleanup') {
  const { contactIds, conversationIds } = await benchConversation()
  for (const [table, col, ids] of [
    ['messages', 'conversation_id', conversationIds],
    ['conversation_states', 'conversation_id', conversationIds],
    ['resort_automation_runs', 'contact_id', contactIds],
    ['leads', 'contact_id', contactIds],
    ['contact_tags', 'contact_id', contactIds],
    ['conversations', 'id', conversationIds],
    ['contacts', 'id', contactIds],
  ]) {
    if (!ids.length) continue
    const { error, count } = await db.from(table).delete({ count: 'exact' }).in(col, ids)
    console.log(`${table}: ${error ? `error ${error.message}` : `${count ?? 0} deleted`}`)
  }
  process.exit(0)
}

const [baseUrl, logFile, countArg, label = 'run'] = process.argv.slice(2)
const count = Number(countArg ?? 100)
const GREETINGS = ['Hi', 'Hello', 'Hey', 'Good morning', 'Good afternoon', 'Good evening', 'MENU', 'START']
const runTag = `bench-${label}-${Date.now()}`
const headers = { 'content-type': 'application/json', 'x-msg91-webhook-secret': env.MSG91_WEBHOOK_SECRET ?? '' }
const logStart = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ackMs = []
let httpErrors = 0
for (let i = 0; i < count; i++) {
  const body = JSON.stringify({
    direction: '0',
    customerNumber: BENCH_PHONE,
    integratedNumber: env.MSG91_INTEGRATED_NUMBER,
    contentType: 'text',
    text: GREETINGS[i % GREETINGS.length],
    uuid: `${runTag}-${i}`,
  })
  const t0 = performance.now()
  const [first, retry] = await Promise.all([
    fetch(`${baseUrl}/api/msg91/webhook`, { method: 'POST', headers, body }),
    // Every message is delivered twice, like an MSG91 retry, to count duplicate replies.
    fetch(`${baseUrl}/api/msg91/webhook`, { method: 'POST', headers, body }),
  ])
  ackMs.push(performance.now() - t0)
  if (!first.ok || !retry.ok) httpErrors++
  await first.text()
  await retry.text()
  await sleep(1500)
}
await sleep(8000)

const lines = fs.readFileSync(logFile, 'utf8').slice(logStart).split(/\r?\n/)
const events = new Map()
for (const line of lines) {
  const start = line.indexOf('{"msg91"')
  if (start < 0) continue
  let j
  try { j = JSON.parse(line.slice(start)) } catch { continue }
  if (!j.cid) continue
  if (!events.has(j.cid)) events.set(j.cid, [])
  events.get(j.cid).push(j)
}

const ts = (e) => (e ? Date.parse(e.at) : NaN)
const decision = [], toSend = [], total = [], failures = []
const timing = { validation_completed_ms: [], conversation_lookup_ms: [], message_saved_ms: [], bot_decision_ms: [], msg91_request_started_ms: [], total_application_processing_ms: [], decision_only_ms: [] }
let processed = 0
for (const evs of events.values()) {
  const recv = evs.find((e) => e.msg91 === 'WEBHOOK_RECEIVED')
  const parsed = evs.find((e) => e.msg91 === 'PAYLOAD_PARSED')
  if (!recv || !parsed || !String(parsed.messageId ?? '').startsWith(runTag)) continue
  const outcome = evs.find((e) => e.msg91 === 'OUTCOME' || e.msg91 === 'TIMING')
  if (evs.some((e) => e.msg91 === 'PROCESSING_FAILED')) failures.push(evs.find((e) => e.msg91 === 'PROCESSING_FAILED'))
  const sent = evs.find((e) => e.msg91 === 'MSG91_SEND_REQUESTED')
  const gen = evs.find((e) => e.msg91 === 'BOT_RESPONSE_GENERATED')
  const t = evs.find((e) => e.msg91 === 'TIMING')
  if (!sent) continue
  processed++
  if (t) {
    for (const k of Object.keys(timing)) if (typeof t[k] === 'number') timing[k].push(t[k])
    if (typeof gen?.decision_only_ms === 'number') timing.decision_only_ms.push(gen.decision_only_ms)
  } else {
    toSend.push(ts(sent) - ts(recv))
    if (gen) decision.push(ts(gen) - ts(recv))
    const done = evs.find((e) => e.msg91 === 'OUTCOME')
    if (done) total.push(ts(done) - ts(recv))
  }
  void outcome
}

const { conversationIds } = await benchConversation()
let botReplies = 0, guestMsgs = 0
if (conversationIds.length) {
  const { data } = await db.from('messages').select('sender_type, message_id, content_text').in('conversation_id', conversationIds)
  const ours = (data ?? []).filter((m) => m.sender_type === 'customer' && String(m.message_id).startsWith(runTag))
  guestMsgs = ours.length
  const { data: replies } = await db.from('messages').select('sender_type, created_at').in('conversation_id', conversationIds).eq('sender_type', 'bot').gte('created_at', new Date(Date.now() - (count * 2000 + 60_000)).toISOString())
  botReplies = replies?.length ?? 0
}

function stats(arr) {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const p = (q) => s[Math.min(s.length - 1, Math.ceil((q / 100) * s.length) - 1)]
  const r = (n) => Math.round(n * 10) / 10
  return { n: s.length, avg: r(s.reduce((a, b) => a + b, 0) / s.length), p50: r(p(50)), p95: r(p(95)), p99: r(p(99)), max: r(s[s.length - 1]) }
}

const report = {
  label,
  requests: count,
  deliveries_including_duplicates: count * 2,
  webhook_ack_ms: stats(ackMs),
  ...(Object.values(timing).some((a) => a.length)
    ? Object.fromEntries(Object.entries(timing).map(([k, v]) => [k, stats(v)]))
    : { decision_ms_from_receipt: stats(decision), send_initiated_ms_from_receipt: stats(toSend), total_ms_from_receipt: stats(total) }),
  processed_with_send: processed,
  http_errors: httpErrors,
  processing_failures: failures.length,
  guest_messages_stored: guestMsgs,
  bot_replies_stored: botReplies,
  duplicate_replies: Math.max(0, botReplies - guestMsgs),
  lost_messages: count - guestMsgs,
}
console.log(JSON.stringify(report, null, 2))
fs.writeFileSync(`bench-${label}.json`, JSON.stringify({ report, failures: failures.slice(0, 5) }, null, 2))
