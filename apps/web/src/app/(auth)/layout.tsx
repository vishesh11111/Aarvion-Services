import type { ReactNode } from 'react';

/**
 * Split layout for sign-in and sign-up. The right panel is decorative and
 * hidden below `lg`, so the form is never pushed below the fold on mobile.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <main id="main" className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">{children}</div>
      </main>

      <aside
        className="relative hidden overflow-hidden bg-gradient-to-br from-brand via-brand/85 to-indigo-900 lg:block"
        aria-hidden="true"
      >
        <div className="absolute inset-0 opacity-20 [background-image:radial-gradient(circle_at_1px_1px,white_1px,transparent_0)] [background-size:28px_28px]" />
        <div className="relative flex h-full flex-col justify-between p-12 text-white">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15 text-lg font-bold backdrop-blur">
              A
            </div>
            <span className="text-lg font-semibold">Aarvion CRM</span>
          </div>

          <div className="max-w-md">
            <h2 className="text-3xl font-semibold leading-tight">
              Every lead, scored and ready to work.
            </h2>
            <p className="mt-4 text-white/75">
              Import from any CSV, let AI map the columns and rank the pipeline, and spend your
              team&apos;s time on the leads that will actually close.
            </p>

            <dl className="mt-10 grid grid-cols-3 gap-6 border-t border-white/15 pt-8">
              {[
                ['0-100', 'AI lead scoring'],
                ['Any CSV', 'Auto column mapping'],
                ['Plain English', 'Natural-language search'],
              ].map(([value, label]) => (
                <div key={label}>
                  <dt className="text-lg font-semibold">{value}</dt>
                  <dd className="mt-1 text-xs text-white/60">{label}</dd>
                </div>
              ))}
            </dl>
          </div>

          <p className="text-xs text-white/40">
            Multi-tenant · Role-based access · Audited
          </p>
        </div>
      </aside>
    </div>
  );
}
