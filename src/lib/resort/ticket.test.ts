import { afterEach, describe, expect, it, vi } from 'vitest'
import { signTicket, ticketUrl, verifyTicket } from './ticket'

const ID = '0b6a3c3e-1111-4222-8333-944445555666'

afterEach(() => vi.unstubAllEnvs())

describe('booking ticket links', () => {
  it('verifies its own signature and rejects others', () => {
    vi.stubEnv('TICKET_SIGNING_SECRET', 'secret-a')
    const sig = signTicket(ID)!
    expect(verifyTicket(ID, sig)).toBe(true)
    expect(verifyTicket('0b6a3c3e-1111-4222-8333-944445555667', sig)).toBe(false)
    expect(verifyTicket(ID, null)).toBe(false)
    expect(verifyTicket(ID, `${sig.slice(0, -1)}x`)).toBe(false)
    vi.stubEnv('TICKET_SIGNING_SECRET', 'secret-b')
    expect(verifyTicket(ID, sig)).toBe(false)
  })

  it('cannot sign without any server secret', () => {
    vi.stubEnv('TICKET_SIGNING_SECRET', '')
    vi.stubEnv('ENCRYPTION_KEY', '')
    expect(signTicket(ID)).toBeNull()
    expect(verifyTicket(ID, 'anything')).toBe(false)
  })

  it('only builds a URL for a public https base (WhatsApp cannot fetch localhost)', () => {
    vi.stubEnv('TICKET_SIGNING_SECRET', 'secret-a')
    vi.stubEnv('TICKET_PUBLIC_BASE_URL', '')
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://localhost:3000')
    expect(ticketUrl(ID)).toBeNull()
    vi.stubEnv('TICKET_PUBLIC_BASE_URL', 'https://crm.example.com/')
    expect(ticketUrl(ID)).toBe(`https://crm.example.com/api/resort/ticket/${ID}?sig=${signTicket(ID)}`)
  })
})
