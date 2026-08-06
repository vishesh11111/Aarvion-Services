'use client';

/**
 * Natural-language search.
 *
 * The design principle here: **the AI is never a black box**. Whatever filters
 * the model produces are shown back to the user as removable chips, and the
 * interpretation is stated in plain English. If the model gets it wrong, the
 * user can see exactly how and fix it — instead of concluding the search is
 * broken.
 */
import { useState, type FormEvent } from 'react';
import { clsx } from 'clsx';
import { humanise } from '@/lib/format';
import { Banner, Button, Input } from '@/components/ui';

const EXAMPLES = [
  'hot leads from last month with no owner',
  'qualified fintech contacts in Germany',
  'unscored leads from referrals',
  'proposals over $50k',
];

interface AiSearchProps {
  onSearch: (query: string) => void;
  onClear: () => void;
  loading: boolean;
  /** Present after a search has run. */
  result?: {
    interpretation?: string | undefined;
    appliedFilters?: Record<string, unknown> | undefined;
    degraded?: boolean | undefined;
    degradedReason?: string | undefined;
    resultCount: number;
  } | undefined;
  available: boolean;
}

const formatFilterValue = (value: unknown): string => {
  if (Array.isArray(value)) return value.map((v) => humanise(String(v))).join(', ');
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return String(value);
};

const FILTER_LABELS: Record<string, string> = {
  q: 'Text',
  status: 'Status',
  source: 'Source',
  priority: 'Priority',
  tags: 'Tags',
  minScore: 'Min score',
  maxScore: 'Max score',
  createdAfter: 'Created after',
  createdBefore: 'Created before',
  unassigned: 'Unassigned',
  sortBy: 'Sorted by',
  sortOrder: 'Order',
};

export const AiSearch = ({ onSearch, onClear, loading, result, available }: AiSearchProps) => {
  const [query, setQuery] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length >= 3) onSearch(trimmed);
  };

  const clear = () => {
    setQuery('');
    onClear();
  };

  const filterEntries = Object.entries(result?.appliedFilters ?? {}).filter(
    ([, value]) => value !== undefined && value !== null && value !== '',
  );

  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="flex gap-2">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-brand">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="m12 3 2.1 5.7 5.9.3-4.6 3.7 1.6 5.7L12 15.2 6.9 18.4l1.6-5.7L4 9l5.9-.3L12 3Z" />
            </svg>
          </span>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              available
                ? 'Ask in plain English — "hot leads from last month with no owner"'
                : 'Keyword search (AI unavailable)'
            }
            className="pl-9"
            aria-label="Natural language lead search"
            minLength={3}
          />
        </div>
        <Button type="submit" loading={loading} disabled={query.trim().length < 3}>
          Search
        </Button>
        {result && (
          <Button type="button" variant="secondary" onClick={clear}>
            Clear
          </Button>
        )}
      </form>

      {/* Example prompts — an empty text box gives the user no idea what this
          feature can actually do. */}
      {!result && (
        <div className="flex flex-wrap gap-1.5">
          <span className="py-1 text-xs text-muted">Try:</span>
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setQuery(example);
                onSearch(example);
              }}
              className="rounded-full border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:border-brand hover:text-brand"
            >
              {example}
            </button>
          ))}
        </div>
      )}

      {result && (
        <div className="space-y-2">
          {result.degraded && (
            <Banner tone="warning">
              <span>
                {result.degradedReason ?? 'AI unavailable'} — these results come from keyword matching, not the
                model.
              </span>
            </Banner>
          )}

          <div className="rounded-lg border border-border bg-surface-2/60 px-3 py-2.5">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className={clsx('text-xs font-medium', result.degraded ? 'text-warning' : 'text-brand')}>
                {result.degraded ? 'Keyword match' : 'AI interpreted'}:
              </span>
              <span className="text-sm">{result.interpretation}</span>
              <span className="text-xs text-muted">· {result.resultCount} result{result.resultCount === 1 ? '' : 's'}</span>
            </div>

            {filterEntries.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {filterEntries.map(([key, value]) => (
                  <span
                    key={key}
                    className="inline-flex items-center gap-1 rounded-md bg-surface px-2 py-0.5 text-xs"
                  >
                    <span className="text-muted">{FILTER_LABELS[key] ?? key}:</span>
                    <span className="font-medium">{formatFilterValue(value)}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
