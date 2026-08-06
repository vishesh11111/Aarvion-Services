/**
 * Display formatting.
 *
 * Centralised so a lead score renders identically in the table, the detail page
 * and the dashboard — inconsistent formatting of the same value across screens
 * reads as a bug to users even when the data is correct.
 */
import type { LeadPriority, LeadStatus } from './types';

/** Locale-aware, but with a fixed currency so totals never silently change unit. */
export const formatCurrency = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
};

export const formatCompactCurrency = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
};

export const formatNumber = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : new Intl.NumberFormat('en-US').format(value);

export const formatDate = (value: string | Date | null | undefined): string => {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date(value));
};

export const formatDateTime = (value: string | Date | null | undefined): string => {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
};

/**
 * "3 days ago". Uses Intl.RelativeTimeFormat rather than a date library — it is
 * built in, localised, and this is the only relative formatting the app needs.
 */
export const formatRelative = (value: string | Date | null | undefined): string => {
  if (!value) return '—';
  const then = new Date(value).getTime();
  const seconds = Math.round((then - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });

  const thresholds: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 30],
    ['month', 12],
    ['year', Number.POSITIVE_INFINITY],
  ];

  let duration = seconds;
  for (const [unit, limit] of thresholds) {
    if (Math.abs(duration) < limit) return formatter.format(Math.round(duration), unit);
    duration /= limit;
  }
  return formatter.format(Math.round(duration), 'year');
};

/** Enum values are SCREAMING_SNAKE on the wire; humans read Title Case. */
export const humanise = (value: string): string =>
  value
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

export const initials = (name: string): string =>
  name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?';

/* -------------------------------------------------------------------------- */
/* Semantic colour mapping                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Colour classes for pipeline stages.
 *
 * Colour is never the *only* signal — every badge also carries its label — so
 * the UI stays readable for colour-blind users and in greyscale print.
 */
export const statusStyles: Record<LeadStatus, string> = {
  NEW: 'bg-slate-500/12 text-slate-600 dark:text-slate-300',
  CONTACTED: 'bg-sky-500/12 text-sky-700 dark:text-sky-300',
  QUALIFIED: 'bg-violet-500/12 text-violet-700 dark:text-violet-300',
  PROPOSAL: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  WON: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  LOST: 'bg-rose-500/12 text-rose-700 dark:text-rose-300',
  DISQUALIFIED: 'bg-zinc-500/12 text-zinc-600 dark:text-zinc-400',
};

export const priorityStyles: Record<LeadPriority, string> = {
  LOW: 'bg-slate-500/12 text-slate-600 dark:text-slate-300',
  MEDIUM: 'bg-sky-500/12 text-sky-700 dark:text-sky-300',
  HIGH: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  URGENT: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
};

/** Score bands. Thresholds mirror the API's priority mapping, deliberately. */
export const scoreStyle = (score: number | null): string => {
  if (score === null) return 'text-muted';
  if (score >= 80) return 'text-emerald-600 dark:text-emerald-400';
  if (score >= 60) return 'text-sky-600 dark:text-sky-400';
  if (score >= 35) return 'text-amber-600 dark:text-amber-400';
  return 'text-rose-600 dark:text-rose-400';
};

export const scoreBarColor = (score: number | null): string => {
  if (score === null) return 'bg-border';
  if (score >= 80) return 'bg-emerald-500';
  if (score >= 60) return 'bg-sky-500';
  if (score >= 35) return 'bg-amber-500';
  return 'bg-rose-500';
};
