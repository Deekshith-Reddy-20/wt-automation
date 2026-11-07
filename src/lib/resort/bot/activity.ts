/** No reply this long after a guest message means the bot run stalled or was skipped. */
export const REPLY_TIMEOUT_MS = 60_000

export interface ActivityMessage {
  sender_type: string
  status: string | null
  content_text: string | null
  created_at: string
}

export type BotActivityState =
  | 'idle'
  | 'processing'
  | 'no_reply'
  | 'failed'
  | 'simulated'
  | 'accepted'
  | 'sent'
  | 'delivered'
  | 'read'

export interface BotActivity {
  state: BotActivityState
  /** When the guest message being answered arrived (or the reply was stored). */
  at: string | null
}

const SIMULATED_PREFIX = '[test mode — not sent]'

/**
 * What happened to the guest's latest message, derived from stored messages
 * only: the bot never holds a "replying" flag that could get stuck.
 * `messages` may be in any order.
 */
export function botActivity(messages: ActivityMessage[], now: Date = new Date()): BotActivity {
  const sorted = [...messages].sort((a, b) => a.created_at.localeCompare(b.created_at))
  let lastGuest = -1
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].sender_type === 'customer') {
      lastGuest = i
      break
    }
  }
  if (lastGuest === -1) return { state: 'idle', at: null }

  const guestAt = sorted[lastGuest].created_at
  const replies = sorted.slice(lastGuest + 1).filter((m) => m.sender_type === 'bot' || m.sender_type === 'agent')
  if (replies.length === 0) {
    const waited = now.getTime() - new Date(guestAt).getTime()
    return { state: waited < REPLY_TIMEOUT_MS ? 'processing' : 'no_reply', at: guestAt }
  }

  const failed = replies.find((m) => m.status === 'failed')
  if (failed) return { state: 'failed', at: failed.created_at }
  const last = replies[replies.length - 1]
  if (last.content_text?.startsWith(SIMULATED_PREFIX)) return { state: 'simulated', at: last.created_at }
  if (last.status === 'read') return { state: 'read', at: last.created_at }
  if (last.status === 'delivered') return { state: 'delivered', at: last.created_at }
  if (last.status === 'sent') return { state: 'sent', at: last.created_at }
  return { state: 'accepted', at: last.created_at }
}
