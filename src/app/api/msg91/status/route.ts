import { NextResponse } from 'next/server'
import { msg91Configured } from '@/lib/msg91/env'

export const dynamic = 'force-dynamic'

/** Whether WhatsApp is connected through MSG91 (server env). Never returns secrets. */
export async function GET() {
  return NextResponse.json({ configured: msg91Configured() })
}
