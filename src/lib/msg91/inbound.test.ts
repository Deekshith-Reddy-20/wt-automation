import { describe, expect, it } from 'vitest'
import { normalizeMsg91Direction, parseMsg91Webhook } from './inbound'

describe('normalizeMsg91Direction', () => {
  it('treats 0 and string 0 as inbound', () => {
    expect(normalizeMsg91Direction(0)).toBe('inbound')
    expect(normalizeMsg91Direction('0')).toBe('inbound')
  })

  it('treats 1 and string 1 as outbound', () => {
    expect(normalizeMsg91Direction(1)).toBe('outbound')
    expect(normalizeMsg91Direction('1')).toBe('outbound')
  })

  it('treats inbound/outbound strings case-insensitively', () => {
    expect(normalizeMsg91Direction('inbound')).toBe('inbound')
    expect(normalizeMsg91Direction('Inbound')).toBe('inbound')
    expect(normalizeMsg91Direction('outbound')).toBe('outbound')
  })
})

describe('parseMsg91Webhook', () => {
  it('parses doc-style inbound with direction "0"', () => {
    const r = parseMsg91Webhook({
      direction: '0',
      customerNumber: '919876543210',
      content: '{"text":"Hi"}',
    })
    expect(r).toMatchObject({ kind: 'inbound', text: 'Hi', customerNumber: '919876543210' })
  })

  it('falls back to the top-level text field when content is empty', () => {
    const r = parseMsg91Webhook({
      direction: '0',
      customerNumber: '919876543210',
      content: '',
      button: '',
      text: 'Hi',
    })
    expect(r).toMatchObject({ kind: 'inbound', text: 'Hi' })
  })

  it('parses content as object with text', () => {
    const r = parseMsg91Webhook({
      direction: 'inbound',
      customerNumber: '919876543210',
      content: { text: 'Hello' },
    })
    expect(r).toMatchObject({ kind: 'inbound', text: 'Hello' })
  })

  it('parses inbound when direction is string "inbound" (report-style payloads)', () => {
    const r = parseMsg91Webhook({
      direction: 'inbound',
      customerNumber: '917748847990',
      content: '{"text":"Heyyyy"}',
      requestId: 'req-1',
    })
    expect(r).toMatchObject({
      kind: 'inbound',
      text: 'Heyyyy',
      customerNumber: '917748847990',
      requestId: 'req-1',
    })
  })

  it('accepts customer_number snake_case', () => {
    const r = parseMsg91Webhook({
      direction: '0',
      customer_number: '91 98765 43210',
      content: '{"text":"Hello"}',
    })
    expect(r).toMatchObject({ kind: 'inbound', text: 'Hello', customerNumber: '919876543210' })
  })

  it('ignores outbound reports', () => {
    expect(parseMsg91Webhook({ direction: 1, customerNumber: '919876543210', content: '{"text":"x"}' }).kind).toBe('ignore')
    expect(parseMsg91Webhook({ direction: 'outbound', customerNumber: '919876543210', content: '{"text":"x"}' }).kind).toBe(
      'ignore',
    )
  })

  it('uses button when content is empty', () => {
    const r = parseMsg91Webhook({
      direction: '0',
      customerNumber: '919876543210',
      button: '{"text":"Stop","payload":"Stop"}',
    })
    expect(r).toMatchObject({ kind: 'inbound', text: 'Stop' })
  })

  it('extracts the reply id from an interactive button tap', () => {
    const r = parseMsg91Webhook({
      direction: '0',
      customerNumber: '919876543210',
      content: '',
      interactive: '{"type":"button_reply","button_reply":{"id":"m_stay","title":"Private Farm Stay"}}',
    })
    expect(r).toMatchObject({ kind: 'inbound', text: 'Private Farm Stay', replyId: 'm_stay' })
  })

  it('extracts the reply id from a list row tap given as an object', () => {
    const r = parseMsg91Webhook({
      direction: 'inbound',
      customerNumber: '919876543210',
      interactive: { type: 'list_reply', list_reply: { id: 'm_event', title: 'Event Enquiry' } },
    })
    expect(r).toMatchObject({ kind: 'inbound', text: 'Event Enquiry', replyId: 'm_event' })
  })

  it('turns delivery reports into status updates keyed by the send requestId', () => {
    for (const eventName of ['sent', 'delivered', 'read', 'failed']) {
      expect(parseMsg91Webhook({ direction: '1', eventName, requestId: 'r1', reason: eventName === 'failed' ? 'expired' : '' })).toEqual({
        kind: 'status',
        requestId: 'r1',
        status: eventName,
        reason: eventName === 'failed' ? 'expired' : null,
      })
    }
    expect(parseMsg91Webhook({ direction: '1', eventName: 'submitted', requestId: 'r1' })).toMatchObject({ kind: 'ignore' })
  })

  it('flags media the bot cannot read instead of dropping it', () => {
    for (const contentType of ['image', 'audio', 'location', 'sticker']) {
      expect(parseMsg91Webhook({ direction: '0', customerNumber: '919876543210', contentType, content: '{"id":"m1"}', uuid: 'u1' })).toMatchObject({
        kind: 'inbound',
        unsupported: contentType,
        text: `[${contentType}]`,
        messageId: 'u1',
      })
    }
  })

  it('uses an image caption as text, and never passes raw JSON content on as the message', () => {
    expect(parseMsg91Webhook({ direction: '0', customerNumber: '919876543210', contentType: 'image', content: '{"caption":"Is this the pool?"}' })).toMatchObject({
      kind: 'inbound',
      text: 'Is this the pool?',
      unsupported: null,
    })
    expect(parseMsg91Webhook({ direction: '0', customerNumber: '919876543210', contentType: 'text', content: '{"foo":1}' })).toMatchObject({ kind: 'ignore' })
  })

  it('normalizes +91 / spaced numbers to digits', () => {
    expect(parseMsg91Webhook({ direction: '0', customerNumber: '+91 63007-29913', text: 'Hi' })).toMatchObject({ customerNumber: '916300729913' })
  })

  it('ignores the MSG91 webhook Test Run sample and masked numbers, so no fake guest is created', () => {
    expect(parseMsg91Webhook({ customerNumber: '9181588XXXXX', uuid: 'wamid.sample-uuid-for-webhook-test', text: 'Hello', contentType: 'text', dryRun: true })).toEqual({
      kind: 'ignore',
      reason: 'msg91_test_run',
    })
    expect(parseMsg91Webhook({ direction: '0', customerNumber: '9181588XXXXX', text: 'Hi' })).toEqual({ kind: 'ignore', reason: 'no_customer_number' })
    expect(parseMsg91Webhook({ direction: '0', customerNumber: '12345', text: 'Hi' })).toEqual({ kind: 'ignore', reason: 'no_customer_number' })
  })

  it('leaves replyId null for plain text', () => {
    const r = parseMsg91Webhook({ direction: '0', customerNumber: '919876543210', content: '{"text":"Hi"}' })
    expect(r).toMatchObject({ kind: 'inbound', text: 'Hi', replyId: null })
  })
})
