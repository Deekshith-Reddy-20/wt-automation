import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isAmbiguousSendError, sendSessionInteractive, sendSessionMedia, sendSessionText } from './client'
import { renderAsText, toMsg91Interactive } from './provider'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubEnv('MSG91_AUTHKEY', 'test-authkey')
  vi.stubEnv('MSG91_INTEGRATED_NUMBER', '919900000000')
  vi.stubEnv('MSG91_DRY_RUN', '')
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.useFakeTimers({ toFake: ['setTimeout'] })
})

afterEach(() => {
  fetchMock.mockReset()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

async function run<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync()
  return p
}

describe('MSG91 outbound client (mocked MSG91 responses)', () => {
  it('sends session text as query params with the authkey header', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { status: 'success', hasError: false, data: { message_uuid: 'uuid-1' } }))
    const res = await sendSessionText({ to: '+91 63007 29913', text: 'Hello' })
    expect(res).toEqual({ ok: true, dryRun: false, messageId: 'uuid-1' })
    const [url, init] = fetchMock.mock.calls[0]
    const u = new URL(url as string)
    expect(u.searchParams.get('content_type')).toBe('text')
    expect(u.searchParams.get('recipient_number')).toBe('916300729913')
    expect(u.searchParams.get('integrated_number')).toBe('919900000000')
    expect((init as RequestInit).headers).toMatchObject({ authkey: 'test-authkey' })
  })

  it('sends session images and videos as query params with a public attachment_url', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { status: 'success', data: { message_uuid: 'uuid-m' } }))
    const res = await sendSessionMedia({ to: '916300729913', kind: 'video', url: 'https://cdn.test/tour.mp4', caption: 'Tour' })
    expect(res).toEqual({ ok: true, dryRun: false, messageId: 'uuid-m' })
    const [url, init] = fetchMock.mock.calls[0]
    const u = new URL(url as string)
    expect(u.searchParams.get('content_type')).toBe('video')
    expect(u.searchParams.get('attachment_url')).toBe('https://cdn.test/tour.mp4')
    expect(u.searchParams.get('caption')).toBe('Tour')
    expect(u.searchParams.get('recipient_number')).toBe('916300729913')
    expect((init as RequestInit).body).toBeUndefined()
  })

  it('sends interactive messages as a JSON body', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { status: 'success', data: { message_uuid: 'uuid-2' } }))
    const interactive = { type: 'button' as const, body: { text: 'Pick' }, action: { buttons: [{ type: 'reply' as const, reply: { id: 'a', title: 'A' } }] } }
    await sendSessionInteractive({ to: '916300729913', interactive })
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body).toEqual({ recipient_number: '916300729913', integrated_number: '919900000000', content_type: 'interactive', interactive })
  })

  it('treats HTTP 200 with hasError as a failure, not a delivery', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { hasError: true, errors: 'Invalid integrated number' }))
    const res = await sendSessionText({ to: '916300729913', text: 'Hi' })
    expect(res.ok).toBe(false)
  })

  it('retries once on 503 and succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(json(200, { status: 'success', data: { message_uuid: 'uuid-3' } }))
    const res = await run(sendSessionText({ to: '916300729913', text: 'Hi' }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res).toMatchObject({ ok: true, messageId: 'uuid-3' })
  })

  it('gives up after one retry on repeated 429', async () => {
    fetchMock.mockImplementation(async () => new Response('slow down', { status: 429 }))
    const res = await run(sendSessionText({ to: '916300729913', text: 'Hi' }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res).toMatchObject({ ok: false })
  })

  it('does not retry a 500 (MSG91 may already have queued the message)', async () => {
    fetchMock.mockImplementation(async () => new Response('oops', { status: 500 }))
    const res = await run(sendSessionText({ to: '916300729913', text: 'Hi' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(res.ok).toBe(false)
  })

  it('does not retry a timeout', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
    const res = await run(sendSessionText({ to: '916300729913', text: 'Hi' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ ok: false, error: 'msg91_timeout' })
  })

  it('retries once when the connection was refused before sending', async () => {
    fetchMock
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
      .mockResolvedValueOnce(json(200, { status: 'success', data: { message_uuid: 'uuid-4' } }))
    const res = await run(sendSessionText({ to: '916300729913', text: 'Hi' }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res).toMatchObject({ ok: true })
  })

  it('does not retry a connection dropped mid-request (ambiguous)', async () => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))
    const res = await run(sendSessionText({ to: '916300729913', text: 'Hi' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ ok: false, error: 'msg91_network_error' })
  })

  it('classifies ambiguous vs definite failures', () => {
    expect(isAmbiguousSendError('msg91_timeout')).toBe(true)
    expect(isAmbiguousSendError('msg91_network_error')).toBe(true)
    expect(isAmbiguousSendError('msg91_500:oops')).toBe(true)
    expect(isAmbiguousSendError('msg91_400:bad payload')).toBe(false)
    expect(isAmbiguousSendError('msg91_unreachable')).toBe(false)
    expect(isAmbiguousSendError('Invalid integrated number')).toBe(false)
  })

  it('never calls MSG91 in dry-run mode', async () => {
    vi.stubEnv('MSG91_DRY_RUN', 'true')
    const res = await sendSessionText({ to: '916300729913', text: 'Hi' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res).toEqual({ ok: true, dryRun: true, messageId: null })
  })

  it('rejects an invalid recipient without calling MSG91', async () => {
    const res = await sendSessionText({ to: '123', text: 'Hi' })
    expect(res).toEqual({ ok: false, error: 'invalid_to' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('bot reply → MSG91 interactive mapping', () => {
  it('puts the ticket / QR image in the button header', () => {
    const m = { kind: 'buttons' as const, body: 'Confirmed', headerImage: 'https://x.test/t.png', buttons: [{ id: 'c_menu', title: 'Main menu' }] }
    expect(toMsg91Interactive(m)).toEqual({
      type: 'button',
      header: { type: 'image', image: { link: 'https://x.test/t.png' } },
      body: { text: 'Confirmed' },
      action: { buttons: [{ type: 'reply', reply: { id: 'c_menu', title: 'Main menu' } }] },
    })
    expect(renderAsText(m)).toContain('https://x.test/t.png')
  })

  it('has no interactive form for plain text', () => {
    expect(toMsg91Interactive({ kind: 'text', text: 'hi' })).toBeNull()
  })
})
