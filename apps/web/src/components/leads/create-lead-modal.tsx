'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api-client';
import { humanise } from '@/lib/format';
import { useToast } from '@/components/providers';
import { Button, Field, Input, Modal, Select, Textarea } from '@/components/ui';
import { LEAD_PRIORITIES, LEAD_SOURCES, LEAD_STATUSES, type Lead } from '@/lib/types';

const EMPTY = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  company: '',
  jobTitle: '',
  industry: '',
  country: '',
  status: 'NEW',
  priority: 'MEDIUM',
  source: 'MANUAL',
  estimatedValue: '',
  tags: '',
  notes: '',
};

export const CreateLeadModal = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [form, setForm] = useState(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [duplicate, setDuplicate] = useState<{ id: string; name: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const update = (key: keyof typeof EMPTY) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const reset = () => {
    setForm(EMPTY);
    setFieldErrors({});
    setDuplicate(null);
    setFormError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const create = useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.post<Lead>('/leads', payload),
    onSuccess: () => {
      toast('Lead created.', 'success');
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
      close();
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) {
        setFormError('Could not reach the server.');
        return;
      }
      setFieldErrors(error.fieldErrors);
      setFormError(error.message);

      // A duplicate is not really an error — the user almost certainly wants to
      // open the existing record rather than retype the form.
      if (error.code === 'DUPLICATE_LEAD') {
        const details = error.details as { existingLeadId?: string; existingLeadName?: string } | undefined;
        if (details?.existingLeadId) {
          setDuplicate({ id: details.existingLeadId, name: details.existingLeadName ?? 'this lead' });
        }
      }
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFieldErrors({});
    setDuplicate(null);
    setFormError(null);

    // Empty strings are omitted rather than sent: the API treats "" as an
    // explicit clear, which is not what a blank optional field means.
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(form)) {
      if (value === '') continue;
      if (key === 'estimatedValue') payload[key] = Number(value);
      else if (key === 'tags') payload[key] = value.split(',').map((t) => t.trim()).filter(Boolean);
      else payload[key] = value;
    }

    create.mutate(payload);
  };

  return (
    <Modal open={open} onClose={close} title="New lead" description="Only one identifying field is required.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {formError && !duplicate && (
          <div className="rounded-lg border border-danger/25 bg-danger/10 px-3 py-2.5 text-sm text-danger" role="alert">
            {formError}
          </div>
        )}

        {duplicate && (
          <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm text-warning" role="alert">
            A matching lead already exists.{' '}
            <Link href={`/leads/${duplicate.id}`} className="font-medium underline" onClick={close}>
              Open {duplicate.name}
            </Link>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" error={fieldErrors.firstName}>
            {(id) => <Input id={id} value={form.firstName} onChange={update('firstName')} autoComplete="off" />}
          </Field>
          <Field label="Last name" error={fieldErrors.lastName}>
            {(id) => <Input id={id} value={form.lastName} onChange={update('lastName')} autoComplete="off" />}
          </Field>
          <Field label="Email" error={fieldErrors.email}>
            {(id) => (
              <Input
                id={id}
                type="email"
                value={form.email}
                onChange={update('email')}
                placeholder="name@company.com"
                invalid={Boolean(fieldErrors.email)}
              />
            )}
          </Field>
          <Field label="Phone" error={fieldErrors.phone}>
            {(id) => <Input id={id} value={form.phone} onChange={update('phone')} placeholder="+1 555 010 1234" />}
          </Field>
          <Field label="Company" error={fieldErrors.company}>
            {(id) => <Input id={id} value={form.company} onChange={update('company')} />}
          </Field>
          <Field label="Job title" error={fieldErrors.jobTitle}>
            {(id) => <Input id={id} value={form.jobTitle} onChange={update('jobTitle')} />}
          </Field>
          <Field label="Industry">
            {(id) => <Input id={id} value={form.industry} onChange={update('industry')} />}
          </Field>
          <Field label="Country">
            {(id) => <Input id={id} value={form.country} onChange={update('country')} />}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Status">
            {(id) => (
              <Select id={id} value={form.status} onChange={update('status')}>
                {LEAD_STATUSES.map((status) => (
                  <option key={status} value={status}>{humanise(status)}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Priority">
            {(id) => (
              <Select id={id} value={form.priority} onChange={update('priority')}>
                {LEAD_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>{humanise(priority)}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Source">
            {(id) => (
              <Select id={id} value={form.source} onChange={update('source')}>
                {LEAD_SOURCES.map((source) => (
                  <option key={source} value={source}>{humanise(source)}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Estimated value" hint="Whole currency units" error={fieldErrors.estimatedValue}>
            {(id, describedBy) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                type="number"
                min={0}
                value={form.estimatedValue}
                onChange={update('estimatedValue')}
                placeholder="25000"
              />
            )}
          </Field>
          <Field label="Tags" hint="Comma separated">
            {(id, describedBy) => (
              <Input id={id} aria-describedby={describedBy} value={form.tags} onChange={update('tags')} placeholder="enterprise, emea" />
            )}
          </Field>
        </div>

        <Field label="Notes" error={fieldErrors.notes}>
          {(id) => <Textarea id={id} rows={3} value={form.notes} onChange={update('notes')} />}
        </Field>

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button type="button" variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Create lead
          </Button>
        </div>
      </form>
    </Modal>
  );
};
