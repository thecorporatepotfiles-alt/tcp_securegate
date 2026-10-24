import { useState, type ReactNode } from 'react';
import { BarChart3, Table2 } from 'lucide-react';
import { Card, cx } from '../ui';

/**
 * Chart tokens. The three categorical series were validated (light surface
 * #ffffff) for lightness band, chroma, CVD separation, normal-vision floor and
 * contrast; order matters — green, slate, gold.
 */
export const SERIES = {
  s1: '#1f8a5f',
  s2: '#4a72b8',
  s3: '#b07d1c',
} as const;
export const STATUS_COLOR = {
  good: '#0ca30c',
  warning: '#fab219',
  critical: '#d03b3b',
  neutral: '#898781',
} as const;
export const GRID = '#e7e5dc';
export const AXIS = '#c9c6b9';
export const MUTED = '#78807b';
export const INK2 = '#4a544e';

export const axisTick = { fill: MUTED, fontSize: 11 } as const;

export function compactTick(n: number): string {
  if (Math.abs(n) >= 1000) {
    const v = n / 1000;
    return `${Number.isInteger(v) ? v : v.toFixed(1)}K`;
  }
  return String(n);
}

/** Clean, integer tick steps (1, 2, 2.5, 5 × 10^k) from zero to a rounded maximum. */
export function niceTicks(max: number, target = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const raw = max / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  step = Math.max(1, Number.isInteger(step) ? step : Math.ceil(step));
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v));
  return ticks;
}

export function maxOf(data: Record<string, unknown>[], keys: string[]): number {
  let m = 0;
  for (const row of data) for (const k of keys) m = Math.max(m, Number(row[k]) || 0);
  return m;
}

export interface LegendItem {
  label: string;
  color: string;
  kind?: 'rect' | 'line';
}

export function ChartLegend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2" aria-label="Legend">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          {i.kind === 'line' ? (
            <span className="inline-block h-[2px] w-3.5 rounded-full" style={{ background: i.color }} aria-hidden />
          ) : (
            <span className="inline-block size-2.5 rounded-[3px]" style={{ background: i.color }} aria-hidden />
          )}
          {i.label}
        </li>
      ))}
    </ul>
  );
}

interface TooltipPayloadItem {
  name?: string | number;
  value?: number | string;
  color?: string;
  stroke?: string;
  fill?: string;
  payload?: Record<string, unknown>;
}

/** Tooltip: value leads (bold), series name follows; short line keys, never filled boxes. */
export function ChartTooltip({
  active,
  payload,
  label,
  labelFormatter,
  extra,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string | number;
  labelFormatter?: (label: string | number | undefined, payload?: TooltipPayloadItem[]) => ReactNode;
  extra?: (row: Record<string, unknown>) => ReactNode;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload ?? {};
  return (
    <div className="pointer-events-none min-w-[140px] rounded-lg border border-line bg-white px-3 py-2 text-xs shadow-[var(--shadow-pop)]">
      <div className="mb-1 font-medium text-ink-2">{labelFormatter ? labelFormatter(label, payload) : label}</div>
      <ul className="space-y-0.5">
        {payload.map((p, i) => (
          <li key={`${p.name}-${i}`} className="flex items-center gap-2">
            <span className="inline-block h-[2px] w-3 rounded-full" style={{ background: p.color ?? p.stroke ?? p.fill }} aria-hidden />
            <span className="font-semibold text-ink tabular-nums">{typeof p.value === 'number' ? p.value.toLocaleString('en-IN') : p.value}</span>
            <span className="text-ink-3">{p.name}</span>
          </li>
        ))}
      </ul>
      {extra && <div className="mt-1 border-t border-line pt-1 text-ink-3">{extra(row)}</div>}
    </div>
  );
}

export interface TableColumn {
  key: string;
  label: string;
  numeric?: boolean;
}

export function ChartTable({ columns, rows }: { columns: TableColumn[]; rows: Record<string, unknown>[] }) {
  return (
    <div className="max-h-[320px] overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-white">
          <tr className="border-b border-line">
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cx('px-3 py-2 text-xs font-semibold text-ink-3', c.numeric ? 'text-right' : 'text-left')}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line/60 last:border-0">
              {columns.map((c) => (
                <td key={c.key} className={cx('px-3 py-1.5 text-ink', c.numeric && 'text-right tabular-nums')}>
                  {typeof r[c.key] === 'number' ? (r[c.key] as number).toLocaleString('en-IN') : String(r[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A chart card with a Chart / Table toggle so every value is reachable without hovering. */
export function ChartCard({
  title,
  subtitle,
  legend,
  table,
  children,
  empty,
  className,
  dim,
}: {
  title: string;
  subtitle?: ReactNode;
  legend?: LegendItem[];
  table: { columns: TableColumn[]; rows: Record<string, unknown>[] };
  children: ReactNode;
  empty?: boolean;
  className?: string;
  dim?: boolean;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <Card className={cx('flex flex-col', className)}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[13px] text-ink-3">{subtitle}</p>}
        </div>
        <div className="no-print inline-flex rounded-lg border border-line p-0.5" role="group" aria-label={`${title} view`}>
          {(['chart', 'table'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={cx('inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium', view === v ? 'bg-forest-50 text-ink' : 'text-ink-3 hover:text-ink')}
            >
              {v === 'chart' ? <BarChart3 className="size-3.5" aria-hidden /> : <Table2 className="size-3.5" aria-hidden />}
              {v === 'chart' ? 'Chart' : 'Table'}
            </button>
          ))}
        </div>
      </div>
      {legend && legend.length > 1 && view === 'chart' && !empty && (
        <div className="mb-2">
          <ChartLegend items={legend} />
        </div>
      )}
      <div className={cx('min-h-0 flex-1 transition-opacity', dim && 'opacity-50')}>
        {empty ? (
          <div className="flex h-[200px] items-center justify-center rounded-lg border border-dashed border-line text-sm text-ink-3">No activity recorded for the selected filters.</div>
        ) : view === 'chart' ? (
          children
        ) : (
          <ChartTable columns={table.columns} rows={table.rows} />
        )}
      </div>
    </Card>
  );
}
