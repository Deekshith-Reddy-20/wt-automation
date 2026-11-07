import { msg91Configured } from '@/lib/msg91/env'

/**
 * Long-running server only (Docker / `next start`): keep the hot path warm
 * between guest messages, so a message after a quiet spell does not pay for
 * TCP + TLS handshakes to Supabase / MSG91 or a bot-config reload.
 *   - one cheap request to each origin every WARM_EVERY_MS keeps a pooled socket open;
 *   - the bot's config cache is refreshed before it expires (same cache keys as the bot).
 * Never runs under Vitest or on serverless, and never throws.
 */
export const WARM_EVERY_MS = 20_000

let timer: ReturnType<typeof setInterval> | null = null

async function warmOnce(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const pings: Promise<unknown>[] = []
  if (supabaseUrl) pings.push(fetch(`${supabaseUrl}/rest/v1/`, { method: 'HEAD', cache: 'no-store' }))
  if (msg91Configured()) {
    pings.push(fetch('https://control.msg91.com/', { method: 'HEAD', cache: 'no-store' }))
    pings.push(
      (async () => {
        const [{ supabaseAdmin }, { resolveMsg91Account }, { prefetchResortBotConfig }] = await Promise.all([
          import('@/lib/flows/admin-client'),
          import('@/lib/msg91/inbound-pipeline'),
          import('@/lib/resort/bot/runtime'),
        ])
        const account = await resolveMsg91Account(supabaseAdmin())
        if (account) prefetchResortBotConfig(account.accountId)
      })(),
    )
  }
  await Promise.allSettled(pings)
}

export function startHotPathWarmer(): void {
  if (timer || process.env.VITEST || process.env.VERCEL || process.env.HOT_PATH_WARMER === 'off') return
  void warmOnce()
  timer = setInterval(() => void warmOnce(), WARM_EVERY_MS)
  timer.unref?.()
}
