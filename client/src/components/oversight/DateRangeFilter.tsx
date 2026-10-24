import { useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { addDaysStr, todayLocal } from '../../lib/format';
import { cx } from '../ui';

export function presetRange(preset: 'today' | 'yesterday' | '7d' | '30d'): { from: string; to: string } {
  const today = todayLocal();
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: addDaysStr(today, -1), to: addDaysStr(today, -1) };
    case '7d':
      return { from: addDaysStr(today, -6), to: today };
    case '30d':
      return { from: addDaysStr(today, -29), to: today };
  }
}

const PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
] as const;

/**
 * Date range control: presets first, custom range behind its own toggle.
 * `allowAll` adds an "All dates" option (empty from/to).
 */
export function DateRangeFilter({ from, to, onChange, allowAll = false }: { from: string; to: string; onChange: (from: string, to: string) => void; allowAll?: boolean }) {
  const active = PRESETS.find((p) => {
    const r = presetRange(p.key);
    return r.from === from && r.to === to;
  })?.key;
  const isAll = allowAll && !from && !to;
  const [custom, setCustom] = useState(!active && !isAll);
  const btn = (selected: boolean) =>
    cx('rounded-md px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors', selected ? 'bg-forest-800 text-white' : 'text-ink-2 hover:bg-forest-50 hover:text-ink');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex flex-wrap rounded-lg border border-line-strong bg-white p-0.5" role="group" aria-label="Date range">
        {allowAll && (
          <button type="button" className={btn(isAll && !custom)} aria-pressed={isAll && !custom} onClick={() => { setCustom(false); onChange('', ''); }}>
            All dates
          </button>
        )}
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            aria-pressed={active === p.key && !custom}
            className={btn(active === p.key && !custom)}
            onClick={() => {
              setCustom(false);
              const r = presetRange(p.key);
              onChange(r.from, r.to);
            }}
          >
            {p.label}
          </button>
        ))}
        <button type="button" aria-pressed={custom} className={cx(btn(custom), 'inline-flex items-center gap-1')} onClick={() => setCustom(true)}>
          <CalendarDays className="size-3.5" aria-hidden /> Custom
        </button>
      </div>
      {custom && (
        <div className="flex items-center gap-1.5 text-[13px] text-ink-2">
          <label className="sr-only" htmlFor="range-from">From</label>
          <input
            id="range-from"
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => e.target.value && onChange(e.target.value, to && to >= e.target.value ? to : e.target.value)}
            className="h-9 rounded-lg border border-line-strong bg-white px-2 text-sm"
          />
          <span aria-hidden>–</span>
          <label className="sr-only" htmlFor="range-to">To</label>
          <input
            id="range-to"
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => e.target.value && onChange(from && from <= e.target.value ? from : e.target.value, e.target.value)}
            className="h-9 rounded-lg border border-line-strong bg-white px-2 text-sm"
          />
        </div>
      )}
    </div>
  );
}
