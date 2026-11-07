export class Msg91ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Msg91ConfigError'
  }
}

/** True when this deployment sends WhatsApp through MSG91 instead of Meta. */
export function msg91Configured(): boolean {
  return Boolean(process.env.MSG91_AUTHKEY?.trim() && process.env.MSG91_INTEGRATED_NUMBER?.trim())
}

export function msg91Env() {
  const authkey = process.env.MSG91_AUTHKEY?.trim()
  const from = process.env.MSG91_INTEGRATED_NUMBER?.trim().replace(/^\+/, '')
  if (!authkey) throw new Msg91ConfigError('MSG91_AUTHKEY is not set')
  if (!from || !/^\d{10,15}$/.test(from)) {
    throw new Msg91ConfigError('MSG91_INTEGRATED_NUMBER must be digits with country code (no +)')
  }
  return {
    authkey,
    from,
    dryRun: process.env.MSG91_DRY_RUN === 'true',
    webhookSecret: process.env.MSG91_WEBHOOK_SECRET?.trim() || null,
  }
}
