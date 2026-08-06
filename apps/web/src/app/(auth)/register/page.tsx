'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api-client';
import { Button, Field, Input } from '@/components/ui';

/**
 * Password strength meter.
 *
 * Mirrors the API's policy (length-based, per NIST SP 800-63B) rather than
 * inventing a stricter client-side rule — a meter that disagrees with the server
 * is worse than no meter.
 */
const strengthOf = (password: string): { score: 0 | 1 | 2 | 3; label: string; className: string } => {
  const distinct = new Set(password).size;
  if (password.length < 10 || distinct < 5) {
    return { score: 0, label: 'Too short', className: 'w-1/4 bg-danger' };
  }
  if (password.length < 14) return { score: 1, label: 'Fair', className: 'w-2/4 bg-warning' };
  if (password.length < 20) return { score: 2, label: 'Good', className: 'w-3/4 bg-info' };
  return { score: 3, label: 'Strong', className: 'w-full bg-success' };
};

export default function RegisterPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [form, setForm] = useState({ organizationName: '', name: '', email: '', password: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const strength = useMemo(() => strengthOf(form.password), [form.password]);

  const update = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      await api.post('/auth/register', form);
      queryClient.clear();
      router.replace('/dashboard');
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

  return (
    <>
      <div className="mb-8">
        <div className="mb-6 flex items-center gap-2.5 lg:hidden">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-lg font-bold text-brand-fg">
            A
          </div>
          <span className="text-lg font-semibold">Aarvion CRM</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Create your organization</h1>
        <p className="mt-1.5 text-sm text-muted">
          You&apos;ll be the owner and can invite your team afterwards.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && (
          <div className="rounded-lg border border-danger/25 bg-danger/10 px-3 py-2.5 text-sm text-danger" role="alert">
            {error}
          </div>
        )}

        <Field label="Organization name" error={fieldErrors.organizationName} required>
          {(id, describedBy) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              required
              minLength={2}
              value={form.organizationName}
              onChange={update('organizationName')}
              placeholder="Acme Corporation"
              invalid={Boolean(fieldErrors.organizationName)}
            />
          )}
        </Field>

        <Field label="Your name" error={fieldErrors.name} required>
          {(id, describedBy) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              required
              autoComplete="name"
              value={form.name}
              onChange={update('name')}
              placeholder="Jane Doe"
              invalid={Boolean(fieldErrors.name)}
            />
          )}
        </Field>

        <Field label="Work email" error={fieldErrors.email} required>
          {(id, describedBy) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              type="email"
              required
              autoComplete="email"
              value={form.email}
              onChange={update('email')}
              placeholder="jane@acme.com"
              invalid={Boolean(fieldErrors.email)}
            />
          )}
        </Field>

        <Field
          label="Password"
          hint="At least 10 characters. A passphrase beats a short complex password."
          error={fieldErrors.password}
          required
        >
          {(id, describedBy) => (
            <>
              <Input
                id={id}
                aria-describedby={describedBy}
                type="password"
                required
                autoComplete="new-password"
                minLength={10}
                value={form.password}
                onChange={update('password')}
                placeholder="correct horse battery staple"
                invalid={Boolean(fieldErrors.password)}
              />
              {form.password.length > 0 && (
                <div className="mt-2 flex items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-2">
                    <div className={`h-full rounded-full transition-all ${strength.className}`} />
                  </div>
                  <span className="w-16 text-right text-xs text-muted">{strength.label}</span>
                </div>
              )}
            </>
          )}
        </Field>

        <Button type="submit" loading={submitting} className="w-full">
          Create organization
        </Button>
      </form>

      <p className="mt-8 text-center text-sm text-muted">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-brand hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
