'use client';

/**
 * CSV import wizard.
 *
 * Three steps, matching the API's two-phase design:
 *   1. Upload      — the file is parsed server-side; nothing is written yet.
 *   2. Map columns — AI proposes a mapping; the user confirms or corrects it.
 *   3. Progress    — the job runs in a worker and is polled until it settles.
 *
 * The mapping step is the important one. Importing tens of thousands of customer
 * records under a mapping nobody checked is how CRMs end up with phone numbers
 * in the job-title column — and no undo. Confirmation is not friction here, it
 * is the feature.
 */
import Link from 'next/link';
import { useCallback, useMemo, useRef, useState, type DragEvent } from 'react';
import { clsx } from 'clsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiRequest, ApiError } from '@/lib/api-client';
import { formatNumber, formatRelative, humanise } from '@/lib/format';
import { useToast } from '@/components/providers';
import { Badge, Banner, Button, Card, EmptyState, ProgressBar, Select, Skeleton } from '@/components/ui';
import {
  LEAD_SOURCES,
  type ImportCreateResponse,
  type ImportError,
  type ImportJob,
  type MappingSuggestion,
  type User,
} from '@/lib/types';

/** Mirrors MAPPABLE_FIELDS on the API. */
const MAPPABLE_FIELDS = [
  'firstName', 'lastName', 'fullName', 'email', 'phone', 'company', 'jobTitle',
  'website', 'industry', 'companySize', 'city', 'state', 'country', 'status',
  'priority', 'source', 'estimatedValue', 'tags', 'notes',
] as const;

const FIELD_LABELS: Record<string, string> = {
  firstName: 'First name', lastName: 'Last name', fullName: 'Full name',
  email: 'Email', phone: 'Phone', company: 'Company', jobTitle: 'Job title',
  website: 'Website', industry: 'Industry', companySize: 'Company size',
  city: 'City', state: 'State / region', country: 'Country', status: 'Status',
  priority: 'Priority', source: 'Source', estimatedValue: 'Estimated value',
  tags: 'Tags', notes: 'Notes',
};

const MAX_BYTES = 50 * 1024 * 1024;

const TERMINAL_STATUSES = ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'];

type Step = 'upload' | 'map' | 'progress';

export default function ImportPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>('upload');
  const [dragging, setDragging] = useState(false);
  const [upload, setUpload] = useState<ImportCreateResponse | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [options, setOptions] = useState({
    duplicateStrategy: 'SKIP' as 'SKIP' | 'UPDATE' | 'CREATE_ANYWAY',
    defaultSource: 'CSV_IMPORT',
    defaultOwnerId: '',
    keepUnmappedAsCustomFields: true,
    autoScore: true,
  });

  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api.get<{ members: User[] }>('/auth/members'),
    staleTime: 5 * 60_000,
  });

  const history = useQuery({
    queryKey: ['imports'],
    queryFn: () => api.get<ImportJob[]>('/imports', { limit: 10 }),
  });

  /* --- upload ----------------------------------------------------------- */

  const uploadFile = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append('file', file);
      const response = await apiRequest<ImportCreateResponse>('/imports', { method: 'POST', body });
      return response.data;
    },
    onSuccess: (data) => {
      setUpload(data);
      setMapping(
        Object.fromEntries(data.mapping.suggestions.map((s) => [s.csvColumn, s.leadField])),
      );
      if (data.mapping.detectedSourceHint) {
        setOptions((current) => ({ ...current, defaultSource: data.mapping.detectedSourceHint! }));
      }
      setStep('map');
    },
    onError: (error) =>
      toast(error instanceof ApiError ? error.message : 'Upload failed.', 'error'),
  });

  const handleFile = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      if (file.size > MAX_BYTES) {
        toast(`File is too large (max ${MAX_BYTES / 1024 / 1024} MB).`, 'error');
        return;
      }
      if (!/\.(csv|tsv|txt)$/i.test(file.name)) {
        toast('Please choose a .csv, .tsv or .txt file.', 'error');
        return;
      }
      uploadFile.mutate(file);
    },
    [toast, uploadFile],
  );

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    handleFile(event.dataTransfer.files[0]);
  };

  /* --- start ------------------------------------------------------------ */

  const startImport = useMutation({
    mutationFn: () =>
      api.post<{ importJobId: string }>(`/imports/${upload!.importJobId}/start`, {
        columnMapping: mapping,
        duplicateStrategy: options.duplicateStrategy,
        defaultSource: options.defaultSource,
        defaultOwnerId: options.defaultOwnerId || null,
        keepUnmappedAsCustomFields: options.keepUnmappedAsCustomFields,
        autoScore: options.autoScore,
      }),
    onSuccess: (result) => {
      setActiveJobId(result.importJobId);
      setStep('progress');
      void queryClient.invalidateQueries({ queryKey: ['imports'] });
    },
    onError: (error) =>
      toast(error instanceof ApiError ? error.message : 'Could not start the import.', 'error'),
  });

  /* --- progress polling ------------------------------------------------- */

  const job = useQuery({
    queryKey: ['import', activeJobId],
    queryFn: () => api.get<ImportJob>(`/imports/${activeJobId}`),
    enabled: activeJobId !== null,
    // Poll while running, stop once terminal. Polling forever would keep a tab
    // hitting the API indefinitely after the job has finished.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && TERMINAL_STATUSES.includes(status) ? false : 1_500;
    },
  });

  const jobErrors = useQuery({
    queryKey: ['import-errors', activeJobId],
    queryFn: () => api.get<ImportError[]>(`/imports/${activeJobId}/errors`, { limit: 20 }),
    enabled: Boolean(activeJobId) && (job.data?.errorCount ?? 0) > 0,
  });

  /* --- mapping validation ----------------------------------------------- */

  const mappedFields = useMemo(
    () => Object.values(mapping).filter((v): v is string => Boolean(v)),
    [mapping],
  );

  const duplicateTargets = useMemo(() => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const field of mappedFields) {
      if (seen.has(field)) dupes.add(field);
      seen.add(field);
    }
    return dupes;
  }, [mappedFields]);

  const hasIdentity = ['email', 'phone', 'fullName', 'firstName', 'lastName', 'company'].some((f) =>
    mappedFields.includes(f),
  );

  const canStart = hasIdentity && duplicateTargets.size === 0;

  const confidenceOf = (column: string): MappingSuggestion | undefined =>
    upload?.mapping.suggestions.find((s) => s.csvColumn === column);

  const reset = () => {
    setUpload(null);
    setMapping({});
    setActiveJobId(null);
    setStep('upload');
  };

  /* --- render ----------------------------------------------------------- */

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Import leads</h1>
        <p className="mt-1 text-sm text-muted">
          Upload a CSV from any source. AI maps the columns; you confirm before anything is written.
        </p>
      </div>

      {/* --- stepper ------------------------------------------------------ */}
      <ol className="flex items-center gap-2 text-sm">
        {(
          [
            ['upload', 'Upload'],
            ['map', 'Map columns'],
            ['progress', 'Import'],
          ] as const
        ).map(([key, label], index) => {
          const order = ['upload', 'map', 'progress'];
          const currentIndex = order.indexOf(step);
          const state = index < currentIndex ? 'done' : index === currentIndex ? 'active' : 'todo';

          return (
            <li key={key} className="flex flex-1 items-center gap-2">
              <span
                className={clsx(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                  state === 'active' && 'bg-brand text-brand-fg',
                  state === 'done' && 'bg-success/15 text-success',
                  state === 'todo' && 'bg-surface-2 text-muted',
                )}
                aria-current={state === 'active' ? 'step' : undefined}
              >
                {state === 'done' ? '✓' : index + 1}
              </span>
              <span className={clsx('truncate', state === 'todo' ? 'text-muted' : 'font-medium')}>{label}</span>
              {index < 2 && <span className="h-px flex-1 bg-border" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>

      {/* --- step 1: upload ----------------------------------------------- */}
      {step === 'upload' && (
        <>
          <Card>
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={clsx(
                'flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-16 text-center transition-colors',
                dragging ? 'border-brand bg-brand-soft' : 'border-border',
              )}
            >
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand-soft text-brand">
                <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
                </svg>
              </div>

              <p className="text-sm font-medium">Drop a CSV here, or</p>
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="mt-1 text-sm font-medium text-brand hover:underline"
              >
                browse your files
              </button>
              <p className="mt-3 text-xs text-muted">
                .csv, .tsv or .txt · up to 50 MB · comma, semicolon or tab delimited
              </p>

              <input
                ref={fileInput}
                type="file"
                accept=".csv,.tsv,.txt,text/csv"
                className="sr-only"
                onChange={(event) => handleFile(event.target.files?.[0])}
              />

              {uploadFile.isPending && (
                <div className="mt-6 w-full max-w-xs">
                  <ProgressBar value={70} />
                  <p className="mt-2 text-xs text-muted">Reading headers and proposing a mapping…</p>
                </div>
              )}
            </div>
          </Card>

          {/* Import history */}
          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold">Recent imports</h2>
            {history.isLoading ? (
              <Skeleton className="h-24" />
            ) : history.data && history.data.length > 0 ? (
              <div className="divide-y divide-border">
                {history.data.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveJobId(item.id);
                      setStep('progress');
                    }}
                    className="flex w-full items-center justify-between gap-4 py-2.5 text-left hover:bg-surface-2/60"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{item.filename}</div>
                      <div className="text-xs text-muted">
                        {formatRelative(item.createdAt)} · {formatNumber(item.createdCount)} created
                        {item.errorCount > 0 && ` · ${formatNumber(item.errorCount)} errors`}
                      </div>
                    </div>
                    <Badge
                      className={
                        item.status === 'COMPLETED'
                          ? 'bg-success/15 text-success'
                          : item.status === 'FAILED'
                            ? 'bg-danger/15 text-danger'
                            : item.status === 'COMPLETED_WITH_ERRORS'
                              ? 'bg-warning/15 text-warning'
                              : 'bg-surface-2 text-muted'
                      }
                    >
                      {humanise(item.status)}
                    </Badge>
                  </button>
                ))}
              </div>
            ) : (
              <EmptyState title="No imports yet" description="Your import history will appear here." />
            )}
          </Card>
        </>
      )}

      {/* --- step 2: mapping ---------------------------------------------- */}
      {step === 'map' && upload && (
        <>
          {upload.mapping.degraded && (
            <Banner tone="warning">
              <span>
                {upload.mapping.degradedReason ?? 'AI unavailable'} — columns were matched by name only.
                Please review the mapping carefully.
              </span>
            </Banner>
          )}

          <Card className="p-5">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold">{upload.filename}</h2>
                <p className="mt-0.5 text-xs text-muted">
                  {upload.preview.headers.length} columns · roughly{' '}
                  {formatNumber(upload.preview.estimatedRows)} rows · delimiter &ldquo;
                  {upload.preview.delimiter === '\t' ? 'tab' : upload.preview.delimiter}&rdquo;
                </p>
              </div>
              <Button variant="ghost" className="h-7 py-0 text-xs" onClick={reset}>
                Choose a different file
              </Button>
            </div>

            <div className="overflow-x-auto scroll-thin">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                    <th scope="col" className="px-2 pb-2 font-medium">CSV column</th>
                    <th scope="col" className="px-2 pb-2 font-medium">Sample value</th>
                    <th scope="col" className="px-2 pb-2 font-medium">Maps to</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {upload.preview.headers.map((header) => {
                    const suggestion = confidenceOf(header);
                    const target = mapping[header] ?? null;
                    const isDuplicate = target !== null && duplicateTargets.has(target);
                    const sample = upload.preview.sampleRows[0]?.[header] ?? '';

                    return (
                      <tr key={header}>
                        <td className="px-2 py-2.5">
                          <div className="font-medium">{header}</div>
                          {suggestion && suggestion.confidence > 0 && target && (
                            <div
                              className={clsx(
                                'text-xs',
                                suggestion.confidence >= 0.8
                                  ? 'text-success'
                                  : suggestion.confidence >= 0.5
                                    ? 'text-muted'
                                    : 'text-warning',
                              )}
                            >
                              {Math.round(suggestion.confidence * 100)}% confident
                              {suggestion.confidence < 0.5 && ' — please check'}
                            </div>
                          )}
                        </td>

                        <td className="max-w-[200px] px-2 py-2.5">
                          <span className="block truncate text-xs text-muted" title={sample}>
                            {sample || <em>empty</em>}
                          </span>
                        </td>

                        <td className="px-2 py-2.5">
                          <Select
                            value={target ?? ''}
                            onChange={(event) =>
                              setMapping((current) => ({
                                ...current,
                                [header]: event.target.value || null,
                              }))
                            }
                            className={clsx('h-9 py-0 text-sm', isDuplicate && 'border-danger')}
                            aria-label={`Map column ${header}`}
                          >
                            <option value="">
                              {options.keepUnmappedAsCustomFields ? 'Keep as custom field' : 'Ignore'}
                            </option>
                            {MAPPABLE_FIELDS.map((field) => (
                              <option key={field} value={field}>{FIELD_LABELS[field]}</option>
                            ))}
                          </Select>
                          {isDuplicate && (
                            <p className="mt-1 text-xs text-danger">
                              Another column already maps here
                            </p>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {!hasIdentity && (
              <div className="mt-4">
                <Banner tone="danger">
                  <span>
                    Map at least one identifying column — email, phone, a name or company — so leads can be
                    told apart and deduplicated.
                  </span>
                </Banner>
              </div>
            )}
          </Card>

          {/* Import options */}
          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold">Options</h2>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="dup-strategy">When a lead already exists</label>
                <Select
                  id="dup-strategy"
                  value={options.duplicateStrategy}
                  onChange={(event) =>
                    setOptions((c) => ({ ...c, duplicateStrategy: event.target.value as typeof c.duplicateStrategy }))
                  }
                >
                  <option value="SKIP">Skip it (keep what we have)</option>
                  <option value="UPDATE">Fill in blanks from the file</option>
                  <option value="CREATE_ANYWAY">Create a separate record</option>
                </Select>
                <p className="mt-1.5 text-xs text-muted">
                  {options.duplicateStrategy === 'SKIP' && 'Existing leads are left untouched.'}
                  {options.duplicateStrategy === 'UPDATE' &&
                    'Only fields present in the file are written — nothing is blanked out.'}
                  {options.duplicateStrategy === 'CREATE_ANYWAY' &&
                    'Will produce duplicates. Use only when you know the file has distinct people.'}
                </p>
              </div>

              <div>
                <label className="label" htmlFor="default-source">Default source</label>
                <Select
                  id="default-source"
                  value={options.defaultSource}
                  onChange={(event) => setOptions((c) => ({ ...c, defaultSource: event.target.value }))}
                >
                  {LEAD_SOURCES.map((source) => (
                    <option key={source} value={source}>{humanise(source)}</option>
                  ))}
                </Select>
                <p className="mt-1.5 text-xs text-muted">Applied to rows with no source column.</p>
              </div>

              <div>
                <label className="label" htmlFor="default-owner">Assign to</label>
                <Select
                  id="default-owner"
                  value={options.defaultOwnerId}
                  onChange={(event) => setOptions((c) => ({ ...c, defaultOwnerId: event.target.value }))}
                >
                  <option value="">Leave unassigned</option>
                  {members.data?.members.map((member) => (
                    <option key={member.id} value={member.id}>{member.name}</option>
                  ))}
                </Select>
              </div>

              <div className="space-y-3 pt-6">
                <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-border accent-[rgb(var(--brand))]"
                    checked={options.keepUnmappedAsCustomFields}
                    onChange={(event) =>
                      setOptions((c) => ({ ...c, keepUnmappedAsCustomFields: event.target.checked }))
                    }
                  />
                  <span>
                    Keep unmapped columns
                    <span className="block text-xs text-muted">
                      Stored as custom fields so no data is lost
                    </span>
                  </span>
                </label>

                <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-border accent-[rgb(var(--brand))]"
                    checked={options.autoScore}
                    onChange={(event) => setOptions((c) => ({ ...c, autoScore: event.target.checked }))}
                  />
                  <span>
                    Score with AI after import
                    <span className="block text-xs text-muted">
                      Runs in the background; leads are usable immediately
                    </span>
                  </span>
                </label>
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2 border-t border-border pt-4">
              <Button variant="secondary" onClick={reset}>
                Cancel
              </Button>
              <Button loading={startImport.isPending} disabled={!canStart} onClick={() => startImport.mutate()}>
                Import {formatNumber(upload.preview.estimatedRows)} rows
              </Button>
            </div>
          </Card>
        </>
      )}

      {/* --- step 3: progress --------------------------------------------- */}
      {step === 'progress' && activeJobId && (
        <Card className="p-6">
          {job.isLoading || !job.data ? (
            <Skeleton className="h-40" />
          ) : (
            <>
              <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold">{job.data.filename}</h2>
                  <p className="mt-0.5 text-sm text-muted">
                    {TERMINAL_STATUSES.includes(job.data.status)
                      ? `Finished ${formatRelative(job.data.completedAt)}`
                      : 'Processing — you can leave this page, it keeps running.'}
                  </p>
                </div>
                <Badge
                  className={
                    job.data.status === 'COMPLETED'
                      ? 'bg-success/15 text-success'
                      : job.data.status === 'FAILED'
                        ? 'bg-danger/15 text-danger'
                        : job.data.status === 'COMPLETED_WITH_ERRORS'
                          ? 'bg-warning/15 text-warning'
                          : 'bg-brand-soft text-brand'
                  }
                >
                  {humanise(job.data.status)}
                </Badge>
              </div>

              <ProgressBar value={job.data.progress} />
              <p className="mt-2 text-xs text-muted">
                {formatNumber(job.data.processedRows)} of {formatNumber(job.data.totalRows)} rows
                {' · '}
                {job.data.progress}%
              </p>

              <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  ['Created', job.data.createdCount, 'text-success'],
                  ['Updated', job.data.updatedCount, 'text-info'],
                  ['Skipped', job.data.skippedCount, 'text-muted'],
                  ['Errors', job.data.errorCount, 'text-danger'],
                ].map(([label, value, tone]) => (
                  <div key={label as string} className="rounded-lg bg-surface-2 p-3">
                    <div className="text-xs text-muted">{label as string}</div>
                    <div className={clsx('mt-0.5 text-xl font-semibold tabular-nums', tone as string)}>
                      {formatNumber(value as number)}
                    </div>
                  </div>
                ))}
              </div>

              {job.data.failureReason && (
                <div className="mt-4">
                  <Banner tone="danger">
                    <span>{job.data.failureReason}</span>
                  </Banner>
                </div>
              )}

              {/* Row errors, with the original row so the user can fix and re-upload. */}
              {jobErrors.data && jobErrors.data.length > 0 && (
                <div className="mt-6">
                  <h3 className="mb-2 text-sm font-semibold">
                    Rows that could not be imported
                    <span className="ml-1 font-normal text-muted">
                      (showing {jobErrors.data.length} of {formatNumber(job.data.errorCount)})
                    </span>
                  </h3>
                  <div className="max-h-64 overflow-y-auto scroll-thin rounded-lg border border-border">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-surface-2">
                        <tr className="text-left text-xs uppercase tracking-wide text-muted">
                          <th scope="col" className="px-3 py-2 font-medium">Row</th>
                          <th scope="col" className="px-3 py-2 font-medium">Problem</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {jobErrors.data.map((error) => (
                          <tr key={error.id}>
                            <td className="px-3 py-2 tabular-nums text-muted">{error.rowNumber}</td>
                            <td className="px-3 py-2">
                              {error.message}
                              {error.field && <span className="ml-1 text-xs text-muted">({error.field})</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="mt-6 flex flex-wrap justify-end gap-2 border-t border-border pt-4">
                <Button variant="secondary" onClick={reset}>
                  Import another file
                </Button>
                {job.data.createdCount > 0 && (
                  <Link href="/leads" className="btn-primary">
                    View imported leads
                  </Link>
                )}
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
