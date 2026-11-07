import { cache } from 'react'
import { connection } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { databaseConfigured } from './http'
import { loadPropertyBundle, loadPublicProperty, loadPublishedFaqs, type PropertyBundle, type PublicProperty } from './property-store'

export type PublicSite =
  | { state: 'ok'; accountId: string; property: PublicProperty }
  | { state: 'unpublished' }
  | { state: 'not_configured' }
  | { state: 'error' }

/**
 * The published property for server-rendered public pages. Uses the
 * service-role client on the server only, and returns only fields the
 * owner has published / approved.
 */
export const getPublicSite = cache(async (): Promise<PublicSite> => {
  await connection()
  if (!databaseConfigured()) return { state: 'not_configured' }
  try {
    const result = await loadPublicProperty(supabaseAdmin())
    return result ? { state: 'ok', ...result } : { state: 'unpublished' }
  } catch (err) {
    console.error('[resort] public property load failed:', err instanceof Error ? err.message : err)
    return { state: 'error' }
  }
})

export const getPublicFaqs = cache(async (accountId: string) => {
  try {
    return await loadPublishedFaqs(supabaseAdmin(), accountId)
  } catch {
    return []
  }
})

export const getPublicBundle = cache(async (accountId: string): Promise<PropertyBundle | null> => {
  try {
    return await loadPropertyBundle(supabaseAdmin(), accountId)
  } catch (err) {
    console.error('[resort] property bundle load failed:', err instanceof Error ? err.message : err)
    return null
  }
})

/** wa.me link for the configured WhatsApp number, or null. */
export function whatsappLink(number: string | null, text?: string): string | null {
  if (!number) return null
  const digits = number.replace(/\D/g, '')
  if (digits.length < 8) return null
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`
}
