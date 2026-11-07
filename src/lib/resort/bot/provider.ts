import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from '@/lib/flows/meta-send'
import type { InteractiveButton, InteractiveListSection } from '@/lib/whatsapp/meta-api'
import type { BotReply } from './types'
import { LIMITS, truncate, withNumberedFallback } from './ui'

/**
 * WhatsApp delivery for the resort bot.
 *
 * - MetaCloudProvider: the existing Meta Cloud API senders (they persist
 *   each bot message to the inbox and honour opt-out).
 * - Dry run: the same senders inside withSimulatedMetaSends — messages are
 *   built and stored in the inbox exactly as in production, but nothing is
 *   sent to Meta. Used while property_settings.test_mode is on (except for
 *   allow-listed staff test numbers) and whenever WHATSAPP_DRY_RUN=true.
 * - MockProvider: in-memory, for tests.
 *
 * A BSP such as AiSensy would be another implementation of this interface;
 * it is not implemented.
 */

export type RenderedMessage =
  | { kind: 'text'; text: string }
  | { kind: 'buttons'; body: string; buttons: InteractiveButton[]; headerImage?: string }
  | { kind: 'list'; body: string; button: string; sections: InteractiveListSection[] }
  | { kind: 'media'; media: 'image' | 'video'; url: string; caption?: string }

export interface WhatsAppProvider {
  readonly name: string
  send(message: RenderedMessage): Promise<void>
  /** Providers that cannot be simulated by withSimulatedMetaSends record instead of sending. */
  setDryRun?(dryRun: boolean): void
}

/** Turn a bot reply into a WhatsApp message within Meta's size limits. */
export function renderReply(reply: BotReply): RenderedMessage {
  if (reply.type === 'text') return { kind: 'text', text: truncate(reply.text, 4096) }
  if (reply.type === 'media') {
    return { kind: 'media', media: reply.kind, url: reply.url, ...(reply.caption ? { caption: truncate(reply.caption, 1024) } : {}) }
  }
  const options = reply.options.slice(0, LIMITS.listRows)
  if (options.length <= LIMITS.buttons) {
    return {
      kind: 'buttons',
      body: truncate(reply.text, LIMITS.body),
      buttons: options.map((o) => ({ id: o.id, title: truncate(o.title, LIMITS.buttonTitle) })),
      ...(reply.image ? { headerImage: reply.image } : {}),
    }
  }
  return {
    kind: 'list',
    body: truncate(withNumberedFallback(reply.text, options), LIMITS.body),
    button: truncate(reply.button ?? 'Options', LIMITS.listButton),
    sections: [
      {
        rows: options.map((o) => ({
          id: o.id,
          title: truncate(o.title, LIMITS.rowTitle),
          ...(o.description ? { description: truncate(o.description, LIMITS.rowDescription) } : {}),
        })),
      },
    ],
  }
}

export interface SendTarget {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
}

export class MetaCloudProvider implements WhatsAppProvider {
  readonly name = 'meta_cloud'
  constructor(private readonly target: SendTarget) {}

  async send(m: RenderedMessage): Promise<void> {
    if (m.kind === 'text') {
      await engineSendText({ ...this.target, text: m.text })
    } else if (m.kind === 'buttons') {
      await engineSendInteractiveButtons({ ...this.target, bodyText: m.body, buttons: m.buttons })
    } else if (m.kind === 'media') {
      await engineSendMedia({ ...this.target, kind: m.media, link: m.url, caption: m.caption })
    } else {
      await engineSendInteractiveList({ ...this.target, bodyText: m.body, buttonLabel: m.button, sections: m.sections })
    }
  }
}

export class MockProvider implements WhatsAppProvider {
  readonly name = 'mock'
  readonly sent: RenderedMessage[] = []
  async send(m: RenderedMessage): Promise<void> {
    this.sent.push(m)
  }
}

export function dryRunForced(): boolean {
  return process.env.WHATSAPP_DRY_RUN === 'true'
}

/**
 * Send replies in order. In dry-run mode the real senders run inside the
 * simulator so the inbox shows exactly what a guest would have received.
 * Returns how many replies failed to send.
 */
export async function deliver(
  provider: WhatsAppProvider,
  replies: BotReply[],
  opts: { dryRun: boolean },
): Promise<{ failed: number; errors: string[] }> {
  const errors: string[] = []
  const run = async () => {
    for (const r of replies) {
      try {
        await provider.send(renderReply(r))
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err))
        // Later replies usually depend on earlier ones; stop at the first failure.
        break
      }
    }
  }
  provider.setDryRun?.(opts.dryRun)
  if (opts.dryRun && provider instanceof MetaCloudProvider) {
    const { withSimulatedMetaSends } = await import('@/lib/whatsapp/send-simulation')
    await withSimulatedMetaSends(run)
  } else await run()
  return { failed: errors.length, errors }
}
