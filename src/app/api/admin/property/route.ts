import { NextResponse } from 'next/server'
import { adminRoute, dbError, parseBody } from '@/lib/resort/admin-http'
import { propertySettingsPatchSchema } from '@/lib/resort/admin-schemas'
import { CONFIG_CHECKLIST, loadPropertyBundle, missingSettings } from '@/lib/resort/property-store'

export const dynamic = 'force-dynamic'

export const GET = adminRoute('viewer', async ({ supabase, accountId }) => {
  const bundle = await loadPropertyBundle(supabase, accountId)
  const [amenities, faqs, media] = await Promise.all([
    supabase.from('amenities').select('*').eq('account_id', accountId).order('sort_order'),
    supabase.from('property_faqs').select('*').eq('account_id', accountId).order('sort_order'),
    supabase.from('property_media').select('*').eq('account_id', accountId).order('sort_order'),
  ])
  return NextResponse.json({
    settings: bundle.settings,
    amenities: amenities.data ?? [],
    faqs: faqs.data ?? [],
    media: media.data ?? [],
    checklist: CONFIG_CHECKLIST,
    missing: missingSettings(bundle.settings).map((m) => m.field),
  })
})

export const PATCH = adminRoute('admin', async ({ supabase, accountId, userId }, request) => {
  const parsed = await parseBody(request, propertySettingsPatchSchema)
  if (!parsed.ok) return parsed.response
  const patch = parsed.data

  if (patch.is_published === true) {
    const bundle = await loadPropertyBundle(supabase, accountId)
    const merged = { ...(bundle.settings ?? {}), ...patch }
    if (!merged.resort_name || !merged.whatsapp_number) {
      return NextResponse.json(
        { error: 'Set the resort name and WhatsApp number before publishing the website.' },
        { status: 422 },
      )
    }
  }

  const { data, error } = await supabase
    .from('property_settings')
    .upsert({ ...patch, account_id: accountId, updated_by: userId }, { onConflict: 'account_id' })
    .select('*')
    .single()
  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Another property is already published.' }, { status: 409 })
    }
    if (error.code === '42501') {
      return NextResponse.json({ error: 'You do not have permission to change property settings.' }, { status: 403 })
    }
    return dbError('Failed to save property settings', error)
  }
  return NextResponse.json({ settings: data })
})
