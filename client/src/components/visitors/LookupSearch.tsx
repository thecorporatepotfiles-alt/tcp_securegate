import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Search, X } from 'lucide-react';
import { api } from '../../lib/api';
import { Field, cx } from '../ui';

/**
 * Typeahead backed by a /lookups endpoint. Minimum two characters; results
 * are scoped server-side to the user's authorized locations.
 */
export function LookupSearch<T extends { id: number }>({
  label,
  hint,
  error,
  required,
  path,
  placeholder,
  renderItem,
  selected,
  renderSelected,
  onSelect,
  onClear,
  extraQuery,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  path: string;
  placeholder?: string;
  renderItem: (item: T) => ReactNode;
  selected: T | null;
  renderSelected: (item: T) => ReactNode;
  onSelect: (item: T) => void;
  onClear: () => void;
  extraQuery?: Record<string, string | number | undefined>;
}) {
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(text.trim()), 250);
    return () => window.clearTimeout(t);
  }, [text]);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const q = useQuery({
    queryKey: ['lookup', path, debounced, extraQuery],
    queryFn: () => api.get<T[]>(path, { q: debounced, ...extraQuery }),
    enabled: debounced.length >= 2 && !selected,
    placeholderData: undefined,
  });

  if (selected) {
    return (
      <Field label={label} hint={hint} error={error} required={required}>
        <div className="flex items-center gap-3 rounded-lg border border-forest-200 bg-forest-50/60 px-3 py-2">
          <div className="min-w-0 flex-1 text-sm">{renderSelected(selected)}</div>
          <button type="button" onClick={onClear} className="rounded-md p-1 text-ink-3 hover:bg-white hover:text-ink" aria-label="Clear selection">
            <X className="size-4" />
          </button>
        </div>
      </Field>
    );
  }

  const items = q.data ?? [];
  return (
    <Field label={label} hint={hint} error={error} required={required}>
      <div className="relative" ref={ref}>
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
        <input
          type="search"
          value={text}
          placeholder={placeholder ?? 'Type at least 2 characters…'}
          aria-label={label}
          aria-invalid={!!error}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          className={cx(
            'h-10 w-full rounded-lg border border-line-strong bg-white pr-9 pl-9 text-sm text-ink placeholder:text-ink-3 focus:border-forest-500 focus:ring-2 focus:ring-forest-200 focus:outline-none',
            error && 'border-bad',
          )}
        />
        {q.isFetching && <Loader2 className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-ink-3" aria-hidden />}
        {open && debounced.length >= 2 && !q.isFetching && (
          <ul className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-line bg-white py-1 shadow-[var(--shadow-pop)]" role="listbox">
            {items.length === 0 ? (
              <li className="px-3 py-3 text-sm text-ink-3">No matches in your authorized locations.</li>
            ) : (
              items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-forest-50"
                    onClick={() => {
                      onSelect(item);
                      setText('');
                      setOpen(false);
                    }}
                  >
                    {renderItem(item)}
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>
    </Field>
  );
}
