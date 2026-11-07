// Adds one E.164 number to property_settings.test_phone_numbers (bot sends for real to it in test mode).
// Usage: node --env-file=.env.local scripts/add-bot-test-number.mjs +916300729913
import { createClient } from '@supabase/supabase-js'

const number = process.argv[2]
if (!/^\+[1-9]\d{7,14}$/.test(number ?? '')) {
  console.error('Pass an E.164 number, e.g. +916300729913')
  process.exit(1)
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const { data, error } = await db.from('property_settings').select('account_id, test_phone_numbers')
if (error) throw error
for (const row of data) {
  const list = new Set(row.test_phone_numbers ?? [])
  list.add(number)
  const upd = await db
    .from('property_settings')
    .update({ test_phone_numbers: [...list] })
    .eq('account_id', row.account_id)
    .select('test_phone_numbers')
  console.log(row.account_id, upd.error?.message ?? upd.data)
}
