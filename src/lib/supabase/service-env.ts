/**
 * Validated SERVER-ONLY Supabase configuration (URL + service-role key).
 *
 * The service-role key bypasses row-level security. Never import this
 * module from a "use client" file — src/lib/resort/security.test.ts fails
 * the build's test run if one does. In a browser bundle the key would be
 * undefined anyway (it has no NEXT_PUBLIC_ prefix), so this throws there.
 */
import { SupabaseConfigError, validateSupabaseKey, validateSupabaseUrl } from './env'

export interface SupabaseServiceConfig {
  url: string
  serviceRoleKey: string
}

export function getSupabaseServiceConfig(): SupabaseServiceConfig {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || null
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null
  const missing = [!url && 'NEXT_PUBLIC_SUPABASE_URL', !serviceRoleKey && 'SUPABASE_SERVICE_ROLE_KEY'].filter(Boolean) as string[]
  if (missing.length) throw new SupabaseConfigError(missing)
  if (serviceRoleKey!.startsWith('sb_publishable_')) {
    throw new SupabaseConfigError(
      ['SUPABASE_SERVICE_ROLE_KEY'],
      'SUPABASE_SERVICE_ROLE_KEY holds the publishable key (sb_publishable_…); it needs the secret key (sb_secret_…)',
    )
  }
  return {
    url: validateSupabaseUrl(url),
    serviceRoleKey: validateSupabaseKey(serviceRoleKey, 'SUPABASE_SERVICE_ROLE_KEY'),
  }
}

export function isSupabaseServiceConfigured(): boolean {
  try {
    getSupabaseServiceConfig()
    return true
  } catch {
    return false
  }
}
