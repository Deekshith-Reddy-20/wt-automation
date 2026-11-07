// Hands one test conversation back to the bot (menu start). Usage: node scripts/reset-test-conversation.mjs <conversation_id>
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^"|"$/g, '')]),
)
const conversationId = process.argv[2]
if (!conversationId) throw new Error('conversation id required')

const s = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const { data, error } = await s
  .from('conversation_states')
  .update({ bot_mode: 'bot', flow: 'menu', step: 'start', data: {}, handoff_reason: null, handoff_at: null })
  .eq('conversation_id', conversationId)
  .select('conversation_id, bot_mode, flow, step')
console.log(error?.message ?? data)
