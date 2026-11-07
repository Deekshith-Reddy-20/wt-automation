import { NextResponse } from 'next/server'
import { adminRoute } from '@/lib/resort/admin-http'
import { envIntegrationStatus, maskSecret, type IntegrationStatus } from '@/lib/resort/integrations'
import { msg91Configured } from '@/lib/msg91/env'

export const dynamic = 'force-dynamic'

/**
 * Connection status only. Razorpay and webhook secrets live in server
 * environment variables (never in the database or the browser); the
 * WhatsApp token is managed on the existing Settings → WhatsApp page,
 * which stores it encrypted. Neither is ever returned here.
 */
export const GET = adminRoute('admin', async ({ supabase, accountId }) => {
  const { data: wa } = await supabase
    .from('whatsapp_config')
    .select('phone_number_id, status, registered_at')
    .eq('account_id', accountId)
    .maybeSingle()

  const env = envIntegrationStatus()
  const viaMsg91 = msg91Configured()
  const status: IntegrationStatus = {
    ...env,
    whatsapp: {
      ...env.whatsapp,
      connected: viaMsg91 || wa?.status === 'connected',
      phone_number_id: maskSecret(viaMsg91 ? (process.env.MSG91_INTEGRATED_NUMBER?.trim() ?? null) : (wa?.phone_number_id ?? null)),
      registered: viaMsg91 || Boolean(wa?.registered_at),
    },
  }
  return NextResponse.json(status)
})
