/**
 * Typed API client.
 *
 * All requests go to `/api/v1/*` on this origin and are proxied to the backend
 * (see `app/api/v1/[...path]/route.ts`). Two behaviours are worth knowing:
 *
 *  • **Transparent refresh.** A 401 triggers exactly one refresh attempt, then
 *    the original request is retried. Concurrent 401s share a single in-flight
 *    refresh — without that, a dashboard firing six parallel queries would send
 *    six refreshes, and token rotation would treat five of them as reuse and
 *    revoke the session.
 *
 *  • **Errors are structured.** Failures throw `ApiError` carrying the API's
 *    stable `code` and any field-level `details`, so forms can render per-field
 *    messages instead of a generic toast.
 */
import type { PaginationMeta } from './types';

export interface ApiEnvelope<T> {
  data: T;
  meta?: PaginationMeta;
}

interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
  requestId?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | undefined;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error?.message ?? 'Request failed');
    this.name = 'ApiError';
    this.status = status;
    this.code = body.error?.code ?? 'UNKNOWN';
    this.details = body.error?.details;
    this.requestId = body.requestId;
  }

  /** `{ email: ["Enter a valid email"] }` when the API returned field errors. */
  get fieldErrors(): Record<string, string[]> {
    const details = this.details as { fields?: Record<string, string[]> } | undefined;
    return details?.fields ?? {};
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }
}

const BASE = '/api/v1';

/** Shared in-flight refresh, so N concurrent 401s produce one rotation. */
let refreshInFlight: Promise<boolean> | null = null;

/**
 * True when the browser is holding a session hint that has not yet expired.
 *
 * `aarvion_sid` is the non-httpOnly companion cookie the API sets alongside the
 * real tokens. It carries no credential — only the session's expiry — so reading
 * it here is safe, and it lets the client distinguish "my access token just
 * lapsed" from "I was never signed in".
 */
const hasLiveSession = (): boolean => {
  if (typeof document === 'undefined') return false;
  const hint = document.cookie
    .split('; ')
    .find((c) => c.startsWith('aarvion_sid='))
    ?.split('=')[1];
  return Boolean(hint) && Number(hint) > Date.now();
};

const attemptRefresh = async (): Promise<boolean> => {
  /*
   * Refusing to refresh without a session is not an optimisation — it fixes a
   * lockout.
   *
   * Every unauthenticated page load used to run: GET /auth/me -> 401 -> POST
   * /auth/refresh -> 401. That refresh consumed a token from the API's auth
   * rate-limit budget, which login shares. Visiting the sign-in page ~10 times
   * in 15 minutes therefore exhausted the budget and made signing in impossible
   * — most visibly right after signing out, which is when people reload that
   * page repeatedly.
   *
   * (The server side was fixed too: refresh now has its own budget. This stops
   * the pointless round-trip from being made at all.)
   */
  if (!hasLiveSession()) return false;

  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      // Cleared on the next tick so callers awaiting this promise all observe
      // the same result before a new attempt can start.
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();

  return refreshInFlight;
};

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Set false for the auth endpoints themselves, to avoid a refresh loop. */
  retryOnUnauthorised?: boolean;
  query?: Record<string, unknown>;
}

const buildQuery = (query: Record<string, unknown> | undefined): string => {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(','));
    } else if (value instanceof Date) {
      params.set(key, value.toISOString());
    } else {
      params.set(key, String(value));
    }
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
};

const parseError = async (response: Response): Promise<ApiError> => {
  let body: ApiErrorBody;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = { error: { code: 'UNKNOWN', message: response.statusText || 'Request failed' } };
  }
  return new ApiError(response.status, body);
};

export const apiRequest = async <T>(path: string, options: RequestOptions = {}): Promise<ApiEnvelope<T>> => {
  const { body, retryOnUnauthorised = true, query, headers, ...rest } = options;

  const isFormData = body instanceof FormData;

  const send = (): Promise<Response> =>
    fetch(`${BASE}${path}${buildQuery(query)}`, {
      ...rest,
      credentials: 'include',
      headers: {
        // Let the browser set the multipart boundary itself.
        ...(isFormData ? {} : { 'content-type': 'application/json' }),
        ...(headers as Record<string, string> | undefined),
      },
      ...(body !== undefined
        ? { body: isFormData ? (body as FormData) : JSON.stringify(body) }
        : {}),
    });

  let response = await send();

  if (response.status === 401 && retryOnUnauthorised) {
    const refreshed = await attemptRefresh();
    if (refreshed) response = await send();
  }

  if (!response.ok) throw await parseError(response);

  if (response.status === 204) return { data: undefined as T };

  return (await response.json()) as ApiEnvelope<T>;
};

/** Unwraps the envelope for the common case where `meta` is not needed. */
export const api = {
  get: async <T>(path: string, query?: Record<string, unknown>): Promise<T> =>
    (await apiRequest<T>(path, { method: 'GET', ...(query ? { query } : {}) })).data,

  getWithMeta: <T>(path: string, query?: Record<string, unknown>): Promise<ApiEnvelope<T>> =>
    apiRequest<T>(path, { method: 'GET', ...(query ? { query } : {}) }),

  post: async <T>(path: string, body?: unknown): Promise<T> =>
    (await apiRequest<T>(path, { method: 'POST', body })).data,

  postWithMeta: <T>(path: string, body?: unknown): Promise<ApiEnvelope<T>> =>
    apiRequest<T>(path, { method: 'POST', body }),

  patch: async <T>(path: string, body?: unknown): Promise<T> =>
    (await apiRequest<T>(path, { method: 'PATCH', body })).data,

  delete: async <T>(path: string): Promise<T> =>
    (await apiRequest<T>(path, { method: 'DELETE' })).data,
};

/** Triggers a browser download without leaving the page. */
export const downloadCsv = async (query: Record<string, unknown>): Promise<void> => {
  const response = await fetch(`${BASE}/leads/export${buildQuery(query)}`, {
    credentials: 'include',
  });
  if (!response.ok) throw await parseError(response);

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
};
