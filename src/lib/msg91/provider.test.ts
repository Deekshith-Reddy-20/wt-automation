import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SendResult } from './client'

const sendSessionText = vi.fn<(...a: unknown[]) => Promise<SendResult>>()
const sendSessionInteractive = vi.fn<(...a: unknown[]) => Promise<SendResult>>()
const sendSessionMedia = vi.fn<(...a: unknown[]) => Promise<SendResult>>()
vi.mock('./client', async (importActual) => ({
  isAmbiguousSendError: (await importActual<typeof import('./client')>()).isAmbiguousSendError,
  sendSessionText: (...a: unknown[]) => sendSessionText(...a),
  sendSessionInteractive: (...a: unknown[]) => sendSessionInteractive(...a),
  sendSessionMedia: (...a: unknown[]) => sendSessionMedia(...a),
}))

const { Msg91Provider } = await import('./provider')

let inserted: Array<{ message_id: string; status: string; content_text: string }> = []
const db = {
  from: (table: string) =>
    table === 'messages'
      ? {
          insert: (row: { message_id: string; status: string; content_text: string }) => {
            inserted.push(row)
            return { select: () => ({ single: async () => ({ data: { id: `m${inserted.length}` }, error: null }) }) }
          },
        }
      : { update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) },
} as never

const target = { accountId: 'acc', userId: 'u', conversationId: 'conv', contactId: 'ct' }
const menu = { kind: 'buttons' as const, body: 'Welcome', buttons: [{ id: 'm_stay', title: 'Stay' }] }

function provider() {
  const stages: string[] = []
  const marks: string[] = []
  const p = new Msg91Provider(db, target, '916300729913', {
    cid: 'c1',
    log: (s) => stages.push(s),
    mark: (m) => marks.push(m),
    timings: () => ({ webhook_received_ms: 0 }),
  })
  return { p, stages, marks }
}

beforeEach(() => {
  inserted = []
  sendSessionText.mockReset()
  sendSessionInteractive.mockReset()
  sendSessionMedia.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('Msg91Provider (mocked MSG91 API)', () => {
  it('stores the reply once with MSG91\'s request id as accepted (sending), not sent, after the API accepts it', async () => {
    sendSessionInteractive.mockResolvedValue({ ok: true, dryRun: false, messageId: 'req-1' })
    const { p, stages, marks } = provider()
    await p.send(menu)
    expect(inserted).toEqual([expect.objectContaining({ message_id: 'req-1', status: 'sending' })])
    expect(stages).toEqual(['MSG91_SEND_REQUESTED', 'MSG91_API_ACCEPTED'])
    expect(marks).toEqual(['msg91_request_started_ms', 'msg91_response_received_ms'])
  })

  it.each(['msg91_timeout', 'msg91_network_error', 'msg91_500:oops'])(
    'does not fall back to text after an ambiguous interactive failure (%s), so the guest is never sent the menu twice',
    async (error) => {
      sendSessionInteractive.mockResolvedValue({ ok: false, error })
      const { p } = provider()
      await expect(p.send(menu)).rejects.toThrow(error)
      expect(sendSessionText).not.toHaveBeenCalled()
      expect(inserted).toEqual([expect.objectContaining({ status: 'failed' })])
    },
  )

  it('sends a photo through MSG91 and stores it in the inbox as an image with its url', async () => {
    sendSessionMedia.mockResolvedValue({ ok: true, dryRun: false, messageId: 'req-img' })
    const { p } = provider()
    await p.send({ kind: 'media', media: 'image', url: 'https://cdn.test/pool.jpg', caption: 'Pool' })
    expect(sendSessionMedia).toHaveBeenCalledWith({ to: '916300729913', kind: 'image', url: 'https://cdn.test/pool.jpg', caption: 'Pool' })
    expect(sendSessionText).not.toHaveBeenCalled()
    expect(inserted).toEqual([expect.objectContaining({ message_id: 'req-img', content_type: 'image', media_url: 'https://cdn.test/pool.jpg', content_text: 'Pool' })])
  })

  it('never re-sends a video as a text link after an ambiguous failure', async () => {
    sendSessionMedia.mockResolvedValue({ ok: false, error: 'msg91_timeout' })
    const { p } = provider()
    await expect(p.send({ kind: 'media', media: 'video', url: 'https://cdn.test/tour.mp4' })).rejects.toThrow('msg91_timeout')
    expect(sendSessionText).not.toHaveBeenCalled()
  })

  it('falls back to the link as text when MSG91 rejects the media', async () => {
    sendSessionMedia.mockResolvedValue({ ok: false, error: 'msg91_rejected:x' })
    sendSessionText.mockResolvedValue({ ok: true, dryRun: false, messageId: 'req-txt' })
    const { p } = provider()
    await p.send({ kind: 'media', media: 'video', url: 'https://cdn.test/tour.mp4', caption: 'Tour' })
    expect(sendSessionText).toHaveBeenCalledWith({ to: '916300729913', text: 'Tour\nhttps://cdn.test/tour.mp4' })
    expect(inserted).toEqual([expect.objectContaining({ message_id: 'req-txt', content_type: 'text' })])
  })

  it('falls back to text once when the interactive send is rejected, without duplicating the inbox copy', async () => {
    sendSessionInteractive.mockResolvedValue({ ok: false, error: 'msg91_rejected:x' })
    sendSessionText.mockResolvedValue({ ok: true, dryRun: false, messageId: 'req-2' })
    const { p } = provider()
    await p.send(menu)
    expect(sendSessionText).toHaveBeenCalledTimes(1)
    expect(inserted).toHaveLength(1)
  })

  it.each([
    ['an API error', 'msg91_401:unauthorized'],
    ['a timeout', 'msg91_timeout'],
  ])('on %s it throws and keeps the unsent reply in the inbox as failed', async (_label, error) => {
    sendSessionText.mockResolvedValue({ ok: false, error })
    const { p, stages } = provider()
    await expect(p.send({ kind: 'text', text: 'Welcome' })).rejects.toThrow(error)
    expect(inserted).toEqual([expect.objectContaining({ status: 'failed', content_text: 'Welcome' })])
    expect(stages).not.toContain('MSG91_API_ACCEPTED')
  })

  it('in test mode records a simulated reply and calls no API', async () => {
    const { p } = provider()
    p.setDryRun(true)
    await p.send({ kind: 'text', text: 'Welcome' })
    expect(sendSessionText).not.toHaveBeenCalled()
    expect(inserted[0].content_text).toBe('[test mode — not sent] Welcome')
  })
})
