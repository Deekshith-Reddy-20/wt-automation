import { describe, expect, it } from 'vitest'
import { botActivity, REPLY_TIMEOUT_MS, type ActivityMessage } from './activity'

const now = new Date('2026-11-07T10:00:00Z')
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString()
const guest = (ms: number): ActivityMessage => ({ sender_type: 'customer', status: 'delivered', content_text: 'Hi', created_at: ago(ms) })
const bot = (ms: number, status = 'sent', text = 'Welcome'): ActivityMessage => ({ sender_type: 'bot', status, content_text: text, created_at: ago(ms) })

describe('botActivity — the inbox never shows a stuck "replying" state', () => {
  it('is idle before any guest message', () => {
    expect(botActivity([], now).state).toBe('idle')
  })

  it('is processing right after a guest message, then times out to no_reply', () => {
    expect(botActivity([guest(5_000)], now).state).toBe('processing')
    expect(botActivity([guest(REPLY_TIMEOUT_MS + 1)], now).state).toBe('no_reply')
  })

  it('separates MSG91 acceptance from confirmed delivery', () => {
    expect(botActivity([guest(9_000), bot(8_000, 'sending')], now).state).toBe('accepted')
    expect(botActivity([guest(9_000), bot(8_000, 'sent')], now).state).toBe('sent')
    expect(botActivity([guest(9_000), bot(8_000, 'delivered')], now).state).toBe('delivered')
    expect(botActivity([guest(9_000), bot(8_000, 'read')], now).state).toBe('read')
  })

  it('shows a failed send even when a later reply went out', () => {
    expect(botActivity([guest(9_000), bot(8_000, 'failed'), bot(7_000, 'sent')], now).state).toBe('failed')
  })

  it('marks test-mode replies as simulated', () => {
    expect(botActivity([guest(9_000), bot(8_000, 'sent', '[test mode — not sent] Welcome')], now).state).toBe('simulated')
  })

  it('only looks at replies after the latest guest message', () => {
    expect(botActivity([guest(90_000), bot(80_000, 'failed'), guest(2_000)], now).state).toBe('processing')
  })
})
