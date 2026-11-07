/**
 * Integration status for the dashboard. Secrets are reported only as
 * "configured / not configured"; identifiers are masked to their last
 * four characters. Nothing here ever returns a secret value.
 */

export function maskSecret(value: string | null | undefined, visible = 4): string | null {
  if (!value) return null
  const v = value.trim()
  if (v.length <= visible) return '•'.repeat(v.length)
  const prefix = /^rzp_(test|live)_/.exec(v)?.[0] ?? ''
  return `${prefix}${'•'.repeat(8)}${v.slice(-visible)}`
}

const isSet = (name: string) => Boolean(process.env[name]?.trim())

export interface IntegrationStatus {
  razorpay: {
    key_id: string | null
    key_secret_configured: boolean
    webhook_secret_configured: boolean
    mode: 'test' | 'live' | 'unknown' | null
  }
  whatsapp: {
    connected: boolean
    phone_number_id: string | null
    registered: boolean
    dry_run_forced: boolean
    verify_token_configured: boolean
    app_secret_configured: boolean
    webhook_path: string
  }
  supabase: { url_configured: boolean; service_role_configured: boolean }
  cron: { secret_configured: boolean; path: string }
  site_url: string | null
}

export function envIntegrationStatus(): Omit<IntegrationStatus, 'whatsapp'> & {
  whatsapp: Pick<IntegrationStatus['whatsapp'], 'dry_run_forced' | 'verify_token_configured' | 'app_secret_configured' | 'webhook_path'>
} {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim() || null
  return {
    razorpay: {
      key_id: maskSecret(keyId),
      key_secret_configured: isSet('RAZORPAY_KEY_SECRET'),
      webhook_secret_configured: isSet('RAZORPAY_WEBHOOK_SECRET'),
      mode: keyId ? (keyId.startsWith('rzp_live_') ? 'live' : keyId.startsWith('rzp_test_') ? 'test' : 'unknown') : null,
    },
    whatsapp: {
      dry_run_forced: process.env.WHATSAPP_DRY_RUN === 'true',
      verify_token_configured: isSet('WHATSAPP_VERIFY_TOKEN'),
      app_secret_configured: isSet('META_APP_SECRET'),
      webhook_path: '/api/whatsapp/webhook',
    },
    supabase: {
      url_configured: isSet('NEXT_PUBLIC_SUPABASE_URL'),
      service_role_configured: isSet('SUPABASE_SERVICE_ROLE_KEY'),
    },
    cron: { secret_configured: isSet('CRON_SECRET') || isSet('AUTOMATION_CRON_SECRET'), path: '/api/resort/cron' },
    site_url: process.env.NEXT_PUBLIC_SITE_URL?.trim() || null,
  }
}
