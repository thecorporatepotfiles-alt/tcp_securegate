import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileBarChart2, Printer } from 'lucide-react';
import { api, downloadCsv, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { BROWSER_EDITION, useCanSaveFiles } from '../../lib/edition';
import { useLocationScope } from '../../lib/location';
import { useListParams } from '../../lib/useListParams';
import { fmtDate, fmtDateTime } from '../../lib/format';
import type { Row } from '../../lib/types';
import { useToast } from '../toast';
import { Button, Card, DataTable, EmptyState, ErrorState, FilterBar, Notice, Pagination, SearchInput, Select, Spinner, type Column } from '../ui';
import { DateRangeFilter, presetRange } from './DateRangeFilter';
import { codeInfo, renderReportCell, type ReportColumn } from './reportCells';

export interface ReportDefinition {
  key: string;
  title: string;
  description: string;
  group: string;
  columns: ReportColumn[];
  filters: { gate?: boolean; category?: string[]; status?: string[] };
  dateFiltered: boolean;
  sortable: string[];
}

interface ReportResult {
  key: string;
  title: string;
  columns: ReportColumn[];
  items: Row[];
  total: number;
  page: number;
  pageSize: number;
}

export function useReportDefinitions() {
  return useQuery({ queryKey: ['reports', 'definitions'], queryFn: () => api.get<ReportDefinition[]>('/reports'), staleTime: 300_000 });
}

/** Generic report viewer: URL-backed filters, sorting, pagination, CSV export and print (standard edition). */
export function ReportView({ reportKey, header }: { reportKey: string; header: (def: ReportDefinition | undefined, actions: ReactNode) => ReactNode }) {
  const { can } = useAuth();
  const toast = useToast();
  const { locationId, setLocationId, locations, allowAll, gates, locationName } = useLocationScope();
  const defs = useReportDefinitions();
  const def = defs.data?.find((d) => d.key === reportKey);
  const week = presetRange('7d');
  const defaults = useMemo(
    () => ({ from: week.from, to: week.to, locationId: '', gateId: '', category: '', status: '', q: '', sort: '', dir: '' }),
    [week.from, week.to],
  );
  const { values, set, page, setPage } = useListParams(defaults);
  const pageSize = 50;
  const filters = {
    from: def?.dateFiltered === false ? '' : values.from,
    to: def?.dateFiltered === false ? '' : values.to,
    locationId: values.locationId || locationId || '',
    gateId: def?.filters.gate ? values.gateId : '',
    category: values.category,
    status: values.status,
    q: values.q,
    sort: values.sort,
    dir: values.dir,
  };
  const q = useQuery({
    queryKey: ['reports', reportKey, filters, page],
    queryFn: () => api.get<ReportResult>(`/reports/${reportKey}`, { ...filters, page, pageSize }),
    enabled: !!def,
  });

  const selectedLocation = Number(filters.locationId) || null;
  const gateOptions = (selectedLocation ? gates.filter((g) => g.locationId === selectedLocation) : gates).map((g) => ({
    value: g.id,
    label: selectedLocation ? g.name : `${g.name} (${locationName(g.locationId)})`,
  }));

  const canSaveFiles = useCanSaveFiles();
  // Browser edition: the viewer's save confirmation stays open a while, so show progress and block repeat clicks.
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    try {
      const { rows, result } = await downloadCsv(`/reports/${reportKey}/export`, filters);
      // The viewer declined the save: nothing to report.
      if (result === 'saved') toast.success(`Exported ${rows.toLocaleString('en-IN')} rows to CSV`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  const actions = (
    <>
      {can('reports.export') && canSaveFiles && (
        <Button icon={<Download className="size-4" />} onClick={exportCsv} loading={BROWSER_EDITION && exporting} disabled={!def}>
          Export CSV
        </Button>
      )}
      {!BROWSER_EDITION && (
        <Button icon={<Printer className="size-4" />} onClick={() => window.print()} disabled={!def}>
          Print / PDF
        </Button>
      )}
    </>
  );

  if (defs.isLoading) return <Spinner />;
  if (defs.isError) return <ErrorState error={defs.error} onRetry={() => defs.refetch()} />;
  if (!def) {
    return (
      <EmptyState
        icon={<FileBarChart2 className="size-5" />}
        title="Report not available"
        description="This report does not exist or your role is not permitted to view it."
      />
    );
  }

  const columns: Column<Row>[] = def.columns.map((c) => ({
    key: c.key,
    header: c.label,
    sortKey: def.sortable.includes(c.key) ? c.key : undefined,
    align: c.type === 'number' ? 'right' : undefined,
    render: (r: Row) => renderReportCell(c, r[c.key]),
  }));
  const rangeText = filters.from || filters.to ? `${fmtDate(filters.from)} – ${fmtDate(filters.to)}` : 'All dates';
  const scopeText = selectedLocation ? locationName(selectedLocation) : 'All authorized locations';

  return (
    <>
      {header(def, actions)}
      <div className="mb-3 hidden text-xs text-ink-2 print:block">
        <div className="text-base font-semibold text-ink">TCP SecureGate — {def.title}</div>
        <div>
          {scopeText} · {def.dateFiltered ? rangeText : 'Current status'}
          {values.q ? ` · search “${values.q}”` : ''} · generated {fmtDateTime(new Date().toISOString())} · synthetic demonstration data
        </div>
        <div>Printed output shows the current page only; use CSV export for the complete filtered set.</div>
      </div>
      {def.dateFiltered && (
        <FilterBar>
          <DateRangeFilter from={values.from} to={values.to} onChange={(from, to) => set({ from, to })} />
        </FilterBar>
      )}
      <FilterBar>
        <SearchInput value={values.q} onChange={(v) => set({ q: v })} placeholder="Search this report…" />
        {locations.length > 1 && (
          <Select aria-label="Location" className="w-auto max-w-[220px]" value={values.locationId || (locationId ? String(locationId) : '')}
            onChange={(e) => {
              // The report follows the global location scope (same as the header switcher).
              setLocationId(e.target.value ? Number(e.target.value) : null);
              set({ locationId: '', gateId: '' });
            }}
          >
            {allowAll && <option value="">All authorized locations</option>}
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        )}
        {def.filters.gate && <Select aria-label="Gate" className="w-auto max-w-[240px]" value={values.gateId} onChange={(e) => set({ gateId: e.target.value })} placeholder="All gates" options={gateOptions} />}
        {def.filters.category && (
          <Select
            aria-label="Category"
            className="w-auto max-w-[220px]"
            value={values.category}
            onChange={(e) => set({ category: e.target.value })}
            placeholder="All categories"
            options={def.filters.category.map((c) => ({ value: c, label: codeInfo(c, 'category').label }))}
          />
        )}
        {def.filters.status && (
          <Select
            aria-label="Status"
            className="w-auto max-w-[240px]"
            value={values.status}
            onChange={(e) => set({ status: e.target.value })}
            placeholder={reportKey === 'audit-history' ? 'Any outcome' : 'Any status'}
            options={def.filters.status.map((s) => ({ value: s, label: codeInfo(s, reportKey === 'audit-history' ? 'outcome' : reportKey === 'credential-history' ? 'action' : 'status').label }))}
          />
        )}
      </FilterBar>
      <Card padded={false} className="print-full">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">
            {def.title} <span className="font-normal text-ink-3">· {scopeText}{def.dateFiltered ? ` · ${rangeText}` : ''}</span>
          </h2>
          {q.data && (
            <span className="text-[13px] text-ink-3">
              <span className="font-semibold text-ink-2">{q.data.total.toLocaleString('en-IN')}</span> {q.data.total === 1 ? 'row' : 'rows'}
            </span>
          )}
        </div>
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <>
            <DataTable
              dense
              loading={q.isFetching}
              rows={q.data?.items ?? []}
              rowKey={(r) => String(r.id)}
              columns={columns}
              sort={{ key: values.sort, dir: (values.dir || 'desc') as 'asc' | 'desc' }}
              onSort={(sort, dir) => set({ sort, dir })}
              empty={<EmptyState icon={<FileBarChart2 className="size-5" />} title="No rows for these filters" description="Widen the date range, choose another location or clear the search." />}
            />
            {q.data && (
              <div className="no-print">
                <Pagination page={page} pageSize={pageSize} total={q.data.total} onPage={setPage} />
              </div>
            )}
          </>
        )}
      </Card>
      {!can('reports.export') && (
        <Notice tone="neutral" className="no-print mt-4">
          CSV export is not included in your role’s permissions.
        </Notice>
      )}
    </>
  );
}
