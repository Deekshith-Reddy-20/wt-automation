import { NextResponse } from 'next/server'
import { adminRoute, dbError } from '@/lib/resort/admin-http'
import { dryRunForced } from '@/lib/resort/bot/provider'

export const dynamic = 'force-dynamic'

type WhatsAppMode = 'not_connected' | 'dry_run' | 'test_mode' | 'bot_off' | 'live'

/**
 * Bot conversation states (default: the human-handoff queue), each with
 * the guest's latest booking request, plus how WhatsApp is actually
 * operating right now. `q` searches guest name, phone and booking reference.
 */
export const GET = adminRoute('viewer', async ({ supabase, accountId }, request) => {
  const url = new URL(request.url)
  const mode = url.searchParams.get('mode') ?? 'human'
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 80)

  let query = supabase
    .from('conversation_states')
    .select('id, conversation_id, contact_id, lead_id, flow, step, bot_mode, handoff_reason, handoff_at, resumed_at, last_inbound_at, updated_at, contacts(name, phone)')
    .eq('account_id', accountId)
    .order('last_inbound_at', { ascending: false, nullsFirst: false })
    .limit(100)
  if (mode === 'human' || mode === 'bot') query = query.eq('bot_mode', mode)

  if (q) {
    const safe = q.replace(/[%,()*\\]/g, ' ').trim()
    const digits = q.replace(/\D/g, '')
    const contactFilters = [`name.ilike.%${safe}%`, ...(digits.length >= 4 ? [`phone.ilike.%${digits}%`] : [])]
    const [{ data: contacts, error: cErr }, { data: bookings, error: bErr }] = await Promise.all([
      supabase.from('contacts').select('id').eq('account_id', accountId).or(contactFilters.join(',')).limit(200),
      supabase.from('bookings').select('conversation_id').eq('account_id', accountId).ilike('booking_ref', `%${safe}%`).not('conversation_id', 'is', null).limit(200),
    ])
    if (cErr) return dbError('Failed to search contacts', cErr)
    if (bErr) return dbError('Failed to search bookings', bErr)
    const contactIds = (contacts ?? []).map((c) => c.id as string)
    const convIds = (bookings ?? []).map((b) => b.conversation_id as string)
    if (contactIds.length === 0 && convIds.length === 0) {
      return NextResponse.json({ conversations: [], whatsapp: await whatsappMode(supabase, accountId) })
    }
    const ors = [
      ...(contactIds.length ? [`contact_id.in.(${contactIds.join(',')})`] : []),
      ...(convIds.length ? [`conversation_id.in.(${convIds.join(',')})`] : []),
    ]
    query = query.or(ors.join(','))
  }

  const { data, error } = await query
  if (error) return dbError('Failed to load conversations', error)
  const rows = data ?? []

  const ids = rows.map((r) => r.conversation_id as string)
  const latest = new Map<string, Record<string, unknown>>()
  if (ids.length) {
    const { data: bookings, error: bErr } = await supabase
      .from('bookings')
      .select('id, conversation_id, booking_ref, booking_type, status, check_in, check_out, event_date, event_start_time, event_end_time, guest_count, quoted_total, created_at')
      .eq('account_id', accountId)
      .in('conversation_id', ids)
      .order('created_at', { ascending: false })
    if (bErr) return dbError('Failed to load bookings', bErr)
    for (const b of bookings ?? []) if (!latest.has(b.conversation_id as string)) latest.set(b.conversation_id as string, b)
  }

  return NextResponse.json({
    conversations: rows.map((r) => ({ ...r, booking: latest.get(r.conversation_id as string) ?? null })),
    whatsapp: await whatsappMode(supabase, accountId),
  })
})

async function whatsappMode(
  supabase: Parameters<Parameters<typeof adminRoute>[1]>[0]['supabase'],
  accountId: string,
): Promise<{ mode: WhatsAppMode; connected: boolean }> {
  const [{ data: wa }, { data: settings }] = await Promise.all([
    supabase.from('whatsapp_config').select('status').eq('account_id', accountId).maybeSingle(),
    supabase.from('property_settings').select('bot_enabled, test_mode').eq('account_id', accountId).maybeSingle(),
  ])
  const connected = wa?.status === 'connected'
  if (!connected) return { mode: 'not_connected', connected }
  if (dryRunForced()) return { mode: 'dry_run', connected }
  if (!settings?.bot_enabled) return { mode: 'bot_off', connected }
  if (settings.test_mode) return { mode: 'test_mode', connected }
  return { mode: 'live', connected }
}
