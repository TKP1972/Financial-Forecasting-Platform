import type { RagStatus, RiskSeverity } from '@ffp/shared';
import { useId, type ReactNode } from 'react';
import { errorMessage } from '@/lib/api';
import { RAG_CLASSES, RAG_LABELS, SEVERITY_CLASSES, humanise, statusClasses } from '@/lib/format';

// --------------------------------------------------------------------------
// Page furniture
// --------------------------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-0.5 max-w-3xl text-xs text-slate-600 dark:text-slate-400">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = '',
  bodyClassName = 'p-4',
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {title ? (
        <div className="card-header">
          <div>
            <h2 className="card-title">{title}</h2>
            {subtitle ? <p className="card-subtitle mt-0.5">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

// --------------------------------------------------------------------------
// States
// --------------------------------------------------------------------------

export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function LoadingCard({ rows = 4, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="card p-4" role="status" aria-live="polite">
      <span className="sr-only">{label}…</span>
      <Skeleton className="mb-3 h-4 w-40" />
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, index) => (
          <Skeleton key={index} className={`h-3 ${index % 3 === 0 ? 'w-11/12' : 'w-full'}`} />
        ))}
      </div>
    </div>
  );
}

export function LoadingTable({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="p-4" role="status" aria-live="polite">
      <span className="sr-only">Loading table data…</span>
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex gap-3">
            {Array.from({ length: columns }).map((__, c) => (
              <Skeleton key={c} className={`h-3 ${c === 0 ? 'w-1/3' : 'flex-1'}`} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{title}</p>
      <p className="max-w-md text-xs text-slate-600 dark:text-slate-400">{description}</p>
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300"
    >
      <p className="font-semibold">Could not load this data</p>
      <p className="mt-1">{errorMessage(error)}</p>
      {onRetry ? (
        <button type="button" className="btn btn-secondary mt-2" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function InlineNote({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'warning';
}) {
  const classes =
    tone === 'warning'
      ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200'
      : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-300';
  return <div className={`rounded-md border px-3 py-2 text-xs ${classes}`}>{children}</div>;
}

// --------------------------------------------------------------------------
// Pills
//
// Every coloured pill also carries its label as text, so the meaning survives
// greyscale printing and colour-vision deficiency.
// --------------------------------------------------------------------------

export function RagPill({ rag }: { rag: RagStatus }) {
  return <span className={`pill ${RAG_CLASSES[rag]}`}>{RAG_LABELS[rag]}</span>;
}

export function SeverityPill({ severity }: { severity: RiskSeverity }) {
  return <span className={`pill ${SEVERITY_CLASSES[severity]}`}>{humanise(severity)}</span>;
}

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill ${statusClasses(status)}`}>{humanise(status)}</span>;
}

// --------------------------------------------------------------------------
// Form controls - every one is labelled.
// --------------------------------------------------------------------------

function useFieldId(explicit?: string): string {
  const generated = useId();
  return explicit ?? generated;
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
  className = '',
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 text-2xs text-slate-600 dark:text-slate-400">{hint}</p> : null}
    </div>
  );
}

export function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  hint,
  disabled,
  className = '',
}: {
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  hint?: string;
  disabled?: boolean;
  className?: string;
}) {
  const fieldId = useFieldId(id);
  return (
    <Field label={label} htmlFor={fieldId} hint={hint} className={className}>
      <select
        id={fieldId}
        className="input"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  step,
  hint,
  className = '',
}: {
  id?: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  className?: string;
}) {
  const fieldId = useFieldId(id);
  return (
    <Field label={label} htmlFor={fieldId} hint={hint} className={className}>
      <input
        id={fieldId}
        type="number"
        className="input num"
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </Field>
  );
}

export function TextField({
  id,
  label,
  value,
  onChange,
  hint,
  placeholder,
  className = '',
  inputClassName = 'input',
}: {
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
}) {
  const fieldId = useFieldId(id);
  return (
    <Field label={label} htmlFor={fieldId} hint={hint} className={className}>
      <input
        id={fieldId}
        type="text"
        className={inputClassName}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

// --------------------------------------------------------------------------
// Tabs
// --------------------------------------------------------------------------

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: Array<{ id: T; label: string }>;
  active: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="mb-4 flex gap-1 border-b border-slate-200 dark:border-slate-800"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={isActive}
            aria-controls={`panel-${tab.id}`}
            onClick={() => onChange(tab.id)}
            className={`-mb-px rounded-t-md border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
              isActive
                ? 'border-accent-600 text-accent-700 dark:border-accent-400 dark:text-accent-300'
                : 'border-transparent text-slate-600 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`}>
      {children}
    </div>
  );
}

// --------------------------------------------------------------------------
// KPI tile
// --------------------------------------------------------------------------

export function StatTile({
  label,
  value,
  caption,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  caption?: string;
  tone?: 'neutral' | 'accent';
}) {
  return (
    <div className="card px-4 py-3">
      <p className="text-2xs font-medium uppercase tracking-wide text-slate-600 dark:text-slate-400">
        {label}
      </p>
      <p
        className={`mt-1 text-xl font-semibold tabular-nums tracking-tight ${
          tone === 'accent'
            ? 'text-accent-700 dark:text-accent-300'
            : 'text-slate-900 dark:text-slate-50'
        }`}
      >
        {value}
      </p>
      {caption ? (
        <p className="mt-0.5 text-2xs text-slate-600 dark:text-slate-400">{caption}</p>
      ) : null}
    </div>
  );
}

/** A labelled horizontal progress meter. The number is always shown as text. */
export function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-slate-600 dark:text-slate-300">{label}</span>
        <span className="font-semibold tabular-nums">{(pct * 100).toFixed(0)}%</span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
        role="progressbar"
        aria-valuenow={Math.round(pct * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className="h-full rounded-full bg-accent-600 dark:bg-accent-400"
          style={{ width: `${pct * 100}%` }}
        />
      </div>
    </div>
  );
}

/**
 * A chart with a real text equivalent, not a decorative SVG.
 *
 * Recharts renders an SVG with no accessible name and no readable content, so
 * a screen-reader user gets nothing from it at all — the largest single gap in
 * `docs/accessibility.md`. Two things fix that, and both are needed:
 *
 *   - `role="img"` with a `summary` that states what the chart *shows*. A list
 *     of numbers is not an equivalent; the trend is the information.
 *   - The underlying figures as a real table, visually hidden but present in
 *     the accessibility tree, so the data is reachable rather than merely
 *     described.
 *
 * The visual chart is hidden from assistive technology (`aria-hidden`) because
 * otherwise a screen reader walks hundreds of unlabelled `<path>` elements
 * before reaching anything useful.
 */
export function AccessibleChart({
  title,
  summary,
  columns,
  rows,
  className,
  children,
}: {
  /** Names the chart in the accessibility tree. */
  title: string;
  /** One sentence on what the chart shows — the trend, not the numbers. */
  summary: string;
  /**
   * The chart's data as a table. Omit **only** where the same figures are
   * already on the page in a real table — a second hidden copy is noise to
   * work through, not an extra equivalent.
   */
  columns?: string[];
  rows?: Array<Array<string | number>>;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className={className}>
      <div role="img" aria-label={`${title}. ${summary}`} className="h-64 w-full">
        <div aria-hidden="true" className="h-full w-full">
          {children}
        </div>
      </div>
      {columns && rows ? (
        <figcaption className="sr-only">
          <table>
            <caption>{`${title}. ${summary}`}</caption>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, cellIndex) =>
                    cellIndex === 0 ? (
                      <th key={cellIndex} scope="row">
                        {cell}
                      </th>
                    ) : (
                      <td key={cellIndex}>{cell}</td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </figcaption>
      ) : null}
    </figure>
  );
}
