'use client';

/**
 * Client-side providers: React Query, session context, theme, toasts.
 */
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '@/lib/api-client';
import type { Organization, User } from '@/lib/types';

/* -------------------------------------------------------------------------- */
/* React Query                                                                */
/* -------------------------------------------------------------------------- */

const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        // Most CRM data is fine slightly stale; refetching on every focus is
        // noise that burns rate-limit budget on a shared API.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          // 4xx will not fix itself. Only retry genuine transient failures.
          if (error instanceof ApiError && error.status < 500) return false;
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });

/* -------------------------------------------------------------------------- */
/* Session                                                                    */
/* -------------------------------------------------------------------------- */

interface SessionValue {
  user: User | null;
  organization: Organization | null;
  isLoading: boolean;
  /** Role check used to hide actions the API would reject anyway. */
  can: (minimum: 'VIEWER' | 'MEMBER' | 'ADMIN' | 'OWNER') => boolean;
}

const SessionContext = createContext<SessionValue>({
  user: null,
  organization: null,
  isLoading: true,
  can: () => false,
});

export const useSession = (): SessionValue => useContext(SessionContext);

const ROLE_RANK = { VIEWER: 10, MEMBER: 20, ADMIN: 30, OWNER: 40 } as const;

/**
 * Whether the browser holds an unexpired session hint.
 *
 * Read once at mount rather than reactively: this only gates whether the very
 * first `/auth/me` is worth making, and the query itself is the source of truth
 * from then on.
 */
const hasSessionHint = (): boolean => {
  if (typeof document === 'undefined') return false;
  const hint = document.cookie
    .split('; ')
    .find((c) => c.startsWith('aarvion_sid='))
    ?.split('=')[1];
  return Boolean(hint) && Number(hint) > Date.now();
};

const SessionProvider = ({ children }: { children: ReactNode }) => {
  /*
   * The provider wraps the whole app, including /login and /register, so
   * without a guard it fired `/auth/me` on every public page view — a
   * guaranteed 401 that then triggered a refresh attempt. Skipping the query
   * when no session exists removes a wasted round-trip on every sign-in page
   * load, and removes the 401 noise that made real failures hard to spot in the
   * console.
   */
  const [enabled] = useState(hasSessionHint);

  const { data, isLoading } = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<{ user: User; organization: Organization }>('/auth/me'),
    enabled,
    // The session underpins routing; keep it fresh but not chatty.
    staleTime: 60_000,
    retry: false,
  });

  const value = useMemo<SessionValue>(
    () => ({
      user: data?.user ?? null,
      organization: data?.organization ?? null,
      // A disabled query reports `isLoading: true` forever, which would leave
      // the shell stuck on its spinner. Signed-out means resolved, not loading.
      isLoading: enabled && isLoading,
      can: (minimum) => {
        const role = data?.user.role;
        if (!role) return false;
        return ROLE_RANK[role] >= ROLE_RANK[minimum];
      },
    }),
    [data, isLoading, enabled],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
};

/* -------------------------------------------------------------------------- */
/* Theme                                                                      */
/* -------------------------------------------------------------------------- */

type Theme = 'light' | 'dark';

const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({
  theme: 'light',
  toggle: () => undefined,
});

export const useTheme = () => useContext(ThemeContext);

const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const [theme, setTheme] = useState<Theme>('light');

  // Read the stored preference on mount rather than during render — touching
  // localStorage during SSR throws, and reading it in render causes hydration
  // mismatch.
  useEffect(() => {
    const stored = window.localStorage.getItem('aarvion-theme') as Theme | null;
    const preferred: Theme =
      stored ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    setTheme(preferred);
    document.documentElement.classList.toggle('dark', preferred === 'dark');
  }, []);

  const toggle = () => {
    setTheme((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      document.documentElement.classList.toggle('dark', next === 'dark');
      window.localStorage.setItem('aarvion-theme', next);
      return next;
    });
  };

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
};

/* -------------------------------------------------------------------------- */
/* Toasts                                                                     */
/* -------------------------------------------------------------------------- */

interface Toast {
  id: number;
  message: string;
  tone: 'success' | 'error' | 'info';
}

const ToastContext = createContext<{
  toast: (message: string, tone?: Toast['tone']) => void;
}>({ toast: () => undefined });

export const useToast = () => useContext(ToastContext);

const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = (message: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 5_000);
  };

  const tones = {
    success: 'border-success/30 bg-success/10 text-success',
    error: 'border-danger/30 bg-danger/10 text-danger',
    info: 'border-border bg-surface text-fg',
  };

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* aria-live so screen readers announce results of actions. */}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
        aria-live="polite"
        aria-atomic="false"
      >
        {toasts.map((item) => (
          <div
            key={item.id}
            className={`pointer-events-auto animate-fade-in rounded-lg border px-4 py-3 text-sm shadow-pop ${tones[item.tone]}`}
          >
            {item.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

/* -------------------------------------------------------------------------- */

export const Providers = ({ children }: { children: ReactNode }) => {
  // Created in state so React Strict Mode's double-render does not build two
  // clients and throw away the cache on every mount.
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          <SessionProvider>{children}</SessionProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
};
