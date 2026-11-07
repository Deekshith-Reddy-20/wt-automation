import { describe, expect, it } from 'vitest'
import {
  AUTOMATION_CONFIG_SCHEMAS,
  DEFAULT_STAY_TEXT,
  DEFAULT_WELCOME_TEXT,
  RESORT_AUTOMATIONS,
  RESORT_AUTOMATION_KEYS,
  automationSettingsFrom,
  defaultAutomationConfig,
  disabledAutomationSettings,
  isResortAutomationKey,
  parseAutomationConfig,
} from './definitions'

describe('resort automation definitions', () => {
  it('defines automations A–N, one per key', () => {
    expect(RESORT_AUTOMATIONS.map((d) => d.letter).join('')).toBe('ABNCDEFMGHIJKL')
    expect(RESORT_AUTOMATIONS.map((d) => d.key)).toEqual([...RESORT_AUTOMATION_KEYS])
  })

  it('numbers the 12 V-Farms flows in the agreed order; follow-up and the stay booking enquiry are extras', () => {
    const flows = RESORT_AUTOMATIONS.filter((d) => d.flow_number !== null).sort((a, b) => a.flow_number! - b.flow_number!)
    expect(flows.map((d) => `${d.flow_number}. ${d.name}`)).toEqual([
      '1. Welcome and Guest Menu',
      '2. Private Farm Stay Enquiry',
      '3. Exclusive Event Enquiry',
      '4. Availability Check',
      '5. Pricing and Quotation',
      '6. Booking Request',
      '7. Booking Confirmation',
      '8. Payment Status and Reminders',
      '9. Human Agent Handoff',
      '10. Pre-Arrival Instructions',
      '11. Cancellation and Rescheduling',
      '12. Post-Stay Feedback',
    ])
    expect(RESORT_AUTOMATIONS.filter((d) => d.flow_number === null).map((d) => d.key)).toEqual(['stay_booking_enquiry', 'abandoned_followup'])
  })

  it('the welcome text leaves the options to the interactive list', () => {
    expect(DEFAULT_WELCOME_TEXT).not.toMatch(/^\s*1\.\s/m)
  })

  it('only human escalation is required; G–K are proactive', () => {
    expect(RESORT_AUTOMATIONS.filter((d) => d.required).map((d) => d.key)).toEqual(['human_escalation'])
    expect(RESORT_AUTOMATIONS.filter((d) => d.proactive).map((d) => d.letter).join('')).toBe('GHIJK')
  })

  it('has no solar wording anywhere', () => {
    const text = JSON.stringify(RESORT_AUTOMATIONS) + DEFAULT_WELCOME_TEXT + DEFAULT_STAY_TEXT
    expect(text.toLowerCase()).not.toMatch(/solar|panel|subsid|kw\b|roof/)
  })

  it('uses the exact welcome and stay texts', () => {
    expect(DEFAULT_WELCOME_TEXT.startsWith('🌿 Welcome to V-Farms!')).toBe(true)
    expect(DEFAULT_WELCOME_TEXT).toBe(
      '🌿 Welcome to V-Farms!\n\nDiscover your private five-acre nature escape near Hyderabad, set on a beautiful dragon fruit farm.\n\n🏡 Stay together. Celebrate together. Enjoy your own private estate.\n\nHow can we help you today?',
    )
    expect(DEFAULT_STAY_TEXT).toContain('booked as one exclusive estate, including the five-room guest building')
    expect(DEFAULT_STAY_TEXT).toContain('7. Talk to our team')
  })

  it('defaults leave reminders and follow-ups unconfigured rather than invented', () => {
    expect(defaultAutomationConfig('payment_reminder').balance_due_days_before).toBeNull()
    expect(defaultAutomationConfig('abandoned_followup').after_hours).toBeNull()
    expect(defaultAutomationConfig('pre_arrival_reminder').hours_before).toBeNull()
    expect(defaultAutomationConfig('human_escalation').assign_to_user_id).toBeNull()
  })

  it('rejects invalid config values', () => {
    expect(AUTOMATION_CONFIG_SCHEMAS.abandoned_followup.safeParse({ max_follow_ups: 4 }).success).toBe(false)
    expect(AUTOMATION_CONFIG_SCHEMAS.booking_confirmation.safeParse({ template_name: 'Bad Name' }).success).toBe(false)
    expect(AUTOMATION_CONFIG_SCHEMAS.human_escalation.safeParse({ assign_to_user_id: 'nope' }).success).toBe(false)
    expect(AUTOMATION_CONFIG_SCHEMAS.welcome_menu.safeParse({ welcome_text: '   ' }).success).toBe(false)
  })

  it('falls back to defaults when a stored config is invalid', () => {
    expect(parseAutomationConfig('abandoned_followup', { max_follow_ups: 99 }).max_follow_ups).toBe(1)
    expect(parseAutomationConfig('welcome_menu', null).welcome_text).toBe(DEFAULT_WELCOME_TEXT)
  })

  it('treats missing rows as disabled, but F as always enabled', () => {
    const s = disabledAutomationSettings()
    for (const key of RESORT_AUTOMATION_KEYS) expect(s.enabled[key]).toBe(key === 'human_escalation')
    const t = automationSettingsFrom([
      { key: 'welcome_menu', is_enabled: true, config: {} },
      { key: 'human_escalation', is_enabled: false, config: {} },
    ])
    expect(t.enabled.welcome_menu).toBe(true)
    expect(t.enabled.human_escalation).toBe(true)
    expect(t.enabled.stay_enquiry).toBe(false)
  })

  it('recognises only known keys', () => {
    expect(isResortAutomationKey('cancel_reschedule')).toBe(true)
    expect(isResortAutomationKey('solar_followup')).toBe(false)
    expect(isResortAutomationKey(3)).toBe(false)
  })
})
