import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { createFakeDb } from '../flows/fake-db.test-helper'
import { RESORT_TAGS, applyResortTags } from './tags'

function setup() {
  const tables: Record<string, Record<string, unknown>[]> = {
    accounts: [{ id: 'acc', owner_user_id: 'owner' }],
    tags: [],
    contact_tags: [],
  }
  return { tables, db: createFakeDb(tables) as unknown as SupabaseClient }
}

const tagNames = (tables: Record<string, Record<string, unknown>[]>) =>
  tables.contact_tags.map((ct) => tables.tags.find((t) => t.id === ct.tag_id)?.name).sort()

describe('resort tags', () => {
  it('defines the 13 V-Farms tags', () => {
    expect(Object.keys(RESORT_TAGS)).toHaveLength(13)
    expect(Object.values(RESORT_TAGS).map((t) => t.name)).toContain('Needs Human')
  })

  it('creates missing tags with the account owner and attaches them', async () => {
    const { tables, db } = setup()
    await applyResortTags(db, 'acc', 'c1', { add: ['new_guest', 'stay_enquiry'] })
    expect(tables.tags.every((t) => t.user_id === 'owner' && t.account_id === 'acc')).toBe(true)
    expect(tagNames(tables)).toEqual(['New Guest', 'Stay Enquiry'])
  })

  it('moving forward through the booking stages clears earlier stage tags', async () => {
    const { tables, db } = setup()
    await applyResortTags(db, 'acc', 'c1', { add: ['quote_sent'] })
    await applyResortTags(db, 'acc', 'c1', { add: ['pending_payment'] })
    expect(tagNames(tables)).toEqual(['Pending Payment'])
    await applyResortTags(db, 'acc', 'c1', { add: ['confirmed_booking', 'returning_guest'] })
    expect(tagNames(tables)).toEqual(['Confirmed Booking', 'Returning Guest'])
  })

  it('removing a tag never creates it', async () => {
    const { tables, db } = setup()
    await applyResortTags(db, 'acc', 'c1', { remove: ['needs_human'] })
    expect(tables.tags).toHaveLength(0)
  })

  it('does nothing without a contact', async () => {
    const { tables, db } = setup()
    await applyResortTags(db, 'acc', null, { add: ['new_guest'] })
    expect(tables.tags).toHaveLength(0)
  })
})
