'use client'

import { useCallback, useState } from 'react'
import { Copy, CheckCircle2, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { WhatsAppHealthPanel } from '@/components/whatsapp/whatsapp-health-panel'
import { SettingsPanelHead } from './settings-panel-head'

export function WhatsAppMsg91Panel() {
  const t = useTranslations('Settings.whatsappMsg91')
  const [copied, setCopied] = useState<string | null>(null)

  const copy = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      toast.success(t('copied'))
      setTimeout(() => setCopied(null), 2000)
    } catch {
      toast.error(t('copyFailed'))
    }
  }, [t])

  const placeholders = {
    webhookUrl: `${t('placeholderOrigin')}/api/msg91/webhook`,
    inboxUrl: `${t('placeholderOrigin')}/inbox`,
    envLocal: `MSG91_AUTHKEY=${t('yourAuthkey')}
MSG91_INTEGRATED_NUMBER=${t('yourIntegratedNumber')}
# MSG91_WEBHOOK_SECRET=…
# MSG91_DRY_RUN=true`,
  }

  return (
    <section className="space-y-6">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <WhatsAppHealthPanel />

      <Card className="border-amber-300/60 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/30">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t('metaRemovedTitle')}</CardTitle>
          <CardDescription>{t('metaRemovedBody')}</CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('whatYouNeedTitle')}</CardTitle>
          <CardDescription>{t('whatYouNeedDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ul className="list-inside list-disc space-y-1 text-muted-foreground">
            <li>{t('needAuthkey')}</li>
            <li>{t('needIntegratedNumber')}</li>
            <li>{t('needWebhook')}</li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('envTitle')}</CardTitle>
          <CardDescription>{t('envDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative rounded-md border border-border bg-muted/40 p-3 font-mono text-xs">
            <pre className="overflow-x-auto whitespace-pre-wrap pr-10">{placeholders.envLocal}</pre>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-2 top-2"
              onClick={() => void copy('env', placeholders.envLocal)}
              aria-label={t('copy')}
            >
              {copied === 'env' ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('webhookTitle')}</CardTitle>
          <CardDescription>{t('webhookDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">{t('webhookSteps')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-muted px-2 py-1 text-xs">{placeholders.webhookUrl}</code>
            <Button type="button" variant="outline" size="sm" onClick={() => void copy('webhook', placeholders.webhookUrl)}>
              <Copy className="mr-1 h-3.5 w-3.5" /> {t('copy')}
            </Button>
          </div>
          <p className="text-muted-foreground">{t('inboxHint')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-muted px-2 py-1 text-xs">{placeholders.inboxUrl}</code>
            <Button type="button" variant="outline" size="sm" onClick={() => void copy('inbox', placeholders.inboxUrl)}>
              <Copy className="mr-1 h-3.5 w-3.5" /> {t('copy')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('runTitle')}</CardTitle>
          <CardDescription>{t('runDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 font-mono text-xs">
          <pre className="rounded-md bg-muted/40 p-3">npm install{'\n'}npm run dev</pre>
          <p className="text-sm text-muted-foreground">{t('ngrok')}</p>
          <pre className="rounded-md bg-muted/40 p-3">ngrok http 3000</pre>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        {t('docsPrefix')}{' '}
        <code className="rounded bg-muted px-1 py-0.5 text-[11px]">MSG91_MIGRATION.md</code>
      </p>

      <a
        href="https://docs.msg91.com/whatsapp"
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        {t('msg91Docs')} <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </section>
  )
}
