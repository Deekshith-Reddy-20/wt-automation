import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const afterTasks: Array<() => Promise<void>> = []
const ingestMsg91Inbound = vi.fn()
const replyToMsg91Inbound = vi.fn()

vi.mock('next/server', async (orig) => {
  const actual = await orig<typeof import('next/server')>()
  return { ...actual, after: (fn: () => Promise<void>) => afterTasks.push(fn) }
})
vi.mock('@/lib/msg91/inbound-pipeline', () => ({
  ingestMsg91Inbound: (...a: unknown[]) => ingestMsg91Inbound(...a),
  replyToMsg91Inbound: (...a: unknown[]) => replyToMsg91Inbound(...a),
}))
const applyDeliveryStatus = vi.fn(async () => 1)
vi.mock('@/lib/msg91/delivery-status', () => ({ applyDeliveryStatus: (...a: unknown[]) => applyDeliveryStatus(...(a as [])) }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }))

const { POST } = await import('./route')

const inbound = (uuid = 'uuid-in-1') => ({
  customerNumber: '916300729913',
  integratedNumber: '919900000000',
  contentType: 'text',
  text: 'Hi',
  uuid,
  direction: '0',
})

const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/msg91/webhook', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })

const saved = (inb: unknown = {}) => ({ status: 'saved', ingested: { messageId: 'uuid-in-1', inbound: inb } })
const runAfter = () => Promise.all(afterTasks.map((t) => t()))

beforeEach(() => {
  vi.stubEnv('MSG91_AUTHKEY', 'test-authkey')
  vi.stubEnv('MSG91_INTEGRATED_NUMBER', '919900000000')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  afterTasks.length = 0
  ingestMsg91Inbound.mockReset()
  ingestMsg91Inbound.mockImplementation(async (inb: unknown) => saved(inb))
  replyToMsg91Inbound.mockReset()
  replyToMsg91Inbound.mockResolvedValue({ status: 'processed', conversationId: 'c1', botConsumed: true })
  applyDeliveryStatus.mockClear()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('MSG91 webhook route (simulated deliveries)', () => {
  it('saves the message before acknowledging and replies after the response', async () => {
    const res = await POST(req(inbound()))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, accepted: true })
    expect(ingestMsg91Inbound).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'inbound', text: 'Hi', messageId: 'uuid-in-1' }),
      expect.objectContaining({ cid: expect.any(String) }),
    )
    expect(replyToMsg91Inbound).not.toHaveBeenCalled()
    await runAfter()
    expect(replyToMsg91Inbound).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'uuid-in-1' }), expect.objectContaining({ cid: expect.any(String) }))
  })

  it('logs one TIMING line with the stage timings once the reply is done', async () => {
    await POST(req(inbound()))
    await runAfter()
    const timing = vi
      .mocked(console.log)
      .mock.calls.map(([l]) => String(l))
      .find((l) => l.includes('"msg91":"TIMING"'))
    expect(timing).toBeDefined()
    const parsed = JSON.parse(timing!)
    expect(parsed).toMatchObject({ webhook_received_ms: 0, validation_completed_ms: expect.any(Number), total_application_processing_ms: expect.any(Number) })
  })

  it('answers 503 when the message could not be saved, so MSG91 redelivers it', async () => {
    ingestMsg91Inbound.mockResolvedValue({ status: 'failed', reason: 'message_insert: db down' })
    const res = await POST(req(inbound()))
    expect(res.status).toBe(503)
    expect(afterTasks).toHaveLength(0)
  })

  it('answers 503 when saving throws', async () => {
    ingestMsg91Inbound.mockRejectedValue(new Error('db down'))
    expect((await POST(req(inbound()))).status).toBe(503)
  })

  it('acknowledges a redelivered message without replying again', async () => {
    ingestMsg91Inbound.mockResolvedValue({ status: 'duplicate' })
    const res = await POST(req(inbound()))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, duplicate: true })
    expect(afterTasks).toHaveLength(0)
  })

  it.each(['Hi', 'Hello', 'MENU', '1', '2'])('hands "%s" to the pipeline unchanged', async (text) => {
    await POST(req({ ...inbound(), text }))
    expect(ingestMsg91Inbound).toHaveBeenCalledWith(expect.objectContaining({ text, unsupported: null }), expect.anything())
  })

  it('passes an image (no text) to the pipeline flagged as unsupported, so the guest gets a fallback', async () => {
    await POST(req({ ...inbound(), text: '', contentType: 'image', content: '{"image":{"id":"x"}}' }))
    expect(ingestMsg91Inbound).toHaveBeenCalledWith(expect.objectContaining({ unsupported: 'image', text: '[image]' }), expect.anything())
  })

  it('applies delivery reports to the stored message instead of running the bot', async () => {
    const report = { direction: '1', eventName: 'delivered', requestId: 'req-123', customerNumber: '916300729913', uuid: 'wamid.x' }
    const res = await POST(req(report))
    expect(await res.json()).toMatchObject({ ok: true, accepted: true })
    await runAfter()
    expect(applyDeliveryStatus).toHaveBeenCalledWith(expect.anything(), 'req-123', 'delivered')
    expect(ingestMsg91Inbound).not.toHaveBeenCalled()
  })

  it('never logs the webhook secret or the full guest number', async () => {
    vi.stubEnv('MSG91_WEBHOOK_SECRET', 'shh-very-secret')
    await POST(req(inbound(), { 'x-msg91-webhook-secret': 'shh-very-secret' }))
    await runAfter()
    const logged = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls].flat().join('\n')
    expect(logged).toContain('WEBHOOK_RECEIVED')
    expect(logged).not.toContain('shh-very-secret')
    expect(logged).not.toContain('916300729913')
  })

  it('a failing reply after the acknowledgement is logged, not thrown (the message is already saved)', async () => {
    replyToMsg91Inbound.mockRejectedValue(new Error('bot crashed'))
    const res = await POST(req(inbound()))
    expect(res.status).toBe(200)
    await expect(runAfter()).resolves.toBeDefined()
  })

  it('requires the configured secret header', async () => {
    vi.stubEnv('MSG91_WEBHOOK_SECRET', 'shh')
    expect((await POST(req(inbound()))).status).toBe(401)
    expect((await POST(req(inbound(), { 'x-msg91-webhook-secret': 'wrong' }))).status).toBe(401)
    expect((await POST(req(inbound(), { 'x-msg91-webhook-secret': 'shh' }))).status).toBe(200)
  })

  it('rejects invalid JSON', async () => {
    const bad = new Request('http://localhost/api/msg91/webhook', { method: 'POST', body: '{nope' })
    expect((await POST(bad)).status).toBe(400)
  })

  it('ignores outbound reports / status callbacks so the bot never answers itself', async () => {
    for (const direction of ['1', 1, 'outbound']) {
      const res = await POST(req({ ...inbound(), direction }))
      expect(await res.json()).toMatchObject({ ok: true, skipped: 'outbound_report' })
    }
    expect(afterTasks).toHaveLength(0)
  })

  it('ignores empty messages', async () => {
    const res = await POST(req({ ...inbound(), text: '' }))
    expect(await res.json()).toMatchObject({ skipped: 'empty_message' })
  })
})
