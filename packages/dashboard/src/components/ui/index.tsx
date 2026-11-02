import { useMemo, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Circle, PauseCircle, XCircle } from 'lucide-react';
import { needsText } from '../../lib/permissions';

/**
 * UX-26: the shared dashboard kit — one table, button, status pill and section so every page gets captions, header
 * scope, a mobile overflow wrapper, honest empty/error states, text-not-colour status and permission reasons for free.
 */

export interface Column<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  numeric?: boolean;
  /** sample size shown next to the value ("n=…") — every number that decides something carries its n */
  n?: (row: T) => number | null | undefined;
  sortValue?: (row: T) => number | string;
  cellClassName?: (row: T) => string | undefined;
}

export function DataTable<T>({ caption, captionVisible = false, columns, rows, rowKey, rowClassName, loading, error, empty = 'No rows.', sortable = false }: {
  caption: string;
  captionVisible?: boolean;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowClassName?: (row: T) => string | undefined;
  loading?: boolean;
  error?: string | null;
  empty?: ReactNode;
  sortable?: boolean;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const value = columns.find((c) => c.key === sort.key)?.sortValue;
    if (!value) return rows;
    return [...rows].sort((a, b) => { const x = value(a); const y = value(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir; });
  }, [rows, columns, sort]);

  if (error) return <p role="alert" className="text-sm text-status-error">{error}</p>;
  if (loading && rows.length === 0) return <p className="text-sm text-foreground-secondary">Loading…</p>;
  if (rows.length === 0) return <p className="text-sm text-foreground-secondary">{empty}</p>;

  const toggle = (key: string) => setSort((s) => (s?.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className={captionVisible ? 'text-left text-xs text-foreground-tertiary mb-1' : 'sr-only'}>{caption}</caption>
        <thead>
          <tr className="text-left text-foreground-tertiary">
            {columns.map((c) => {
              const active = sort?.key === c.key;
              const canSort = sortable && !!c.sortValue;
              return (
                <th key={c.key} scope="col" className={c.numeric ? 'text-right' : undefined}
                  aria-sort={active ? (sort?.dir === 1 ? 'ascending' : 'descending') : canSort ? 'none' : undefined}>
                  {canSort ? <button type="button" className="underline-offset-2 hover:underline" onClick={() => toggle(c.key)}>{c.label}</button> : c.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={rowKey(row)} className={`border-t border-border ${rowClassName?.(row) ?? ''}`}>
              {columns.map((c) => {
                const n = c.n?.(row);
                return (
                  <td key={c.key} className={[c.numeric ? 'text-right tabular-nums' : '', c.cellClassName?.(row) ?? ''].join(' ').trim() || undefined}>
                    {c.render(row)}{n !== undefined && n !== null && <span className="ml-1 text-xs text-foreground-muted">n={n}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const VARIANTS = {
  primary: 'border-accent bg-accent/10 hover:bg-accent/20',
  secondary: 'border-border hover:bg-background-tertiary',
  danger: 'border-status-error/60 text-status-error hover:bg-status-error/10',
} as const;

/** A button that, without the permission it needs, is disabled and says why (tooltip + screen-reader text). */
export function Button({ variant = 'secondary', needs, reason, className = '', disabled, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof VARIANTS;
  /** permission the action needs; when given, the button is disabled with 'Needs <permission>' */
  needs?: string;
  /** free-text reason for a disabled state */
  reason?: string;
}) {
  const why = needs ? needsText(needs) : disabled ? reason : undefined;
  return (
    <button type="button" {...rest} disabled={disabled || !!needs} title={why ?? rest.title}
      className={`rounded border px-2 py-0.5 text-sm disabled:opacity-50 ${VARIANTS[variant]} ${className}`.trim()}>
      {children}{why && <>{' '}<span className="sr-only">{why}</span></>}
    </button>
  );
}

const TONES = {
  ok: { icon: CheckCircle2, cls: 'text-status-completed' },
  warn: { icon: AlertTriangle, cls: 'text-status-warning' },
  error: { icon: XCircle, cls: 'text-status-error' },
  paused: { icon: PauseCircle, cls: 'text-status-paused' },
  neutral: { icon: Circle, cls: 'text-foreground-secondary' },
} as const;

/** Status as text plus an icon — colour is never the only signal. */
export function StatusPill({ tone, label, title }: { tone: keyof typeof TONES; label: string; title?: string }) {
  const { icon: Icon, cls } = TONES[tone];
  return <span className={`inline-flex items-center gap-1 ${cls}`} title={title}><Icon className="w-3.5 h-3.5" aria-hidden="true" />{label}</span>;
}

/** A page section whose heading carries a stable anchor id (Needs-you links point at these). */
export function Section({ id, title, children, className, headingClassName = 'text-lg font-semibold mb-2' }: {
  id: string; title: ReactNode; children: ReactNode; className?: string; headingClassName?: string;
}) {
  return (
    <section aria-labelledby={id} className={className}>
      <h2 id={id} className={headingClassName}>{title}</h2>
      {children}
    </section>
  );
}
