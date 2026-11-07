/**
 * Validated public Supabase configuration (URL + anon key).
 *
 * Safe for browser bundles: it only reads NEXT_PUBLIC_* variables, and
 * reads them as literal `process.env.NEXT_PUBLIC_…` expressions so Next.js
 * can inline them at build time. The service-role key lives in
 * ./service-env.ts, which client code must never import.
 */

export class SupabaseConfigError extends Error {
  readonly missing: string[]

  constructor(missing: string[], detail?: string) {
    super(
      `Supabase is not configured: ${detail ?? `missing ${missing.join(', ')}`}. ` +
        'Set these in .env.local for local development (copy .env.example) or in your hosting provider\'s ' +
        'environment settings, then restart the server. Values are in Supabase → Project Settings → API.',
    )
    this.name = 'SupabaseConfigError'
    this.missing = missing
  }
}

// Values copied verbatim from .env.example / .env.local.example templates.
const PLACEHOLDER = /^(your-|replace-with-|replace-me|changeme|<)|your-project(-ref)?\.supabase\.co/i

function clean(value: string | undefined): string | null {
  const v = value?.trim()
  return v ? v : null
}

export function validateSupabaseUrl(raw: string | null, name = 'NEXT_PUBLIC_SUPABASE_URL'): string {
  if (!raw) throw new SupabaseConfigError([name])
  if (PLACEHOLDER.test(raw)) throw new SupabaseConfigError([name], `${name} still holds the example placeholder`)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SupabaseConfigError([name], `${name} is not a valid URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SupabaseConfigError([name], `${name} must start with https://`)
  }
  return raw.replace(/\/+$/, '')
}

export function validateSupabaseKey(raw: string | null, name: string): string {
  if (!raw) throw new SupabaseConfigError([name])
  if (PLACEHOLDER.test(raw)) throw new SupabaseConfigError([name], `${name} still holds the example placeholder`)
  return raw
}

export interface SupabasePublicConfig {
  url: string
  anonKey: string
}

/** URL + anon key, or throws SupabaseConfigError naming what is missing. */
export function getSupabasePublicConfig(): SupabasePublicConfig {
  const url = clean(process.env.NEXT_PUBLIC_SUPABASE_URL)
  const anonKey = clean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const missing = [!url && 'NEXT_PUBLIC_SUPABASE_URL', !anonKey && 'NEXT_PUBLIC_SUPABASE_ANON_KEY'].filter(Boolean) as string[]
  if (missing.length) throw new SupabaseConfigError(missing)
  if (anonKey!.startsWith('sb_secret_')) {
    throw new SupabaseConfigError(
      ['NEXT_PUBLIC_SUPABASE_ANON_KEY'],
      'NEXT_PUBLIC_SUPABASE_ANON_KEY holds a secret key (sb_secret_…), which would be sent to every browser. Use the publishable key (sb_publishable_…) there and put the secret key in SUPABASE_SERVICE_ROLE_KEY',
    )
  }
  return {
    url: validateSupabaseUrl(url),
    anonKey: validateSupabaseKey(anonKey, 'NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  }
}

export function isSupabasePublicConfigured(): boolean {
  try {
    getSupabasePublicConfig()
    return true
  } catch {
    return false
  }
}

export function isSupabaseConfigError(err: unknown): err is SupabaseConfigError {
  return err instanceof SupabaseConfigError
}
