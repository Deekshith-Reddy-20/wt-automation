/**
 * Last MSG91 webhook POST this server process saw, for the health panel.
 * In memory, like the Meta equivalent: resets on restart and is per instance.
 */

export type Msg91WebhookOutcome = 'accepted' | 'skipped' | 'unauthorized' | 'invalid_json'

export interface Msg91WebhookHealth {
  since: string
  last_post: { at: string; outcome: Msg91WebhookOutcome } | null
  last_accepted_at: string | null
}

const state: Msg91WebhookHealth = {
  since: new Date().toISOString(),
  last_post: null,
  last_accepted_at: null,
}

export function recordMsg91WebhookPost(outcome: Msg91WebhookOutcome, now: Date = new Date()): void {
  const at = now.toISOString()
  state.last_post = { at, outcome }
  if (outcome === 'accepted') state.last_accepted_at = at
}

export function getMsg91WebhookHealth(): Msg91WebhookHealth {
  return { ...state }
}
