#!/usr/bin/env node
// Archive the leftover Suraj Solar records for ONE account — reversibly.
//
//   node scripts/archive-solar-records.mjs --owner-email you@example.com                 # dry run (default): report only
//   node scripts/archive-solar-records.mjs --owner-email you@example.com --apply         # archive
//   node scripts/archive-solar-records.mjs --owner-email you@example.com --apply --include-demo-contacts
//   node scripts/archive-solar-records.mjs --restore backups/solar-archive-<...>.json    # undo
//
// Only records the old solar seed created are touched, matched by their
// exact names (never by keyword search):
//   * automations named "Suraj Solar · …"        → archived_at set, is_active false (rows kept)
//   * the solar lead-qualification flow           → status 'archived' (row kept)
//   * DRAFT message templates named solar_*       → snapshot, then removed
//   * the solar quick replies                     → snapshot, then removed
//   * solar-only tags / custom fields             → snapshot, then removed ONLY when unused
//   * the "Solar Sales" pipeline                  → snapshot, then removed ONLY when it has no deals
//   * demo contacts +915555500001–08              → only with --include-demo-contacts
//   * account named "Suraj Solar"                 → renamed "V-Farms"
//   * AI system prompt mentioning solar           → snapshot, prompt cleared, auto-reply off
// Anything in use is reported and left alone. Other flows, automations,
// quick replies, draft templates and AI knowledge documents that mention
// "solar" / "Suraj" are only REPORTED; add --include-flagged to archive
// them too. Real (non-demo) contacts and their conversations are never
// removed — they are listed for manual review.
//
// --apply first writes a full JSON backup to backups/ (git-ignored) and a
// copy of each removed row to the legacy_archive table (migration 063).
// Refuses a non-local Supabase unless --allow-remote is given.
// Credentials come from .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).

import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return {}
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

const env = { ...loadEnv(path.join(root, '.env.local')), ...process.env }
const ownerEmail = opt('--owner-email')?.toLowerCase()
const accountIdArg = opt('--account-id')
const restoreFile = opt('--restore')
if ((!ownerEmail && !accountIdArg && !restoreFile) || !env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Usage: node scripts/archive-solar-records.mjs (--owner-email <email> | --account-id <uuid>) [--apply] [--include-flagged] [--include-demo-contacts] [--allow-remote]')
  console.error('       node scripts/archive-solar-records.mjs --restore <backup.json> [--allow-remote]')
  console.error('Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (.env.local).')
  process.exit(2)
}
const writes = flag('--apply') || Boolean(restoreFile)
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(env.NEXT_PUBLIC_SUPABASE_URL)
if (writes && !isLocal && !flag('--allow-remote')) {
  console.error(`Refusing to change non-local Supabase ${env.NEXT_PUBLIC_SUPABASE_URL}. Run the dry run first, then add --allow-remote.`)
  process.exit(2)
}

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

function must({ data, error }, what) {
  if (error) throw new Error(`${what}: ${error.message}`)
  return data
}

// Exact names created by the old scripts/seed-suraj-solar.mjs.
const AUTOMATION_PREFIX = 'Suraj Solar · '
const FLOW_NAME = 'Suraj Solar — Multilingual WhatsApp Lead Qualification'
// The generic sales starter ("capture name + email + company, hand off to sales").
const LEGACY_STARTER_FLOWS = ['Lead capture']
const TEMPLATE_PREFIX = 'solar_'
const QUICK_REPLY_TITLES = ['Documents needed', 'Book site survey', 'Subsidy information', 'Quotation shared']
// "Needs Human" is shared with V-Farms and deliberately kept.
const SOLAR_TAGS = [
  'New Enquiry', 'Residential', 'Commercial', 'Agricultural', 'Hot Lead', 'Bill Requested', 'Bill Received',
  'Quotation Requested', 'Quotation Sent', 'Follow-up Sent', 'Do Not Follow Up',
]
// Generic fields (Location, Lead source, Lead priority, Follow-up date, Lead status, …) are kept.
const SOLAR_FIELDS = [
  'Property type', 'Electricity bill amount', 'Solar requirement', 'Interested capacity (kW)', 'Installation type',
  'Installation timeline', 'Roof / site details',
]
const PIPELINE_NAME = 'Solar Sales'
const DEMO_PHONES = Array.from({ length: 8 }, (_, i) => `+91555550000${i + 1}`)
const FLAG = /\b(suraj|solar)\b/i
const OLD_ACCOUNT_NAME = /^\s*suraj solar\s*$/i

async function findUserId(email) {
  for (let page = 1; page <= 50; page++) {
    const { users } = must(await db.auth.admin.listUsers({ page, perPage: 200 }), 'list users')
    const hit = users.find((u) => u.email?.toLowerCase() === email)
    if (hit) return hit.id
    if (users.length < 200) return null
  }
  return null
}

async function rows(table, build) {
  return must(await build(db.from(table).select('*')), `load ${table}`) ?? []
}

async function collect(accountId) {
  const plan = { automations: [], flows: [], removals: [], kept: [], account: null, ai: [], review: [] }
  const flagged = flag('--include-flagged')

  const account = must(await db.from('accounts').select('id, name').eq('id', accountId).single(), 'load account')
  if (OLD_ACCOUNT_NAME.test(account.name)) plan.account = { id: account.id, from: account.name, to: 'V-Farms' }

  for (const a of await rows('ai_configs', (q) => q.eq('account_id', accountId))) {
    if (a.system_prompt && FLAG.test(a.system_prompt)) {
      plan.ai.push({ id: a.id, system_prompt: a.system_prompt, auto_reply_enabled: a.auto_reply_enabled })
    }
  }
  const demo = await rows('contacts', (q) => q.eq('account_id', accountId).in('phone', DEMO_PHONES))
  const removingDemo = new Set(flag('--include-demo-contacts') ? demo.map((c) => c.id) : [])
  // Usage by contacts that stay; a shared record is never removed from under a real contact.
  const usage = async (table, column, value) => {
    const found = must(await db.from(table).select('contact_id').eq(column, value), `usage ${table}`) ?? []
    return found.filter((r) => !removingDemo.has(r.contact_id)).length
  }

  const note = (what, row, take) => {
    if (take && flagged) return true
    plan.review.push(`${what} "${row.name ?? row.title}" mentions solar${take ? ' (add --include-flagged to archive)' : ''}`)
    return false
  }

  for (const a of (await rows('automations', (q) => q.eq('account_id', accountId))).filter((a) => !a.archived_at)) {
    const exact = a.name.startsWith(AUTOMATION_PREFIX)
    if (exact || (FLAG.test(`${a.name} ${a.description ?? ''}`) && note('automation', a, true))) plan.automations.push(a)
  }

  for (const f of (await rows('flows', (q) => q.eq('account_id', accountId))).filter((f) => f.status !== 'archived')) {
    const exact = f.name === FLOW_NAME || LEGACY_STARTER_FLOWS.includes(f.name)
    if (exact || (FLAG.test(`${f.name} ${f.description ?? ''}`) && note('flow', f, true))) plan.flows.push(f)
  }

  for (const t of await rows('message_templates', (q) => q.eq('account_id', accountId))) {
    const exact = t.name.startsWith(TEMPLATE_PREFIX)
    const mentions = FLAG.test(`${t.name} ${t.body_text ?? ''}`)
    if (!exact && !mentions) continue
    if (t.status !== 'DRAFT') plan.kept.push(`message template ${t.name} (status ${t.status}; submitted to Meta — remove it in WhatsApp Manager)`)
    else if (exact || note('draft template', t, true)) plan.removals.push({ table: 'message_templates', row: t, reason: 'solar draft template' })
  }

  for (const q of await rows('quick_replies', (b) => b.eq('account_id', accountId))) {
    const exact = QUICK_REPLY_TITLES.includes(q.title)
    if (exact || (FLAG.test(`${q.title} ${q.content_text ?? ''}`) && note('quick reply', q, true))) {
      plan.removals.push({ table: 'quick_replies', row: q, reason: 'solar quick reply' })
    }
  }

  for (const d of await rows('ai_knowledge_documents', (q) => q.eq('account_id', accountId))) {
    if (FLAG.test(`${d.title} ${d.content}`) && note('AI knowledge document', d, true)) {
      plan.removals.push({ table: 'ai_knowledge_documents', row: d, reason: 'solar AI knowledge (re-index after restore)' })
    }
  }

  for (const t of await rows('tags', (q) => q.eq('account_id', accountId).in('name', SOLAR_TAGS))) {
    const used = await usage('contact_tags', 'tag_id', t.id)
    if (used > 0) plan.kept.push(`tag "${t.name}" (on ${used} contact(s))`)
    else plan.removals.push({ table: 'tags', row: t, reason: 'solar tag' })
  }

  for (const f of await rows('custom_fields', (q) => q.eq('account_id', accountId).in('field_name', SOLAR_FIELDS))) {
    const used = await usage('contact_custom_values', 'custom_field_id', f.id)
    if (used > 0) plan.kept.push(`custom field "${f.field_name}" (has ${used} value(s))`)
    else plan.removals.push({ table: 'custom_fields', row: f, reason: 'solar custom field' })
  }

  const pipelines = await rows('pipelines', (q) => q.eq('account_id', accountId).eq('name', PIPELINE_NAME))
  for (const p of pipelines) {
    const used = await usage('deals', 'pipeline_id', p.id)
    if (used > 0) {
      plan.kept.push(`pipeline "${p.name}" (has ${used} deal(s))`)
      continue
    }
    const stages = await rows('pipeline_stages', (q) => q.eq('pipeline_id', p.id))
    plan.removals.push({ table: 'pipelines', row: p, reason: 'solar pipeline', children: { pipeline_stages: stages } })
  }

  for (const c of demo) {
    if (!flag('--include-demo-contacts')) {
      plan.kept.push(`demo contact ${c.name} ${c.phone} (add --include-demo-contacts to archive)`)
      continue
    }
    const conversations = await rows('conversations', (q) => q.eq('contact_id', c.id))
    const convIds = conversations.map((x) => x.id)
    const children = {
      conversations,
      messages: convIds.length ? await rows('messages', (q) => q.in('conversation_id', convIds)) : [],
      deals: await rows('deals', (q) => q.eq('contact_id', c.id)),
      contact_tags: await rows('contact_tags', (q) => q.eq('contact_id', c.id)),
      contact_custom_values: await rows('contact_custom_values', (q) => q.eq('contact_id', c.id)),
      contact_notes: await rows('contact_notes', (q) => q.eq('contact_id', c.id)),
    }
    // Contacts go first so their dependent rows are removed before the tags / fields / pipeline they reference.
    plan.removals.unshift({ table: 'contacts', row: c, reason: 'solar demo contact', children })
  }

  const solarTagIds = (await rows('tags', (q) => q.eq('account_id', accountId).in('name', SOLAR_TAGS))).map((t) => t.id)
  if (solarTagIds.length) {
    const tagged = await rows('contact_tags', (q) => q.in('tag_id', solarTagIds))
    const real = [...new Set(tagged.map((t) => t.contact_id))].filter((id) => !demo.some((c) => c.id === id))
    if (real.length) plan.review.push(`${real.length} real contact(s) carry solar tags — kept with their conversations; review them in Contacts`)
  }
  return plan
}

function label(r) {
  return r.row.name ?? r.row.title ?? r.row.field_name ?? r.row.id
}

function report(plan) {
  if (plan.account) console.log(`\nAccount name: "${plan.account.from}" → "${plan.account.to}"`)
  if (plan.ai.length) console.log(`AI assistant: solar system prompt will be cleared (snapshot kept) and auto-reply turned off`)
  console.log(`\nAutomations to archive (kept, disabled, hidden): ${plan.automations.length}`)
  for (const a of plan.automations) console.log(`  - ${a.name}${a.is_active ? ' (currently ACTIVE — will be turned off)' : ''}`)
  console.log(`Flows to archive (kept, status 'archived'): ${plan.flows.length}`)
  for (const f of plan.flows) console.log(`  - ${f.name} (status ${f.status})`)
  console.log(`Rows to snapshot and remove: ${plan.removals.length}`)
  for (const r of plan.removals) console.log(`  - ${r.table}: ${label(r)}`)
  if (plan.kept.length) {
    console.log('Left untouched:')
    for (const k of plan.kept) console.log(`  - ${k}`)
  }
  if (plan.review.length) {
    console.log('Needs manual review (not changed):')
    for (const k of plan.review) console.log(`  - ${k}`)
  }
}

async function archive(accountId) {
  const plan = await collect(accountId)
  report(plan)
  if (!flag('--apply')) {
    console.log('\nDry run — nothing changed. Re-run with --apply to archive.')
    return
  }
  const total = plan.automations.length + plan.flows.length + plan.removals.length + plan.ai.length + (plan.account ? 1 : 0)
  if (total === 0) {
    console.log('\nNothing to archive.')
    return
  }

  // Before migration 063 there is no legacy_archive table or automations.archived_at:
  // only the reversible steps run (the JSON backup holds every original value),
  // and removals wait until the migration is applied and the script is re-run.
  const { error: archiveTable } = await db.from('legacy_archive').select('id').limit(1)
  const { error: archivedCol } = await db.from('automations').select('archived_at').limit(1)
  const limited = Boolean(archiveTable || archivedCol)
  if (limited) {
    console.log('\nMigration 063 is not applied: turning solar automations OFF (not hiding them),')
    console.log('archiving flows, renaming the account and clearing the AI prompt only.')
    if (plan.removals.length) console.log(`${plan.removals.length} removal(s) deferred — apply the migrations, then re-run this script.`)
    plan.removals = []
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(root, 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `solar-archive-${accountId}-${stamp}.json`)
  fs.writeFileSync(file, JSON.stringify({ version: 1, account_id: accountId, created_at: new Date().toISOString(), limited, plan }, null, 2))
  console.log(`\nBackup written: ${path.relative(root, file)}`)

  const now = new Date().toISOString()
  if (plan.account) {
    must(await db.from('accounts').update({ name: plan.account.to }).eq('id', plan.account.id), 'rename account')
  }
  for (const a of plan.ai) {
    if (!limited) {
      must(
        await db.from('legacy_archive').insert({ account_id: accountId, source_table: 'ai_configs', source_id: a.id, snapshot: a, reason: 'solar AI system prompt' }),
        'snapshot AI prompt',
      )
    }
    must(await db.from('ai_configs').update({ system_prompt: null, auto_reply_enabled: false }).eq('id', a.id), 'clear AI prompt')
  }
  for (const a of plan.automations) {
    const change = limited ? { is_active: false } : { is_active: false, archived_at: now }
    must(await db.from('automations').update(change).eq('id', a.id), `archive automation ${a.name}`)
  }
  for (const f of plan.flows) {
    must(await db.from('flows').update({ status: 'archived' }).eq('id', f.id), `archive flow ${f.name}`)
  }
  for (const r of plan.removals) {
    must(
      await db.from('legacy_archive').insert({
        account_id: accountId,
        source_table: r.table,
        source_id: r.row.id,
        snapshot: { row: r.row, children: r.children ?? {} },
        reason: r.reason,
      }),
      `snapshot ${r.table} ${label(r)}`,
    )
    must(await db.from(r.table).delete().eq('id', r.row.id), `remove ${r.table} ${label(r)}`)
  }
  console.log(`Archived ${plan.automations.length} automation(s), ${plan.flows.length} flow(s); removed ${plan.removals.length} row(s) with snapshots.`)
  console.log(`To undo: node scripts/archive-solar-records.mjs --restore ${path.relative(root, file)}`)
}

const RESTORE_ORDER = ['pipeline_stages', 'conversations', 'messages', 'deals', 'contact_tags', 'contact_custom_values', 'contact_notes']
// Generated columns reject explicit values on insert.
const GENERATED = { contacts: ['phone_normalized'] }
const writable = (table, row) => {
  const out = { ...row }
  for (const col of GENERATED[table] ?? []) delete out[col]
  return out
}

async function restore(file) {
  const backup = JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8'))
  if (backup.version !== 1 || !backup.plan) throw new Error('Not a solar archive backup file')
  const { plan, account_id: accountId } = backup

  if (plan.account) must(await db.from('accounts').update({ name: plan.account.from }).eq('id', plan.account.id), 'restore account name')
  for (const a of plan.ai ?? []) {
    must(await db.from('ai_configs').update({ system_prompt: a.system_prompt, auto_reply_enabled: a.auto_reply_enabled }).eq('id', a.id), 'restore AI prompt')
  }
  for (const a of plan.automations) {
    // Restored disabled: re-enable deliberately from the Automations page if still wanted.
    if (backup.limited) continue
    must(await db.from('automations').update({ archived_at: null }).eq('id', a.id), `restore automation ${a.name}`)
  }
  for (const f of plan.flows) {
    must(await db.from('flows').update({ status: f.status }).eq('id', f.id), `restore flow ${f.name}`)
  }
  // Parents (tags, fields, pipelines, then contacts) before the rows that reference them.
  const parents = [...plan.removals].sort((x, y) => (x.table === 'contacts') - (y.table === 'contacts'))
  for (const r of parents) {
    must(await db.from(r.table).upsert(writable(r.table, r.row), { onConflict: 'id', ignoreDuplicates: true }), `restore ${r.table} ${label(r)}`)
  }
  for (const table of RESTORE_ORDER) {
    for (const r of parents) {
      const children = r.children?.[table] ?? []
      if (children.length === 0) continue
      const conflict = table === 'contact_tags' ? 'contact_id,tag_id' : 'id'
      must(await db.from(table).upsert(children.map((c) => writable(table, c)), { onConflict: conflict, ignoreDuplicates: true }), `restore ${table} for ${label(r)}`)
    }
  }
  const ids = [...plan.removals.map((r) => r.row.id), ...(plan.ai ?? []).map((a) => a.id)]
  if (ids.length && !backup.limited) {
    must(
      await db.from('legacy_archive').update({ restored_at: new Date().toISOString() }).eq('account_id', accountId).in('source_id', ids).is('restored_at', null),
      'mark snapshots restored',
    )
  }
  console.log(`Restored ${plan.automations.length} automation(s) (still disabled), ${plan.flows.length} flow(s) and ${plan.removals.length} row(s).`)
}

async function main() {
  if (restoreFile) return restore(restoreFile)
  if (accountIdArg) {
    console.log(`Account ${accountIdArg} on ${env.NEXT_PUBLIC_SUPABASE_URL}`)
    return archive(accountIdArg)
  }
  const userId = await findUserId(ownerEmail)
  if (!userId) throw new Error(`No user with email ${ownerEmail}`)
  const profile = must(await db.from('profiles').select('account_id').eq('user_id', userId).single(), 'load profile')
  console.log(`Account ${profile.account_id} (${ownerEmail}) on ${env.NEXT_PUBLIC_SUPABASE_URL}`)
  await archive(profile.account_id)
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`)
  process.exit(1)
})
