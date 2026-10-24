import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Circle, Info, Loader2, Search, X, XCircle } from 'lucide-react';
import type { Tone } from '../../../shared/constants';
import { initials } from '../lib/format';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'gold';
type ButtonSize = 'sm' | 'md' | 'lg';

const BTN_VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-forest-800 text-white hover:bg-forest-700 active:bg-forest-900 shadow-[var(--shadow-card)]',
  secondary: 'bg-white text-ink border border-line-strong hover:bg-canvas active:bg-line',
  ghost: 'text-ink-2 hover:bg-forest-50 hover:text-ink',
  danger: 'bg-bad text-white hover:bg-[#962222] active:bg-[#7f1d1d]',
  gold: 'bg-gold-500 text-forest-950 hover:bg-gold-400 active:bg-gold-600',
};
const BTN_SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-md',
  md: 'h-10 px-4 text-sm gap-2 rounded-lg',
  lg: 'h-12 px-5 text-base gap-2 rounded-lg',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center font-medium whitespace-nowrap transition-colors select-none disabled:opacity-50 disabled:cursor-not-allowed',
        BTN_VARIANT[variant],
        BTN_SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export function ButtonLink({ to, variant = 'secondary', size = 'md', icon, children, className }: { to: string; variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={cx('inline-flex items-center justify-center font-medium whitespace-nowrap transition-colors', BTN_VARIANT[variant], BTN_SIZE[size], className)}>
      {icon}
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

const FIELD_BASE =
  'rounded-lg border border-line-strong bg-white px-3 text-sm text-ink placeholder:text-ink-3 transition-colors focus:border-forest-500 focus:outline-none focus:ring-2 focus:ring-forest-200 disabled:bg-canvas disabled:text-ink-3';

/** Fields are full width unless the caller supplies its own w-* class. */
const widthOf = (className?: string) => (/(^|\s)(w-|max-w-|min-w-)/.test(className ?? '') ? '' : 'w-full');

export function Field({ label, hint, error, required, children, className, htmlFor }: { label?: string; hint?: string; error?: string | null; required?: boolean; children: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      {label && (
        <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink-2">
          {label}
          {required && <span className="ml-0.5 text-bad" aria-hidden>*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-xs text-bad" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string; error?: string | null; containerClassName?: string };

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, hint, error, required, className, containerClassName, id, ...rest }, ref) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const el = <input ref={ref} id={fieldId} required={required} aria-invalid={!!error} className={cx(FIELD_BASE, widthOf(className), 'h-10', error && 'border-bad', className)} {...rest} />;
  if (!label && !hint && !error) return el;
  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={fieldId} className={containerClassName}>
      {el}
    </Field>
  );
});

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { label?: string; hint?: string; error?: string | null; containerClassName?: string; options?: { value: string | number; label: string }[]; placeholder?: string };

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ label, hint, error, required, className, containerClassName, options, placeholder, children, id, ...rest }, ref) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const el = (
    <select ref={ref} id={fieldId} required={required} aria-invalid={!!error} className={cx(FIELD_BASE, widthOf(className), 'h-10 pr-8', error && 'border-bad', className)} {...rest}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options?.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
      {children}
    </select>
  );
  if (!label && !hint && !error) return el;
  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={fieldId} className={containerClassName}>
      {el}
    </Field>
  );
});

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; hint?: string; error?: string | null; containerClassName?: string };

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ label, hint, error, required, className, containerClassName, id, rows = 3, ...rest }, ref) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const el = <textarea ref={ref} id={fieldId} rows={rows} required={required} aria-invalid={!!error} className={cx(FIELD_BASE, 'w-full py-2', error && 'border-bad', className)} {...rest} />;
  if (!label && !hint && !error) return el;
  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={fieldId} className={containerClassName}>
      {el}
    </Field>
  );
});

export function Checkbox({ label, checked, onChange, disabled, hint }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hint?: string }) {
  return (
    <label className={cx('flex items-start gap-2.5 text-sm', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-forest-700)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="text-ink">{label}</span>
        {hint && <span className="block text-xs text-ink-3">{hint}</span>}
      </span>
    </label>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…', className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  const timer = useRef<number | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current && inputRef.current.value !== value && document.activeElement !== inputRef.current) inputRef.current.value = value;
  }, [value]);
  return (
    <div className={cx('relative min-w-[200px] flex-1 sm:max-w-xs', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
      <input
        ref={inputRef}
        type="search"
        defaultValue={value}
        placeholder={placeholder}
        aria-label={placeholder}
        className={cx(FIELD_BASE, 'h-10 w-full pl-9')}
        onChange={(e) => {
          const v = e.target.value;
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => onChange(v), 300);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Surfaces & layout
// ---------------------------------------------------------------------------

export function Card({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <div className={cx('rounded-xl border border-line bg-card shadow-[var(--shadow-card)]', padded && 'p-5', className)}>{children}</div>;
}

export function CardHeader({ title, subtitle, actions, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cx('mb-4 flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[13px] text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, back, eyebrow }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { to: string; label: string }; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6">
      {back && (
        <Link to={back.to} className="no-print mb-3 inline-flex items-center gap-1 text-[13px] font-medium text-ink-3 hover:text-ink">
          <ChevronLeft className="size-4" aria-hidden />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {eyebrow && <div className="mb-1 text-xs font-semibold tracking-wide text-gold-600 uppercase">{eyebrow}</div>}
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
          {subtitle && <p className="mt-1 max-w-3xl text-sm text-ink-2">{subtitle}</p>}
        </div>
        {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="no-print mb-4 flex flex-wrap items-center gap-2">{children}</div>;
}

export function KeyValue({ items, columns = 2 }: { items: { label: string; value: ReactNode; hidden?: boolean }[]; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={cx('grid gap-x-6 gap-y-4', columns === 1 ? 'grid-cols-1' : columns === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3')}>
      {items
        .filter((i) => !i.hidden)
        .map((i) => (
          <div key={i.label} className="min-w-0">
            <dt className="text-xs font-medium text-ink-3">{i.label}</dt>
            <dd className="mt-0.5 text-sm break-words text-ink">{i.value ?? '—'}</dd>
          </div>
        ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const TONE_CLASS: Record<Tone, string> = {
  success: 'bg-ok-bg text-ok',
  warning: 'bg-warn-bg text-warn',
  danger: 'bg-bad-bg text-bad',
  info: 'bg-info-bg text-info',
  neutral: 'bg-mute-bg text-mute',
};
const TONE_ICON: Record<Tone, typeof CheckCircle2> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  info: Info,
  neutral: Circle,
};

export function Badge({ tone = 'neutral', children, icon = true, className }: { tone?: Tone; children: ReactNode; icon?: boolean; className?: string }) {
  const Icon = TONE_ICON[tone];
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', TONE_CLASS[tone], className)}>
      {icon && <Icon className="size-3.5 shrink-0" aria-hidden />}
      {children}
    </span>
  );
}

export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center rounded-md border border-line bg-canvas px-1.5 py-0.5 text-[11px] font-medium text-ink-2', className)}>{children}</span>;
}

export function Notice({ tone = 'info', title, children, className }: { tone?: Tone; title?: ReactNode; children?: ReactNode; className?: string }) {
  const Icon = TONE_ICON[tone];
  return (
    <div className={cx('flex gap-3 rounded-lg border px-4 py-3 text-sm', TONE_CLASS[tone], 'border-current/15', className)} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 text-ink">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cx(title ? 'mt-0.5' : null, 'text-ink-2')}>{children}</div>}
      </div>
    </div>
  );
}

export function Avatar({ name, size = 36, tone = 'forest' }: { name?: string | null; size?: number; tone?: 'forest' | 'gold' }) {
  return (
    <span
      aria-hidden
      className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold', tone === 'forest' ? 'bg-forest-100 text-forest-700' : 'bg-gold-100 text-gold-600')}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {initials(name)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Feedback states
// ---------------------------------------------------------------------------

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-3" role="status">
      <Loader2 className="size-5 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon && <div className="mb-3 rounded-full bg-forest-50 p-3 text-forest-600">{icon}</div>}
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-ink-3">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div className="p-4">
      <Notice tone="danger" title="Could not load this view">
        {message}
        {onRetry && (
          <div className="mt-2">
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          </div>
        )}
      </Notice>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data table
// ---------------------------------------------------------------------------

export interface Column<T> {
  key: string;
  header: ReactNode;
  render?: (row: T) => ReactNode;
  sortKey?: string;
  className?: string;
  /** Hide below this breakpoint to keep mobile tables readable. */
  hideBelow?: 'sm' | 'md' | 'lg';
  align?: 'left' | 'right';
}

const HIDE: Record<string, string> = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' };

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowHref,
  sort,
  onSort,
  empty,
  loading,
  dense,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  rowHref?: (row: T) => string;
  sort?: { key?: string; dir?: 'asc' | 'desc' };
  onSort?: (key: string, dir: 'asc' | 'desc') => void;
  empty?: ReactNode;
  loading?: boolean;
  dense?: boolean;
}) {
  return (
    <div className={cx('overflow-x-auto transition-opacity', loading && 'opacity-60')}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left">
            {columns.map((c) => {
              const active = sort?.key === c.sortKey && c.sortKey;
              return (
                <th
                  key={c.key}
                  scope="col"
                  className={cx('px-4 py-2.5 text-xs font-semibold whitespace-nowrap text-ink-3', c.hideBelow && HIDE[c.hideBelow], c.align === 'right' && 'text-right', c.className)}
                  aria-sort={active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {c.sortKey && onSort ? (
                    <button
                      type="button"
                      className={cx('inline-flex items-center gap-1 hover:text-ink', active && 'text-ink')}
                      onClick={() => onSort(c.sortKey!, active && sort?.dir === 'desc' ? 'asc' : 'desc')}
                    >
                      {c.header}
                      <span aria-hidden className="text-[10px]">
                        {active ? (sort?.dir === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && !loading ? (
            <tr>
              <td colSpan={columns.length}>{empty ?? <EmptyState title="No records match" description="Adjust the filters or search to see more results." />}</td>
            </tr>
          ) : (
            rows.map((row) => {
              const href = rowHref?.(row);
              const clickable = !!(href || onRowClick);
              return (
                <tr
                  key={rowKey(row)}
                  className={cx('border-b border-line/70 last:border-0', clickable && 'cursor-pointer hover:bg-forest-50/60')}
                  onClick={clickable ? () => (onRowClick ? onRowClick(row) : href && window.__sgNavigate?.(href)) : undefined}
                  onKeyDown={
                    clickable
                      ? (e) => {
                          if (e.key === 'Enter') onRowClick ? onRowClick(row) : href && window.__sgNavigate?.(href);
                        }
                      : undefined
                  }
                  tabIndex={clickable ? 0 : undefined}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={cx('px-4 align-middle text-ink', dense ? 'py-2' : 'py-3', c.hideBelow && HIDE[c.hideBelow], c.align === 'right' && 'text-right', c.className)}>
                      {c.render ? c.render(row) : ((row as Record<string, ReactNode>)[c.key] ?? '—')}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

declare global {
  interface Window {
    __sgNavigate?: (to: string) => void;
  }
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-[13px] text-ink-3">
      <span>
        {from.toLocaleString('en-IN')}–{to.toLocaleString('en-IN')} of <span className="font-medium text-ink-2">{total.toLocaleString('en-IN')}</span>
      </span>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page" icon={<ChevronLeft className="size-4" />} />
        <span className="px-2 tabular-nums">
          Page {page} of {pages}
        </span>
        <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page" icon={<ChevronRight className="size-4" />} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function Modal({ open, onClose, title, description, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    setTimeout(() => ref.current?.querySelector<HTMLElement>('input, select, textarea, button[data-autofocus]')?.focus(), 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-forest-950/50 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={cx('max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white shadow-[var(--shadow-pop)] sm:rounded-2xl', size === 'sm' ? 'sm:max-w-md' : size === 'md' ? 'sm:max-w-lg' : 'sm:max-w-2xl')}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            {description && <p className="mt-0.5 text-[13px] text-ink-3">{description}</p>}
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-ink-3 hover:bg-canvas hover:text-ink" aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-canvas/60 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { value: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="no-print mb-4 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cx(
            '-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors',
            value === t.value ? 'border-gold-500 text-ink' : 'border-transparent text-ink-3 hover:text-ink',
          )}
        >
          {t.label}
          {t.count !== undefined && <span className={cx('rounded-full px-1.5 text-[11px]', value === t.value ? 'bg-gold-100 text-gold-600' : 'bg-canvas text-ink-3')}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Timeline({ items }: { items: { id?: string | number; title: ReactNode; meta?: ReactNode; body?: ReactNode; tone?: Tone }[] }) {
  if (items.length === 0) return <p className="text-sm text-ink-3">No history yet.</p>;
  const dot: Record<Tone, string> = { success: 'bg-ok', warning: 'bg-gold-500', danger: 'bg-bad', info: 'bg-info', neutral: 'bg-ink-3' };
  return (
    <ol className="relative space-y-4 border-l border-line pl-5">
      {items.map((i, idx) => (
        <li key={i.id ?? idx} className="relative">
          <span className={cx('absolute top-1.5 -left-[25px] size-2.5 rounded-full ring-4 ring-white', dot[i.tone ?? 'neutral'])} aria-hidden />
          <div className="text-sm font-medium text-ink">{i.title}</div>
          {i.meta && <div className="text-xs text-ink-3">{i.meta}</div>}
          {i.body && <div className="mt-1 text-[13px] text-ink-2">{i.body}</div>}
        </li>
      ))}
    </ol>
  );
}

export function StatTile({ label, value, hint, to, tone = 'neutral', icon }: { label: string; value: ReactNode; hint?: ReactNode; to?: string; tone?: Tone; icon?: ReactNode }) {
  const accent: Record<Tone, string> = { success: 'bg-ok', warning: 'bg-gold-500', danger: 'bg-bad', info: 'bg-info', neutral: 'bg-forest-600' };
  const body = (
    <div className="flex h-full flex-col justify-between gap-2">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[13px] leading-snug font-medium text-ink-2">{label}</span>
        {icon && <span className="text-ink-3">{icon}</span>}
      </div>
      <div>
        <div className="text-[28px] leading-none font-semibold tracking-tight text-ink">{value}</div>
        {hint && <div className="mt-1.5 text-xs text-ink-3">{hint}</div>}
      </div>
      <span className={cx('absolute top-0 left-0 h-full w-[3px] rounded-l-xl', accent[tone])} aria-hidden />
    </div>
  );
  const cls = 'relative block h-full overflow-hidden rounded-xl border border-line bg-card p-4 shadow-[var(--shadow-card)]';
  return to ? (
    <Link to={to} className={cx(cls, 'transition-colors hover:border-forest-200 hover:bg-forest-50/40')}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
