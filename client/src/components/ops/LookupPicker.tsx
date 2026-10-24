import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { api } from '../../lib/api';
import type { Row } from '../../lib/types';
import { Field, cx } from '../ui';

/**
 * Debounced search-and-pick for personnel / contractor lookups.
 * `endpoint` returns rows with at least { id, name } plus a reference field.
 */
export function LookupPicker({
  label,
  endpoint,
  value,
  onChange,
  render,
  placeholder = 'Type at least 2 characters…',
  required,
  error,
  hint,
}: {
  label: string;
  endpoint: string;
  value: Row | null;
  onChange: (row: Row | null) => void;
  render: (row: Row) => { title: string; subtitle?: string };
  placeholder?: string;
  required?: boolean;
  error?: string | null;
  hint?: string;
}) {
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const q = useQuery({
    queryKey: ['lookup', endpoint, debounced],
    queryFn: () => api.get<Row[]>(endpoint, { q: debounced }),
    enabled: debounced.length >= 2,
  });

  if (value) {
    const r = render(value);
    return (
      <Field label={label} required={required} error={error} hint={hint}>
        <div className="flex h-10 items-center justify-between gap-2 rounded-lg border border-forest-200 bg-forest-50 px-3 text-sm">
          <span className="min-w-0 truncate">
            <span className="font-medium text-ink">{r.title}</span>
            {r.subtitle && <span className="ml-2 text-xs text-ink-3">{r.subtitle}</span>}
          </span>
          <button type="button" className="rounded p-0.5 text-ink-3 hover:text-ink" aria-label={`Clear ${label}`} onClick={() => onChange(null)}>
            <X className="size-4" />
          </button>
        </div>
      </Field>
    );
  }

  return (
    <Field label={label} required={required} error={error} hint={hint}>
      <div className="relative" ref={ref}>
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
        <input
          type="search"
          value={text}
          placeholder={placeholder}
          aria-label={label}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          className={cx(
            'h-10 w-full rounded-lg border border-line-strong bg-white pr-3 pl-9 text-sm text-ink placeholder:text-ink-3 focus:border-forest-500 focus:ring-2 focus:ring-forest-200 focus:outline-none',
            error && 'border-bad',
          )}
        />
        {open && debounced.length >= 2 && (
          <ul className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-line bg-white py-1 shadow-[var(--shadow-pop)]" role="listbox">
            {q.isLoading && <li className="px-3 py-2 text-sm text-ink-3">Searching…</li>}
            {q.data?.length === 0 && <li className="px-3 py-2 text-sm text-ink-3">No matches in your authorized locations.</li>}
            {q.data?.map((row) => {
              const r = render(row);
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-forest-50"
                    onClick={() => {
                      onChange(row);
                      setText('');
                      setOpen(false);
                    }}
                  >
                    <span className="font-medium text-ink">{r.title}</span>
                    {r.subtitle && <span className="block text-xs text-ink-3">{r.subtitle}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Field>
  );
}
