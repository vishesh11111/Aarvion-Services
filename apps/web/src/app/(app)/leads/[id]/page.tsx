'use client';

/**
 * Lead detail.
 *
 * Three columns of concern: the record itself (editable inline), the AI briefing
 * (loaded on demand, never blocking the page), and the activity timeline.
 *
 * AI insights are fetched lazily rather than on mount. Loading a model response
 * for every lead a rep clicks through would burn quota on records they glance at
 * for two seconds — the user asks for it when they actually need it.
 */
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { clsx } from 'clsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api-client';
import {
  formatCurrency,
  formatDateTime,
  formatRelative,
  humanise,
  priorityStyles,
  scoreBarColor,
  scoreStyle,
  statusStyles,
} from '@/lib/format';
import { useSession, useToast } from '@/components/providers';
import { Badge, Banner, Button, Card, ErrorState, Field, Input, Select, Skeleton, Textarea } from '@/components/ui';
import {
  LEAD_PRIORITIES,
  LEAD_STATUSES,
  type LeadDetail,
  type LeadInsights,
  type User,
} from '@/lib/types';

/* -------------------------------------------------------------------------- */
/* Sub-components                                                             */
/* -------------------------------------------------------------------------- */

const DetailRow = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-start justify-between gap-4 border-b border-border py-2.5 last:border-0">
    <dt className="shrink-0 text-sm text-muted">{label}</dt>
    <dd className="min-w-0 break-words text-right text-sm font-medium">{children}</dd>
  </div>
);

const ACTIVITY_ICONS: Record<string, string> = {
  CREATED: 'M12 5v14M5 12h14',
  IMPORTED: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  NOTE: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6',
  EMAIL: 'm4 4 8 6 8-6M4 4h16v16H4V4Z',
  CALL: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.1a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z',
  MEETING: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
  STATUS_CHANGE: 'M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3',
  OWNER_CHANGE: 'M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM20 8v6M23 11h-6',
  MERGED: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM15 6a9 9 0 0 1-9 9',
  AI_ENRICHMENT: 'm12 3 2.1 5.7 5.9.3-4.6 3.7 1.6 5.7L12 15.2 6.9 18.4l1.6-5.7L4 9l5.9-.3L12 3Z',
};

const Timeline = ({ activities }: { activities: LeadDetail['activities'] }) => {
  if (activities.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">No activity recorded yet.</p>;
  }

  return (
    <ol className="relative space-y-4 pl-6">
      {/* The connecting rail. aria-hidden — it carries no information. */}
      <span className="absolute left-[9px] top-2 h-[calc(100%-1rem)] w-px bg-border" aria-hidden="true" />
      {activities.map((activity) => (
        <li key={activity.id} className="relative">
          <span className="absolute -left-6 top-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full border border-border bg-surface text-muted">
            <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d={ACTIVITY_ICONS[activity.type] ?? ACTIVITY_ICONS.NOTE!} />
            </svg>
          </span>
          <div className="text-sm font-medium">{activity.title}</div>
          {activity.body && <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted">{activity.body}</p>}
          <div className="mt-0.5 text-xs text-muted">
            {activity.user?.name ? `${activity.user.name} · ` : ''}
            <time dateTime={activity.createdAt} title={formatDateTime(activity.createdAt)}>
              {formatRelative(activity.createdAt)}
            </time>
          </div>
        </li>
      ))}
    </ol>
  );
};

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function LeadDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { can } = useSession();

  const leadId = params.id;
  const canWrite = can('MEMBER');

  const [editing, setEditing] = useState(false);
  const [insightsRequested, setInsightsRequested] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [draft, setDraft] = useState<Record<string, string>>({});

  const lead = useQuery({
    queryKey: ['lead', leadId],
    queryFn: () => api.get<LeadDetail>(`/leads/${leadId}`),
  });

  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api.get<{ members: User[] }>('/auth/members'),
    staleTime: 5 * 60_000,
  });

  const insights = useQuery({
    queryKey: ['insights', leadId],
    queryFn: () => api.getWithMeta<LeadInsights>(`/ai/leads/${leadId}/insights`),
    enabled: insightsRequested,
    staleTime: 10 * 60_000,
  });

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch<LeadDetail>(`/leads/${leadId}`, patch),
    onSuccess: () => {
      toast('Lead updated.', 'success');
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
    onError: (error) => toast(error instanceof ApiError ? error.message : 'Update failed.', 'error'),
  });

  const score = useMutation({
    mutationFn: () => api.postWithMeta('/ai/score', { leadIds: [leadId], force: true }),
    onSuccess: (response) => {
      toast(response.meta?.degraded ? 'Scored using rule-based fallback.' : 'Lead scored with AI.', response.meta?.degraded ? 'info' : 'success');
      void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
      void queryClient.invalidateQueries({ queryKey: ['insights', leadId] });
    },
    onError: (error) => toast(error instanceof ApiError ? error.message : 'Scoring failed.', 'error'),
  });

  const addNote = useMutation({
    mutationFn: (body: string) =>
      api.post(`/leads/${leadId}/activities`, { type: 'NOTE', title: 'Note added', body }),
    onSuccess: () => {
      setNoteText('');
      void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
    },
    onError: (error) => toast(error instanceof ApiError ? error.message : 'Could not add note.', 'error'),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/leads/${leadId}`),
    onSuccess: () => {
      toast('Lead deleted. It can be restored for 30 days.', 'success');
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      router.push('/leads');
    },
    onError: (error) => toast(error instanceof ApiError ? error.message : 'Delete failed.', 'error'),
  });

  if (lead.isLoading) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <Skeleton className="h-24" />
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-96 lg:col-span-2" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  if (lead.isError || !lead.data) {
    return (
      <ErrorState
        message={lead.error instanceof ApiError ? lead.error.message : 'Could not load this lead.'}
        onRetry={() => void lead.refetch()}
      />
    );
  }

  const l = lead.data;

  const startEditing = () => {
    setDraft({
      firstName: l.firstName ?? '',
      lastName: l.lastName ?? '',
      email: l.email ?? '',
      phone: l.phone ?? '',
      company: l.company ?? '',
      jobTitle: l.jobTitle ?? '',
      industry: l.industry ?? '',
      country: l.country ?? '',
      estimatedValue: l.estimatedValue?.toString() ?? '',
      notes: l.notes ?? '',
    });
    setEditing(true);
  };

  const saveEdits = (event: FormEvent) => {
    event.preventDefault();
    // `null` clears a field; omitting it leaves it alone. Mapping "" -> null is
    // what makes "delete the phone number" expressible from a form input.
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(draft)) {
      if (key === 'estimatedValue') patch[key] = value === '' ? null : Number(value);
      else patch[key] = value === '' ? null : value;
    }
    update.mutate(patch);
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      {/* --- header ------------------------------------------------------- */}
      <div>
        <Link href="/leads" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m15 18-6-6 6-6" />
          </svg>
          All leads
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">{l.fullName}</h1>
            <p className="mt-1 text-sm text-muted">
              {[l.jobTitle, l.company].filter(Boolean).join(' at ') || 'No role or company recorded'}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge className={statusStyles[l.status]}>{humanise(l.status)}</Badge>
              <Badge className={priorityStyles[l.priority]}>{humanise(l.priority)}</Badge>
              <Badge className="bg-surface-2 text-muted">{humanise(l.source)}</Badge>
              {l.tags.map((tag) => (
                <Badge key={tag} className="bg-brand-soft text-brand">{tag}</Badge>
              ))}
            </div>
          </div>

          {canWrite && (
            <div className="flex flex-wrap gap-2">
              {!editing && (
                <Button variant="secondary" onClick={startEditing}>
                  Edit
                </Button>
              )}
              <Button variant="secondary" loading={score.isPending} onClick={() => score.mutate()}>
                Re-score
              </Button>
              <Button
                variant="ghost"
                className="text-danger"
                onClick={() => {
                  if (window.confirm('Delete this lead? It can be restored for 30 days.')) remove.mutate();
                }}
              >
                Delete
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* --- main column ------------------------------------------------ */}
        <div className="space-y-4 lg:col-span-2">
          {/* Score */}
          <Card className="p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold">AI lead score</h2>
                {l.scoredAt ? (
                  <p className="mt-0.5 text-xs text-muted">Scored {formatRelative(l.scoredAt)}</p>
                ) : (
                  <p className="mt-0.5 text-xs text-muted">Not scored yet</p>
                )}
              </div>
              <div className={clsx('text-3xl font-semibold tabular-nums', scoreStyle(l.score))}>
                {l.score ?? '—'}
              </div>
            </div>

            <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-2">
              <div
                className={clsx('h-full rounded-full transition-[width] duration-700', scoreBarColor(l.score))}
                style={{ width: `${l.score ?? 0}%` }}
              />
            </div>

            {l.scoreRationale && <p className="mt-3 text-sm text-muted">{l.scoreRationale}</p>}
            {l.aiNextAction && (
              <div className="mt-3 rounded-lg border border-brand/20 bg-brand-soft px-3 py-2">
                <div className="text-xs font-medium uppercase tracking-wide text-brand">Suggested next step</div>
                <p className="mt-0.5 text-sm">{l.aiNextAction}</p>
              </div>
            )}
          </Card>

          {/* Details / edit form */}
          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold">Details</h2>

            {editing ? (
              <form onSubmit={saveEdits} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  {(
                    [
                      ['firstName', 'First name', 'text'],
                      ['lastName', 'Last name', 'text'],
                      ['email', 'Email', 'email'],
                      ['phone', 'Phone', 'tel'],
                      ['company', 'Company', 'text'],
                      ['jobTitle', 'Job title', 'text'],
                      ['industry', 'Industry', 'text'],
                      ['country', 'Country', 'text'],
                      ['estimatedValue', 'Estimated value', 'number'],
                    ] as const
                  ).map(([key, label, type]) => (
                    <Field key={key} label={label}>
                      {(id) => (
                        <Input
                          id={id}
                          type={type}
                          value={draft[key] ?? ''}
                          onChange={(event) => setDraft((d) => ({ ...d, [key]: event.target.value }))}
                        />
                      )}
                    </Field>
                  ))}
                </div>

                <Field label="Notes">
                  {(id) => (
                    <Textarea
                      id={id}
                      rows={4}
                      value={draft.notes ?? ''}
                      onChange={(event) => setDraft((d) => ({ ...d, notes: event.target.value }))}
                    />
                  )}
                </Field>

                <div className="flex justify-end gap-2 border-t border-border pt-4">
                  <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" loading={update.isPending}>
                    Save changes
                  </Button>
                </div>
              </form>
            ) : (
              <dl>
                <DetailRow label="Email">
                  {l.email ? <a className="text-brand hover:underline" href={`mailto:${l.email}`}>{l.email}</a> : '—'}
                </DetailRow>
                <DetailRow label="Phone">
                  {l.phone ? <a className="text-brand hover:underline" href={`tel:${l.phone}`}>{l.phone}</a> : '—'}
                </DetailRow>
                <DetailRow label="Company">{l.company ?? '—'}</DetailRow>
                <DetailRow label="Job title">{l.jobTitle ?? '—'}</DetailRow>
                <DetailRow label="Industry">{l.industry ?? '—'}</DetailRow>
                <DetailRow label="Company size">{l.companySize ?? '—'}</DetailRow>
                <DetailRow label="Location">
                  {[l.city, l.state, l.country].filter(Boolean).join(', ') || '—'}
                </DetailRow>
                <DetailRow label="Website">
                  {l.website ? (
                    <a className="text-brand hover:underline" href={l.website} target="_blank" rel="noopener noreferrer">
                      {l.website.replace(/^https?:\/\//, '')}
                    </a>
                  ) : (
                    '—'
                  )}
                </DetailRow>
                <DetailRow label="Estimated value">{formatCurrency(l.estimatedValue)}</DetailRow>
                <DetailRow label="Added">{formatDateTime(l.createdAt)}</DetailRow>
                {l.importJob && (
                  <DetailRow label="Imported from">
                    <span className="text-muted">{l.importJob.filename}</span>
                  </DetailRow>
                )}
                {l.notes && (
                  <div className="pt-3">
                    <dt className="mb-1 text-sm text-muted">Notes</dt>
                    <dd className="whitespace-pre-wrap text-sm">{l.notes}</dd>
                  </div>
                )}

                {/* Unmapped CSV columns are preserved rather than discarded, so
                    show them — otherwise the user cannot tell they survived. */}
                {Object.keys(l.customFields).length > 0 && (
                  <div className="mt-3 border-t border-border pt-3">
                    <dt className="mb-2 text-sm text-muted">Custom fields (from import)</dt>
                    <dd className="grid gap-1.5 sm:grid-cols-2">
                      {Object.entries(l.customFields).map(([key, value]) => (
                        <div key={key} className="rounded-md bg-surface-2 px-2.5 py-1.5 text-xs">
                          <span className="text-muted">{key}: </span>
                          <span className="font-medium">{String(value)}</span>
                        </div>
                      ))}
                    </dd>
                  </div>
                )}
              </dl>
            )}
          </Card>

          {/* Activity */}
          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold">Activity</h2>

            {canWrite && (
              <form
                className="mb-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (noteText.trim()) addNote.mutate(noteText.trim());
                }}
              >
                <Textarea
                  rows={2}
                  value={noteText}
                  onChange={(event) => setNoteText(event.target.value)}
                  placeholder="Log a note, call outcome or next step…"
                  aria-label="Add a note"
                />
                <div className="mt-2 flex justify-end">
                  <Button type="submit" className="h-8 py-0 text-xs" loading={addNote.isPending} disabled={!noteText.trim()}>
                    Add note
                  </Button>
                </div>
              </form>
            )}

            <Timeline activities={l.activities} />
          </Card>
        </div>

        {/* --- side column ------------------------------------------------- */}
        <div className="space-y-4">
          {/* Pipeline controls */}
          {canWrite && (
            <Card className="p-5">
              <h2 className="mb-3 text-sm font-semibold">Pipeline</h2>
              <div className="space-y-3">
                <Field label="Status">
                  {(id) => (
                    <Select
                      id={id}
                      value={l.status}
                      onChange={(event) => update.mutate({ status: event.target.value })}
                      disabled={update.isPending}
                    >
                      {LEAD_STATUSES.map((status) => (
                        <option key={status} value={status}>{humanise(status)}</option>
                      ))}
                    </Select>
                  )}
                </Field>

                <Field label="Priority">
                  {(id) => (
                    <Select
                      id={id}
                      value={l.priority}
                      onChange={(event) => update.mutate({ priority: event.target.value })}
                      disabled={update.isPending}
                    >
                      {LEAD_PRIORITIES.map((priority) => (
                        <option key={priority} value={priority}>{humanise(priority)}</option>
                      ))}
                    </Select>
                  )}
                </Field>

                <Field label="Owner">
                  {(id) => (
                    <Select
                      id={id}
                      value={l.ownerId ?? ''}
                      onChange={(event) => update.mutate({ ownerId: event.target.value || null })}
                      disabled={update.isPending}
                    >
                      <option value="">Unassigned</option>
                      {members.data?.members.map((member) => (
                        <option key={member.id} value={member.id}>{member.name}</option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
            </Card>
          )}

          {/* AI briefing */}
          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">AI briefing</h2>
              {!insightsRequested && (
                <Button className="h-7 py-0 text-xs" onClick={() => setInsightsRequested(true)}>
                  Generate
                </Button>
              )}
            </div>

            {!insightsRequested ? (
              <p className="text-sm text-muted">
                Get a pre-call summary, talking points and a draft opener for this lead.
              </p>
            ) : insights.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-4 w-3/5" />
              </div>
            ) : insights.isError ? (
              <p className="text-sm text-danger">Could not generate a briefing right now.</p>
            ) : insights.data ? (
              <div className="space-y-4 text-sm">
                {insights.data.meta?.degraded && (
                  <Banner tone="warning">
                    <span>{insights.data.meta.degradedReason ?? 'Rule-based fallback — AI unavailable.'}</span>
                  </Banner>
                )}

                <p>{insights.data.data.summary}</p>

                {insights.data.data.talkingPoints.length > 0 && (
                  <div>
                    <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">Talking points</h3>
                    <ul className="space-y-1">
                      {insights.data.data.talkingPoints.map((point) => (
                        <li key={point} className="flex gap-2">
                          <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-brand" aria-hidden="true" />
                          <span>{point}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {insights.data.data.risks.length > 0 && (
                  <div>
                    <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">Watch out for</h3>
                    <ul className="space-y-1">
                      {insights.data.data.risks.map((risk) => (
                        <li key={risk} className="flex gap-2">
                          <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-warning" aria-hidden="true" />
                          <span className="text-muted">{risk}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="rounded-lg bg-surface-2 p-3">
                  <div className="mb-1 flex items-center justify-between">
                    <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Draft opener</h3>
                    <span className="badge bg-brand-soft text-brand">
                      via {humanise(insights.data.data.recommendedChannel)}
                    </span>
                  </div>
                  <p className="text-sm">{insights.data.data.draftOpener}</p>
                  <button
                    type="button"
                    className="mt-2 text-xs text-brand hover:underline"
                    onClick={() => {
                      void navigator.clipboard.writeText(insights.data!.data.draftOpener);
                      toast('Copied to clipboard.', 'success');
                    }}
                  >
                    Copy
                  </button>
                </div>
              </div>
            ) : null}
          </Card>
        </div>
      </div>
    </div>
  );
}
