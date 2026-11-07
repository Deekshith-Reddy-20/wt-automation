import { describe, expect, it } from 'vitest'
import { accountAlertKind } from './account-access-alert'

describe('accountAlertKind', () => {
  it('a missing profiles table is reported as incomplete setup', () => {
    expect(accountAlertKind('error', "Could not find the table 'public.profiles' in the schema cache (PGRST205)")).toBe('schema')
    expect(accountAlertKind('error', 'relation "public.profiles" does not exist')).toBe('schema')
  })

  it('other failures stay generic errors and unlinked users stay unlinked', () => {
    expect(accountAlertKind('error', 'TypeError: Failed to fetch')).toBe('error')
    expect(accountAlertKind('error', null)).toBe('error')
    expect(accountAlertKind('unlinked', 'PGRST205')).toBe('unlinked')
  })
})
