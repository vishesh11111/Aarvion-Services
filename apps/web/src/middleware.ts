/**
 * Route protection.
 *
 * This is an *optimistic* guard, not an authorisation boundary. It reads the
 * non-httpOnly session-hint cookie to decide whether to render the app shell or
 * bounce to sign-in, which avoids a login-page flash on every navigation.
 *
 * Real authorisation happens in the API on every request. Forging the hint
 * cookie gets you an empty shell that 401s on its first fetch — deliberately, so
 * that a UI convenience is never load-bearing for security.
 */
import { type NextRequest, NextResponse } from 'next/server';

const SESSION_HINT = 'aarvion_sid';

const PUBLIC_PATHS = ['/login', '/register'];

export const middleware = (request: NextRequest): NextResponse => {
  const { pathname, search } = request.nextUrl;

  const hint = request.cookies.get(SESSION_HINT)?.value;
  // The hint stores the session's expiry so a stale cookie does not keep
  // routing the user into a shell that cannot load.
  const hasSession = Boolean(hint) && Number(hint) > Date.now();

  const isPublic = PUBLIC_PATHS.some((path) => pathname.startsWith(path));

  if (!hasSession && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    // Preserve the destination so sign-in returns the user where they meant to go.
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  if (hasSession && isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
};

export const config = {
  // Everything except the BFF proxy, Next internals and static assets.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|robots.txt).*)'],
};
