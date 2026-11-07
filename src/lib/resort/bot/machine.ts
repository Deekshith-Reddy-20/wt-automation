import { parseGuestDate } from '../date-parse'
import { DATE_ERROR_MESSAGES, validateEventDate, validateStayDates } from '../occupancy'
import { describeRates, formatINR, formatQuoteText, rupeesToPaise } from '../pricing'
import { normalizePhoneE164, maskPhone } from '../refs'
import { addDays, daysBetween, formatDateHuman, formatTimeHuman, parseTimeInput, todayIST } from '../time'
import { EVENT_TYPE_LABELS, EVENT_TYPES } from '../types'
import type { AvailabilityStatus } from '../availability'
import type { ResortAutomationKey } from '../automations/definitions'
import type {
  AutomationEvent,
  BotFlow,
  BotInput,
  BotOption,
  BotReply,
  BotResult,
  BotServices,
  BotState,
  DateChange,
  GuestBooking,
  RescheduleCheck,
  SubmitResult,
} from './types'
import { isSkip, matchOption, normalizeInput, parseAmount, parseCount, parseYesNo, truncate } from './ui'

/**
 * Deterministic WhatsApp conversation engine for V-Farms. Every reply is
 * either fixed copy or data returned by BotServices (the database). Prices,
 * availability and policies are never computed or assumed here.
 */

/** After this long without a message, a guest mid-flow is asked whether to continue. */
export const RESUME_AFTER_MS = 12 * 60 * 60 * 1000
const MAX_RETRIES = 3

interface Data {
  check_in?: string
  check_out?: string
  adults?: number
  children?: number
  children_ages?: number[] | null
  purpose?: string | null
  special?: string | null
  name?: string
  event_type?: string
  event_type_other?: string | null
  event_date?: string
  start_time?: string
  end_time?: string
  guest_count?: number
  accommodation?: boolean | null
  catering?: boolean | null
  decoration?: string | null
  budget?: number | null
  contact_phone?: string
  booking_id?: string
  booking_ref?: string
  alternatives?: { check_in: string; check_out: string }[]
  date_options?: string[]
  avail_kind?: 'stay' | 'event'
  resume?: { flow: BotFlow; step: string }
  retries?: number
  editing?: boolean
  /** Cancellation / rescheduling (automation L). */
  mg?: GuestBooking
  mg_options?: GuestBooking[]
  mg_change?: DateChange
  mg_check?: RescheduleCheck
  /** Set by the post-stay feedback message (automation J). */
  feedback_booking_id?: string
  /** Customer Information & Stay Booking Enquiry (automation N). */
  purpose_other?: boolean
  bk_status?: AvailabilityStatus
}

const COMMANDS: Record<'menu' | 'back' | 'help' | 'cancel' | 'human', string[]> = {
  menu: ['menu', 'main menu', 'start', 'home', 'restart', 'start over', 'c_menu'],
  back: ['back', 'go back', 'previous', 'c_back'],
  help: ['help', '?', 'options', 'c_help'],
  cancel: ['cancel', 'exit', 'quit', 'never mind', 'nevermind', 'c_cancel'],
  human: [
    'human', 'agent', 'person', 'staff', 'team', 'manager', 'representative', 'call me',
    'talk to human', 'talk to a human', 'talk to a person', 'talk to someone', 'speak to someone',
    'talk to team', 'talk to our team', 'talk to your team', 'customer care', 'c_human',
  ],
}

const GREETINGS = [
  'hi', 'hii', 'hiii', 'hello', 'helo', 'hey', 'hey there', 'hola', 'namaste', 'namaskar', 'namaskaram',
  'good morning', 'good afternoon', 'good evening', 'hi there', 'hello there',
]

function commandOf(input: BotInput): keyof typeof COMMANDS | null {
  const key = input.replyId ?? normalizeInput(input.text)
  for (const [cmd, words] of Object.entries(COMMANDS)) {
    if (words.includes(key)) return cmd as keyof typeof COMMANDS
  }
  return null
}

function isGreeting(input: BotInput): boolean {
  return !input.replyId && GREETINGS.includes(normalizeInput(input.text))
}

/** A greeting or MENU: the guest is starting over, so a quiet human handoff can return to the bot. */
export function asksForMenu(input: BotInput): boolean {
  return isGreeting(input) || commandOf(input) === 'menu'
}

const NAV_MENU: BotOption = { id: 'c_menu', title: 'Main menu' }
const NAV_HUMAN: BotOption = { id: 'c_human', title: 'Talk to our team' }
/** The seven welcome-menu rows, in order (numbered fallback 1–7). Titles fit WhatsApp's 24-character list rows. */
function menuOptions(name: string): BotOption[] {
  return [
    { id: 'm_stay', title: '🏡 Private Farm Stay', description: 'Book the whole estate overnight', aliases: ['stay', 'farm stay', 'private farm stay', 'room', 'rooms', 'overnight', 'book a stay'] },
    { id: 'm_event', title: '🎉 Events & Celebrations', description: 'Exclusive events & celebrations', aliases: ['event', 'events', 'party', 'function', 'celebration', 'celebrations', 'events & celebrations', 'exclusive events', 'exclusive events & celebrations'] },
    { id: 'm_pricing', title: '💰 Pricing & Packages', description: 'Rates for stays and events', aliases: ['price', 'prices', 'pricing', 'packages', 'pricing & packages', 'rate', 'rates', 'tariff', 'cost', 'charges'] },
    { id: 'm_avail', title: '📅 Check Availability', description: 'Check dates and request a booking', aliases: ['availability', 'available', 'dates', 'book', 'booking', 'check dates', 'check availability', 'check availability & book'] },
    { id: 'm_explore', title: truncate(`🌿 Explore ${name}`, 24), description: 'The estate, photos, amenities, FAQs', aliases: ['explore', `explore ${name}`, 'about', 'amenities', 'facilities', 'photos', 'info'] },
    { id: 'm_location', title: '📍 Location & Directions', description: 'How to reach us', aliases: ['location', 'location & directions', 'address', 'directions', 'map', 'where', 'route'] },
    { id: 'm_human', title: '👨‍💼 Talk to Our Team', description: 'A person will reply here', aliases: ['talk to our team'] },
  ]
}

const PRICING_OPTIONS: BotOption[] = [
  { id: 'p_weekday', title: 'Weekday stays', aliases: ['weekday'] },
  { id: 'p_weekend', title: 'Weekend stays', aliases: ['weekend'] },
  { id: 'p_seasonal', title: 'Seasonal & special dates', aliases: ['seasonal', 'season', 'holiday', 'festival'] },
  { id: 'p_extra', title: 'Extra guests & children', aliases: ['extra', 'children', 'kids', 'extra guests'] },
  { id: 'p_events', title: 'Event packages', aliases: ['event', 'events', 'packages'] },
  { id: 'p_addons', title: 'Add-ons & advance', aliases: ['addons', 'add-ons', 'advance', 'deposit'] },
]

/** Order matches the numbered stay text (1–7). The first four preset the purpose of the stay. */
const STAY_MENU: BotOption[] = [
  { id: 'st_weekend', title: 'Weekend getaway', aliases: ['weekend'] },
  { id: 'st_family', title: 'Family stay', aliases: ['family'] },
  { id: 'st_friends', title: "Friends' getaway", aliases: ['friends', 'friends getaway'] },
  { id: 'st_occasion', title: 'Birthday or occasion', description: 'Birthday or special occasion', aliases: ['birthday', 'occasion', 'special occasion', 'birthday or special occasion'] },
  { id: 'st_dates', title: 'Check available dates', aliases: ['dates', 'availability', 'check dates'] },
  { id: 'st_pricing', title: 'Pricing and packages', aliases: ['pricing', 'price', 'prices', 'packages'] },
  { id: 'c_human', title: 'Talk to our team' },
]

const STAY_PURPOSE: Record<string, string> = {
  st_weekend: 'Weekend getaway',
  st_family: 'Family stay',
  st_friends: "Friends' getaway",
  st_occasion: 'Birthday or special occasion',
}

/** Steps where the conversation has reached a natural end; a greeting there starts afresh. */
const RESTING_STEPS = new Set(['done', 'shown', 'waiting'])

const PURPOSE_OPTIONS: BotOption[] = [
  { id: 'pu_weekend', title: 'Weekend getaway' },
  { id: 'pu_family', title: 'Family stay' },
  { id: 'pu_friends', title: "Friends' getaway" },
  { id: 'pu_occasion', title: 'Birthday or occasion' },
  { id: 'skip', title: 'Skip' },
]

// ---- Customer Information & Stay Booking Enquiry (automation N) ----

const BOOKING_KEYWORDS = ['book', 'stay', 'book stay', 'book a stay']

const BK_INTRO: BotOption[] = [
  { id: 'bk_start', title: 'Start Enquiry', aliases: ['start', 'start booking', 'start booking enquiry', 'start enquiry', 'continue', 'yes'] },
  { id: 'c_human', title: 'Talk to Our Team' },
  { id: 'c_menu', title: 'Main Menu' },
]

const BK_PURPOSE: BotOption[] = [
  { id: 'bp_family', title: 'Family Vacation', aliases: ['family'] },
  { id: 'bp_friends', title: 'Friends Get-Together', aliases: ['friends', 'get together', 'get-together'] },
  { id: 'bp_birthday', title: 'Birthday Celebration', aliases: ['birthday'] },
  { id: 'bp_anniversary', title: 'Anniversary' },
  { id: 'bp_relax', title: 'Relaxation / Weekend', description: 'Relaxation / Weekend Stay', aliases: ['relaxation', 'weekend', 'weekend stay', 'relaxation / weekend stay'] },
  { id: 'bp_other', title: 'Other' },
]
const BK_PURPOSE_VALUE: Record<string, string> = { bp_relax: 'Relaxation / Weekend Stay' }

const BK_SUMMARY: BotOption[] = [
  { id: 'bk_submit', title: 'Submit Enquiry', aliases: ['submit', 'submit enquiry', 'confirm', 'yes', 'correct', 'ok'] },
  { id: 'bk_edit', title: 'Edit Details', aliases: ['edit', 'edit details', 'change'] },
  { id: 'c_cancel', title: 'Cancel' },
]

const BK_AVAILABLE: BotOption[] = [
  { id: 'bk_submit', title: 'Submit Enquiry', aliases: ['submit', 'submit enquiry', 'yes', 'ok'] },
  { id: 'bk_dates', title: 'Change Dates', aliases: ['change dates', 'dates', 'other dates'] },
  { id: 'c_human', title: 'Talk to Our Team' },
]

const BK_EDIT: BotOption[] = [
  { id: 'e_name', title: 'Guest name', aliases: ['name'] },
  { id: 'e_check_in', title: 'Check-in date', aliases: ['check-in', 'check in', 'checkin'] },
  { id: 'e_check_out', title: 'Check-out date', aliases: ['check-out', 'check out', 'checkout'] },
  { id: 'e_adults', title: 'Members', aliases: ['members', 'guests', 'people', 'adults', 'children', 'kids'] },
  { id: 'e_purpose', title: 'Visit purpose', aliases: ['purpose', 'occasion'] },
  { id: 'e_special', title: 'Special requirements', aliases: ['special', 'requests', 'requirements', 'special requirements'] },
]

/** Steps where a question from the guest is answered with an offer of help instead of being read as the answer. */
const BK_QUESTION_GUARD = new Set(['intro', 'name', 'check_in', 'check_out', 'adults', 'purpose', 'summary', 'available', 'edit'])

/** Stays ask one head count (stored as adults; children 0) rather than adults, children and ages. */
const MEMBERS_QUESTION = '👨‍👩‍👧 How many members will be staying?'
const MEMBERS_RETRY = 'Please reply with the number of members staying, e.g. 6.'

function membersError(n: number | null, max: number | null): string | null {
  if (n === null || n < 1 || n > 500) return MEMBERS_RETRY
  if (max !== null && n > max) {
    return `The estate can host up to ${max} guests overnight. For larger groups, our team can advise — reply HUMAN.`
  }
  return null
}

function membersPatch(n: number): Pick<Data, 'adults' | 'children' | 'children_ages'> {
  return { adults: n, children: 0, children_ages: null }
}

/** Bot flows that belong to an optional automation; entering one that is disabled hands over to the team. */
const FLOW_AUTOMATION: Partial<Record<BotFlow, ResortAutomationKey>> = {
  stay: 'stay_enquiry',
  booking: 'stay_booking_enquiry',
  event: 'event_enquiry',
  pricing: 'pricing_quote',
  availability: 'availability_check',
  manage: 'cancel_reschedule',
}

const YES_NO: BotOption[] = [
  { id: 'yes', title: 'Yes' },
  { id: 'no', title: 'No' },
]

class Run {
  replies: BotReply[] = []
  events: AutomationEvent[] = []
  handoff = false
  handoffReason: string | null = null
  constructor(
    readonly svc: BotServices,
    public state: BotState,
    readonly input: BotInput,
  ) {}

  get d(): Data {
    return this.state.data as Data
  }
  set(patch: Partial<Data>) {
    this.state.data = { ...this.state.data, ...patch }
  }
  say(text: string) {
    this.replies.push({ type: 'text', text })
  }
  ask(text: string, options: BotOption[], button?: string, image?: string) {
    this.replies.push({ type: 'choices', text, options, button, ...(image ? { image } : {}) })
  }
  media(kind: 'image' | 'video', url: string, caption?: string) {
    this.replies.push({ type: 'media', kind, url, ...(caption ? { caption } : {}) })
  }
  get name() {
    return this.svc.settings.resort_name
  }
  emit(key: ResortAutomationKey, status: AutomationEvent['status'], detail?: Record<string, unknown>, error?: string) {
    this.events.push({ key, status, ...(detail ? { detail } : {}), ...(error ? { error } : {}) })
  }

  /** False (after handing over to the team) when the flow's automation is disabled. */
  async enter(flow: BotFlow): Promise<boolean> {
    const key = FLOW_AUTOMATION[flow]
    if (!key || this.svc.automations.enabled[key]) return true
    this.emit(key, 'skipped', { reason: 'automation_disabled' })
    await startHandoff(this, `automation_disabled:${key}`)
    return false
  }

  /** Move to a step (remembering where we were for BACK) and prompt it. */
  async go(flow: BotFlow, step: string, opts: { push?: boolean } = {}) {
    if (!(await this.enter(flow))) return
    const here = { flow: this.state.flow, step: this.state.step }
    if (opts.push !== false && !(here.flow === flow && here.step === step)) {
      this.state.history = [...this.state.history, here].slice(-20)
    }
    this.state.flow = flow
    this.state.step = step
    this.set({ retries: 0 })
    await prompt(this)
  }

  /** Reset to the main menu. */
  async menu(intro?: string) {
    this.state = { flow: 'menu', step: 'start', data: {}, history: [], lastInboundAt: this.state.lastInboundAt }
    if (intro) this.say(intro)
    await prompt(this)
  }

  /** The reply didn't fit the question: explain, re-ask, and offer a person after repeated misses. */
  async retry(message: string) {
    const retries = (this.d.retries ?? 0) + 1
    this.set({ retries })
    if (retries >= MAX_RETRIES) {
      this.ask(`${message}\n\nWould you like one of our team to help?`, [NAV_HUMAN, { id: 'c_continue', title: 'Keep trying' }, NAV_MENU])
      return
    }
    this.say(message)
    await prompt(this)
  }
}

// ------------------------------------------------------------------
// Entry point
// ------------------------------------------------------------------

export function initialState(): BotState {
  return { flow: 'menu', step: 'start', data: {}, history: [], lastInboundAt: null }
}

export async function handleInbound(svc: BotServices, prev: BotState, input: BotInput): Promise<BotResult> {
  const now = svc.now()
  const state: BotState = structuredClone(prev)
  const gap = state.lastInboundAt ? now.getTime() - new Date(state.lastInboundAt).getTime() : null
  state.lastInboundAt = now.toISOString()
  const run = new Run(svc, state, input)

  const cmd = commandOf(input)
  if (input.unsupported) {
    run.say("Thanks! I can only read text messages here, so I couldn't open that. Please type your reply, or send MENU to see the options.")
    if (run.state.flow === 'menu' && run.state.step === 'start') await run.menu()
    else await prompt(run)
  } else if (cmd === 'human') {
    await startHandoff(run, 'guest_requested')
  } else if (cmd === 'menu') {
    await run.menu()
  } else if (cmd === 'cancel') {
    await run.menu(run.state.flow === 'menu' ? undefined : 'Okay, I have stopped that. Nothing was booked.')
  } else if (cmd === 'help') {
    run.say(
      'You can reply:\n• MENU – main menu\n• BACK – previous question\n• CANCEL – stop the current request\n• HUMAN – talk to our team\n• STOP – stop all messages from us',
    )
    await prompt(run)
  } else if (cmd === 'back') {
    const prevStep = run.state.history.pop()
    if (!prevStep) await run.menu()
    else {
      run.state.flow = prevStep.flow
      run.state.step = prevStep.step
      await prompt(run)
    }
  } else if (input.replyId === 'c_continue') {
    run.set({ retries: 0 })
    await prompt(run)
  } else if (run.state.flow === 'booking' && !input.replyId && normalizeInput(input.text) === 'edit' && !['intro', 'done'].includes(run.state.step)) {
    await run.go('booking', 'edit')
  } else if (
    isBookingKeyword(input) &&
    svc.automations.enabled.stay_booking_enquiry &&
    ((run.state.flow === 'menu' && ['start', 'resume', 'done'].includes(run.state.step)) || RESTING_STEPS.has(run.state.step))
  ) {
    run.state.data = {}
    await run.go('booking', 'intro')
  } else if (isManageRequest(input) && (!['stay', 'event', 'manage'].includes(run.state.flow) || RESTING_STEPS.has(run.state.step))) {
    await startManage(run)
  } else if (
    (run.state.flow === 'menu' && run.state.step === 'start' && (isGreeting(input) || !prev.lastInboundAt)) ||
    (RESTING_STEPS.has(run.state.step) && (isGreeting(input) || (gap !== null && gap > RESUME_AFTER_MS)))
  ) {
    await run.menu()
  } else if (run.state.flow !== 'menu' && gap !== null && gap > RESUME_AFTER_MS) {
    run.set({ resume: { flow: run.state.flow, step: run.state.step } })
    run.state.history = []
    run.state.flow = 'menu'
    run.state.step = 'resume'
    await prompt(run)
  } else if (isGreeting(input) && run.state.flow !== 'menu') {
    run.set({ resume: { flow: run.state.flow, step: run.state.step } })
    run.state.flow = 'menu'
    run.state.step = 'resume'
    await prompt(run)
  } else {
    await answer(run)
  }
  return { state: run.state, replies: run.replies, events: run.events, handoff: run.handoff, handoffReason: run.handoffReason }
}

function isBookingKeyword(input: BotInput): boolean {
  return !input.replyId && BOOKING_KEYWORDS.includes(normalizeInput(input.text))
}

/** "What is the price?", "is wifi available" — a question rather than an answer to the current step. */
function looksLikeQuestion(text: string): boolean {
  const t = text.trim()
  if (/\?\s*$/.test(t)) return true
  return /^(what|how|where|why|which|who|is|are|can|could|do|does|will|would)\b/i.test(t) && t.split(/\s+/).length >= 3
}

function isManageRequest(input: BotInput): boolean {
  if (input.replyId) return false
  const n = normalizeInput(input.text)
  return (
    /\b(cancel|cancellation)\b.*\b(booking|reservation|stay|event)\b/.test(n) ||
    /\bresched/.test(n) ||
    /\bpostpone\b/.test(n) ||
    /\b(change|modify|move|shift)\b.*\b(date|dates|booking|reservation)\b/.test(n)
  )
}

// ------------------------------------------------------------------
// Prompts — the question for the current step
// ------------------------------------------------------------------

async function prompt(run: Run): Promise<void> {
  const { flow, step } = run.state
  const d = run.d
  switch (`${flow}.${step}`) {
    case 'menu.start':
      run.ask(run.svc.automations.config.welcome_menu.welcome_text, menuOptions(run.name), 'View options')
      run.emit('welcome_menu', 'success')
      return
    case 'menu.resume': {
      const label = FLOW_LABEL[d.resume?.flow ?? 'menu']
      run.ask(`Welcome back! Last time we were working on ${label}. Shall we continue?`, [
        { id: 'r_continue', title: 'Continue' },
        { id: 'r_restart', title: 'Start over' },
        NAV_HUMAN,
      ])
      return
    }

    // ---- Customer Information & Stay Booking Enquiry ----
    case 'booking.intro':
      run.ask(run.svc.automations.config.stay_booking_enquiry.booking_welcome_text, BK_INTRO)
      return
    case 'booking.name':
      if (run.svc.contactName && validGuestName(run.svc.contactName)) {
        run.ask('May we know your full name?', [{ id: 'use_name', title: truncate(run.svc.contactName, 20) }])
      } else run.say('May we know your full name?')
      return
    case 'booking.check_in':
      run.say('📅 What is your preferred check-in date?\n\nPlease reply in DD-MM-YYYY format, e.g. 25-12-2026.')
      return
    case 'booking.check_out':
      run.say(`Check-in: ${formatDateHuman(d.check_in!)}\n\n📅 What is your preferred check-out date?\n\nPlease reply in DD-MM-YYYY format.`)
      return
    case 'booking.adults':
      run.say(MEMBERS_QUESTION)
      return
    case 'booking.purpose':
      run.ask('🌿 What is the purpose of your visit?', BK_PURPOSE, 'Choose')
      return
    case 'booking.purpose_other':
      run.say('Please tell us briefly about the purpose of your visit.')
      return
    case 'booking.special':
      run.ask(
        'Do you have any special requirements or requests for your stay?\n\nFor example:\n• Food preferences\n• Decorations\n• Additional arrangements\n• Accessibility requirements\n\nType your answer, or tap Skip.',
        [{ id: 'skip', title: 'Skip' }],
      )
      return
    case 'booking.summary':
      run.ask(`${bookingSummary(d, run.name)}\n\nAre these details correct?`, BK_SUMMARY)
      return
    case 'booking.edit':
      run.ask('What would you like to change?', BK_EDIT, 'Choose field')
      return
    case 'booking.available':
      run.ask('Would you like us to submit your booking enquiry?', BK_AVAILABLE)
      return
    case 'booking.done':
      run.ask('Anything else I can help with?', [NAV_MENU, NAV_HUMAN])
      return

    // ---- Stay ----
    case 'stay.menu':
      run.ask(run.svc.automations.config.stay_enquiry.intro_text, STAY_MENU, 'Choose')
      return
    case 'stay.check_in':
      run.say('When would you like to check in? (e.g. 25 Dec, tomorrow, 25/12/2026)')
      return
    case 'stay.check_out':
      run.say(`Check-in: ${formatDateHuman(d.check_in!)}.\nWhen will you check out? You can also reply with the number of nights, e.g. "2 nights".`)
      return
    case 'stay.adults':
      run.say(MEMBERS_QUESTION)
      return
    case 'stay.purpose':
      run.ask('What is the occasion? (optional)', PURPOSE_OPTIONS, 'Choose')
      return
    case 'stay.special':
      run.ask('Any special requests? Type them here, or tap Skip.', [{ id: 'skip', title: 'Skip' }])
      return
    case 'stay.name':
    case 'event.name':
      if (run.svc.contactName) {
        run.ask(`May I have the name for this ${flow === 'stay' ? 'booking' : 'event'}? Tap below or type a different name.`, [
          { id: 'use_name', title: truncate(run.svc.contactName, 20) },
        ])
      } else run.say(`May I have the name for this ${flow === 'stay' ? 'booking' : 'event'}?`)
      return
    case 'stay.summary':
      run.ask(`Please check your details:\n\n${staySummary(d)}`, [
        { id: 's_confirm', title: 'Check & get quote', aliases: ['confirm', 'yes', 'ok', 'correct'] },
        { id: 's_edit', title: 'Edit details', aliases: ['edit', 'change'] },
        { id: 'c_cancel', title: 'Cancel' },
      ])
      return
    case 'stay.edit':
      run.ask('What would you like to change?', [
        { id: 'e_check_in', title: 'Check-in date' },
        { id: 'e_check_out', title: 'Check-out date' },
        { id: 'e_adults', title: 'Members' },
        { id: 'e_purpose', title: 'Occasion' },
        { id: 'e_special', title: 'Special requests' },
        { id: 'e_name', title: 'Name' },
      ], 'Choose field')
      return
    case 'stay.result':
      run.ask('What would you like to do next?', [
        { id: 's_reserve', title: 'Request booking', aliases: ['book', 'reserve', 'request'] },
        NAV_HUMAN,
        NAV_MENU,
      ])
      return
    case 'stay.alternatives':
    case 'availability.alternatives': {
      const alts = d.alternatives ?? []
      run.ask(
        'These nearby dates are open right now:',
        [
          ...alts.map((a) => ({ id: `alt:${a.check_in}:${a.check_out}`, title: truncate(`${shortDate(a.check_in)} → ${shortDate(a.check_out)}`, 24) })),
          { id: 'av_other', title: 'Other dates' },
          NAV_HUMAN,
        ],
        'See dates',
      )
      return
    }
    case 'stay.done':
    case 'event.done':
    case 'manage.done':
    case 'menu.done':
      run.ask('Anything else I can help with?', [NAV_MENU, NAV_HUMAN])
      return
    case 'menu.feedback':
      run.say('Please reply with a rating from 1 (poor) to 5 (excellent), and any comments.')
      return

    // ---- Cancellation & rescheduling ----
    case 'manage.pick':
      run.ask(
        'Which booking is this about?',
        [
          ...(d.mg_options ?? []).map((b) => ({ id: `bk:${b.id}`, title: truncate(b.ref, 24), description: truncate(describeGuestBooking(b), 72) })),
          NAV_HUMAN,
        ],
        'Your bookings',
      )
      return
    case 'manage.ref':
      run.say('Please send your booking reference (it looks like VF-261227-7K3Q9), or reply HUMAN to talk to our team.')
      return
    case 'manage.action':
      run.ask(`${d.mg!.ref} · ${describeGuestBooking(d.mg!)}\n\nWhat would you like to do?`, [
        { id: 'mg_cancel', title: 'Cancel booking', aliases: ['cancel', 'cancellation'] },
        { id: 'mg_change', title: 'Change dates', aliases: ['change', 'reschedule', 'change dates'] },
        NAV_HUMAN,
      ])
      return
    case 'manage.cancel_confirm':
      run.ask(`${cancellationTerms(run, d.mg!)}\n\nDo you want to cancel ${d.mg!.ref}?`, [
        { id: 'mc_yes', title: 'Yes, cancel', aliases: ['yes', 'cancel', 'yes cancel'] },
        { id: 'mc_keep', title: 'Keep booking', aliases: ['no', 'keep', 'keep booking'] },
        NAV_HUMAN,
      ])
      return
    case 'manage.new_check_in':
      run.say('Which new check-in date would you like? (e.g. 25 Dec)')
      return
    case 'manage.new_check_out':
      run.say(`New check-in: ${formatDateHuman(d.mg_change!.check_in!)}.\nWhich new check-out date? (or e.g. "2 nights")`)
      return
    case 'manage.new_event_date':
      run.say(`Which new date would you like for the event? The times stay ${formatTimeHuman(d.mg!.start_time)} – ${formatTimeHuman(d.mg!.end_time)}.`)
      return
    case 'manage.resched_confirm':
      if (d.mg_check?.availability === 'unavailable') {
        run.ask('Would you like to try other dates?', [{ id: 'mr_other', title: 'Other dates' }, NAV_HUMAN, NAV_MENU])
      } else {
        run.ask('Shall I send this date-change request to our team?', [
          { id: 'mr_send', title: 'Send request', aliases: ['yes', 'send', 'confirm'] },
          { id: 'mr_other', title: 'Other dates', aliases: ['other', 'other dates'] },
          NAV_HUMAN,
        ])
      }
      return

    // ---- Event ----
    case 'event.type':
      run.ask(
        'Lovely! What kind of event are you planning?',
        EVENT_TYPES.map((t) => ({ id: `et:${t}`, title: truncate(EVENT_TYPE_LABELS[t], 24), aliases: [t.replace('_', ' ')] })),
        'Event types',
      )
      return
    case 'event.type_other':
      run.say('Please describe the event in a few words.')
      return
    case 'event.date':
      run.say('On which date? (e.g. 14 Feb, 14/02/2027)')
      return
    case 'event.start':
      run.say('What time will it start? (e.g. 11 am, 6:30 pm)')
      return
    case 'event.end':
      run.say('And what time will it end?')
      return
    case 'event.guests':
      run.say('About how many guests are you expecting?')
      return
    case 'event.accommodation':
      run.ask('Will your group need overnight accommodation?', YES_NO)
      return
    case 'event.catering':
      run.ask('Will you need catering?', YES_NO)
      return
    case 'event.decoration':
      run.ask('Any decoration requirements? Type them, or tap Skip.', [{ id: 'skip', title: 'Skip' }])
      return
    case 'event.budget':
      run.ask('Do you have a budget in mind (in ₹)? Type an amount, or tap Skip.', [{ id: 'skip', title: 'Skip' }])
      return
    case 'event.contact':
      if (run.svc.contactPhone) {
        run.ask(`Which number should our team call about this event?`, [
          { id: 'ct_this', title: 'This WhatsApp number', aliases: ['this', 'same', 'this number'] },
        ])
      } else run.say('Which phone number should our team call about this event?')
      return
    case 'event.summary':
      run.ask(`Please check your event details:\n\n${eventSummary(d)}`, [
        { id: 'ev_confirm', title: 'Send request', aliases: ['confirm', 'yes', 'ok', 'send', 'correct'] },
        { id: 'ev_edit', title: 'Edit details', aliases: ['edit', 'change'] },
        { id: 'c_cancel', title: 'Cancel' },
      ])
      return
    case 'event.edit':
      run.ask('What would you like to change?', [
        { id: 'e_event_type', title: 'Event type' },
        { id: 'e_event_date', title: 'Date' },
        { id: 'e_start_time', title: 'Start time' },
        { id: 'e_end_time', title: 'End time' },
        { id: 'e_guest_count', title: 'Guests' },
        { id: 'e_accommodation', title: 'Accommodation' },
        { id: 'e_catering', title: 'Catering' },
        { id: 'e_decoration', title: 'Decoration' },
        { id: 'e_budget', title: 'Budget' },
        { id: 'e_contact', title: 'Name / contact' },
      ], 'Choose field')
      return

    // ---- Pricing ----
    case 'pricing.menu':
      run.ask('Which prices would you like to see?', PRICING_OPTIONS, 'Pricing')
      return
    case 'pricing.shown':
      run.ask('Would you like an exact quote for your dates?', [
        { id: 'pr_quote', title: 'Get a quote', aliases: ['quote', 'yes'] },
        { id: 'pr_menu', title: 'Other prices' },
        NAV_MENU,
      ])
      return

    // ---- Availability ----
    case 'availability.kind':
      run.ask('Would you like to check dates for a stay or an event?', [
        { id: 'av_stay', title: 'Overnight stay', aliases: ['stay'] },
        { id: 'av_event', title: 'Event', aliases: ['event'] },
      ])
      return
    case 'availability.check_in':
      run.say('Which check-in date? (e.g. 25 Dec)')
      return
    case 'availability.check_out':
      run.say(`Check-in: ${formatDateHuman(d.check_in!)}. Which check-out date? (or e.g. "2 nights")`)
      return
    case 'availability.event_date':
      run.say('Which date is the event? (e.g. 14 Feb)')
      return
    case 'availability.start':
      run.say('What time would it start? (e.g. 11 am)')
      return
    case 'availability.end':
      run.say('And end?')
      return
    case 'availability.result':
      run.ask('What next?', [
        { id: 'av_book', title: d.avail_kind === 'event' ? 'Plan this event' : 'Book these dates', aliases: ['book', 'yes'] },
        { id: 'av_other', title: 'Other dates' },
        NAV_MENU,
      ])
      return
    case 'availability.unverified':
      run.ask('What would you like to do?', [NAV_HUMAN, { id: 'av_retry', title: 'Try again' }, NAV_MENU])
      return

    // ---- Explore ----
    case 'explore.menu': {
      const opts = exploreOptions(run)
      if (opts.length === 0) {
        run.ask(`More details about ${run.name} will be shared here soon. Our team can answer your questions in the meantime.`, [NAV_HUMAN, NAV_MENU])
        return
      }
      run.ask(`What would you like to know about ${run.name}?`, [...opts, NAV_HUMAN], 'Explore')
      return
    }
    case 'explore.shown':
      run.ask('Anything else?', [{ id: 'ex_menu', title: 'Explore more' }, { id: 'm_avail', title: 'Check dates' }, NAV_MENU])
      return

    case 'location.shown':
      run.ask('Anything else?', [NAV_MENU, NAV_HUMAN])
      return

    case 'human.waiting':
      // Silent: a person is handling the conversation.
      return
    default:
      await run.menu()
  }
}

const FLOW_LABEL: Record<BotFlow, string> = {
  menu: 'your enquiry',
  stay: 'your stay enquiry',
  booking: 'your stay booking enquiry',
  event: 'your event request',
  pricing: 'pricing',
  availability: 'checking dates',
  explore: 'exploring the estate',
  location: 'directions',
  manage: 'changing a booking',
  human: 'your enquiry',
}

// ------------------------------------------------------------------
// Answers — interpret the reply for the current step
// ------------------------------------------------------------------

async function answer(run: Run): Promise<void> {
  const { flow, step } = run.state
  const { text, replyId } = run.input
  const d = run.d
  const svc = run.svc
  const s = svc.settings

  switch (`${flow}.${step}`) {
    case 'menu.start': {
      const opt = matchOption(menuOptions(run.name), text, replyId)
      if (!opt) {
        run.say("Sorry, I didn't catch that.")
        await prompt(run)
        return
      }
      return startFromMenu(run, opt.id)
    }
    case 'menu.resume': {
      if (replyId === 'r_continue' || /^(continue|yes|1)$/.test(normalizeInput(text))) {
        const r = d.resume
        run.set({ resume: undefined })
        if (!r) return run.menu()
        if (!(await run.enter(r.flow))) return
        run.state.flow = r.flow
        run.state.step = r.step
        return prompt(run)
      }
      if (replyId === 'r_restart' || /^(start over|restart|no|2)$/.test(normalizeInput(text))) return run.menu()
      const opt = matchOption(menuOptions(run.name), text, replyId)
      if (opt) {
        run.state.data = {}
        return startFromMenu(run, opt.id)
      }
      return run.retry('Please choose Continue or Start over.')
    }

    // ---------------- Customer Information & Stay Booking Enquiry ----------------
    case 'booking.intro':
    case 'booking.name':
    case 'booking.check_in':
    case 'booking.check_out':
    case 'booking.adults':
    case 'booking.purpose':
    case 'booking.purpose_other':
    case 'booking.special':
    case 'booking.summary':
    case 'booking.edit':
    case 'booking.available':
      return answerBooking(run)

    // ---------------- Stay ----------------
    case 'stay.menu': {
      const opt = matchOption(STAY_MENU, text, replyId)
      if (opt && STAY_PURPOSE[opt.id]) {
        run.set({ purpose: STAY_PURPOSE[opt.id] })
        await svc.noteInterest('stay')
        return run.go('stay', nextStayStep(run.d))
      }
      if (opt?.id === 'st_dates') {
        run.set({ avail_kind: 'stay' })
        return run.go('availability', 'check_in')
      }
      if (opt?.id === 'st_pricing') {
        await svc.noteInterest('pricing')
        return run.go('pricing', 'menu')
      }
      if (opt?.id === 'c_human') return startHandoff(run, 'guest_requested')
      return run.retry('Please reply with a number from 1 to 7.')
    }
    case 'stay.check_in':
    case 'availability.check_in': {
      const date = await readDate(run)
      if (!date) return
      const err = validateStayDates(date, addDays(date, 1), { now: svc.now() })
      if (err) return run.retry(DATE_ERROR_MESSAGES[err])
      const keepCheckout = d.check_out && d.check_out > date && daysBetween(date, d.check_out) <= 30
      run.set({ check_in: date, check_out: keepCheckout ? d.check_out : undefined, date_options: undefined })
      if (flow === 'stay') return run.go('stay', nextStayStep(run.d))
      return run.go('availability', 'check_out')
    }
    case 'stay.check_out':
    case 'availability.check_out': {
      const nights = /^(?:for\s+)?(\d{1,2})\s*nights?$/.exec(normalizeInput(text))
      const date = nights ? addDays(d.check_in!, Number(nights[1])) : await readDate(run)
      if (!date) return
      const minNights = svc.pricing.rules?.min_nights ?? null
      const err = validateStayDates(d.check_in!, date, { now: svc.now(), minNights })
      if (err) {
        const msg = err === 'below_min_nights' && minNights ? `The minimum stay is ${minNights} nights.` : DATE_ERROR_MESSAGES[err]
        return run.retry(msg)
      }
      run.set({ check_out: date, date_options: undefined })
      if (flow === 'stay') return run.go('stay', nextStayStep(run.d))
      return checkStayAvailability(run)
    }
    case 'stay.adults': {
      const n = parseCount(text)
      const err = membersError(n, s.max_stay_guests)
      if (err || n === null) return run.retry(err ?? MEMBERS_RETRY)
      run.set(membersPatch(n))
      return run.go('stay', nextStayStep(run.d))
    }
    // Conversations saved before members replaced adults/children/ages.
    case 'stay.children':
    case 'stay.children_ages':
      run.set({ children: d.children ?? 0, children_ages: null })
      return run.go('stay', nextStayStep(run.d))
    case 'stay.purpose': {
      if (isSkip(text, replyId)) run.set({ purpose: null })
      else {
        const opt = matchOption(PURPOSE_OPTIONS, text, replyId)
        const value = opt ? opt.title : text.trim().slice(0, 100)
        if (!value) return run.retry('Please choose an occasion or tap Skip.')
        run.set({ purpose: value })
      }
      return run.go('stay', nextStayStep(run.d))
    }
    case 'stay.special':
    case 'event.decoration': {
      const value = isSkip(text, replyId) ? null : text.trim().slice(0, 500) || null
      run.set(flow === 'stay' ? { special: value } : { decoration: value })
      return run.go(flow, flow === 'stay' ? nextStayStep(run.d) : nextEventStep(run.d))
    }
    case 'stay.name':
    case 'event.name': {
      const value = replyId === 'use_name' && svc.contactName ? svc.contactName : text.trim()
      if (value.length < 2 || value.length > 80 || !/\p{L}/u.test(value)) return run.retry('Please type the name for the booking.')
      run.set({ name: value.slice(0, 80) })
      return run.go(flow, flow === 'stay' ? nextStayStep(run.d) : nextEventStep(run.d))
    }
    case 'stay.summary': {
      const opt = matchOption(
        [
          { id: 's_confirm', title: 'Check & get quote', aliases: ['confirm', 'yes', 'ok', 'correct'] },
          { id: 's_edit', title: 'Edit details', aliases: ['edit', 'change'] },
        ],
        text,
        replyId,
      )
      if (opt?.id === 's_edit') return run.go('stay', 'edit')
      if (opt?.id === 's_confirm') return submitStay(run)
      return run.retry('Please tap "Check & get quote", "Edit details" or "Cancel".')
    }
    case 'stay.edit':
    case 'event.edit': {
      const field = replyId?.startsWith('e_') ? replyId.slice(2) : editFieldFromText(flow, text)
      if (!field) return run.retry('Please choose what to change.')
      clearField(run, field)
      return run.go(flow, flow === 'stay' ? nextStayStep(run.d) : nextEventStep(run.d))
    }
    case 'stay.result': {
      if (replyId === 's_reserve' || /^(1|book|reserve|request|request booking|yes)$/.test(normalizeInput(text))) return reserve(run)
      return run.retry('Tap "Request booking" to reserve, or choose another option.')
    }
    case 'stay.alternatives':
    case 'availability.alternatives': {
      const picked = replyId?.startsWith('alt:') ? replyId : altFromNumber(d, text)
      if (picked) {
        const [, ci, co] = picked.split(':')
        if (flow === 'stay') {
          run.set({ check_in: ci, check_out: co, booking_id: undefined, booking_ref: undefined })
          return run.go('stay', nextStayStep(run.d))
        }
        run.set({ check_in: ci, check_out: co })
        return checkStayAvailability(run)
      }
      if (replyId === 'av_other' || /^(other|other dates)$/.test(normalizeInput(text))) {
        run.set({ check_in: undefined, check_out: undefined, booking_id: undefined })
        return run.go(flow, 'check_in')
      }
      return run.retry('Please pick one of the dates, or "Other dates".')
    }
    case 'menu.feedback':
      return recordFeedback(run)
    case 'stay.done':
    case 'booking.done':
    case 'event.done':
    case 'manage.done':
    case 'menu.done':
    case 'location.shown': {
      const opt = matchOption(menuOptions(run.name), text, replyId)
      if (opt) {
        run.state.data = {}
        return startFromMenu(run, opt.id)
      }
      return run.menu()
    }

    // ---------------- Cancellation & rescheduling ----------------
    case 'manage.pick': {
      const list = d.mg_options ?? []
      const id = replyId?.startsWith('bk:') ? replyId.slice(3) : null
      const num = /^(\d{1,2})$/.exec(normalizeInput(text))
      const picked = id ? list.find((b) => b.id === id) : num ? list[Number(num[1]) - 1] : undefined
      if (!picked) return run.retry('Please choose one of your bookings.')
      run.set({ mg: picked, mg_options: undefined })
      return run.go('manage', 'action')
    }
    case 'manage.ref': {
      const ref = text.trim().toUpperCase()
      if (!/^VF-\d{6}-[0-9A-Z]{5}$/.test(ref)) return run.retry('Please send the booking reference exactly as shown, e.g. VF-261227-7K3Q9.')
      let found: GuestBooking | null = null
      try {
        found = await svc.findGuestBooking(ref)
      } catch {
        run.emit('cancel_reschedule', 'failed', { step: 'lookup' }, 'booking_lookup_failed')
        run.say("I couldn't look up that booking just now.")
        return startHandoff(run, 'booking_lookup_failed')
      }
      if (!found) return run.retry("I couldn't find an upcoming booking with that reference for this WhatsApp number.")
      run.set({ mg: found })
      return run.go('manage', 'action')
    }
    case 'manage.action': {
      const opt = matchOption(
        [
          { id: 'mg_cancel', title: 'Cancel booking', aliases: ['cancel', 'cancellation', '1'] },
          { id: 'mg_change', title: 'Change dates', aliases: ['change', 'reschedule', 'change dates', '2'] },
        ],
        text,
        replyId,
      )
      if (opt?.id === 'mg_cancel') return run.go('manage', 'cancel_confirm')
      if (opt?.id === 'mg_change') {
        run.set({ mg_change: undefined, mg_check: undefined })
        return run.go('manage', d.mg!.type === 'event' ? 'new_event_date' : 'new_check_in')
      }
      return run.retry('Please choose Cancel booking, Change dates or Talk to our team.')
    }
    case 'manage.cancel_confirm': {
      const opt = matchOption(
        [
          { id: 'mc_yes', title: 'Yes, cancel', aliases: ['yes', 'cancel', 'yes cancel'] },
          { id: 'mc_keep', title: 'Keep booking', aliases: ['no', 'keep', 'keep booking'] },
        ],
        text,
        replyId,
      )
      if (opt?.id === 'mc_keep') {
        run.say(`Okay — ${d.mg!.ref} stays exactly as it is.`)
        return run.go('manage', 'done')
      }
      if (opt?.id !== 'mc_yes') return run.retry('Please choose "Yes, cancel" or "Keep booking".')
      return requestCancellation(run)
    }
    case 'manage.new_check_in': {
      const date = await readDate(run)
      if (!date) return
      const err = validateStayDates(date, addDays(date, 1), { now: svc.now() })
      if (err) return run.retry(DATE_ERROR_MESSAGES[err])
      run.set({ mg_change: { check_in: date }, date_options: undefined })
      return run.go('manage', 'new_check_out')
    }
    case 'manage.new_check_out': {
      const checkIn = d.mg_change?.check_in
      if (!checkIn) return run.go('manage', 'new_check_in')
      const nights = /^(?:for\s+)?(\d{1,2})\s*nights?$/.exec(normalizeInput(text))
      const date = nights ? addDays(checkIn, Number(nights[1])) : await readDate(run)
      if (!date) return
      const minNights = svc.pricing.rules?.min_nights ?? null
      const err = validateStayDates(checkIn, date, { now: svc.now(), minNights })
      if (err) {
        return run.retry(err === 'below_min_nights' && minNights ? `The minimum stay is ${minNights} nights.` : DATE_ERROR_MESSAGES[err])
      }
      run.set({ mg_change: { check_in: checkIn, check_out: date }, date_options: undefined })
      return checkReschedule(run)
    }
    case 'manage.new_event_date': {
      const date = await readDate(run)
      if (!date) return
      const err = validateEventDate(date, { now: svc.now() })
      if (err) return run.retry(DATE_ERROR_MESSAGES[err])
      run.set({ mg_change: { event_date: date }, date_options: undefined })
      return checkReschedule(run)
    }
    case 'manage.resched_confirm': {
      if (replyId === 'mr_other' || /^(other|other dates)$/.test(normalizeInput(text))) {
        run.set({ mg_change: undefined, mg_check: undefined })
        return run.go('manage', d.mg!.type === 'event' ? 'new_event_date' : 'new_check_in')
      }
      const send = replyId === 'mr_send' || /^(1|yes|send|send request|confirm)$/.test(normalizeInput(text))
      if (send && d.mg_check && d.mg_check.availability !== 'unavailable') return requestReschedule(run)
      return run.retry('Please choose one of the options.')
    }

    // ---------------- Event ----------------
    case 'event.type': {
      const opts = EVENT_TYPES.map((t) => ({ id: `et:${t}`, title: EVENT_TYPE_LABELS[t], aliases: [t.replace('_', ' '), t.split('_')[0]] }))
      const opt = matchOption(opts, text, replyId)
      if (!opt) return run.retry('Please choose the type of event.')
      const type = opt.id.slice(3)
      run.set({ event_type: type, event_type_other: type === 'other' ? undefined : null })
      await svc.noteInterest('event')
      return run.go('event', nextEventStep(run.d))
    }
    case 'event.type_other': {
      const v = text.trim().slice(0, 100)
      if (v.length < 2) return run.retry('Please describe the event in a few words.')
      run.set({ event_type_other: v })
      return run.go('event', nextEventStep(run.d))
    }
    case 'event.date':
    case 'availability.event_date': {
      const date = await readDate(run)
      if (!date) return
      const err = validateEventDate(date, { now: svc.now() })
      if (err) return run.retry(DATE_ERROR_MESSAGES[err])
      run.set({ event_date: date, date_options: undefined })
      return flow === 'event' ? run.go('event', nextEventStep(run.d)) : run.go('availability', 'start')
    }
    case 'event.start':
    case 'availability.start': {
      const t = parseTimeInput(text)
      if (!t) return run.retry('Please include am or pm, e.g. 11 am or 6:30 pm.')
      run.set({ start_time: t })
      return flow === 'event' ? run.go('event', nextEventStep(run.d)) : run.go('availability', 'end')
    }
    case 'event.end':
    case 'availability.end': {
      const t = parseTimeInput(text)
      if (!t) return run.retry('Please include am or pm, e.g. 10 pm.')
      if (t === d.start_time) return run.retry('The end time must be different from the start time.')
      run.set({ end_time: t })
      return flow === 'event' ? run.go('event', nextEventStep(run.d)) : checkEventAvailability(run)
    }
    case 'event.guests': {
      const n = parseCount(text)
      if (n === null || n < 1 || n > 5000) return run.retry('Please reply with the approximate number of guests, e.g. 40.')
      if (s.max_event_guests !== null && n > s.max_event_guests) {
        return run.retry(`Events at ${run.name} can host up to ${s.max_event_guests} guests. Our team can advise on larger groups — reply HUMAN.`)
      }
      run.set({ guest_count: n })
      return run.go('event', nextEventStep(run.d))
    }
    case 'event.accommodation':
    case 'event.catering': {
      const yn = parseYesNo(text, replyId)
      if (yn === null) return run.retry('Please reply Yes or No.')
      run.set(step === 'accommodation' ? { accommodation: yn } : { catering: yn })
      return run.go('event', nextEventStep(run.d))
    }
    case 'event.budget': {
      if (isSkip(text, replyId)) run.set({ budget: null })
      else {
        const amount = parseAmount(text)
        if (amount === null) return run.retry('Please type an amount like 50000, or tap Skip.')
        run.set({ budget: amount })
      }
      return run.go('event', nextEventStep(run.d))
    }
    case 'event.contact': {
      const phone = replyId === 'ct_this' || /^(this|same|this number|this whatsapp number|1)$/.test(normalizeInput(text))
        ? svc.contactPhone
        : normalizePhoneE164(text)
      if (!phone) return run.retry('Please send a valid mobile number, e.g. 98765 43210 (or +country code).')
      run.set({ contact_phone: phone })
      return run.go('event', nextEventStep(run.d))
    }
    case 'event.summary': {
      const opt = matchOption(
        [
          { id: 'ev_confirm', title: 'Send request', aliases: ['confirm', 'yes', 'ok', 'send', 'correct'] },
          { id: 'ev_edit', title: 'Edit details', aliases: ['edit', 'change'] },
        ],
        text,
        replyId,
      )
      if (opt?.id === 'ev_edit') return run.go('event', 'edit')
      if (opt?.id === 'ev_confirm') return submitEvent(run)
      return run.retry('Please tap "Send request", "Edit details" or "Cancel".')
    }

    // ---------------- Pricing ----------------
    case 'pricing.menu': {
      const opt = matchOption(PRICING_OPTIONS, text, replyId)
      if (!opt) return run.retry('Please choose a pricing category.')
      return showPricing(run, opt.id, false)
    }
    case 'pricing.shown': {
      if (replyId === 'pr_quote' || /^(1|quote|get a quote|yes)$/.test(normalizeInput(text))) {
        run.state.data = {}
        return run.go('stay', 'check_in')
      }
      if (replyId === 'pr_menu' || /^(2|other prices|prices|pricing)$/.test(normalizeInput(text))) return run.go('pricing', 'menu')
      return run.retry('Please choose an option.')
    }

    // ---------------- Availability ----------------
    case 'availability.kind': {
      const opt = matchOption([{ id: 'av_stay', title: 'Overnight stay', aliases: ['stay'] }, { id: 'av_event', title: 'Event', aliases: ['event'] }], text, replyId)
      if (!opt) return run.retry('Please choose Stay or Event.')
      run.set({ avail_kind: opt.id === 'av_stay' ? 'stay' : 'event' })
      return run.go('availability', opt.id === 'av_stay' ? 'check_in' : 'event_date')
    }
    case 'availability.result': {
      if (replyId === 'av_book' || /^(1|book|yes|book these dates|plan this event)$/.test(normalizeInput(text))) {
        const keep = d.avail_kind === 'event'
          ? { event_date: d.event_date, start_time: d.start_time, end_time: d.end_time }
          : { check_in: d.check_in, check_out: d.check_out }
        run.state.data = { ...keep }
        return d.avail_kind === 'event' ? run.go('event', nextEventStep(run.d)) : run.go('stay', nextStayStep(run.d))
      }
      if (replyId === 'av_other' || /^(2|other|other dates)$/.test(normalizeInput(text))) {
        return run.go('availability', d.avail_kind === 'event' ? 'event_date' : 'check_in')
      }
      return run.retry('Please choose an option.')
    }
    case 'availability.unverified': {
      if (replyId === 'av_retry' || /^(try again|retry|2)$/.test(normalizeInput(text))) {
        return d.avail_kind === 'event' ? checkEventAvailability(run) : checkStayAvailability(run)
      }
      return run.retry('Please choose an option.')
    }

    // ---------------- Explore ----------------
    case 'explore.menu': {
      const opt = matchOption(exploreOptions(run), text, replyId)
      if (!opt) return run.retry('Please choose a topic.')
      return showExplore(run, opt.id)
    }
    case 'explore.shown': {
      if (replyId === 'ex_menu' || /^(1|explore more|more)$/.test(normalizeInput(text))) return run.go('explore', 'menu')
      if (replyId === 'm_avail' || /^(2|check dates)$/.test(normalizeInput(text))) {
        run.state.data = {}
        return run.go('availability', 'kind')
      }
      return run.menu()
    }

    case 'human.waiting':
      return
    default:
      return run.menu()
  }
}

async function startFromMenu(run: Run, id: string): Promise<void> {
  run.state.data = {}
  switch (id) {
    case 'm_stay':
      // Automation N, when on, takes over new stay enquiries from the Private Farm Stay menu (B).
      if (run.svc.automations.enabled.stay_booking_enquiry) return run.go('booking', 'intro')
      return run.go('stay', 'menu')
    case 'm_event':
      return run.go('event', 'type')
    case 'm_pricing':
      await run.svc.noteInterest('pricing')
      return run.go('pricing', 'menu')
    case 'm_avail':
      return run.go('availability', 'kind')
    case 'm_explore':
      sendExploreShowcase(run)
      return run.go('explore', 'menu')
    case 'm_location':
      return showLocation(run)
    case 'm_human':
      return startHandoff(run, 'guest_requested')
    default:
      return run.menu()
  }
}

// ------------------------------------------------------------------
// Step ordering
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// Customer Information & Stay Booking Enquiry (automation N)
// ------------------------------------------------------------------

function nextBookingStep(d: Data): string {
  if (!d.name) return 'name'
  if (!d.check_in) return 'check_in'
  if (!d.check_out) return 'check_out'
  if (d.adults === undefined) return 'adults'
  if (d.purpose === undefined) return d.purpose_other ? 'purpose_other' : 'purpose'
  if (d.special === undefined) return 'special'
  return 'summary'
}

const BOOKING_EDIT_FIELDS: Record<string, (keyof Data)[]> = {
  name: ['name'],
  check_in: ['check_in'],
  check_out: ['check_out'],
  adults: ['adults', 'children', 'children_ages'],
  purpose: ['purpose', 'purpose_other'],
  special: ['special'],
}

/** Two or more letters; letters (any script), spaces, dots, apostrophes and hyphens only. */
export function validGuestName(value: string): boolean {
  const t = value.trim()
  if (t.length < 2 || t.length > 80) return false
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u.test(t)) return false
  return (t.match(/\p{L}/gu) ?? []).length >= 2
}

function bookingSummary(d: Data, brand: string): string {
  const nights = daysBetween(d.check_in!, d.check_out!)
  return [
    `🌿 ${brand} – Booking Enquiry Summary`,
    '',
    `Guest Name: ${d.name}`,
    `Check-in: ${formatDateHuman(d.check_in!)}`,
    `Check-out: ${formatDateHuman(d.check_out!)}`,
    `Total Nights: ${nights}`,
    `Members: ${d.adults}`,
    `Visit Purpose: ${d.purpose ?? 'Not specified'}`,
    `Special Requirements: ${d.special ? truncate(d.special, 300) : 'None'}`,
    `Property: Entire Exclusive ${brand} Estate`,
  ].join('\n')
}

/** Show a prompt that depends on what just happened (instead of the step's standard prompt). */
function moveTo(run: Run, step: string, text: string, options: BotOption[]) {
  run.state.history = [...run.state.history, { flow: run.state.flow, step: run.state.step }].slice(-20)
  run.state.flow = 'booking'
  run.state.step = step
  run.set({ retries: 0 })
  run.ask(text, options)
}

async function answerBooking(run: Run): Promise<void> {
  const { step } = run.state
  const { text, replyId } = run.input
  const d = run.d
  const svc = run.svc
  const next = () => run.go('booking', nextBookingStep(run.d))

  if (!replyId && BK_QUESTION_GUARD.has(step) && looksLikeQuestion(text)) {
    run.say("Good question! Our team will be happy to help with that — reply HUMAN to talk to them. Meanwhile, let's continue with your enquiry.")
    return prompt(run)
  }

  switch (step) {
    case 'intro': {
      const opt = matchOption(BK_INTRO, text, replyId)
      if (opt?.id === 'bk_start') {
        await svc.noteInterest('stay')
        return next()
      }
      if (opt?.id === 'c_human') return startHandoff(run, 'guest_requested')
      if (opt?.id === 'c_menu') return run.menu()
      return run.retry('Please choose Start Enquiry, Talk to Our Team or Main Menu.')
    }
    case 'name': {
      const value = replyId === 'use_name' && svc.contactName ? svc.contactName.trim() : text.trim().replace(/\s+/g, ' ')
      if (!validGuestName(value)) return run.retry('Please type your full name (at least two letters), e.g. Priya Sharma.')
      run.set({ name: value })
      return next()
    }
    case 'check_in': {
      const date = await readDate(run)
      if (!date) return
      const err = validateStayDates(date, addDays(date, 1), { now: svc.now() })
      if (err) return run.retry(err === 'invalid_date' ? 'Please send a valid date in DD-MM-YYYY format, e.g. 25-12-2026.' : DATE_ERROR_MESSAGES[err])
      const keepCheckout = d.check_out && d.check_out > date && daysBetween(date, d.check_out) <= 30
      run.set({ check_in: date, check_out: keepCheckout ? d.check_out : undefined, date_options: undefined, bk_status: undefined })
      return next()
    }
    case 'check_out': {
      const nights = /^(?:for\s+)?(\d{1,2})\s*nights?$/.exec(normalizeInput(text))
      const date = nights ? addDays(d.check_in!, Number(nights[1])) : await readDate(run)
      if (!date) return
      const minNights = svc.pricing.rules?.min_nights ?? null
      const err = validateStayDates(d.check_in!, date, { now: svc.now(), minNights })
      if (err) {
        if (err === 'checkout_not_after_checkin') return run.retry(`The check-out date must be after your check-in date (${formatDateHuman(d.check_in!)}).`)
        if (err === 'below_min_nights' && minNights) return run.retry(`The minimum stay is ${minNights} nights.`)
        return run.retry(err === 'invalid_date' ? 'Please send a valid date in DD-MM-YYYY format.' : DATE_ERROR_MESSAGES[err])
      }
      run.set({ check_out: date, date_options: undefined, bk_status: undefined })
      return next()
    }
    case 'adults': {
      const n = parseCount(text)
      const err = membersError(n, svc.settings.max_stay_guests)
      if (err || n === null) return run.retry(err ?? MEMBERS_RETRY)
      run.set(membersPatch(n))
      return next()
    }
    case 'purpose': {
      const opt = matchOption(BK_PURPOSE, text, replyId)
      if (opt?.id === 'bp_other') {
        run.set({ purpose_other: true })
        return next()
      }
      const value = opt ? (BK_PURPOSE_VALUE[opt.id] ?? opt.title) : text.trim().slice(0, 100)
      if (value.length < 2) return run.retry('Please choose the purpose of your visit.')
      run.set({ purpose: value })
      return next()
    }
    case 'purpose_other': {
      const value = text.trim().slice(0, 100)
      if (value.length < 2) return run.retry('Please type the purpose of your visit in a few words.')
      run.set({ purpose: value })
      return next()
    }
    case 'special': {
      run.set({ special: isSkip(text, replyId) ? null : text.trim().slice(0, 500) || null })
      return next()
    }
    case 'summary': {
      const opt = matchOption(BK_SUMMARY, text, replyId)
      if (opt?.id === 'bk_submit') return checkBookingAvailability(run)
      if (opt?.id === 'bk_edit') return run.go('booking', 'edit')
      if (opt?.id === 'c_cancel') return run.menu('Okay, I have cancelled this enquiry. Nothing was submitted.')
      return run.retry('Please choose Submit Enquiry, Edit Details or Cancel.')
    }
    case 'edit': {
      const opt = matchOption(BK_EDIT, text, replyId)
      if (!opt) return run.retry('Please choose what to change.')
      const patch: Partial<Data> = { bk_status: undefined, booking_id: undefined, booking_ref: undefined }
      for (const k of BOOKING_EDIT_FIELDS[opt.id.slice(2)] ?? []) (patch as Record<string, undefined>)[k] = undefined
      run.set(patch)
      return next()
    }
    case 'available': {
      const opt = matchOption(BK_AVAILABLE, text, replyId)
      if (opt?.id === 'bk_submit') return submitBookingEnquiry(run)
      if (opt?.id === 'bk_dates') {
        run.set({ check_in: undefined, check_out: undefined, bk_status: undefined })
        return run.go('booking', 'check_in')
      }
      if (opt?.id === 'c_human') return startHandoff(run, 'guest_requested')
      return run.retry('Please choose Submit Enquiry, Change Dates or Talk to Our Team.')
    }
  }
}

/** Live, read-only calendar check (stays, holds, closures, turnover buffer). Nothing is reserved here. */
async function checkBookingAvailability(run: Run): Promise<void> {
  const d = run.d
  let status: AvailabilityStatus
  try {
    status = await run.svc.checkStay(d.check_in!, d.check_out!)
  } catch {
    status = 'unknown'
  }
  emitAvailability(run, status, { kind: 'stay', check_in: d.check_in, check_out: d.check_out, flow: 'booking' })
  if (status === 'unavailable') {
    run.say('Sorry, your selected dates are currently unavailable.\n\nPlease choose another date range, and we will check again.')
    run.set({ check_in: undefined, check_out: undefined, bk_status: undefined })
    return run.go('booking', 'check_in')
  }
  run.set({ bk_status: status })
  // pending_manual = no calendar conflict, but staff confirm every stay — which is what an enquiry is.
  const copy =
    status === 'unknown'
      ? "I couldn't check the calendar just now, so I can't confirm availability yet. You can still submit your enquiry and our team will check the dates for you."
      : `Good news! 🌿 Your preferred dates are currently available for an exclusive ${run.name} stay.`
  moveTo(run, 'available', `${copy}\n\nWould you like us to submit your booking enquiry?`, BK_AVAILABLE)
}

async function submitBookingEnquiry(run: Run): Promise<void> {
  const d = run.d
  let result: SubmitResult
  try {
    result = await run.svc.submitStay(
      {
        check_in: d.check_in!,
        check_out: d.check_out!,
        adults: d.adults!,
        children: d.children ?? 0,
        children_ages: null,
        purpose: d.purpose ?? null,
        special_requirements: d.special ?? null,
        name: d.name!,
        enquiry_only: true,
      },
      `bot:${run.input.messageId}`,
    )
  } catch (err) {
    run.emit('stay_booking_enquiry', 'failed', { step: 'submit' }, err instanceof Error ? err.message : 'submit_failed')
    run.say("Sorry, I couldn't save your enquiry just now. I've asked our team to help.")
    return startHandoff(run, 'bot_submit_failed', false)
  }
  run.set({ booking_id: result.bookingId, booking_ref: result.ref })
  run.emit('stay_booking_enquiry', 'success', { ref: result.ref, booking_id: result.bookingId, availability: result.availability })
  const brand = run.name
  const text =
    result.availability === 'unavailable'
      ? `🌿 Thank you for choosing ${brand}!\n\nYour stay enquiry has been submitted.\n\nEnquiry Reference: ${result.ref}\n\nThose dates were booked moments ago, so our team will contact you shortly with other options.`
      : `🌿 Thank you for choosing ${brand}!\n\nYour stay enquiry has been successfully submitted.\n\nEnquiry Reference: ${result.ref}\n\nOur team will review your requested dates and contact you shortly.\n\nWe look forward to welcoming you to ${brand}!`
  moveTo(run, 'done', text, [NAV_MENU, NAV_HUMAN])
  run.state.history = []
}

function nextStayStep(d: Data): string {
  if (!d.check_in) return 'check_in'
  if (!d.check_out) return 'check_out'
  if (d.adults === undefined) return 'adults'
  if (d.purpose === undefined) return 'purpose'
  if (d.special === undefined) return 'special'
  if (!d.name) return 'name'
  return 'summary'
}

function nextEventStep(d: Data): string {
  if (!d.event_type) return 'type'
  if (d.event_type === 'other' && d.event_type_other === undefined) return 'type_other'
  if (!d.event_date) return 'date'
  if (!d.start_time) return 'start'
  if (!d.end_time) return 'end'
  if (d.guest_count === undefined) return 'guests'
  if (d.accommodation === undefined) return 'accommodation'
  if (d.catering === undefined) return 'catering'
  if (d.decoration === undefined) return 'decoration'
  if (d.budget === undefined) return 'budget'
  if (!d.name) return 'name'
  if (!d.contact_phone) return 'contact'
  return 'summary'
}

const EDIT_FIELDS: Record<string, (keyof Data)[]> = {
  check_in: ['check_in'],
  check_out: ['check_out'],
  adults: ['adults', 'children', 'children_ages'],
  purpose: ['purpose'],
  special: ['special'],
  name: ['name'],
  event_type: ['event_type', 'event_type_other'],
  event_date: ['event_date'],
  start_time: ['start_time'],
  end_time: ['end_time'],
  guest_count: ['guest_count'],
  accommodation: ['accommodation'],
  catering: ['catering'],
  decoration: ['decoration'],
  budget: ['budget'],
  contact: ['name', 'contact_phone'],
}

function clearField(run: Run, field: string) {
  const keys = EDIT_FIELDS[field] ?? []
  const patch: Partial<Data> = { booking_id: undefined, booking_ref: undefined }
  for (const k of keys) (patch as Record<string, undefined>)[k] = undefined
  run.set(patch)
}

function editFieldFromText(flow: BotFlow, text: string): string | null {
  const n = normalizeInput(text)
  const stay: Record<string, string> = { 'check-in': 'check_in', 'check in': 'check_in', checkin: 'check_in', 'check-out': 'check_out', 'check out': 'check_out', checkout: 'check_out', members: 'adults', guests: 'adults', people: 'adults', adults: 'adults', children: 'adults', kids: 'adults', occasion: 'purpose', purpose: 'purpose', requests: 'special', 'special requests': 'special', name: 'name' }
  const event: Record<string, string> = { type: 'event_type', 'event type': 'event_type', date: 'event_date', start: 'start_time', 'start time': 'start_time', end: 'end_time', 'end time': 'end_time', guests: 'guest_count', accommodation: 'accommodation', catering: 'catering', decoration: 'decoration', budget: 'budget', contact: 'contact', name: 'contact' }
  const map = flow === 'stay' ? stay : event
  if (map[n]) return map[n]
  const num = /^(\d{1,2})$/.exec(n)
  if (num) {
    const keys = flow === 'stay'
      ? ['check_in', 'check_out', 'adults', 'purpose', 'special', 'name']
      : ['event_type', 'event_date', 'start_time', 'end_time', 'guest_count', 'accommodation', 'catering', 'decoration', 'budget', 'contact']
    return keys[Number(num[1]) - 1] ?? null
  }
  return null
}

// ------------------------------------------------------------------
// Dates
// ------------------------------------------------------------------

function shortDate(date: string): string {
  return formatDateHuman(date).replace(/ \d{4}$/, '')
}

/** Parse a date reply; on ambiguity it asks a clarifying question and returns null. */
async function readDate(run: Run): Promise<string | null> {
  const { text, replyId } = run.input
  if (replyId?.startsWith('date:')) return replyId.slice(5)
  const opts = run.d.date_options
  if (opts && /^[12]$/.test(normalizeInput(text))) return opts[Number(normalizeInput(text)) - 1] ?? null
  const r = parseGuestDate(text, run.svc.now())
  if (r.kind === 'date') return r.date
  if (r.kind === 'ambiguous') {
    if (r.options && r.options.length > 0) {
      run.set({ date_options: r.options })
      run.ask('Which date do you mean?', r.options.map((o) => ({ id: `date:${o}`, title: truncate(formatDateHuman(o), 20) })))
      return null
    }
    const msg: Record<string, string> = {
      needs_specific_day: 'Please share a specific date, e.g. 25 Dec.',
      needs_month: 'Which month? e.g. 5 Jan.',
      range_given: 'Please send one date at a time — first the start date.',
      which_week: 'Which week do you mean? Please send the exact date, e.g. 14 Feb.',
    }
    run.say(msg[r.reason] ?? 'Please share a specific date, e.g. 25 Dec.')
    return null
  }
  await run.retry("Sorry, I couldn't read that date. Try something like 25 Dec or 25/12/2026.")
  return null
}

function altFromNumber(d: Data, text: string): string | null {
  const n = /^(\d)$/.exec(normalizeInput(text))
  if (!n) return null
  const a = (d.alternatives ?? [])[Number(n[1]) - 1]
  return a ? `alt:${a.check_in}:${a.check_out}` : null
}

// ------------------------------------------------------------------
// Summaries
// ------------------------------------------------------------------

function staySummary(d: Data): string {
  const nights = daysBetween(d.check_in!, d.check_out!)
  const lines = [
    `Check-in: ${formatDateHuman(d.check_in!)}`,
    `Check-out: ${formatDateHuman(d.check_out!)} (${nights} night${nights === 1 ? '' : 's'})`,
    `Members: ${d.adults}`,
  ]
  if (d.purpose) lines.push(`Occasion: ${d.purpose}`)
  if (d.special) lines.push(`Requests: ${d.special}`)
  lines.push(`Name: ${d.name}`)
  return lines.join('\n')
}

function eventSummary(d: Data): string {
  const type = d.event_type === 'other' && d.event_type_other ? d.event_type_other : EVENT_TYPE_LABELS[d.event_type as keyof typeof EVENT_TYPE_LABELS] ?? d.event_type
  const lines = [
    `Event: ${type}`,
    `Date: ${formatDateHuman(d.event_date!)}`,
    `Time: ${formatTimeHuman(d.start_time)} – ${formatTimeHuman(d.end_time)}`,
    `Guests: about ${d.guest_count}`,
    `Accommodation: ${d.accommodation ? 'Yes' : 'No'}`,
    `Catering: ${d.catering ? 'Yes' : 'No'}`,
  ]
  if (d.decoration) lines.push(`Decoration: ${d.decoration}`)
  if (d.budget) lines.push(`Budget: ${formatINR(rupeesToPaise(d.budget))}`)
  lines.push(`Name: ${d.name}`, `Contact: ${d.contact_phone}`)
  return lines.join('\n')
}

// ------------------------------------------------------------------
// Actions
// ------------------------------------------------------------------

const AVAILABILITY_COPY: Record<AvailabilityStatus, string> = {
  available: 'Good news — the estate is open for those dates.',
  pending_manual: 'The estate looks open for those dates. Our team will confirm availability personally.',
  unavailable: 'Sorry, the estate is already booked for those dates.',
  unknown: "I couldn't verify the calendar just now, so I can't confirm availability. Our team will check for you.",
}

async function submitStay(run: Run): Promise<void> {
  const d = run.d
  let result: SubmitResult
  try {
    result = await run.svc.submitStay(
      {
        check_in: d.check_in!,
        check_out: d.check_out!,
        adults: d.adults!,
        children: d.children ?? 0,
        children_ages: d.children_ages ?? null,
        purpose: d.purpose ?? null,
        special_requirements: d.special ?? null,
        name: d.name!,
      },
      `bot:${run.input.messageId}`,
    )
  } catch (err) {
    run.emit('stay_enquiry', 'failed', { step: 'submit' }, err instanceof Error ? err.message : 'submit_failed')
    run.say("Sorry, I couldn't save your request just now. I've asked our team to help.")
    return startHandoff(run, 'bot_submit_failed', false)
  }
  run.set({ booking_id: result.bookingId, booking_ref: result.ref })
  run.emit('stay_enquiry', 'success', { ref: result.ref, booking_id: result.bookingId })
  emitAvailability(run, result.availability, { ref: result.ref })
  if (result.quote.status === 'ok') run.emit('pricing_quote', 'success', { ref: result.ref, total_paise: result.quote.quote.total })
  else run.emit('pricing_quote', 'skipped', { ref: result.ref, reason: result.quote.status })

  if (result.availability === 'unavailable') {
    run.say(`${AVAILABILITY_COPY.unavailable} (Ref ${result.ref})`)
    return offerAlternatives(run, 'stay')
  }
  if (result.availability === 'unknown') {
    run.say(`${AVAILABILITY_COPY.unknown}\nYour reference is ${result.ref}.`)
    return run.go('stay', 'done')
  }
  const parts = [AVAILABILITY_COPY[result.availability]]
  if (result.quote.status === 'ok') parts.push(`\nYour quote (ref ${result.ref}):\n${formatQuoteText(result.quote.quote)}`)
  else if (result.quote.status === 'below_min_nights') parts.push(`\nThose dates need a minimum stay of ${result.quote.min_nights} nights. Reply BACK to change dates.`)
  else parts.push(`\nYour reference is ${result.ref}. Our team will send you an exact quote shortly.`)
  if (result.link) parts.push(`\nView your booking: ${result.link}`)
  parts.push('\nAvailability is confirmed only when our team confirms your booking.')
  run.say(parts.join('\n'))
  return run.go('stay', 'result')
}

async function submitEvent(run: Run): Promise<void> {
  const d = run.d
  let result: SubmitResult
  try {
    result = await run.svc.submitEvent(
      {
        event_type: d.event_type!,
        event_type_other: d.event_type_other ?? null,
        event_date: d.event_date!,
        start_time: d.start_time!,
        end_time: d.end_time!,
        guest_count: d.guest_count!,
        accommodation_required: d.accommodation ?? null,
        catering_required: d.catering ?? null,
        decoration_requirements: d.decoration ?? null,
        budget_inr: d.budget ?? null,
        name: d.name!,
        contact_phone: d.contact_phone!,
      },
      `bot:${run.input.messageId}`,
    )
  } catch (err) {
    run.emit('event_enquiry', 'failed', { step: 'submit' }, err instanceof Error ? err.message : 'submit_failed')
    run.say("Sorry, I couldn't save your request just now. I've asked our team to help.")
    return startHandoff(run, 'bot_submit_failed', false)
  }
  run.set({ booking_id: result.bookingId, booking_ref: result.ref })
  run.emit('event_enquiry', 'success', { ref: result.ref, booking_id: result.bookingId })
  emitAvailability(run, result.availability, { ref: result.ref })
  const lines = [`Thank you! Your event request ${result.ref} is *Pending Review*. Our team will review it and get back to you here.`]
  if (result.availability === 'unavailable') lines.push('\nNote: the estate already has a booking around that time. Our team will suggest options.')
  else if (result.availability === 'unknown') lines.push("\nI couldn't verify the calendar just now — our team will check.")
  else lines.push('\nThe estate looks open at that time.')
  if (result.quote.status === 'ok') lines.push(`\nIndicative price from our current packages: ${formatINR(result.quote.quote.total)} (final price confirmed after review).`)
  if (result.link) lines.push(`\nView your request: ${result.link}`)
  run.say(lines.join('\n'))
  return run.go('event', 'done')
}

async function reserve(run: Run): Promise<void> {
  const d = run.d
  if (!d.booking_id) return run.go('stay', nextStayStep(d))
  if (!run.svc.automations.enabled.booking_request) {
    run.emit('booking_request', 'skipped', { ref: d.booking_ref, booking_id: d.booking_id, reason: 'automation_disabled' })
    run.say(`Thank you — I've passed your request ${d.booking_ref} to our team. Nothing is reserved yet; they'll confirm availability with you here.`)
    return startHandoff(run, 'automation_disabled:booking_request', false)
  }
  let r
  try {
    r = await run.svc.reserve(d.booking_id)
  } catch {
    run.say("I couldn't verify availability just now, so I can't reserve the dates. I've asked our team to help.")
    return startHandoff(run, 'reservation_failed', false)
  }
  run.emit('booking_request', r.outcome === 'not_eligible' ? 'skipped' : 'success', { ref: d.booking_ref, booking_id: d.booking_id, reserve: r.outcome })
  const until = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null
  switch (r.outcome) {
    case 'payment_required': {
      const lines = [`The estate is on hold for you${r.holdExpiresAt ? ` until ${until(r.holdExpiresAt)}` : ''} (ref ${d.booking_ref}).`]
      lines.push(r.paymentLink ? `To secure it, please pay the advance here:\n${r.paymentLink}` : 'Our team will share payment details with you here.')
      lines.push(
        run.svc.settings.manual_approval_required
          ? 'Your booking is confirmed once the payment is verified and our team confirms it.'
          : 'Your booking is confirmed once the payment is verified.',
      )
      run.say(lines.join('\n'))
      break
    }
    case 'requested':
      run.say(
        `Your booking request ${d.booking_ref} has been sent to our team.${r.holdExpiresAt ? ` The dates are held for you until ${until(r.holdExpiresAt)}.` : ''}\nThis is not a confirmed booking yet — we'll confirm with you here on WhatsApp.`,
      )
      break
    case 'requested_review':
      run.say(`Your request ${d.booking_ref} is with our team for review. We'll get back to you here.`)
      break
    case 'unavailable':
      run.say('Sorry — those dates were just taken.')
      return offerAlternatives(run, 'stay')
    case 'not_eligible':
      run.say("This request can't be reserved in its current state. I've asked our team to help.")
      return startHandoff(run, 'reservation_not_eligible', false)
  }
  return run.go('stay', 'done')
}

function emitAvailability(run: Run, status: AvailabilityStatus, detail: Record<string, unknown> = {}) {
  if (status === 'unknown') run.emit('availability_check', 'failed', { ...detail, status }, 'unable_to_verify')
  else run.emit('availability_check', 'success', { ...detail, status })
}

async function offerAlternatives(run: Run, flow: 'stay' | 'availability'): Promise<void> {
  const d = run.d
  if (!run.svc.automations.enabled.availability_check || !run.svc.automations.config.availability_check.suggest_alternatives) {
    run.ask('Would you like to try other dates or talk to our team?', [{ id: 'av_other', title: 'Other dates' }, NAV_HUMAN, NAV_MENU])
    run.set({ alternatives: [] })
    run.state.flow = flow
    run.state.step = 'alternatives'
    return
  }
  const alts = await run.svc.alternatives(d.check_in!, daysBetween(d.check_in!, d.check_out!))
  if (alts === null) {
    run.say("I couldn't check other dates just now.")
    return run.go(flow, flow === 'stay' ? 'done' : 'unverified')
  }
  if (alts.length === 0) {
    run.ask('There are no open dates of the same length within two weeks of your request. Would you like to try other dates or talk to our team?', [
      { id: 'av_other', title: 'Other dates' },
      NAV_HUMAN,
      NAV_MENU,
    ])
    run.set({ alternatives: [] })
    run.state.history = [...run.state.history, { flow: run.state.flow, step: run.state.step }].slice(-20)
    run.state.flow = flow
    run.state.step = 'alternatives'
    return
  }
  run.set({ alternatives: alts })
  return run.go(flow, 'alternatives')
}

async function checkStayAvailability(run: Run): Promise<void> {
  const d = run.d
  run.set({ avail_kind: 'stay' })
  const status = await run.svc.checkStay(d.check_in!, d.check_out!)
  emitAvailability(run, status, { kind: 'stay', check_in: d.check_in, check_out: d.check_out })
  if (status === 'unavailable') {
    run.say(AVAILABILITY_COPY.unavailable)
    return offerAlternatives(run, 'availability')
  }
  run.say(`${formatDateHuman(d.check_in!)} → ${formatDateHuman(d.check_out!)}\n${AVAILABILITY_COPY[status]}`)
  return run.go('availability', status === 'unknown' ? 'unverified' : 'result')
}

async function checkEventAvailability(run: Run): Promise<void> {
  const d = run.d
  run.set({ avail_kind: 'event' })
  const status = await run.svc.checkEvent(d.event_date!, d.start_time!, d.end_time!)
  emitAvailability(run, status, { kind: 'event', event_date: d.event_date })
  const when = `${formatDateHuman(d.event_date!)}, ${formatTimeHuman(d.start_time)} – ${formatTimeHuman(d.end_time)}`
  if (status === 'unavailable') {
    run.say(`${when}\nSorry, the estate is already booked around that time.`)
    run.ask('Would you like to try another date or time?', [{ id: 'av_other', title: 'Other dates' }, NAV_HUMAN, NAV_MENU])
    run.state.flow = 'availability'
    run.state.step = 'result'
    return
  }
  const copy = status === 'unknown' ? AVAILABILITY_COPY.unknown : 'The estate looks open at that time. Every event is reviewed by our team before it is confirmed.'
  run.say(`${when}\n${copy}`)
  return run.go('availability', status === 'unknown' ? 'unverified' : 'result')
}

async function startHandoff(run: Run, reason: string, announce = true): Promise<void> {
  const summary = handoffSummary(run)
  try {
    await run.svc.handoff(reason, summary)
    run.emit('human_escalation', 'success', { reason })
  } catch (err) {
    // The runtime logs; the guest still gets an honest reply and the bot still pauses.
    run.emit('human_escalation', 'failed', { reason }, err instanceof Error ? err.message : 'handoff_failed')
  }
  if (announce) {
    run.say("I've asked our team to join this chat. A person will reply here as soon as possible.")
  }
  run.handoff = true
  run.handoffReason = reason
  run.state.history = []
  run.state.flow = 'human'
  run.state.step = 'waiting'
}

function handoffSummary(run: Run): string {
  const d = run.d
  const bits = [`Was in: ${FLOW_LABEL[run.state.flow]}`]
  if (d.check_in) bits.push(`Dates: ${d.check_in} → ${d.check_out ?? '?'}`)
  if (d.event_date) bits.push(`Event: ${d.event_type ?? ''} on ${d.event_date}`)
  if (d.adults) bits.push(`Guests: ${d.adults} adults, ${d.children ?? 0} children`)
  if (d.guest_count) bits.push(`Guests: ${d.guest_count}`)
  if (d.booking_ref) bits.push(`Ref: ${d.booking_ref}`)
  if (run.svc.contactPhone) bits.push(`Phone: ${maskPhone(run.svc.contactPhone)}`)
  return bits.join(' · ')
}

// ------------------------------------------------------------------
// Information (approved data only)
// ------------------------------------------------------------------

function stayInfo(run: Run): string {
  const s = run.svc.settings
  const lines: string[] = [`A stay at ${run.name} is exclusive — one group books the whole estate.`]
  if (s.room_count !== null) lines.push(`• ${s.room_count} guest rooms`)
  if (s.max_stay_guests !== null) lines.push(`• Up to ${s.max_stay_guests} guests overnight`)
  if (s.check_in_time) lines.push(`• Check-in from ${formatTimeHuman(s.check_in_time)}`)
  if (s.check_out_time) lines.push(`• Check-out by ${formatTimeHuman(s.check_out_time)}`)
  if (s.building_description) lines.push('', s.building_description)
  if (lines.length === 1) lines.push('Our team can share full details of the rooms — reply HUMAN.')
  return truncate(lines.join('\n'), 1000)
}

async function showPricing(run: Run, id: string, fromStay: boolean): Promise<void> {
  const rates = describeRates(run.svc.pricing)
  const rules = run.svc.pricing.rules
  const lines: string[] = []
  const notSet = (what: string) => `Our team hasn't published ${what} here yet. Reply HUMAN and they'll share it with you.`
  switch (id) {
    case 'p_weekday':
      lines.push(rates.weekday !== null ? `Weekday nights: ${formatINR(rates.weekday)} per night for the whole estate.` : notSet('weekday rates'))
      if (fromStay && rates.weekend !== null) lines.push(`Weekend nights: ${formatINR(rates.weekend)} per night.`)
      break
    case 'p_weekend':
      lines.push(rates.weekend !== null ? `Weekend nights: ${formatINR(rates.weekend)} per night for the whole estate.` : notSet('weekend rates'))
      break
    case 'p_seasonal': {
      const today = run.svc.now().toISOString().slice(0, 10)
      const upcoming = rates.seasonal.filter((s) => s.end >= today).slice(0, 6)
      if (upcoming.length === 0) lines.push('There are no seasonal or special-date rates published right now. Regular rates apply unless our team tells you otherwise.')
      else {
        lines.push('Seasonal & special-date rates:')
        for (const s of upcoming) lines.push(`• ${s.name} (${shortDate(s.start)}${s.end !== s.start ? ` – ${shortDate(s.end)}` : ''}): ${formatINR(s.nightly)}/night`)
      }
      break
    }
    case 'p_extra':
      if (!rules || (rules.base_guests_included === null && rules.extra_adult_rate_per_night === null && rules.extra_child_rate_per_night === null)) {
        lines.push(notSet('extra-guest charges'))
      } else {
        if (rules.base_guests_included !== null) lines.push(`The nightly rate includes up to ${rules.base_guests_included} guests.`)
        if (rules.extra_adult_rate_per_night !== null) lines.push(`Extra adult: ${formatINR(rupeesToPaise(rules.extra_adult_rate_per_night))} per night.`)
        if (rules.extra_child_rate_per_night !== null) {
          lines.push(`Extra child${rules.child_age_limit !== null ? ` (up to ${rules.child_age_limit} yrs)` : ''}: ${formatINR(rupeesToPaise(rules.extra_child_rate_per_night))} per night.`)
        }
      }
      break
    case 'p_events':
      if (rates.packages.length === 0) lines.push(notSet('event packages'))
      else {
        lines.push('Event packages:')
        for (const p of rates.packages.slice(0, 6)) {
          lines.push(`• ${p.name}: ${formatINR(p.base)}${p.hours !== null ? ` · ${p.hours} hrs` : ''}${p.max_guests !== null ? ` · up to ${p.max_guests} guests` : ''}`)
        }
        lines.push('Every event is reviewed by our team before it is confirmed.')
      }
      break
    case 'p_addons':
      if (rates.addons.length > 0) {
        lines.push('Add-ons:')
        for (const a of rates.addons.slice(0, 8)) lines.push(`• ${a.name}: ${formatINR(a.price)} ${a.unit.replace(/_/g, ' ')}`)
      }
      if (rules?.deposit_pct != null) lines.push(`Advance to reserve: ${rules.deposit_pct}% of the total.`)
      else if (rules?.deposit_fixed_amount != null) lines.push(`Advance to reserve: ${formatINR(rupeesToPaise(rules.deposit_fixed_amount))}.`)
      if (lines.length === 0) lines.push(notSet('add-ons and advance terms'))
      break
  }
  if (rules?.tax_pct != null && ['p_weekday', 'p_weekend', 'p_seasonal', 'p_extra'].includes(id) && lines.length > 0 && !lines[0].startsWith('Our team')) {
    lines.push(rules.prices_include_tax ? `Prices include ${rules.tax_label}.` : `${rules.tax_label} (${rules.tax_pct}%) is extra.`)
  }
  run.say(truncate(lines.join('\n'), 1000))
  run.emit('pricing_quote', 'success', { category: id })
  return run.go('pricing', 'shown')
}

/** The reply to the post-stay feedback message: "5", "4 - lovely stay", or just a comment. */
async function recordFeedback(run: Run): Promise<void> {
  const bookingId = run.d.feedback_booking_id
  const { text, replyId } = run.input
  if (!bookingId || replyId || isGreeting(run.input)) return run.menu()
  const m = /^\s*([1-5])(?:\s*(?:\/\s*5|stars?|out of 5))?\s*[-–:,.!]?\s*([\s\S]*)$/i.exec(text)
  const rating = m ? Number(m[1]) : null
  const comment = (m ? m[2] : text).trim().slice(0, 2000) || null
  if (rating === null && (!comment || comment.length < 3)) return run.retry('Please reply with a rating from 1 to 5.')
  let saved = false
  try {
    saved = await run.svc.recordFeedback(bookingId, rating, comment)
  } catch (err) {
    run.emit('post_stay_feedback', 'failed', { booking_id: bookingId }, err instanceof Error ? err.message : 'feedback_failed')
  }
  if (saved) run.emit('post_stay_feedback', 'success', { booking_id: bookingId, rating })
  run.set({ feedback_booking_id: undefined })
  run.say(`Thank you for your feedback! 🌿${rating !== null && rating <= 2 ? ' We are sorry it fell short — our team will look into it.' : ''}`)
  if (rating !== null && rating <= 2) return startHandoff(run, 'low_feedback_rating', false)
  run.state.flow = 'menu'
  run.state.step = 'done'
  return prompt(run)
}

// ------------------------------------------------------------------
// Cancellation & rescheduling (automation L). The bot only records a
// request: a paid or confirmed booking is changed solely by staff.
// ------------------------------------------------------------------

async function startManage(run: Run): Promise<void> {
  if (!(await run.enter('manage'))) return
  run.state.data = {}
  let list: GuestBooking[]
  try {
    list = await run.svc.guestBookings()
  } catch (err) {
    run.emit('cancel_reschedule', 'failed', { step: 'lookup' }, err instanceof Error ? err.message : 'booking_lookup_failed')
    run.say("I couldn't look up your bookings just now.")
    return startHandoff(run, 'booking_lookup_failed')
  }
  if (list.length === 1) {
    run.set({ mg: list[0] })
    return run.go('manage', 'action')
  }
  if (list.length > 1) {
    run.set({ mg_options: list.slice(0, 9) })
    return run.go('manage', 'pick')
  }
  run.say("I couldn't find an upcoming booking for this WhatsApp number.")
  return run.go('manage', 'ref')
}

function describeGuestBooking(b: GuestBooking): string {
  if (b.type === 'event' && b.event_date) {
    return `Event on ${formatDateHuman(b.event_date)}, ${formatTimeHuman(b.start_time)} – ${formatTimeHuman(b.end_time)}`
  }
  if (b.check_in && b.check_out) return `Stay ${shortDate(b.check_in)} → ${shortDate(b.check_out)}`
  return 'Booking'
}

/** The published policy and, only when cancellation rules are configured, the refund they give. */
function cancellationTerms(run: Run, b: GuestBooking): string {
  const policy = run.svc.settings.cancellation_policy
  const lines = [
    policy
      ? `Cancellation policy:\n${truncate(policy, 500)}`
      : "Our cancellation policy hasn't been published here yet — our team will explain any charges before anything is cancelled.",
  ]
  const rules = run.svc.pricing.rules?.cancellation_rules ?? null
  const start = b.check_in ?? b.event_date
  if (b.amount_paid_paise > 0 && start && rules && rules.length > 0) {
    const days = daysBetween(todayIST(run.svc.now()), start)
    const rule = [...rules].sort((x, y) => y.days_before - x.days_before).find((r) => days >= r.days_before)
    if (rule) {
      const refund = Math.round((b.amount_paid_paise * rule.refund_pct) / 100)
      lines.push(
        `Paid so far: ${formatINR(b.amount_paid_paise)}. Cancelling ${days} day${days === 1 ? '' : 's'} before, the configured rules give a ${rule.refund_pct}% refund (about ${formatINR(refund)}). Our team confirms the final amount — no refund has been processed yet.`,
      )
    }
  }
  return lines.join('\n\n')
}

async function requestCancellation(run: Run): Promise<void> {
  const b = run.d.mg!
  let outcome: 'cancelled' | 'cancellation_requested'
  try {
    outcome = await run.svc.requestCancellation(b.id)
  } catch (err) {
    run.emit('cancel_reschedule', 'failed', { action: 'cancel', ref: b.ref }, err instanceof Error ? err.message : 'cancel_failed')
    run.say("I couldn't record your cancellation request just now. I've asked our team to help — nothing has been cancelled.")
    return startHandoff(run, 'cancellation_failed', false)
  }
  run.emit('cancel_reschedule', 'success', { action: 'cancel', ref: b.ref, outcome })
  if (outcome === 'cancelled') {
    run.say(`Your request ${b.ref} has been cancelled and the dates released. No payment had been made, so nothing is due.`)
    return run.go('manage', 'done')
  }
  run.say(
    `I've sent your cancellation request for ${b.ref} to our team. Your booking stays as it is until they confirm the cancellation${b.amount_paid_paise > 0 ? ' and any refund' : ''}. No refund has been processed yet.`,
  )
  return startHandoff(run, 'cancellation_requested', false)
}

async function checkReschedule(run: Run): Promise<void> {
  const b = run.d.mg!
  const change = run.d.mg_change!
  let check: RescheduleCheck
  try {
    check = await run.svc.checkReschedule(b.id, change)
  } catch {
    check = { availability: 'unknown', total_paise: null, quote_snapshot: null }
  }
  run.set({ mg_check: check })
  emitAvailability(run, check.availability, { kind: 'reschedule', ref: b.ref })
  const when = change.event_date
    ? formatDateHuman(change.event_date)
    : `${formatDateHuman(change.check_in!)} → ${formatDateHuman(change.check_out!)}`
  if (check.availability === 'unavailable') {
    run.say(`${when}\nSorry, the estate isn't open for those dates.`)
    return run.go('manage', 'resched_confirm')
  }
  const lines = [when, AVAILABILITY_COPY[check.availability]]
  lines.push(
    check.total_paise !== null
      ? `Estimated total for the new dates at current rates: ${formatINR(check.total_paise)}. Our team confirms the final amount and any difference.`
      : 'Our team will confirm the price for the new dates.',
  )
  lines.push('Your current booking stays unchanged until our team confirms the change.')
  run.say(lines.join('\n'))
  return run.go('manage', 'resched_confirm')
}

async function requestReschedule(run: Run): Promise<void> {
  const b = run.d.mg!
  try {
    await run.svc.requestReschedule(b.id, run.d.mg_change!, run.d.mg_check!)
  } catch (err) {
    run.emit('cancel_reschedule', 'failed', { action: 'reschedule', ref: b.ref }, err instanceof Error ? err.message : 'reschedule_failed')
    run.say("I couldn't record your date-change request just now. I've asked our team to help — your booking is unchanged.")
    return startHandoff(run, 'reschedule_failed', false)
  }
  run.emit('cancel_reschedule', 'success', { action: 'reschedule', ref: b.ref })
  run.say(`Your date-change request for ${b.ref} has been sent to our team. They will confirm here on WhatsApp.`)
  return startHandoff(run, 'reschedule_requested', false)
}

function exploreOptions(run: Run): BotOption[] {
  const s = run.svc.settings
  const opts: BotOption[] = []
  if (s.description || s.farm_description) opts.push({ id: 'x_about', title: 'About the estate', aliases: ['about', 'farm'] })
  if (s.room_count !== null || s.building_description || s.check_in_time) opts.push({ id: 'x_rooms', title: 'Rooms & stay', aliases: ['rooms'] })
  opts.push({ id: 'x_amenities', title: 'Amenities', aliases: ['amenities', 'facilities'] })
  if (s.food_info) opts.push({ id: 'x_food', title: 'Food', aliases: ['food', 'meals'] })
  if (s.activities_info) opts.push({ id: 'x_activities', title: 'Things to do', aliases: ['activities'] })
  opts.push({ id: 'x_faq', title: 'Common questions', aliases: ['faq', 'faqs', 'questions'] })
  if (run.svc.explore?.website || run.svc.explore?.media.length || run.svc.siteUrl) {
    opts.push({ id: 'x_photos', title: 'Photos & video', aliases: ['photos', 'gallery', 'website', 'video', 'pictures'] })
  }
  return opts
}

/** Website link, then the estate photos and video, in order. */
function sendExploreShowcase(run: Run): boolean {
  const explore = run.svc.explore
  if (!explore || (!explore.website && explore.media.length === 0)) return false
  const intro = [`🌿 Explore ${run.name}`]
  if (explore.website) intro.push(`Visit our website for photos and full details:\n${explore.website}`)
  if (explore.media.length > 0) intro.push('Here is a look at the estate 👇')
  run.say(intro.join('\n\n'))
  for (const m of explore.media) run.media(m.kind, m.url, m.caption)
  return true
}

async function showExplore(run: Run, id: string): Promise<void> {
  const s = run.svc.settings
  let text = ''
  switch (id) {
    case 'x_about':
      text = [s.description, s.farm_description].filter(Boolean).join('\n\n')
      break
    case 'x_rooms':
      text = stayInfo(run)
      break
    case 'x_amenities': {
      const list = run.svc.amenities
      text = list.length > 0
        ? `Amenities:\n${list.slice(0, 15).map((a) => `• ${a.name}${a.description ? ` – ${a.description}` : ''}`).join('\n')}`
        : "Our amenities list hasn't been published yet. Reply HUMAN and our team will tell you what's available."
      break
    }
    case 'x_food':
      text = s.food_info ?? ''
      break
    case 'x_activities':
      text = s.activities_info ?? ''
      break
    case 'x_faq': {
      const faqs = await run.svc.faqs().catch(() => [])
      text = faqs.length > 0
        ? faqs.slice(0, 5).map((f) => `*${f.question}*\n${f.answer}`).join('\n\n')
        : 'Answers to common questions will be published soon. Reply HUMAN to ask our team.'
      break
    }
    case 'x_photos':
      if (sendExploreShowcase(run)) return run.go('explore', 'shown')
      text = `See photos and full details on our website:\n${run.svc.siteUrl}/gallery`
      break
  }
  run.say(truncate(text || 'Our team can tell you more — reply HUMAN.', 1000))
  return run.go('explore', 'shown')
}

async function showLocation(run: Run): Promise<void> {
  const s = run.svc.settings
  if (!s.address && !s.map_url && !s.directions) {
    run.say("Our team will share the location and directions with you here shortly.")
    return startHandoff(run, 'location_not_configured', false)
  }
  const lines = [run.name]
  if (s.address) lines.push(s.address)
  if (s.map_url) lines.push(`Map: ${s.map_url}`)
  if (s.directions) lines.push('', s.directions)
  if (s.parking_info) lines.push('', `Parking: ${s.parking_info}`)
  run.say(truncate(lines.join('\n'), 1000))
  return run.go('location', 'shown')
}
