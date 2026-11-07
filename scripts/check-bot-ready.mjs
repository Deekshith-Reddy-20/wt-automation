// Read-only readiness check for the MSG91 → resort bot path. Usage: node scripts/check-bot-ready.mjs [customer_digits]
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^"|"$/g, '')]),
)
const phone = (process.argv[2] ?? '916300729913').replace(/\D/g, '')
const s = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

console.log('env MSG91_AUTHKEY set:', Boolean(env.MSG91_AUTHKEY))
console.log('env MSG91_INTEGRATED_NUMBER:', env.MSG91_INTEGRATED_NUMBER ?? '(missing)')
console.log('env MSG91_WEBHOOK_SECRET set:', Boolean(env.MSG91_WEBHOOK_SECRET), '| MSG91_DRY_RUN:', env.MSG91_DRY_RUN ?? '(unset)')

const { data: settings } = await s.from('property_settings').select('account_id, bot_enabled, test_mode, test_phone_numbers')
console.log('property_settings:', settings)
const { data: autos } = await s.from('resort_automations').select('key, is_enabled').eq('key', 'welcome_menu')
console.log('welcome_menu automation:', autos)

const { data: contacts } = await s.from('contacts').select('id, phone').ilike('phone', `%${phone.slice(-10)}`)
for (const c of contacts ?? []) {
  const { data: convs } = await s.from('conversations').select('id, status').eq('contact_id', c.id)
  for (const cv of convs ?? []) {
    const { data: st } = await s.from('conversation_states').select('bot_mode, flow, step, updated_at').eq('conversation_id', cv.id).maybeSingle()
    console.log('conversation', cv.id, cv.status, 'state:', st)
  }
}
