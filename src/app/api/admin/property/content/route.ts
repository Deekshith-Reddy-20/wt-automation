import { NextResponse } from 'next/server'
import { adminRoute, dbError, parseBody } from '@/lib/resort/admin-http'
import { CONTENT_TABLES, contentWriteSchema } from '@/lib/resort/admin-schemas'

export const dynamic = 'force-dynamic'

/** Amenities, FAQs and photos. Only approved / published rows reach the website and bot. */
export const PUT = adminRoute('admin', async ({ supabase, accountId, userId }, request) => {
  const parsed = await parseBody(request, contentWriteSchema)
  if (!parsed.ok) return parsed.response
  const table = CONTENT_TABLES[parsed.data.entity]
  const { id, ...fields } = parsed.data.data
  const extra = parsed.data.entity === 'media' && !id ? { uploaded_by: userId } : {}
  const q = id
    ? supabase.from(table).update(fields).eq('account_id', accountId).eq('id', id)
    : supabase.from(table).insert({ ...fields, ...extra, account_id: accountId })
  const { data, error } = await q.select('*').maybeSingle()
  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'An item with that name already exists.' }, { status: 409 })
    if (error.code === '42501') return NextResponse.json({ error: 'You do not have permission to edit property content.' }, { status: 403 })
    return dbError('Failed to save', error)
  }
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ item: data })
})

export const DELETE = adminRoute('admin', async ({ supabase, accountId }, request) => {
  const url = new URL(request.url)
  const entity = url.searchParams.get('entity') as keyof typeof CONTENT_TABLES | null
  const id = url.searchParams.get('id')
  if (!entity || !(entity in CONTENT_TABLES) || !id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'entity and id are required' }, { status: 400 })
  }
  const { error, count } = await supabase
    .from(CONTENT_TABLES[entity])
    .delete({ count: 'exact' })
    .eq('account_id', accountId)
    .eq('id', id)
  if (error) return dbError('Failed to delete', error)
  if (!count) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
})
