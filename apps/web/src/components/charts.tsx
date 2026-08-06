'use client';

/**
 * Charts, drawn as inline SVG.
 *
 * No charting library. These are four fixed, simple visualisations; a charting
 * dependency would add ~120 KB to the bundle and a second styling system to
 * keep in sync with the theme tokens. Hand-drawn SVG inherits `currentColor`
 * and the CSS variables, so dark mode works with no extra code.
 *
 * Each chart carries a table-equivalent for screen readers, because an SVG on
 * its own is unreadable to assistive tech.
 */
import { clsx } from 'clsx';
import { formatCompactCurrency, formatNumber, humanise } from '@/lib/format';
import type { FunnelData, ScoreBucket, TimeseriesPoint } from '@/lib/types';

/* -------------------------------------------------------------------------- */
/* Area chart — lead volume over time                                         */
/* -------------------------------------------------------------------------- */

export const VolumeChart = ({ data }: { data: TimeseriesPoint[] }) => {
  if (data.length === 0) {
    return <div className="flex h-52 items-center justify-center text-sm text-muted">No data yet</div>;
  }

  const width = 720;
  const height = 200;
  const padding = { top: 12, right: 8, bottom: 22, left: 8 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  // Never divide by zero, and give a flat series some vertical room.
  const max = Math.max(1, ...data.map((d) => d.created));
  const stepX = data.length > 1 ? innerW / (data.length - 1) : innerW;

  const pointAt = (index: number, value: number): [number, number] => [
    padding.left + index * stepX,
    padding.top + innerH - (value / max) * innerH,
  ];

  const line = data.map((d, i) => pointAt(i, d.created).join(',')).join(' L ');
  const area = `M ${padding.left},${padding.top + innerH} L ${line} L ${padding.left + (data.length - 1) * stepX},${padding.top + innerH} Z`;

  const total = data.reduce((sum, d) => sum + d.created, 0);
  const won = data.reduce((sum, d) => sum + d.won, 0);

  return (
    <figure>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-52 w-full text-brand"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Lead volume over ${data.length} days: ${total} created, ${won} won`}
      >
        <defs>
          <linearGradient id="volume-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Horizontal gridlines give the eye a scale reference. */}
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={fraction}
            x1={padding.left}
            x2={width - padding.right}
            y1={padding.top + innerH * fraction}
            y2={padding.top + innerH * fraction}
            className="stroke-border"
            strokeWidth="1"
            strokeDasharray="3 4"
          />
        ))}

        <path d={area} fill="url(#volume-fill)" />
        <path d={`M ${line}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />

        {/* Only label the first and last day — dense axis labels on a 90-day
            window are unreadable and add nothing. */}
        <text x={padding.left} y={height - 4} className="fill-current text-[10px] opacity-50">
          {data[0]?.date.slice(5)}
        </text>
        <text x={width - padding.right} y={height - 4} textAnchor="end" className="fill-current text-[10px] opacity-50">
          {data.at(-1)?.date.slice(5)}
        </text>
      </svg>

      <figcaption className="sr-only">
        <table>
          <caption>Leads created per day</caption>
          <tbody>
            {data.map((point) => (
              <tr key={point.date}>
                <th scope="row">{point.date}</th>
                <td>{point.created} created</td>
                <td>{point.won} won</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
};

/* -------------------------------------------------------------------------- */
/* Funnel                                                                     */
/* -------------------------------------------------------------------------- */

export const FunnelChart = ({ data }: { data: FunnelData }) => {
  const max = Math.max(1, ...data.stages.map((stage) => stage.count));

  return (
    <div className="space-y-2.5">
      {data.stages.map((stage) => (
        <div key={stage.status}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="font-medium">{humanise(stage.status)}</span>
            <span className="flex items-baseline gap-2">
              {stage.conversionFromPrevious !== null && (
                <span className="text-xs text-muted">{stage.conversionFromPrevious}% →</span>
              )}
              <span className="tabular-nums font-medium">{formatNumber(stage.count)}</span>
            </span>
          </div>
          <div className="h-6 overflow-hidden rounded-md bg-surface-2">
            <div
              className="flex h-full items-center justify-end rounded-md bg-brand/80 px-2 transition-[width] duration-500"
              style={{ width: `${Math.max(2, (stage.count / max) * 100)}%` }}
            >
              {stage.value > 0 && (
                <span className="text-[10px] font-medium text-brand-fg">
                  {formatCompactCurrency(stage.value)}
                </span>
              )}
            </div>
          </div>
        </div>
      ))}

      <div className="flex gap-4 border-t border-border pt-3 text-xs text-muted">
        <span>Lost: <strong className="text-fg">{formatNumber(data.lost)}</strong></span>
        <span>Disqualified: <strong className="text-fg">{formatNumber(data.disqualified)}</strong></span>
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Score histogram                                                            */
/* -------------------------------------------------------------------------- */

export const ScoreHistogram = ({ data }: { data: ScoreBucket[] }) => {
  const max = Math.max(1, ...data.map((bucket) => bucket.count));
  const total = data.reduce((sum, bucket) => sum + bucket.count, 0);

  if (total === 0) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-1 text-center text-sm text-muted">
        <span>No leads scored yet</span>
        <span className="text-xs">Run AI scoring to populate this chart</span>
      </div>
    );
  }

  const colourFor = (min: number) =>
    min >= 80 ? 'bg-emerald-500' : min >= 60 ? 'bg-sky-500' : min >= 35 ? 'bg-amber-500' : 'bg-rose-500';

  return (
    <div>
      <div className="flex h-40 items-end gap-1.5" role="img" aria-label="Distribution of lead scores">
        {data.map((bucket) => (
          <div key={bucket.range} className="group flex flex-1 flex-col items-center gap-1">
            <span className="text-[10px] tabular-nums text-muted opacity-0 transition-opacity group-hover:opacity-100">
              {bucket.count}
            </span>
            <div
              className={clsx('w-full rounded-t transition-all', colourFor(bucket.min))}
              style={{ height: `${Math.max(2, (bucket.count / max) * 100)}%` }}
              title={`${bucket.range}: ${bucket.count} leads`}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-1.5 text-[10px] text-muted">
        {data.map((bucket) => (
          <span key={bucket.range} className="flex-1 text-center">
            {bucket.min}
          </span>
        ))}
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Stat tile                                                                  */
/* -------------------------------------------------------------------------- */

export const StatCard = ({
  label,
  value,
  sublabel,
  tone = 'default',
}: {
  label: string;
  value: string;
  sublabel?: string;
  tone?: 'default' | 'success' | 'warning' | 'brand';
}) => {
  const tones = {
    default: 'text-fg',
    success: 'text-success',
    warning: 'text-warning',
    brand: 'text-brand',
  };

  return (
    <div className="card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={clsx('mt-1.5 text-2xl font-semibold tabular-nums', tones[tone])}>{value}</div>
      {sublabel && <div className="mt-0.5 text-xs text-muted">{sublabel}</div>}
    </div>
  );
};
