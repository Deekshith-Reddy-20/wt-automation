import { NextResponse } from 'next/server'
import { adminRoute, dbError, parseBody } from '@/lib/resort/admin-http'
import { leadNoteSchema } from '@/lib/resort/admin-schemas'

export const dynamic = 'force-dynamic'

export const POST = adminRoute<{ id: string }>('agent', async ({ supabase, accountId, userId }, request, { id }) => {
  const parsed = await parseBody(request, leadNoteSchema)
  if (!parsed.ok) return parsed.response

  const { data: lead } = await supabase.from('leads').select('id').eq('account_id', accountId).eq('id', id).maybeSingle()
  if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })

  const { data, error } = await supabase
    .from('lead_notes')
    .insert({ account_id: accountId, lead_id: id, author_user_id: userId, body: parsed.data.body })
    .select('id, body, author_user_id, created_at')
    .single()
  if (error) return dbError('Failed to add note', error)
  await supabase.from('leads').update({ last_interaction_at: new Date().toISOString() }).eq('id', id)
  return NextResponse.json({ note: data }, { status: 201 })
})
