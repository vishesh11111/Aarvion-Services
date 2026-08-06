/**
 * Backend-for-frontend proxy.
 *
 * Every browser request goes to `/api/v1/*` **on the web app's own origin**, and
 * this handler forwards it to the API. That buys three things:
 *
 *  1. **Cookies just work.** Auth cookies are first-party to the web origin, so
 *     there is no SameSite=None / third-party-cookie problem — the exact issue
 *     that breaks cookie auth in Safari and in Chrome's phase-out.
 *  2. **The API's address is never public.** In production the API can live on
 *     a private network with no ingress of its own.
 *  3. **The path prefix is preserved deliberately.** The API scopes the refresh
 *     cookie to `/api/v1/auth`; mirroring the prefix here means that scoping
 *     survives the proxy instead of silently breaking.
 *
 * The handler is intentionally dumb: it does not parse or re-serialise bodies
 * (so uploads stream through untouched) and it adds no logic of its own.
 */
import { type NextRequest, NextResponse } from 'next/server';

const API_BASE = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

// Node runtime, not edge: we need streaming request bodies for CSV uploads.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Hop-by-hop headers must not be forwarded (RFC 7230 §6.1). */
const STRIPPED_REQUEST_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'content-length', // refetched/recomputed by fetch
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-encoding', 'content-length',
]);

const buildTargetUrl = (req: NextRequest, path: string[]): string => {
  const search = req.nextUrl.search;
  return `${API_BASE}/api/v1/${path.map(encodeURIComponent).join('/')}${search}`;
};

const forward = async (req: NextRequest, path: string[]): Promise<NextResponse> => {
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });

  // Preserve the real client address for the API's rate limiter and audit log.
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) headers.set('x-forwarded-for', forwardedFor);

  const hasBody = !['GET', 'HEAD'].includes(req.method);

  let upstream: Response;
  try {
    upstream = await fetch(buildTargetUrl(req, path), {
      method: req.method,
      headers,
      ...(hasBody ? { body: req.body, duplex: 'half' } : {}),
      redirect: 'manual',
      cache: 'no-store',
    } as RequestInit);
  } catch (error) {
    // The API being unreachable is an infrastructure failure, and the client
    // deserves the same error envelope it gets from the API itself.
    return NextResponse.json(
      {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'The API is not reachable. Please try again shortly.',
          details: process.env.NODE_ENV === 'development' ? { cause: (error as Error).message } : undefined,
        },
      },
      { status: 503 },
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value);
  });

  // `Headers.get('set-cookie')` folds multiple cookies into one comma-joined
  // string, which corrupts them. getSetCookie() returns them individually.
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  responseHeaders.delete('set-cookie');
  for (const cookie of cookies) responseHeaders.append('set-cookie', cookie);

  // 204/304 must not carry a body; constructing one with a body throws.
  const bodyless = upstream.status === 204 || upstream.status === 304;

  return new NextResponse(bodyless ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
};

type RouteContext = { params: Promise<{ path: string[] }> };

const handler = async (req: NextRequest, context: RouteContext): Promise<NextResponse> => {
  const { path } = await context.params;
  return forward(req, path ?? []);
};

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;
export const HEAD = handler;
