import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { getSupabasePublicConfig, isSupabaseConfigError, type SupabasePublicConfig } from '@/lib/supabase/env'

// Every top-level route under src/app/(dashboard)/ belongs here —
// middleware.test.ts reads that directory and fails on a missing one.
export const PROTECTED_PATHS = ['/dashboard', '/resort', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/flows', '/agents', '/notifications', '/settings']

function isProtectedPage(path: string) {
  return PROTECTED_PATHS.some((p) => path.startsWith(p))
}

function isProtectedApi(path: string) {
  return (
    (path.startsWith('/api/whatsapp/') && !path.includes('/webhook')) ||
    (path.startsWith('/api/msg91/') && !path.includes('/webhook')) ||
    path.startsWith('/api/admin/')
  )
}

function configMissingResponse(path: string, err: Error & { missing?: string[] }) {
  // Variable names are not secret, but keep production responses generic;
  // the full message is in the server log.
  const detail = process.env.NODE_ENV === 'production' ? undefined : err.message
  if (path.startsWith('/api/')) {
    return NextResponse.json(
      { error: 'Service unavailable: authentication is not configured.', code: 'supabase_not_configured', missing: detail ? err.missing : undefined, detail },
      { status: 503 },
    )
  }
  return new NextResponse(
    `Service unavailable: authentication is not configured.${detail ? `\n\n${detail}` : ''}`,
    { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } },
  )
}

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname

  let config: SupabasePublicConfig
  try {
    config = getSupabasePublicConfig()
  } catch (err) {
    if (!isSupabaseConfigError(err)) throw err
    console.error(`[middleware] ${err.message}`)
    // Fail closed: without Supabase nobody can be authenticated, so
    // protected pages and APIs are refused rather than served. Other
    // routes (login, signup, invite pages) render and show the same error
    // when they try to use Supabase.
    if (isProtectedPage(path) || isProtectedApi(path)) return configMissingResponse(path, err)
    return NextResponse.next({ request })
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    config.url,
    config.anonKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/dashboard'
      url.search = ''
    }
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // Protected pages - redirect to login if not authenticated
  if (!user && isProtectedPage(path)) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // API routes that need auth (not webhooks). Admin routes also verify
  // the caller's role server-side; this is only the first gate.
  if (!user && isProtectedApi(path)) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
