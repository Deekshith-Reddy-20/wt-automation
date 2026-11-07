import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { advanceLeadStage, maxPriority, scoreLeadPriority, type PrioritySignals } from './lifecycle'
import { daysBetween, todayIST } from './time'
import type { Lead, LeadSource, LeadStage } from './types'

const OPEN_STAGES_EXCLUDED = '(completed,cancelled,lost)'

export interface LeadFields {
  check_in?: string | null
  check_out?: string | null
  event_date?: string | null
  event_start_time?: string | null
  event_end_time?: string | null
  adults?: number | null
  children?: number | null
  children_ages?: number[] | null
  guest_count?: number | null
  purpose?: string | null
  special_requirements?: string | null
  budget_inr?: number | null
  estimated_quote_inr?: number | null
}

export interface LeadUpsert {
  accountId: string
  contactId?: string | null
  conversationId?: string | null
  phoneE164?: string | null
  customerName?: string | null
  email?: string | null
  source: LeadSource
  category?: Lead['category']
  fields?: LeadFields
  stage?: LeadStage
  signals?: Partial<PrioritySignals>
  consent?: 'granted' | 'revoked'
  now?: Date
}

function prune<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}

/**
 * Create or update the contact's single open lead. Repeat enquiries refine
 * the same lead (the partial unique index uq_leads_open_per_contact backs
 * this up), so a guest who asks twice is not counted twice.
 */
export async function upsertLead(db: SupabaseClient, input: LeadUpsert, attempt = 0): Promise<Lead> {
  const now = input.now ?? new Date()
  const existing = await findOpenLead(db, input.accountId, input.contactId ?? null, input.phoneE164 ?? null)

  const fields = prune(input.fields ?? {})
  const merged = { ...(existing ?? {}), ...fields } as Partial<Lead>
  const checkIn = merged.check_in ?? merged.event_date ?? null
  const signals: PrioritySignals = {
    has_dates: Boolean(checkIn),
    dates_within_days: checkIn ? daysBetween(todayIST(now), checkIn) : null,
    requested_quote: false,
    requested_booking: false,
    requested_human: false,
    availability_confirmed: false,
    ...input.signals,
  }
  const scored = scoreLeadPriority(signals)
  const priority = existing ? maxPriority(existing.priority, scored) : scored
  const stage = existing
    ? advanceLeadStage(existing.stage, input.stage ?? existing.stage)
    : (input.stage ?? 'new')

  const row = prune({
    account_id: input.accountId,
    contact_id: input.contactId ?? existing?.contact_id ?? null,
    conversation_id: input.conversationId ?? existing?.conversation_id ?? undefined,
    phone_e164: input.phoneE164 ?? existing?.phone_e164 ?? undefined,
    customer_name: input.customerName ?? undefined,
    email: input.email ?? undefined,
    category: input.category ?? undefined,
    ...fields,
    priority,
    stage,
    last_interaction_at: now.toISOString(),
    consent_status: input.consent ?? undefined,
  })

  if (existing) {
    const { data, error } = await db.from('leads').update(row).eq('id', existing.id).select('*').single()
    if (error) throw new Error(`Could not update lead: ${error.message}`)
    return data as Lead
  }

  const { data, error } = await db
    .from('leads')
    .insert({ ...row, source: input.source })
    .select('*')
    .single()
  if (error) {
    if (isUniqueViolation(error) && attempt === 0) {
      // A concurrent message created the lead first; refine that one.
      return upsertLead(db, input, 1)
    }
    throw new Error(`Could not create lead: ${error.message}`)
  }
  return data as Lead
}

export async function findOpenLead(
  db: SupabaseClient,
  accountId: string,
  contactId: string | null,
  phoneE164: string | null,
): Promise<Lead | null> {
  if (contactId) {
    const { data, error } = await db
      .from('leads')
      .select('*')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .not('stage', 'in', OPEN_STAGES_EXCLUDED)
      .maybeSingle()
    if (error) throw new Error(`Lead lookup failed: ${error.message}`)
    if (data) return data as Lead
  }
  if (phoneE164) {
    const { data, error } = await db
      .from('leads')
      .select('*')
      .eq('account_id', accountId)
      .eq('phone_e164', phoneE164)
      .not('stage', 'in', OPEN_STAGES_EXCLUDED)
      .order('updated_at', { ascending: false })
      .limit(1)
    if (error) throw new Error(`Lead lookup failed: ${error.message}`)
    if (data && data.length > 0) return data[0] as Lead
  }
  return null
}

/**
 * The contact for a website enquiry, so a later WhatsApp message from the
 * same number lands on the same contact, lead and history.
 */
export async function ensureContactForPhone(
  db: SupabaseClient,
  accountId: string,
  phoneE164: string,
  name: string | null,
): Promise<string> {
  const digits = phoneE164.replace(/^\+/, '')
  const existing = await findExistingContact(db, accountId, digits)
  if (existing) return existing.id

  const { data: account, error: accErr } = await db
    .from('accounts')
    .select('owner_user_id')
    .eq('id', accountId)
    .single()
  if (accErr || !account) throw new Error('Account not found')

  const { data, error } = await db
    .from('contacts')
    .insert({ account_id: accountId, user_id: account.owner_user_id, phone: digits, name })
    .select('id')
    .single()
  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(db, accountId, digits)
      if (raced) return raced.id
    }
    throw new Error(`Could not create contact: ${error.message}`)
  }
  return data.id as string
}

export async function recordConsent(
  db: SupabaseClient,
  entry: {
    accountId: string
    contactId: string | null
    phoneE164: string | null
    consentType: 'service' | 'marketing'
    status: 'granted' | 'revoked'
    source: 'whatsapp_inbound' | 'website_form' | 'stop_keyword' | 'start_keyword' | 'staff'
    evidence?: string
    recordedBy?: string | null
  },
): Promise<void> {
  try {
    const { error } = await db.from('consent_records').insert({
      account_id: entry.accountId,
      contact_id: entry.contactId,
      phone_e164: entry.phoneE164,
      consent_type: entry.consentType,
      status: entry.status,
      source: entry.source,
      evidence: entry.evidence?.slice(0, 500) ?? null,
      recorded_by: entry.recordedBy ?? null,
    })
    if (error) console.error('[resort] consent record failed:', error.message)
  } catch (err) {
    // The ledger is evidence, not the gate — contacts.opted_out_at is what blocks sends.
    console.error('[resort] consent record failed:', err instanceof Error ? err.message : err)
  }
}
