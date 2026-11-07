import { ImageResponse } from 'next/og'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { coerceBooking } from '@/lib/resort/bookings'
import { formatDateHuman } from '@/lib/resort/time'
import { verifyTicket } from '@/lib/resort/ticket'

export const dynamic = 'force-dynamic'

const TICKET_STATUSES = new Set(['confirmed', 'checked_in'])

/** Signed booking ticket (PNG) used as the image on the WhatsApp confirmation. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sig = new URL(request.url).searchParams.get('sig')
  if (!/^[0-9a-f-]{36}$/i.test(id) || !verifyTicket(id, sig)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const db = supabaseAdmin()
  const { data: row } = await db.from('bookings').select('*').eq('id', id).maybeSingle()
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const b = coerceBooking(row)
  if (!TICKET_STATUSES.has(b.status)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: settings } = await db.from('property_settings').select('resort_name').eq('account_id', b.account_id).maybeSingle()
  const resort = (settings?.resort_name as string | undefined)?.trim() || 'V-Farms'
  const when =
    b.booking_type === 'stay' && b.check_in && b.check_out
      ? `${formatDateHuman(b.check_in)} → ${formatDateHuman(b.check_out)}`
      : b.event_date
        ? formatDateHuman(b.event_date)
        : ''
  const guests = `${b.adults} adult${b.adults === 1 ? '' : 's'}${b.children ? `, ${b.children} child${b.children === 1 ? '' : 'ren'}` : ''}`
  const balance = b.quoted_total !== null ? Math.max(0, b.quoted_total - b.amount_paid + b.amount_refunded) : null

  const rows: [string, string][] = [
    ['Booking', b.booking_ref],
    ['Guest', b.guest_name || '—'],
    [b.booking_type === 'stay' ? 'Dates' : 'Event date', when || '—'],
    ['Guests', guests],
    ['Paid', `₹${b.amount_paid.toLocaleString('en-IN')}`],
    ...(balance !== null && balance > 0 ? ([['Balance at check-in', `₹${balance.toLocaleString('en-IN')}`]] as [string, string][]) : []),
  ]

  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: '#f4f7f2', padding: 48, fontFamily: 'sans-serif' }}>
        <div style={{ display: 'flex', flexDirection: 'column', backgroundColor: '#ffffff', borderRadius: 24, padding: 48, flexGrow: 1, border: '2px solid #cfe0c8' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', fontSize: 48, fontWeight: 700, color: '#2f5d2a' }}>{resort}</div>
            <div style={{ display: 'flex', fontSize: 28, color: '#ffffff', backgroundColor: '#2f7d32', padding: '10px 24px', borderRadius: 999 }}>CONFIRMED</div>
          </div>
          <div style={{ display: 'flex', fontSize: 26, color: '#6b7a66', marginTop: 8 }}>Booking ticket</div>
          <div style={{ display: 'flex', flexDirection: 'column', marginTop: 36 }}>
            {rows.map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 32, padding: '14px 0', borderBottom: '1px solid #e5ece2' }}>
                <span style={{ color: '#6b7a66' }}>{k}</span>
                <span style={{ color: '#1f2a1d', fontWeight: 600 }}>{v}</span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', fontSize: 22, color: '#8a9785', marginTop: 'auto' }}>Show this ticket at check-in.</div>
        </div>
      </div>
    ),
    { width: 1000, height: 1000, headers: { 'cache-control': 'private, max-age=300' } },
  )
}
