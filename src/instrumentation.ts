export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installKeepAliveDispatcher } = await import('./lib/http/keep-alive')
    installKeepAliveDispatcher()
    if (process.env.NODE_ENV === 'production') {
      const { startHotPathWarmer } = await import('./lib/http/warmup')
      startHotPathWarmer()
    }
  }
}
