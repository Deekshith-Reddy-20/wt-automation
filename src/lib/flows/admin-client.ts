import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseServiceConfig } from '@/lib/supabase/service-env'

// Lazy, shared service-role client for the Flows engine.
// Mirrors src/lib/automations/admin-client.ts — same shape so anyone
// reading either file picks up the convention immediately.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    const { url, serviceRoleKey } = getSupabaseServiceConfig()
    _adminClient = createClient(url, serviceRoleKey)
  }
  return _adminClient
}
