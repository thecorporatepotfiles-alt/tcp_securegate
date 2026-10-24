import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * List filters live in the URL so dashboard links open pre-filtered views and
 * refresh/back keep the reader's place.
 */
export function useListParams<T extends Record<string, string>>(defaults: T) {
  const [sp, setSp] = useSearchParams();
  const values = useMemo(() => {
    const out: Record<string, string> = { ...defaults };
    sp.forEach((v, k) => {
      out[k] = v;
    });
    return out as T & { page: string };
  }, [sp, defaults]);

  const set = useCallback(
    (patch: Partial<Record<string, string | number | null | undefined>>, resetPage = true) => {
      setSp(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined || v === null || v === '' || (defaults[k] !== undefined && String(v) === defaults[k] && k !== 'page')) next.delete(k);
            else next.set(k, String(v));
          }
          if (resetPage && !('page' in patch)) next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setSp, defaults],
  );

  const page = Number(values.page ?? '1') || 1;
  return { values, set, page, setPage: (p: number) => set({ page: p }, false) };
}
