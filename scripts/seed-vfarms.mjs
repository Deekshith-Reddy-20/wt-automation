#!/usr/bin/env node
// Create the V-Farms property profile for ONE existing account.
//
//   node scripts/seed-vfarms.mjs --owner-email you@example.com           # create if missing
//   node scripts/seed-vfarms.mjs --owner-email you@example.com --check   # report only
//
// Writes ONLY facts the business has stated: name, five acres, five rooms,
// dragon fruit farm near Hyderabad, booked as one exclusive estate. Every
// other detail (rates, capacity, check-in/out, amenities, policies, address,
// WhatsApp number …) is left empty so the admin panel shows it as
// "Not configured" until the owner enters it. Nothing is overwritten if a
// profile already exists. The website stays unpublished, the WhatsApp bot
// off and test mode on.
//
// Credentials come from .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).
// The owner must already have signed up at /signup (see README.md, "Turning on the resort automation").

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
if (!ownerEmail || !env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Usage: node scripts/seed-vfarms.mjs --owner-email <email> [--check]')
  console.error('Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (.env.local).')
  process.exit(2)
}

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

function must({ data, error }, what) {
  if (error) throw new Error(`${what}: ${error.message}`)
  return data
}

async function findUserId(email) {
  for (let page = 1; page <= 50; page++) {
    const { users } = must(await db.auth.admin.listUsers({ page, perPage: 200 }), 'list users')
    const hit = users.find((u) => u.email?.toLowerCase() === email)
    if (hit) return hit.id
    if (users.length < 200) return null
  }
  return null
}

// Stated by the business. Anything not listed here is intentionally absent.
const CONFIRMED = {
  resort_name: 'V-Farms',
  property_area_acres: 5,
  room_count: 5,
  locality: 'Near Hyderabad',
  farm_description: 'A private five-acre dragon fruit farm.',
  description:
    'A private dragon fruit farm resort near Hyderabad with five rooms, booked only as one exclusive estate for overnight stays or private events.',
}

const CHECKLIST = [
  ['whatsapp_number', 'WhatsApp business number'],
  ['address', 'Full address'],
  ['map_url', 'Google Maps link'],
  ['check_in_time', 'Check-in time'],
  ['check_out_time', 'Check-out time'],
  ['max_stay_guests', 'Maximum overnight guests'],
  ['max_event_guests', 'Maximum event guests'],
  ['cancellation_policy', 'Cancellation policy'],
  ['refund_policy', 'Refund policy'],
  ['guest_policies', 'House rules'],
  ['food_info', 'Food / meals information'],
  ['privacy_policy', 'Privacy policy'],
  ['terms', 'Terms'],
]

async function main() {
  const userId = await findUserId(ownerEmail)
  if (!userId) throw new Error(`No user with email ${ownerEmail}. Sign up at /signup first.`)
  const profile = must(await db.from('profiles').select('account_id, account_role').eq('user_id', userId).maybeSingle(), 'profile')
  if (!profile) throw new Error('That user has no profile/account.')
  if (!['owner', 'admin'].includes(profile.account_role)) throw new Error(`User is ${profile.account_role}; an owner or admin is required.`)
  const accountId = profile.account_id

  let settings = must(await db.from('property_settings').select('*').eq('account_id', accountId).maybeSingle(), 'property settings')
  if (!settings && !flag('--check')) {
    settings = must(
      await db
        .from('property_settings')
        .insert({ account_id: accountId, ...CONFIRMED, is_published: false, bot_enabled: false, test_mode: true, payments_enabled: false, manual_approval_required: true })
        .select('*')
        .single(),
      'create property settings',
    )
    console.log('Created the V-Farms property profile (unpublished, bot off, test mode on).')
  } else if (settings) {
    console.log('A property profile already exists; nothing was changed.')
  }

  let rules = must(await db.from('pricing_rules').select('*').eq('account_id', accountId).maybeSingle(), 'pricing rules')
  if (!rules && !flag('--check')) {
    rules = must(await db.from('pricing_rules').insert({ account_id: accountId }).select('*').single(), 'create pricing rules')
    console.log('Created an empty pricing profile (no rates — the bot and website will say pricing is not configured).')
  }

  console.log('\nStill to be entered in Dashboard → V-Farms Resort:')
  for (const [key, label] of CHECKLIST) if (!settings?.[key]) console.log(`  • ${label}`)
  if (!rules?.weekday_night_rate) console.log('  • Weekday nightly rate')
  if (!rules?.weekend_night_rate) console.log('  • Weekend nightly rate')
  if (!rules?.deposit_pct && !rules?.deposit_fixed_amount) console.log('  • Advance / deposit rule (needed for online payments)')
  console.log('  • Amenities, FAQs, verified property photos, event packages, add-ons')
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
