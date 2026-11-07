import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { RenderedMessage, SendTarget, WhatsAppProvider } from '@/lib/resort/bot/provider'
import { isAmbiguousSendError, sendSessionInteractive, sendSessionMedia, sendSessionText, type Msg91Interactive } from './client'
import { noopTrace, type Trace } from './trace'

/**
 * Plain-text rendering of a bot reply, used for the inbox copy and as the
 * fallback when MSG91 rejects an interactive send; the bot already accepts
 * "1", "2" … as a selection (matchOption).
 */
export function renderAsText(m: RenderedMessage): string {
  if (m.kind === 'text') return m.text
  if (m.kind === 'media') return m.caption ? `${m.caption}\n${m.url}` : m.url
  if (m.kind === 'buttons') {
    const lines = m.buttons.map((b, i) => `${i + 1}. ${b.title}`)
    const image = m.headerImage ? `\n\n${m.headerImage}` : ''
    return `${m.body}${image}\n\n${lines.join('\n')}\n\nReply with a number.`
  }
  const rows = m.sections.flatMap((s) => s.rows)
  if (/^\s*1\.\s/m.test(m.body) && /^\s*2\.\s/m.test(m.body)) {
    return m.body.replace(/\n*Reply with a number, or tap the menu below\.\s*$/, '\n\nReply with a number.')
  }
  const lines = rows.map((r, i) => `${i + 1}. ${r.title}`)
  return `${m.body}\n\n${lines.join('\n')}\n\nReply with a number.`
}

/** Resort bot delivery through MSG91; every reply is stored in the shared inbox. */
export class Msg91Provider implements WhatsAppProvider {
  readonly name = 'msg91'
  private dryRun = false

  constructor(
    private readonly db: SupabaseClient,
    private readonly target: SendTarget,
    private readonly phone: string,
    private readonly trace: Trace = noopTrace,
  ) {}

  setDryRun(dryRun: boolean): void {
    this.dryRun = dryRun
  }

  async send(m: RenderedMessage): Promise<void> {
    const text = renderAsText(m)
    let messageId: string
    let fellBackToText = false
    if (this.dryRun) {
      messageId = `msg91-sim:${randomUUID()}`
      this.trace.mark('msg91_request_started_ms')
      this.trace.log('MSG91_SEND_REQUESTED', { to: this.phone, kind: m.kind, simulated: true })
    } else {
      const interactive = toMsg91Interactive(m)
      this.trace.mark('msg91_request_started_ms')
      this.trace.log('MSG91_SEND_REQUESTED', { to: this.phone, kind: m.kind === 'media' ? m.media : interactive ? interactive.type : 'text' })
      let sent =
        m.kind === 'media'
          ? await sendSessionMedia({ to: this.phone, kind: m.media, url: m.url, caption: m.caption })
          : interactive
            ? await sendSessionInteractive({ to: this.phone, interactive })
            : null
      if (sent && !sent.ok && isAmbiguousSendError(sent.error)) {
        // MSG91 may have queued the media / interactive message; a text fallback could reach the guest twice.
        this.trace.log('PROCESSING_FAILED', { stage: 'send', ambiguous: true, error: sent.error.slice(0, 120) })
      } else if (!sent?.ok) {
        if (sent) {
          console.warn(`[msg91] ${m.kind} send failed, falling back to text:`, sent.error)
          this.trace.log('MSG91_SEND_REQUESTED', { to: this.phone, kind: 'text', fallbackFrom: m.kind === 'media' ? m.media : interactive?.type, previousError: sent.error.slice(0, 120) })
        }
        sent = await sendSessionText({ to: this.phone, text })
        if (sent.ok) fellBackToText = true
      }
      this.trace.mark('msg91_response_received_ms')
      if (!sent.ok) {
        // Keep the unsent reply visible in the inbox so staff can see what the guest did not get.
        await persistOutbound(this.db, this.target, { text, messageId: `msg91-failed:${randomUUID()}`, senderType: 'bot', status: 'failed' }).catch(
          (err) => console.error('[msg91] could not record failed reply:', err instanceof Error ? err.message : err),
        )
        throw new Error(sent.error)
      }
      messageId = sent.messageId ?? `msg91-out:${randomUUID()}`
      this.trace.log('MSG91_API_ACCEPTED', { requestId: messageId })
    }
    const media = m.kind === 'media' && !fellBackToText ? { contentType: m.media, mediaUrl: m.url, text: m.caption ?? '' } : null
    await persistOutbound(this.db, this.target, {
      text: media ? media.text : text,
      messageId,
      senderType: 'bot',
      simulated: this.dryRun,
      ...(media ? { contentType: media.contentType, mediaUrl: media.mediaUrl } : {}),
    })
  }
}

/** Buttons/lists map 1:1 onto WhatsApp interactive messages; plain text has no interactive form. */
export function toMsg91Interactive(m: RenderedMessage): Msg91Interactive | null {
  if (m.kind === 'buttons') {
    return {
      type: 'button',
      ...(m.headerImage ? { header: { type: 'image' as const, image: { link: m.headerImage } } } : {}),
      body: { text: m.body },
      action: { buttons: m.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
    }
  }
  if (m.kind === 'list') {
    return {
      type: 'list',
      body: { text: m.body },
      action: {
        button: m.button,
        sections: m.sections.map((s) => ({
          ...(s.title ? { title: s.title } : {}),
          rows: s.rows.map((r) => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) })),
        })),
      },
    }
  }
  return null
}

export async function persistOutbound(
  db: SupabaseClient,
  target: { accountId: string; conversationId: string },
  row: {
    text: string
    messageId: string
    senderType: 'bot' | 'agent'
    simulated?: boolean
    status?: 'sent' | 'failed'
    contentType?: 'text' | 'image' | 'video'
    mediaUrl?: string
  },
): Promise<string | null> {
  const now = new Date().toISOString()
  const preview = row.text || `[${row.contentType ?? 'text'}]`
  const [inserted, conv] = await Promise.all([
    db
      .from('messages')
      .insert({
        conversation_id: target.conversationId,
        sender_type: row.senderType,
        content_type: row.contentType ?? 'text',
        ...(row.mediaUrl ? { media_url: row.mediaUrl } : {}),
        content_text: row.simulated ? `[test mode — not sent] ${row.text}` : row.text,
        message_id: row.messageId,
        // MSG91 accepting the request is not WhatsApp sending it: start at 'sending' and let delivery
        // reports / log reconciliation move it to sent → delivered → read (or failed).
        status: row.status ?? (row.simulated ? 'sent' : 'sending'),
      })
      .select('id')
      .single(),
    db
      .from('conversations')
      .update({ last_message_text: preview.slice(0, 200), last_message_at: now, updated_at: now })
      .eq('id', target.conversationId)
      .eq('account_id', target.accountId),
  ])
  if (inserted.error) throw new Error(`Could not save outbound message: ${inserted.error.message}`)
  if (conv.error) console.error('[msg91] conversation preview update failed:', conv.error.message)
  return (inserted.data as { id: string } | null)?.id ?? null
}
