'use client';

/**
 * Authenticated application shell: sidebar navigation, header, user menu.
 *
 * The sidebar is a persistent column on desktop and an off-canvas drawer below
 * `lg`. Navigation state is derived from the pathname rather than stored, so a
 * deep link always highlights the right item.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { initials } from '@/lib/format';
import { useSession, useTheme } from '@/components/providers';
import { Spinner } from '@/components/ui';

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
}

const icon = (path: string) => (
  <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={path} />
  </svg>
);

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: icon('M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z') },
  { href: '/leads', label: 'Leads', icon: icon('M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm14 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75') },
  { href: '/import', label: 'Import', icon: icon('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3') },
  { href: '/settings', label: 'Settings', icon: icon('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2-1.2L14.5 2h-4l-.4 2.6c-.7.3-1.4.7-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1c.6.5 1.3.9 2 1.2l.4 2.6h4l.4-2.6c.7-.3 1.4-.7 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z') },
];

export const AppShell = ({ children }: { children: ReactNode }) => {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { user, organization, isLoading } = useSession();
  const { theme, toggle } = useTheme();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  /** Wraps the trigger + menu, so a press inside either is treated as "inside". */
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  // Close the mobile drawer on navigation — leaving it open over the new page
  // is a classic mobile-nav bug.
  useEffect(() => {
    setDrawerOpen(false);
    setMenuOpen(false);
  }, [pathname]);

  /*
   * Dismiss the account menu on an outside click or Escape.
   *
   * This has to be a document listener rather than the usual full-screen
   * backdrop element: the header sets `backdrop-blur`, and an ancestor with
   * `backdrop-filter` becomes the containing block for `position: fixed`
   * descendants. A `fixed inset-0` overlay therefore covered only the 56px-tall
   * header instead of the viewport, so clicking anywhere in the page body left
   * the menu stuck open.
   *
   * `pointerdown` rather than `click` so the menu closes on press, matching
   * every native menu — but the ref check means a press on the menu itself is
   * ignored, so menu items still receive their click.
   */
  useEffect(() => {
    if (!menuOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menuButtonRef.current?.focus(); // return focus where the user left it
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  /**
   * Signs out.
   *
   * Deliberately ends with a **full page load** rather than `router.replace()`.
   * Sign-out has to guarantee that nothing survives: React state, the App Router
   * cache, in-memory query data and any in-flight request. A client-side
   * navigation leaves all of those alive and races `router.refresh()`, which is
   * how a user ends up back on a stale dashboard. A hard navigation also
   * re-runs middleware server-side against the freshly cleared cookies.
   *
   * The redirect is in `finally`: if the network call fails, the user still gets
   * signed out locally rather than being stranded on "Signing out…" with a live
   * session they were told was ended.
   */
  const signOut = async () => {
    if (signingOut) return; // ignore double-clicks
    setSigningOut(true);
    setMenuOpen(false);
    try {
      await api.post('/auth/logout');
    } catch {
      // Already logged server-side; a failed revoke must not block the exit.
    } finally {
      queryClient.clear();
      window.location.assign('/login');
    }
  };

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  const sidebar = (
    <nav className="flex h-full flex-col gap-1 p-3" aria-label="Main">
      <Link href="/dashboard" className="mb-4 flex items-center gap-2.5 px-2 py-1.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-brand-fg">
          A
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold leading-tight">Aarvion CRM</div>
          <div className="truncate text-xs text-muted">{organization?.name ?? '—'}</div>
        </div>
      </Link>

      {NAV.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={isActive(item.href) ? 'page' : undefined}
          className={clsx(
            'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
            isActive(item.href)
              ? 'bg-brand-soft text-brand'
              : 'text-muted hover:bg-surface-2 hover:text-fg',
          )}
        >
          {item.icon}
          {item.label}
        </Link>
      ))}

      <div className="mt-auto border-t border-border pt-3">
        <button
          type="button"
          onClick={toggle}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          {theme === 'dark'
            ? icon('M12 3v1m0 16v1m9-9h-1M4 12H3m15.4 6.4-.7-.7M6.3 6.3l-.7-.7m12.8 0-.7.7M6.3 17.7l-.7.7M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z')
            : icon('M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z')}
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </button>
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-border bg-surface lg:block">
        {sidebar}
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <aside className="absolute left-0 top-0 h-full w-64 animate-fade-in border-r border-border bg-surface">
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-surface/80 px-4 backdrop-blur">
          <button
            type="button"
            className="btn-ghost -ml-1 px-2 lg:hidden"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
          >
            {icon('M4 6h16M4 12h16M4 18h16')}
          </button>

          <div className="flex-1" />

          {isLoading ? (
            <Spinner className="h-4 w-4 text-muted" />
          ) : (
            <div className="relative" ref={menuRef}>
              <button
                ref={menuButtonRef}
                type="button"
                onClick={() => setMenuOpen((open) => !open)}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-2"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand">
                  {initials(user?.name ?? '?')}
                </span>
                <span className="hidden text-left sm:block">
                  <span className="block leading-tight">{user?.name}</span>
                  <span className="block text-xs text-muted">{user?.role.toLowerCase()}</span>
                </span>
              </button>

              {/*
                No backdrop element: dismissal is handled by the document
                `pointerdown` listener above. A `fixed inset-0` overlay is
                unusable here because the header's `backdrop-blur` makes it the
                containing block for fixed descendants, so the overlay covered
                only the header instead of the page.
              */}
              {menuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 z-20 mt-2 w-56 animate-fade-in overflow-hidden rounded-lg border border-border bg-surface shadow-pop"
                >
                  <div className="border-b border-border px-3 py-2.5">
                    <div className="truncate text-sm font-medium">{user?.name}</div>
                    <div className="truncate text-xs text-muted">{user?.email}</div>
                  </div>
                  <Link
                    href="/settings"
                    role="menuitem"
                    onClick={() => setMenuOpen(false)}
                    className="block px-3 py-2 text-sm hover:bg-surface-2"
                  >
                    Settings
                  </Link>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={signOut}
                    disabled={signingOut}
                    className="block w-full px-3 py-2 text-left text-sm text-danger hover:bg-surface-2 disabled:opacity-50"
                  >
                    {signingOut ? 'Signing out…' : 'Sign out'}
                  </button>
                </div>
              )}
            </div>
          )}
        </header>

        <main id="main" className="min-w-0 flex-1 p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
};
