'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api-client';
import { formatCompactCurrency, formatNumber } from '@/lib/format';
import { useSession, useToast } from '@/components/providers';
import { Banner, Button, Card, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { FunnelChart, ScoreHistogram, StatCard, VolumeChart } from '@/components/charts';
import type {
  AiStatus,
  FunnelData,
  LeadStats,
  OwnerPerformance,
  ScoreBucket,
  ScoredLead,
  TimeseriesPoint,
} from '@/lib/types';

export default function DashboardPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { can } = useSession();
  const [days, setDays] = useState(30);

  const stats = useQuery({ queryKey: ['stats'], queryFn: () => api.get<LeadStats>('/leads/stats') });
  const funnel = useQuery({ queryKey: ['funnel'], queryFn: () => api.get<FunnelData>('/analytics/funnel') });
  const scores = useQuery({
    queryKey: ['score-distribution'],
    queryFn: () => api.get<ScoreBucket[]>('/analytics/score-distribution'),
  });
  const timeseries = useQuery({
    queryKey: ['timeseries', days],
    queryFn: () => api.get<TimeseriesPoint[]>('/analytics/timeseries', { days }),
  });
  const owners = useQuery({
    queryKey: ['by-owner'],
    queryFn: () => api.get<OwnerPerformance[]>('/analytics/by-owner'),
  });
  const aiStatus = useQuery({ queryKey: ['ai-status'], queryFn: () => api.get<AiStatus>('/ai/status') });

  /**
   * Scores the backlog of unscored leads. Deliberately capped at 50 per click:
   * it keeps the request inside a sane latency budget and gives the user
   * visible, incremental progress instead of one opaque three-minute wait.
   */
  const scoreLeads = useMutation({
    mutationFn: () => api.postWithMeta<{ scored: ScoredLead[] }>('/ai/score', { limit: 50 }),
    onSuccess: (response) => {
      const count = response.data.scored.length;
      if (count === 0) {
        toast('Every lead is already scored.', 'info');
      } else if (response.meta?.degraded) {
        toast(`Scored ${count} leads using rule-based fallback (${response.meta.degradedReason}).`, 'info');
      } else {
        toast(`Scored ${count} leads with AI.`, 'success');
      }
      void queryClient.invalidateQueries();
    },
    onError: (error) => {
      toast(error instanceof ApiError ? error.message : 'Scoring failed.', 'error');
    },
  });

  if (stats.isError) {
    return (
      <ErrorState
        message={stats.error instanceof ApiError ? stats.error.message : 'Could not load the dashboard.'}
        onRetry={() => void stats.refetch()}
      />
    );
  }

  const s = stats.data;
  const ai = aiStatus.data;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      {/* --- header ------------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted">Pipeline health at a glance.</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {can('MEMBER') && (
            <Button
              variant="secondary"
              loading={scoreLeads.isPending}
              onClick={() => scoreLeads.mutate()}
              disabled={s?.unscored === 0}
              icon={
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="m12 3 2.1 5.7 5.9.3-4.6 3.7 1.6 5.7L12 15.2 6.9 18.4l1.6-5.7L4 9l5.9-.3L12 3Z" />
                </svg>
              }
            >
              {s?.unscored ? `Score ${Math.min(s.unscored, 50)} leads` : 'All leads scored'}
            </Button>
          )}
          <Link href="/import" className="btn-primary">
            Import CSV
          </Link>
        </div>
      </div>

      {/* --- AI provenance banner ---------------------------------------- */}
      {ai && !ai.enabled && (
        <Banner tone="warning">
          <span>
            <strong>AI is not configured.</strong> Scoring, column mapping and natural-language search are
            running on deterministic rule-based fallbacks. Set <code>GEMINI_API_KEY</code> to enable the model.
          </span>
        </Banner>
      )}
      {ai?.enabled && !ai.available && (
        <Banner tone="warning">
          <span>
            The AI provider is currently unreachable — features are serving rule-based fallbacks until it
            recovers.
          </span>
        </Banner>
      )}

      {/* --- stat tiles --------------------------------------------------- */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {stats.isLoading
          ? Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[92px]" />)
          : s && (
              <>
                <StatCard label="Total leads" value={formatNumber(s.total)} sublabel={`${formatNumber(s.newLast30Days)} added in 30 days`} />
                <StatCard label="Pipeline value" value={formatCompactCurrency(s.pipelineValue)} tone="brand" />
                <StatCard
                  label="Average score"
                  value={s.averageScore !== null ? String(s.averageScore) : '—'}
                  sublabel={s.unscored > 0 ? `${formatNumber(s.unscored)} unscored` : 'All scored'}
                  tone={s.averageScore !== null && s.averageScore >= 60 ? 'success' : 'default'}
                />
                <StatCard label="Won" value={formatNumber(s.byStatus.WON)} tone="success" />
                <StatCard
                  label="Conversion"
                  value={`${s.conversionRate}%`}
                  sublabel="of closed leads"
                  tone={s.conversionRate >= 30 ? 'success' : 'warning'}
                />
              </>
            )}
      </div>

      {/* --- volume + funnel ---------------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Lead volume</h2>
            <div className="flex gap-1" role="group" aria-label="Time range">
              {[7, 30, 90].map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setDays(option)}
                  aria-pressed={days === option}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    days === option ? 'bg-brand-soft text-brand' : 'text-muted hover:bg-surface-2'
                  }`}
                >
                  {option}d
                </button>
              ))}
            </div>
          </div>
          {timeseries.isLoading ? (
            <Skeleton className="h-52" />
          ) : (
            <VolumeChart data={timeseries.data ?? []} />
          )}
        </Card>

        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold">Pipeline funnel</h2>
          {funnel.isLoading ? <Skeleton className="h-52" /> : funnel.data && <FunnelChart data={funnel.data} />}
        </Card>
      </div>

      {/* --- scores + leaderboard ----------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Score distribution</h2>
            {ai?.enabled && (
              <span className="text-xs text-muted">
                {formatNumber(ai.usedToday)} / {formatNumber(ai.dailyLimit)} AI calls today
              </span>
            )}
          </div>
          {scores.isLoading ? <Skeleton className="h-40" /> : <ScoreHistogram data={scores.data ?? []} />}
        </Card>

        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold">Performance by owner</h2>
          {owners.isLoading ? (
            <Skeleton className="h-40" />
          ) : owners.data && owners.data.length > 0 ? (
            <div className="-mx-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted">
                    <th scope="col" className="px-2 pb-2 font-medium">Owner</th>
                    <th scope="col" className="px-2 pb-2 text-right font-medium">Leads</th>
                    <th scope="col" className="px-2 pb-2 text-right font-medium">Won</th>
                    <th scope="col" className="px-2 pb-2 text-right font-medium">Win rate</th>
                    <th scope="col" className="px-2 pb-2 text-right font-medium">Avg score</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {owners.data.slice(0, 8).map((owner) => (
                    <tr key={owner.ownerId ?? 'unassigned'}>
                      <td className="px-2 py-2 font-medium">{owner.name}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatNumber(owner.total)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatNumber(owner.won)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{owner.winRate}%</td>
                      <td className="px-2 py-2 text-right tabular-nums">{owner.averageScore ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No leads yet" description="Import a CSV to get started." />
          )}
        </Card>
      </div>
    </div>
  );
}
