'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api-client';
import { Button, Field, Input } from '@/components/ui';

const DEMO = { email: 'admin@acme.test', password: 'Password123!' };

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      await api.post('/auth/login', { email, password });
      // Drop any cached data from a previous session before navigating —
      // otherwise the next user briefly sees the last user's leads.
      queryClient.clear();

      // `next` comes from the URL, so it is attacker-controllable. Only accept
      // same-origin relative paths; `//evil.com` is a valid relative URL to the
      // browser and would be an open redirect.
      const next = searchParams.get('next');
      const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
      router.replace(safeNext);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else {
        setError('Could not reach the server. Please try again.');
      }
      setSubmitting(false);
    }
  };

  const fillDemo = () => {
    setEmail(DEMO.email);
    setPassword(DEMO.password);
  };

  return (
    <>
      <div className="mb-8">
        <div className="mb-6 flex items-center gap-2.5 lg:hidden">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-lg font-bold text-brand-fg">
            A
          </div>
          <span className="text-lg font-semibold">Aarvion CRM</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1.5 text-sm text-muted">Welcome back. Enter your details to continue.</p>
      </div>

      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && (
          <div className="rounded-lg border border-danger/25 bg-danger/10 px-3 py-2.5 text-sm text-danger" role="alert">
            {error}
          </div>
        )}

        <Field label="Email" error={fieldErrors.email} required>
          {(id, describedBy) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              type="email"
              name="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              invalid={Boolean(fieldErrors.email)}
            />
          )}
        </Field>

        <Field label="Password" error={fieldErrors.password} required>
          {(id, describedBy) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••"
              invalid={Boolean(fieldErrors.password)}
            />
          )}
        </Field>

        <Button type="submit" loading={submitting} className="w-full">
          Sign in
        </Button>
      </form>

      <button
        type="button"
        onClick={fillDemo}
        className="mt-4 w-full rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted transition-colors hover:border-brand hover:text-brand"
      >
        Use demo credentials ({DEMO.email})
      </button>

      <p className="mt-8 text-center text-sm text-muted">
        No account yet?{' '}
        <Link href="/register" className="font-medium text-brand hover:underline">
          Create an organization
        </Link>
      </p>
    </>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary in the app router.
  return (
    <Suspense fallback={<div className="h-64" />}>
      <LoginForm />
    </Suspense>
  );
}
