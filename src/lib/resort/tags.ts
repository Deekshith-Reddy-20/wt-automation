import type { SupabaseClient } from '@supabase/supabase-js'

/** The V-Farms guest tags. Created on first use per account. */
export const RESORT_TAGS = {
  new_guest: { name: 'New Guest', color: '#22c55e' },
  stay_enquiry: { name: 'Stay Enquiry', color: '#16a34a' },
  event_enquiry: { name: 'Event Enquiry', color: '#a855f7' },
  availability_requested: { name: 'Availability Requested', color: '#0ea5e9' },
  quote_requested: { name: 'Quote Requested', color: '#f59e0b' },
  quote_sent: { name: 'Quote Sent', color: '#eab308' },
  booking_requested: { name: 'Booking Requested', color: '#f97316' },
  pending_payment: { name: 'Pending Payment', color: '#ef4444' },
  confirmed_booking: { name: 'Confirmed Booking', color: '#15803d' },
  returning_guest: { name: 'Returning Guest', color: '#0d9488' },
  needs_human: { name: 'Needs Human', color: '#dc2626' },
  follow_up_due: { name: 'Follow-up Due', color: '#6366f1' },
  do_not_contact: { name: 'Do Not Contact', color: '#6b7280' },
} as const
export type ResortTag = keyof typeof RESORT_TAGS

/** Tags that describe one stage of an enquiry; moving forward clears the earlier ones. */
const PROGRESSION: ResortTag[] = ['quote_requested', 'quote_sent', 'booking_requested', 'pending_payment', 'confirmed_booking']

async function tagIds(db: SupabaseClient, accountId: string, tags: ResortTag[], create: boolean): Promise<Map<ResortTag, string>> {
  if (tags.length === 0) return new Map()
  const names = tags.map((t) => RESORT_TAGS[t].name)
  const { data, error } = await db.from('tags').select('id, name').eq('account_id', accountId).in('name', names)
  if (error) throw new Error(`Could not load tags: ${error.message}`)
  const byName = new Map((data ?? []).map((r) => [r.name as string, r.id as string]))
  const missing = create ? tags.filter((t) => !byName.has(RESORT_TAGS[t].name)) : []
  if (missing.length > 0) {
    const { data: account, error: accErr } = await db.from('accounts').select('owner_user_id').eq('id', accountId).maybeSingle()
    if (accErr || !account) throw new Error('Could not resolve the account owner for new tags')
    const { data: created, error: insErr } = await db
      .from('tags')
      .insert(missing.map((t) => ({ account_id: accountId, user_id: account.owner_user_id, name: RESORT_TAGS[t].name, color: RESORT_TAGS[t].color })))
      .select('id, name')
    if (insErr) throw new Error(`Could not create tags: ${insErr.message}`)
    for (const r of created ?? []) byName.set(r.name as string, r.id as string)
  }
  const out = new Map<ResortTag, string>()
  for (const t of tags) {
    const id = byName.get(RESORT_TAGS[t].name)
    if (id) out.set(t, id)
  }
  return out
}

/**
 * Add / remove V-Farms tags on a contact. Never throws — tagging is
 * bookkeeping and must not break the guest-facing action.
 */
export async function applyResortTags(
  db: SupabaseClient,
  accountId: string,
  contactId: string | null | undefined,
  change: { add?: ResortTag[]; remove?: ResortTag[] },
): Promise<void> {
  if (!contactId) return
  const add = change.add ?? []
  const progressed = add.filter((t) => PROGRESSION.includes(t))
  const furthest = progressed.length > 0 ? Math.max(...progressed.map((t) => PROGRESSION.indexOf(t))) : -1
  const remove = [...new Set([...(change.remove ?? []), ...(furthest > 0 ? PROGRESSION.slice(0, furthest) : [])])].filter(
    (t) => !add.includes(t),
  )
  try {
    const addIds = await tagIds(db, accountId, add, true)
    const rows = add.flatMap((t) => (addIds.get(t) ? [{ contact_id: contactId, tag_id: addIds.get(t)! }] : []))
    if (rows.length > 0) {
      const { error } = await db.from('contact_tags').upsert(rows, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true })
      if (error) throw new Error(error.message)
    }
    const existing = await tagIds(db, accountId, remove, false)
    const removeIds = remove.flatMap((t) => (existing.get(t) ? [existing.get(t)!] : []))
    if (removeIds.length > 0) {
      const { error } = await db.from('contact_tags').delete().eq('contact_id', contactId).in('tag_id', removeIds)
      if (error) throw new Error(error.message)
    }
  } catch (err) {
    console.error('[resort-tags] could not update tags:', err instanceof Error ? err.message : err)
  }
}
