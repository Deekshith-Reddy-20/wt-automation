import { z } from 'zod'

/**
 * The V-Farms resort automations (A–M). Each one is a persisted row in
 * resort_automations (disabled until an admin turns it on) that gates a
 * part of the resort engine — the WhatsApp bot flows or the guest-message
 * queue — rather than a free-form step list, so availability, payment,
 * consent and approval checks can never be skipped by configuration.
 *
 * Pure module: safe to import from client components.
 */

export const RESORT_AUTOMATION_KEYS = [
  'welcome_menu',
  'stay_enquiry',
  'stay_booking_enquiry',
  'availability_check',
  'pricing_quote',
  'event_enquiry',
  'human_escalation',
  'booking_request',
  'booking_confirmation',
  'payment_reminder',
  'pre_arrival_reminder',
  'post_stay_feedback',
  'abandoned_followup',
  'cancel_reschedule',
] as const
export type ResortAutomationKey = (typeof RESORT_AUTOMATION_KEYS)[number]

export const DEFAULT_WELCOME_TEXT = `🌿 Welcome to V-Farms!

Discover your private five-acre nature escape near Hyderabad, set on a beautiful dragon fruit farm.

🏡 Stay together. Celebrate together. Enjoy your own private estate.

How can we help you today?`

export const DEFAULT_STAY_TEXT = `🏡 Welcome to the V-Farms private stay experience!

Our property is booked as one exclusive estate, including the five-room guest building.

What are you planning?

1. Weekend getaway
2. Family stay
3. Friends' getaway
4. Birthday or special occasion
5. Check available dates
6. Pricing and packages
7. Talk to our team`

export const DEFAULT_BOOKING_WELCOME_TEXT = `🌿 Welcome to V-Farms Stay Booking!

Enjoy an exclusive private five-acre nature escape near Hyderabad.

Your reservation includes the entire estate and all five guest rooms.

Let's collect a few details to help our team check your preferred dates.

Would you like to continue?`

export const DEFAULT_FEEDBACK_TEXT =
  'Thank you for staying with us at V-Farms! 🌿\n\nHow was your experience? Please reply with a rating from 1 (poor) to 5 (excellent), and add any comments you would like to share.'

export const DEFAULT_FOLLOWUP_TEXT =
  'Hello from V-Farms! 🌿 You were asking about a visit recently. Would you like to continue? Reply MENU to see the options, or HUMAN to talk to our team. Reply STOP to stop messages.'

const templateName = z
  .string()
  .trim()
  .regex(/^[a-z0-9_]{1,512}$/, 'Template names use lowercase letters, numbers and underscores')
  .nullable()

const messageText = (max: number) => z.string().trim().min(1).max(max)

export const AUTOMATION_CONFIG_SCHEMAS = {
  welcome_menu: z.object({ welcome_text: messageText(1024).default(DEFAULT_WELCOME_TEXT) }),
  stay_enquiry: z.object({ intro_text: messageText(1024).default(DEFAULT_STAY_TEXT) }),
  stay_booking_enquiry: z.object({ booking_welcome_text: messageText(1024).default(DEFAULT_BOOKING_WELCOME_TEXT) }),
  availability_check: z.object({ suggest_alternatives: z.boolean().default(true) }),
  pricing_quote: z.object({
    /** With incomplete rates the guest is told the team will quote, and staff get a quote request. */
    notify_team_when_unpriced: z.boolean().default(true),
  }),
  event_enquiry: z.object({}),
  human_escalation: z.object({
    /** Staff member to assign; null leaves the conversation unassigned and alerts the whole team. */
    assign_to_user_id: z.string().uuid().nullable().default(null),
  }),
  booking_request: z.object({}),
  booking_confirmation: z.object({ template_name: templateName.default(null) }),
  payment_reminder: z.object({
    /** Days before check-in / the event when the balance is due. Null = not configured, no reminders. */
    balance_due_days_before: z.number().int().min(0).max(90).nullable().default(null),
    /** How many days before the due date the reminder goes out. */
    remind_days_before_due: z.number().int().min(0).max(30).default(2),
    template_name: templateName.default(null),
  }),
  pre_arrival_reminder: z.object({
    /** Null falls back to Resort settings → reminder hours; nothing is sent when neither is set. */
    hours_before: z.number().int().min(1).max(336).nullable().default(null),
    template_name: templateName.default(null),
    arrival_instructions: z.string().trim().max(800).nullable().default(null),
  }),
  post_stay_feedback: z.object({
    message_text: messageText(1000).default(DEFAULT_FEEDBACK_TEXT),
    delay_hours: z.number().int().min(0).max(168).default(3),
    template_name: templateName.default(null),
  }),
  abandoned_followup: z.object({
    /** Hours of silence before a follow-up. Null = not configured, nothing is sent. */
    after_hours: z.number().int().min(1).max(720).nullable().default(null),
    max_follow_ups: z.number().int().min(1).max(3).default(1),
    message_text: messageText(1000).default(DEFAULT_FOLLOWUP_TEXT),
    template_name: templateName.default(null),
  }),
  cancel_reschedule: z.object({}),
} satisfies Record<ResortAutomationKey, z.ZodObject>

export type AutomationConfig<K extends ResortAutomationKey> = z.infer<(typeof AUTOMATION_CONFIG_SCHEMAS)[K]>
export type AutomationConfigs = { [K in ResortAutomationKey]: AutomationConfig<K> }

export type AutomationKind = 'conversation' | 'scheduled'

export interface ResortAutomationDefinition {
  key: ResortAutomationKey
  letter: string
  /** Position in the 12 V-Farms flows (Flows page order); null for extra automations. */
  flow_number: number | null
  name: string
  description: string
  trigger_type: string
  trigger_label: string
  kind: AutomationKind
  /** Cannot be disabled: turning it off would leave guests with no way to reach a person. */
  required?: boolean
  /** Customer-facing message outside a conversation; needs an approved template outside 24h. */
  proactive?: boolean
}

export const RESORT_AUTOMATIONS: readonly ResortAutomationDefinition[] = [
  {
    key: 'welcome_menu',
    letter: 'A',
    name: 'Welcome and Guest Menu',
    flow_number: 1,
    description: 'Greets new guests with the V-Farms menu and handles MENU, BACK, HELP and HUMAN.',
    trigger_type: 'inbound_message',
    trigger_label: 'First message / greeting',
    kind: 'conversation',
  },
  {
    key: 'stay_enquiry',
    letter: 'B',
    name: 'Private Farm Stay Enquiry',
    flow_number: 2,
    description: 'Collects stay dates, guests, children’s ages, purpose and requests one question at a time, then checks live availability and quotes.',
    trigger_type: 'interactive_reply',
    trigger_label: 'Menu: Private Farm Stay',
    kind: 'conversation',
  },
  {
    key: 'stay_booking_enquiry',
    letter: 'N',
    name: 'V-Farms – Customer Information & Stay Booking Enquiry',
    flow_number: null,
    description:
      'Collects the guest’s name, dates, adults, children, purpose and special requirements one question at a time, shows a summary, checks the live calendar and saves a new enquiry for the team. Whole-estate stays only; no prices or payments. When on, it replaces the Private Farm Stay menu for new stay enquiries.',
    trigger_type: 'interactive_reply',
    trigger_label: 'Menu: Private Farm Stay · BOOK / STAY / BOOK STAY',
    kind: 'conversation',
  },
  {
    key: 'availability_check',
    letter: 'C',
    name: 'Availability Check',
    flow_number: 4,
    description: 'Checks the estate calendar live (holds, blocks, buffers) and suggests open alternative dates. Never creates a booking.',
    trigger_type: 'interactive_reply',
    trigger_label: 'Menu: Check Availability & Book',
    kind: 'conversation',
  },
  {
    key: 'pricing_quote',
    letter: 'D',
    name: 'Pricing and Quotation',
    flow_number: 5,
    description: 'Shows configured rates and builds quotes from pricing rules; asks the team to quote when rules are incomplete.',
    trigger_type: 'interactive_reply',
    trigger_label: 'Menu: Pricing & Packages',
    kind: 'conversation',
  },
  {
    key: 'event_enquiry',
    letter: 'E',
    name: 'Exclusive Event Enquiry',
    flow_number: 3,
    description: 'Collects event type, date, times, guests and needs; checks conflicts; every event goes to the team for review.',
    trigger_type: 'interactive_reply',
    trigger_label: 'Menu: Exclusive Events & Celebrations',
    kind: 'conversation',
  },
  {
    key: 'human_escalation',
    letter: 'F',
    name: 'Human Agent Handoff',
    flow_number: 9,
    description: 'Pauses the bot, tags the guest Needs Human, assigns staff and alerts the team with the conversation context.',
    trigger_type: 'keyword',
    trigger_label: 'HUMAN / Talk to Our Team / bot cannot help',
    kind: 'conversation',
    required: true,
  },
  {
    key: 'booking_request',
    letter: 'M',
    name: 'Booking Request',
    flow_number: 6,
    description: 'When the guest taps "Request booking" after a quote, re-checks availability in one transaction and places a temporary hold. A request, never a confirmed booking. When off, the request goes to the team and nothing is held.',
    trigger_type: 'interactive_reply',
    trigger_label: 'Guest taps "Request booking"',
    kind: 'conversation',
  },
  {
    key: 'booking_confirmation',
    letter: 'G',
    name: 'Booking Confirmation',
    flow_number: 7,
    description: 'Sends the confirmation only after the booking is confirmed, holds the estate, and is paid or has an approved payment exception. Sent once.',
    trigger_type: 'booking_status_changed',
    trigger_label: 'Booking confirmed',
    kind: 'scheduled',
    proactive: true,
  },
  {
    key: 'payment_reminder',
    letter: 'H',
    name: 'Payment Status and Reminders',
    flow_number: 8,
    description: 'Reminds guests of an outstanding balance from the payment ledger before the configured due date. Stops on payment, cancellation or opt-out.',
    trigger_type: 'scheduled',
    trigger_label: 'Before the balance due date',
    kind: 'scheduled',
    proactive: true,
  },
  {
    key: 'pre_arrival_reminder',
    letter: 'I',
    name: 'Pre-Arrival Instructions',
    flow_number: 10,
    description: 'Sends the booking reference, date, check-in time, directions and contact before arrival. Skips cancelled bookings.',
    trigger_type: 'scheduled',
    trigger_label: 'Before check-in / event start',
    kind: 'scheduled',
    proactive: true,
  },
  {
    key: 'post_stay_feedback',
    letter: 'J',
    name: 'Post-Stay Feedback',
    flow_number: 12,
    description: 'Asks for a 1–5 rating after a completed booking and records the reply against the booking. Sent once.',
    trigger_type: 'booking_status_changed',
    trigger_label: 'Booking completed',
    kind: 'scheduled',
    proactive: true,
  },
  {
    key: 'abandoned_followup',
    letter: 'K',
    name: 'Abandoned Enquiry Follow-up',
    flow_number: null,
    description: 'Follows up an enquiry that went quiet, within the configured limit. Stops on reply, opt-out, booking, cancellation or human takeover.',
    trigger_type: 'follow_up_due',
    trigger_label: 'Enquiry inactive for the configured period',
    kind: 'scheduled',
    proactive: true,
  },
  {
    key: 'cancel_reschedule',
    letter: 'L',
    name: 'Cancellation and Rescheduling',
    flow_number: 11,
    description: 'Finds the guest’s own booking, explains the configured policy, and records a cancellation or date-change request for the team.',
    trigger_type: 'keyword',
    trigger_label: '“cancel booking”, “reschedule”, “change dates”',
    kind: 'conversation',
  },
]

export function automationDefinition(key: ResortAutomationKey): ResortAutomationDefinition {
  const def = RESORT_AUTOMATIONS.find((d) => d.key === key)
  if (!def) throw new Error(`Unknown resort automation: ${key}`)
  return def
}

export function isResortAutomationKey(value: unknown): value is ResortAutomationKey {
  return typeof value === 'string' && (RESORT_AUTOMATION_KEYS as readonly string[]).includes(value)
}

/** Parse a stored config, falling back to defaults field by field when it is missing or invalid. */
export function parseAutomationConfig<K extends ResortAutomationKey>(key: K, raw: unknown): AutomationConfig<K> {
  const schema = AUTOMATION_CONFIG_SCHEMAS[key]
  const parsed = schema.safeParse(raw ?? {})
  if (parsed.success) return parsed.data as AutomationConfig<K>
  return schema.parse({}) as AutomationConfig<K>
}

export function defaultAutomationConfig<K extends ResortAutomationKey>(key: K): AutomationConfig<K> {
  return AUTOMATION_CONFIG_SCHEMAS[key].parse({}) as AutomationConfig<K>
}

/** Enabled flags + parsed configs for one account, as the engine sees them. */
export interface AutomationSettings {
  enabled: Record<ResortAutomationKey, boolean>
  config: AutomationConfigs
}

export function automationSettingsFrom(
  rows: { key: string; is_enabled: boolean; config: unknown }[],
): AutomationSettings {
  const enabled = {} as Record<ResortAutomationKey, boolean>
  const config = {} as Record<ResortAutomationKey, unknown>
  for (const key of RESORT_AUTOMATION_KEYS) {
    const row = rows.find((r) => r.key === key)
    enabled[key] = automationDefinition(key).required ? true : Boolean(row?.is_enabled)
    config[key] = parseAutomationConfig(key, row?.config)
  }
  return { enabled, config: config as AutomationConfigs }
}

/** Everything off (except the required escalation) — used when the registry can't be read. */
export function disabledAutomationSettings(): AutomationSettings {
  return automationSettingsFrom([])
}
