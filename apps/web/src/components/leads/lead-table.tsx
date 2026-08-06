'use client';

/**
 * The leads data grid.
 *
 * Presentational: it renders rows and reports interactions upward. All fetching,
 * filtering and mutation live in the page, which keeps this component testable
 * and prevents the table from acquiring its own private copy of the query state.
 */
import Link from 'next/link';
import { clsx } from 'clsx';
import { formatCompactCurrency, formatRelative, humanise, priorityStyles, scoreBarColor, scoreStyle, statusStyles } from '@/lib/format';
import { Badge, Skeleton } from '@/components/ui';
import type { Lead } from '@/lib/types';

export type SortField =
  | 'createdAt' | 'updatedAt' | 'score' | 'fullName' | 'company' | 'estimatedValue' | 'lastActivityAt';

interface Column {
  key: string;
  label: string;
  sortable?: SortField;
  className?: string;
}

const COLUMNS: Column[] = [
  { key: 'name', label: 'Lead', sortable: 'fullName' },
  { key: 'company', label: 'Company', sortable: 'company', className: 'hidden md:table-cell' },
  { key: 'status', label: 'Status' },
  { key: 'score', label: 'Score', sortable: 'score' },
  { key: 'value', label: 'Value', sortable: 'estimatedValue', className: 'hidden lg:table-cell' },
  { key: 'owner', label: 'Owner', className: 'hidden xl:table-cell' },
  { key: 'created', label: 'Added', sortable: 'createdAt', className: 'hidden sm:table-cell' },
];

/** Compact 0-100 bar. Communicates magnitude faster than a bare number. */
const ScoreCell = ({ score }: { score: number | null }) => {
  if (score === null) {
    return <span className="text-xs text-muted">Not scored</span>;
  }
  return (
    <div className="flex items-center gap-2">
      <span className={clsx('w-7 text-sm font-semibold tabular-nums', scoreStyle(score))}>{score}</span>
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-surface-2">
        <div className={clsx('h-full rounded-full', scoreBarColor(score))} style={{ width: `${score}%` }} />
      </div>
    </div>
  );
};

interface LeadTableProps {
  leads: Lead[];
  loading: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  sortBy: SortField;
  sortOrder: 'asc' | 'desc';
  onSort: (field: SortField) => void;
  selectable: boolean;
}

export const LeadTable = ({
  leads,
  loading,
  selected,
  onToggle,
  onToggleAll,
  sortBy,
  sortOrder,
  onSort,
  selectable,
}: LeadTableProps) => {
  const allSelected = leads.length > 0 && leads.every((lead) => selected.has(lead.id));
  const someSelected = leads.some((lead) => selected.has(lead.id));

  return (
    <div className="overflow-x-auto scroll-thin">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            {selectable && (
              <th scope="col" className="w-10 px-3 py-2.5">
                <input
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer rounded border-border accent-[rgb(var(--brand))]"
                  checked={allSelected}
                  // Indeterminate cannot be expressed as an attribute; the ref
                  // callback is the only way to set it.
                  ref={(node) => {
                    if (node) node.indeterminate = someSelected && !allSelected;
                  }}
                  onChange={onToggleAll}
                  aria-label="Select all leads on this page"
                />
              </th>
            )}
            {COLUMNS.map((column) => {
              const isSorted = column.sortable !== undefined && sortBy === column.sortable;
              return (
                <th
                  key={column.key}
                  scope="col"
                  className={clsx('px-3 py-2.5 font-medium', column.className)}
                  // `aria-sort` belongs on the header cell, not on the button
                  // inside it — the `columnheader` role is what carries sort
                  // state, and a `button` role does not support the attribute.
                  aria-sort={
                    column.sortable === undefined
                      ? undefined
                      : isSorted
                        ? sortOrder === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                  }
                >
                  {column.sortable ? (
                    <button
                      type="button"
                      onClick={() => onSort(column.sortable!)}
                      className="inline-flex items-center gap-1 hover:text-fg"
                    >
                      {column.label}
                      <span className={clsx('text-[10px]', isSorted ? 'text-brand' : 'opacity-30')} aria-hidden="true">
                        {isSorted ? (sortOrder === 'asc' ? '▲' : '▼') : '▼'}
                      </span>
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>

        <tbody className="divide-y divide-border">
          {loading
            ? Array.from({ length: 8 }, (_, i) => (
                <tr key={i}>
                  {selectable && <td className="px-3 py-3"><Skeleton className="h-4 w-4" /></td>}
                  {COLUMNS.map((column) => (
                    <td key={column.key} className={clsx('px-3 py-3', column.className)}>
                      <Skeleton className="h-4 w-full max-w-32" />
                    </td>
                  ))}
                </tr>
              ))
            : leads.map((lead) => {
                const isSelected = selected.has(lead.id);
                return (
                  <tr
                    key={lead.id}
                    className={clsx('transition-colors', isSelected ? 'bg-brand-soft/50' : 'hover:bg-surface-2/60')}
                  >
                    {selectable && (
                      <td className="px-3 py-2.5">
                        <input
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer rounded border-border accent-[rgb(var(--brand))]"
                          checked={isSelected}
                          onChange={() => onToggle(lead.id)}
                          aria-label={`Select ${lead.fullName}`}
                        />
                      </td>
                    )}

                    <td className="px-3 py-2.5">
                      <Link href={`/leads/${lead.id}`} className="group block min-w-0">
                        <div className="truncate font-medium text-fg group-hover:text-brand group-hover:underline">
                          {lead.fullName}
                        </div>
                        <div className="truncate text-xs text-muted">
                          {lead.email ?? lead.phone ?? 'No contact details'}
                        </div>
                      </Link>
                    </td>

                    <td className="hidden px-3 py-2.5 md:table-cell">
                      <div className="truncate">{lead.company ?? '—'}</div>
                      {lead.jobTitle && <div className="truncate text-xs text-muted">{lead.jobTitle}</div>}
                    </td>

                    <td className="px-3 py-2.5">
                      <Badge className={statusStyles[lead.status]}>{humanise(lead.status)}</Badge>
                      {lead.priority !== 'MEDIUM' && (
                        <Badge className={clsx('ml-1 hidden lg:inline-flex', priorityStyles[lead.priority])}>
                          {humanise(lead.priority)}
                        </Badge>
                      )}
                    </td>

                    <td className="px-3 py-2.5">
                      <ScoreCell score={lead.score} />
                    </td>

                    <td className="hidden px-3 py-2.5 tabular-nums lg:table-cell">
                      {lead.estimatedValue ? formatCompactCurrency(lead.estimatedValue) : '—'}
                    </td>

                    <td className="hidden px-3 py-2.5 xl:table-cell">
                      {lead.owner ? (
                        <span className="truncate text-xs">{lead.owner.name}</span>
                      ) : (
                        <span className="text-xs text-muted">Unassigned</span>
                      )}
                    </td>

                    <td className="hidden whitespace-nowrap px-3 py-2.5 text-xs text-muted sm:table-cell">
                      {formatRelative(lead.createdAt)}
                    </td>
                  </tr>
                );
              })}
        </tbody>
      </table>
    </div>
  );
};
