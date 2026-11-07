import { NextResponse } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { adminRoute, parseBody } from '@/lib/resort/admin-http'
import { SimulatorSetupError, simulateTurn } from '@/lib/resort/bot/simulator'
import type { BotState } from '@/lib/resort/bot/types'

export const dynamic = 'force-dynamic'

const stateSchema = z.object({
  flow: z.enum(['menu', 'stay', 'event', 'pricing', 'availability', 'explore', 'location', 'manage', 'human']),
  step: z.string().max(64),
  data: z.record(z.string(), z.unknown()),
  history: z.array(z.object({ flow: z.string().max(32), step: z.string().max(64) })).max(50),
  lastInboundAt: z.string().max(40).nullable(),
})

const bodySchema = z
  .object({
    state: stateSchema.nullable(),
    text: z.string().max(1000),
    replyId: z.string().max(200).nullable(),
  })
  .strict()
  .refine((b) => b.text.trim() !== '' || b.replyId !== null, 'Type a message or tap an option')

/**
 * Staff test chat: one guest message through the real bot, using this
 * account's live settings, pricing, automation switches and calendar.
 * Nothing is sent to WhatsApp and nothing is written; the conversation
 * state lives in the browser and is passed back on each turn.
 */
export const POST = adminRoute('agent', async ({ accountId }, request) => {
  const parsed = await parseBody(request, bodySchema)
  if (!parsed.ok) return parsed.response
  try {
    const turn = await simulateTurn(supabaseAdmin(), accountId, parsed.data.state as BotState | null, {
      text: parsed.data.text,
      replyId: parsed.data.replyId,
    })
    return NextResponse.json(turn)
  } catch (err) {
    if (err instanceof SimulatorSetupError) return NextResponse.json({ error: err.message, code: 'setup_required' }, { status: 409 })
    throw err
  }
})
