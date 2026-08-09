import {
  DEFAULT_CURRENCY,
  formatMoney,
  formatPercent,
  type MoneyInput,
  type RagStatus,
  type RiskSeverity,
} from '@ffp/shared';

/**
 * Money arrives from the API as a decimal string and is never turned into a
 * number for arithmetic. These wrappers only format, and they fail soft: a
 * missing or malformed value renders as an em dash rather than "NaN".
 */
export function money(
  value: MoneyInput | null | undefined,
  options: { currency?: string; compact?: boolean; accounting?: boolean; decimals?: number } = {},
): string {
  if (value === null || value === undefined || value === '') return '—';
  const { currency = DEFAULT_CURRENCY, compact = false, accounting = true, decimals } = options;
  try {
    return formatMoney(value, {
      currency,
      accountingNegatives: accounting,
      ...(compact
        ? { scaleUnit: 'millions' as const, minimumFractionDigits: 1, maximumFractionDigits: 1 }
        : {}),
      ...(decimals !== undefined
        ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
        : {}),
    });
  } catch {
    return '—';
  }
}

/** Whole-currency-unit variant for dense tables. */
export function money0(value: MoneyInput | null | undefined, currency = DEFAULT_CURRENCY): string {
  return money(value, { currency, decimals: 0 });
}

export function percent(
  value: MoneyInput | null | undefined,
  { fractionDigits = 1 }: { fractionDigits?: number } = {},
): string {
  if (value === null || value === undefined || value === '') return '—';
  try {
    return formatPercent(value, { fractionDigits });
  } catch {
    return '—';
  }
}

/** For metrics that are plain floats (MASE, correlations, scores). */
export function decimal(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

export function integer(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US').format(value);
}

/**
 * Charts need floats. Only ever used for plotting - never fed back into a
 * total, which is why it lives beside the formatters rather than in a helper
 * that looks like arithmetic.
 */
export function chartValue(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** SNAKE_CASE enum values into readable label text. */
export function humanise(value: string | null | undefined): string {
  if (!value) return '—';
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// --------------------------------------------------------------------------
// RAG and severity
//
// Red, amber and green are used ONLY here and in risk severity, so that a
// colour in this application always means the same thing. Every helper is
// paired with a text label, because colour is never the sole encoding.
// --------------------------------------------------------------------------

export const RAG_CLASSES: Record<RagStatus, string> = {
  GREEN: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  AMBER: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
  RED: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
};

export const RAG_LABELS: Record<RagStatus, string> = {
  GREEN: 'Green',
  AMBER: 'Amber',
  RED: 'Red',
};

export const SEVERITY_CLASSES: Record<RiskSeverity, string> = {
  LOW: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  MODERATE: 'bg-lime-100 text-lime-900 dark:bg-lime-950 dark:text-lime-300',
  HIGH: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
  SEVERE: 'bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-300',
  CRITICAL: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
};

/** Mirrors the engine's severity banding so the heat map agrees with the register. */
export function severityFor(score: number): RiskSeverity {
  if (score <= 3) return 'LOW';
  if (score <= 7) return 'MODERATE';
  if (score <= 12) return 'HIGH';
  if (score <= 19) return 'SEVERE';
  return 'CRITICAL';
}

export const PROBABILITY_LABELS: Record<number, string> = {
  1: 'Rare',
  2: 'Unlikely',
  3: 'Possible',
  4: 'Likely',
  5: 'Almost certain',
};

export const IMPACT_LABELS: Record<number, string> = {
  1: 'Insignificant',
  2: 'Minor',
  3: 'Moderate',
  4: 'Major',
  5: 'Catastrophic',
};

/** Neutral status pills - deliberately not RAG-coloured. */
export function statusClasses(status: string): string {
  switch (status) {
    case 'APPROVED':
    case 'LOCKED':
    case 'WON':
      return 'bg-accent-100 text-accent-800 dark:bg-accent-900/50 dark:text-accent-200';
    case 'SUBMITTED':
    case 'IN_REVIEW':
    case 'NEGOTIATION':
    case 'PROPOSAL':
      return 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200';
    case 'REJECTED':
    case 'LOST':
    case 'WITHDRAWN':
      return 'bg-slate-200 text-slate-600 line-through dark:bg-slate-800 dark:text-slate-400';
    default:
      return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
  }
}
