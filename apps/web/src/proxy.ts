import { auth } from '@/lib/auth'

export default auth((req) => {
  const isLoggedIn = !!req.auth
  const { pathname } = req.nextUrl

  // Return 401 JSON for unauthenticated API calls (skip /api/auth which handles sign-in)
  if (!isLoggedIn && pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Redirect unauthenticated users to login (covers both /dashboard/* and (dashboard) group routes at /)
  if (!isLoggedIn) {
    const loginUrl = new URL('/login', req.url)
    loginUrl.searchParams.set('callbackUrl', pathname)
    return Response.redirect(loginUrl)
  }

  // Redirect logged-in users away from login page
  if (isLoggedIn && pathname === '/login') {
    return Response.redirect(new URL('/', req.url))
  }
})

export const config = {
  // Protect all routes except next-auth endpoints, static assets, the login page,
  // and the Alertmanager webhook receiver (called by the cluster, not a browser session).
  matcher: ['/((?!login|api/auth|api/favicon|api/alerts/webhook|_next/static|_next/image|favicon\\.ico).*)'],
}
