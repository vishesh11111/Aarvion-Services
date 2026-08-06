'use client';

/**
 * Leads workspace.
 *
 * Owns all query state (filters, sort, pagination, selection) and passes it
 * down. Filters live in component state rather than the URL for one honest
 * reason: the filter surface is wide enough that URL-encoding it would produce
 * unreadable links, and the AI search already gives users a shareable way to
 * express intent. Sharing a saved view is the right fix, not a 400-character
 * query string.
 */
import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, downloadCsv } from '@/lib/api-client';
import { formatNumber, humanise } from '@/lib/format';
import { useSession, useToast } from '@/components/providers';
import { Button, Card, EmptyState, ErrorState, Input, Select } from '@/components/ui';
import { LeadTable, type SortField } from '@/components/leads/lead-table';
import { AiSearch } from '@/components/leads/ai-search';
import { CreateLeadModal } from '@/components/leads/create-lead-modal';
import {
  LEAD_PRIORITIES,
  LEAD_SOURCES,
  LEAD_STATUSES,
  type AiStatus,
  type Lead,
  type LeadStatus,
  type User,
} from '@/lib/types';

interface Filters {
  q: string;
  status: LeadStatus[];
  source: string[];
  priority: string[];
  ownerId: string;
  unassigned: boolean;
  minScore: string;
}

const EMPTY_FILTERS: Filters = {
  q: '',
  status: [],
  source: [],
  priority: [],
  ownerId: '',
  unassigned: false,
  minScore: '',
};

const PAGE_SIZE = 25;

interface AiSearchResult {
  leads: Lead[];
  interpretation?: string | undefined;
  appliedFilters?: Record<string, unknown> | undefined;
  degraded?: boolean | undefined;
  degradedReason?: string | undefined;
}

export default function LeadsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { can } = useSession();

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [sortBy, setSortBy] = useState<SortField>('createdAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [aiResult, setAiResult] = useState<AiSearchResult | null>(null);

  const canWrite = can('MEMBER');

  /* --- queries ---------------------------------------------------------- */

  const queryParams = useMemo(
    () => ({
      ...(filters.q ? { q: filters.q } : {}),
      ...(filters.status.length ? { status: filters.status } : {}),
      ...(filters.source.length ? { source: filters.source } : {}),
      ...(filters.priority.length ? { priority: filters.priority } : {}),
      ...(filters.unassigned ? { unassigned: true } : filters.ownerId ? { ownerId: filters.ownerId } : {}),
      ...(filters.minScore ? { minScore: Number(filters.minScore) } : {}),
      sortBy,
      sortOrder,
      page,
      limit: PAGE_SIZE,
    }),
    [filters, sortBy, sortOrder, page],
  );

  const leadsQuery = useQuery({
    queryKey: ['leads', queryParams],
    queryFn: () => api.getWithMeta<Lead[]>('/leads', queryParams),
    // Keeps the previous page visible while the next one loads, so paginating
    // does not flash an empty table.
    placeholderData: keepPreviousData,
    // Not fetched at all while AI results are on screen.
    enabled: aiResult === null,
  });

  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api.get<{ members: User[] }>('/auth/members'),
    staleTime: 5 * 60_000,
  });

  const aiStatus = useQuery({ queryKey: ['ai-status'], queryFn: () => api.get<AiStatus>('/ai/status') });

  /* --- mutations -------------------------------------------------------- */

  const aiSearch = useMutation({
    mutationFn: (query: string) => api.postWithMeta<Lead[]>('/ai/search', { query }),
    onSuccess: (response) => {
      setSelected(new Set());
      setAiResult({
        leads: response.data,
        interpretation: response.meta?.interpretation,
        appliedFilters: response.meta?.appliedFilters,
        degraded: response.meta?.degraded,
        degradedReason: response.meta?.degradedReason,
      });
    },
    onError: (error) =>
      toast(error instanceof ApiError ? error.message : 'Search failed.', 'error'),
  });

  const bulkUpdate = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.patch<{ updated: number }>('/leads/bulk', { leadIds: [...selected], patch }),
    onSuccess: (result) => {
      toast(`Updated ${result.updated} lead${result.updated === 1 ? '' : 's'}.`, 'success');
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
    onError: (error) => toast(error instanceof ApiError ? error.message : 'Update failed.', 'error'),
  });

  const bulkDelete = useMutation({
    mutationFn: () => api.post<{ deleted: number }>('/leads/bulk-delete', { leadIds: [...selected] }),
    onSuccess: (result) => {
      toast(`Deleted ${result.deleted} lead${result.deleted === 1 ? '' : 's'}.`, 'success');
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
    onError: (error) => toast(error instanceof ApiError ? error.message : 'Delete failed.', 'error'),
  });

  const scoreSelected = useMutation({
    mutationFn: () => api.postWithMeta<{ scored: unknown[] }>('/ai/score', { leadIds: [...selected], force: true }),
    onSuccess: (response) => {
      toast(
        response.meta?.degraded
          ? `Scored ${response.data.scored.length} leads (rule-based fallback).`
          : `Scored ${response.data.scored.length} leads with AI.`,
        response.meta?.degraded ? 'info' : 'success',
      );
      setSelected(new Set());
      void queryClient.invalidateQueries();
    },
    onError: (error) => toast(error instanceof ApiError ? error.message : 'Scoring failed.', 'error'),
  });

  /* --- derived ---------------------------------------------------------- */

  const leads = aiResult ? aiResult.leads : (leadsQuery.data?.data ?? []);
  const meta = leadsQuery.data?.meta;
  const total = meta?.total;
  const totalPages = total !== undefined ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : undefined;

  const activeFilterCount =
    (filters.status.length ? 1 : 0) +
    (filters.source.length ? 1 : 0) +
    (filters.priority.length ? 1 : 0) +
    (filters.ownerId || filters.unassigned ? 1 : 0) +
    (filters.minScore ? 1 : 0);

  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
    setSelected(new Set());
  };

  const toggleMulti = (key: 'status' | 'source' | 'priority', value: string) => {
    const current = filters[key] as string[];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    setFilter(key, next as never);
  };

  const handleSort = (field: SortField) => {
    if (sortBy === field) setSortOrder((order) => (order === 'asc' ? 'desc' : 'asc'));
    else {
      setSortBy(field);
      setSortOrder('desc');
    }
    setPage(1);
  };

  const toggleSelected = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected((current) => {
      const allOnPage = leads.every((lead) => current.has(lead.id));
      if (allOnPage) return new Set();
      return new Set(leads.map((lead) => lead.id));
    });

  const exportCsv = async () => {
    try {
      await downloadCsv({ ...queryParams, page: undefined, limit: 10_000 });
      toast('Export started.', 'success');
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Export failed.', 'error');
    }
  };

  /* --- render ----------------------------------------------------------- */

  if (leadsQuery.isError) {
    return (
      <ErrorState
        message={leadsQuery.error instanceof ApiError ? leadsQuery.error.message : 'Could not load leads.'}
        onRetry={() => void leadsQuery.refetch()}
      />
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Leads</h1>
          <p className="mt-1 text-sm text-muted">
            {aiResult
              ? `${leads.length} result${leads.length === 1 ? '' : 's'} from AI search`
              : total !== undefined
                ? `${formatNumber(total)}${meta?.totalIsApproximate ? '+' : ''} lead${total === 1 ? '' : 's'}`
                : 'Loading…'}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={exportCsv}>
            Export CSV
          </Button>
          {canWrite && <Button onClick={() => setCreateOpen(true)}>New lead</Button>}
        </div>
      </div>

      {/* --- AI search ---------------------------------------------------- */}
      <Card className="p-4">
        <AiSearch
          available={aiStatus.data?.available ?? false}
          loading={aiSearch.isPending}
          onSearch={(query) => aiSearch.mutate(query)}
          onClear={() => {
            setAiResult(null);
            setSelected(new Set());
          }}
          result={
            aiResult
              ? {
                  interpretation: aiResult.interpretation,
                  appliedFilters: aiResult.appliedFilters,
                  degraded: aiResult.degraded,
                  degradedReason: aiResult.degradedReason,
                  resultCount: aiResult.leads.length,
                }
              : undefined
          }
        />
      </Card>

      {/* --- manual filters ----------------------------------------------- */}
      {!aiResult && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={filters.q}
              onChange={(event) => setFilter('q', event.target.value)}
              placeholder="Search name, email, company…"
              className="max-w-xs flex-1"
              aria-label="Search leads"
            />

            <Button variant="secondary" onClick={() => setShowFilters((open) => !open)}>
              Filters{activeFilterCount > 0 && ` (${activeFilterCount})`}
            </Button>

            {activeFilterCount > 0 && (
              <Button variant="ghost" onClick={() => setFilters({ ...EMPTY_FILTERS, q: filters.q })}>
                Clear
              </Button>
            )}
          </div>

          {showFilters && (
            <div className="mt-4 grid gap-4 border-t border-border pt-4 md:grid-cols-2 lg:grid-cols-4">
              <div>
                <span className="label">Status</span>
                <div className="flex flex-wrap gap-1.5">
                  {LEAD_STATUSES.map((status) => (
                    <button
                      key={status}
                      type="button"
                      onClick={() => toggleMulti('status', status)}
                      aria-pressed={filters.status.includes(status)}
                      className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                        filters.status.includes(status)
                          ? 'border-brand bg-brand-soft text-brand'
                          : 'border-border text-muted hover:text-fg'
                      }`}
                    >
                      {humanise(status)}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className="label">Priority</span>
                <div className="flex flex-wrap gap-1.5">
                  {LEAD_PRIORITIES.map((priority) => (
                    <button
                      key={priority}
                      type="button"
                      onClick={() => toggleMulti('priority', priority)}
                      aria-pressed={filters.priority.includes(priority)}
                      className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                        filters.priority.includes(priority)
                          ? 'border-brand bg-brand-soft text-brand'
                          : 'border-border text-muted hover:text-fg'
                      }`}
                    >
                      {humanise(priority)}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="label" htmlFor="filter-owner">Owner</label>
                <Select
                  id="filter-owner"
                  value={filters.unassigned ? '__unassigned' : filters.ownerId}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === '__unassigned') {
                      setFilters((c) => ({ ...c, unassigned: true, ownerId: '' }));
                    } else {
                      setFilters((c) => ({ ...c, unassigned: false, ownerId: value }));
                    }
                    setPage(1);
                  }}
                >
                  <option value="">Anyone</option>
                  <option value="__unassigned">Unassigned</option>
                  {members.data?.members.map((member) => (
                    <option key={member.id} value={member.id}>{member.name}</option>
                  ))}
                </Select>
              </div>

              <div>
                <label className="label" htmlFor="filter-source">Source</label>
                <Select
                  id="filter-source"
                  value={filters.source[0] ?? ''}
                  onChange={(event) =>
                    setFilter('source', event.target.value ? [event.target.value] : [])
                  }
                >
                  <option value="">Any source</option>
                  {LEAD_SOURCES.map((source) => (
                    <option key={source} value={source}>{humanise(source)}</option>
                  ))}
                </Select>
              </div>

              <div>
                <label className="label" htmlFor="filter-score">Minimum score</label>
                <Input
                  id="filter-score"
                  type="number"
                  min={0}
                  max={100}
                  value={filters.minScore}
                  onChange={(event) => setFilter('minScore', event.target.value)}
                  placeholder="e.g. 70"
                />
              </div>
            </div>
          )}
        </Card>
      )}

      {/* --- bulk action bar ---------------------------------------------- */}
      {selected.size > 0 && canWrite && (
        <div className="sticky top-16 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-brand/30 bg-brand-soft px-3 py-2 shadow-card">
          <span className="text-sm font-medium text-brand">
            {selected.size} selected
          </span>

          <Select
            className="h-8 w-auto py-0 text-xs"
            value=""
            onChange={(event) => {
              if (event.target.value) bulkUpdate.mutate({ status: event.target.value });
              event.target.value = '';
            }}
            aria-label="Set status for selected leads"
          >
            <option value="">Set status…</option>
            {LEAD_STATUSES.map((status) => (
              <option key={status} value={status}>{humanise(status)}</option>
            ))}
          </Select>

          <Button variant="secondary" className="h-8 py-0 text-xs" loading={scoreSelected.isPending} onClick={() => scoreSelected.mutate()}>
            Score with AI
          </Button>

          <Button
            variant="danger"
            className="h-8 py-0 text-xs"
            loading={bulkDelete.isPending}
            onClick={() => {
              if (window.confirm(`Delete ${selected.size} lead(s)? They can be restored for 30 days.`)) {
                bulkDelete.mutate();
              }
            }}
          >
            Delete
          </Button>

          <Button variant="ghost" className="ml-auto h-8 py-0 text-xs" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </div>
      )}

      {/* --- table -------------------------------------------------------- */}
      <Card>
        {!leadsQuery.isLoading && leads.length === 0 ? (
          <EmptyState
            title={aiResult || activeFilterCount > 0 || filters.q ? 'No leads match' : 'No leads yet'}
            description={
              aiResult || activeFilterCount > 0 || filters.q
                ? 'Try widening your filters or clearing the search.'
                : 'Import a CSV or create your first lead to get started.'
            }
            action={
              canWrite ? (
                <div className="flex gap-2">
                  <Button onClick={() => setCreateOpen(true)}>New lead</Button>
                  <a href="/import" className="btn-secondary">Import CSV</a>
                </div>
              ) : undefined
            }
          />
        ) : (
          <LeadTable
            leads={leads}
            loading={leadsQuery.isLoading && !aiResult}
            selected={selected}
            onToggle={toggleSelected}
            onToggleAll={toggleAll}
            sortBy={sortBy}
            sortOrder={sortOrder}
            onSort={handleSort}
            selectable={canWrite}
          />
        )}

        {/* Pagination is meaningless over an AI result set, which is a single
            ranked page by design. */}
        {!aiResult && leads.length > 0 && (
          <div className="flex items-center justify-between border-t border-border px-4 py-3 text-sm">
            <span className="text-muted">
              Page {page}
              {totalPages !== undefined && ` of ${totalPages}${meta?.totalIsApproximate ? '+' : ''}`}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="h-8 py-0 text-xs"
                disabled={page === 1}
                onClick={() => {
                  setPage((p) => Math.max(1, p - 1));
                  setSelected(new Set());
                }}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                className="h-8 py-0 text-xs"
                disabled={!meta?.hasMore}
                onClick={() => {
                  setPage((p) => p + 1);
                  setSelected(new Set());
                }}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>

      <CreateLeadModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
