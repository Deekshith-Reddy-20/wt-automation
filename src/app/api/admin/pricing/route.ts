import { NextResponse } from 'next/server'
import { adminRoute, dbError, parseBody } from '@/lib/resort/admin-http'
import { PRICING_TABLES, pricingWriteSchema } from '@/lib/resort/admin-schemas'
import { loadPropertyBundle, missingPricing } from '@/lib/resort/property-store'

export const dynamic = 'force-dynamic'

/**
 * Pricing is written through the caller's RLS-scoped client, so the
 * database audit trigger records the signed-in admin as the actor and
 * RLS independently enforces the admin role.
 */
export const GET = adminRoute('viewer', async ({ supabase, accountId }) => {
  const bundle = await loadPropertyBundle(supabase, accountId)
  const [seasonal, packages, addons] = await Promise.all([
    supabase.from('seasonal_rates').select('*').eq('account_id', accountId).order('start_date'),
    supabase.from('event_packages').select('*').eq('account_id', accountId).order('sort_order'),
    supabase.from('addons').select('*').eq('account_id', accountId).order('name'),
  ])
  return NextResponse.json({
    rules: bundle.pricing.rules,
    seasonal_rates: seasonal.data ?? [],
    event_packages: packages.data ?? [],
    addons: addons.data ?? [],
    missing: missingPricing(bundle.pricing.rules),
  })
})

export const PUT = adminRoute('admin', async ({ supabase, accountId, userId }, request) => {
  const parsed = await parseBody(request, pricingWriteSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data

  if (body.entity === 'rules') {
    const { data, error } = await supabase
      .from('pricing_rules')
      .upsert({ ...body.data, account_id: accountId, updated_by: userId }, { onConflict: 'account_id' })
      .select('*')
      .single()
    if (error) return writeError(error)
    return NextResponse.json({ rules: data })
  }

  const table = PRICING_TABLES[body.entity]
  const { id, ...fields } = body.data
  const q = id
    ? supabase.from(table).update(fields).eq('account_id', accountId).eq('id', id)
    : supabase.from(table).insert({ ...fields, account_id: accountId })
  const { data, error } = await q.select('*').maybeSingle()
  if (error) return writeError(error)
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ item: data })
})

export const DELETE = adminRoute('admin', async ({ supabase, accountId }, request) => {
  const url = new URL(request.url)
  const entity = url.searchParams.get('entity') as keyof typeof PRICING_TABLES | null
  const id = url.searchParams.get('id')
  if (!entity || !(entity in PRICING_TABLES) || !id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'entity and id are required' }, { status: 400 })
  }
  const { error, count } = await supabase
    .from(PRICING_TABLES[entity])
    .delete({ count: 'exact' })
    .eq('account_id', accountId)
    .eq('id', id)
  if (error) return dbError('Failed to delete', error)
  if (!count) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
})

function writeError(error: { code?: string; message?: string }) {
  if (error.code === '23P01') {
    return NextResponse.json({ error: 'This rate overlaps another active rate of the same kind.' }, { status: 409 })
  }
  if (error.code === '23514') {
    return NextResponse.json({ error: 'A value is outside the allowed range.' }, { status: 422 })
  }
  if (error.code === '42501') {
    return NextResponse.json({ error: 'You do not have permission to change pricing.' }, { status: 403 })
  }
  return dbError('Failed to save pricing', error)
}
