// Last messages + bot state for one conversation. Usage: node scripts/show-conversation.mjs <conversation_id> [count]
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^"|"$/g, '')]),
)
const [conversationId, count = '4'] = process.argv.slice(2)
if (!conversationId) throw new Error('conversation id required')

const s = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const [{ data: msgs }, { data: state }] = await Promise.all([
  s.from('messages').select('sender_type, content_text, created_at').eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(Number(count)),
  s.from('conversation_states').select('bot_mode, flow, step').eq('conversation_id', conversationId).maybeSingle(),
])
for (const m of (msgs ?? []).reverse()) console.log(`--- ${m.sender_type} ${m.created_at}\n${m.content_text}`)
console.log('\nstate:', state)
