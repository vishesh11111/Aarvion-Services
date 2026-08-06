import type { Metadata, Viewport } from 'next';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Aarvion CRM',
    template: '%s · Aarvion CRM',
  },
  description: 'AI-powered CRM for importing, managing and organising customer leads.',
  robots: { index: false, follow: false }, // it is an authenticated app
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8fafc' },
    { media: '(prefers-color-scheme: dark)', color: '#090c14' },
  ],
};

/**
 * Applies the stored theme before first paint.
 *
 * Without this, a dark-theme user sees a white flash on every page load while
 * React hydrates. It has to be a blocking inline script — there is no other way
 * to run code before the browser paints.
 */
const themeScript = `
(function () {
  try {
    var stored = localStorage.getItem('aarvion-theme');
    var dark = stored ? stored === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        {/* First tab stop on every page — a keyboard user should not have to
            traverse the whole sidebar to reach the content. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50
                     focus:rounded-lg focus:bg-brand focus:px-4 focus:py-2 focus:text-brand-fg"
        >
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
