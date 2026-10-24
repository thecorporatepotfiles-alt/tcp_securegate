import { useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { api, type Page } from '../lib/api';
import { useLocationScope } from '../lib/location';
import { useListParams } from '../lib/useListParams';
import { fmtDateTime, fmtRelative } from '../lib/format';
import type { Row } from '../lib/types';
import { ALERT_SEVERITIES, ALERT_STATUSES, ALERT_STATUS_INFO, ALERT_TYPES, ALERT_TYPE_INFO, type AlertType } from '../../../shared/constants';
import { Card, DataTable, EmptyState, ErrorState, FilterBar, PageHeader, Pagination, SearchInput, Select, Tabs } from '../components/ui';
import { AlertStatusBadge, SeverityBadge } from '../components/status';

const DEFAULTS = { q: '', status: '', statusGroup: '', severity: '', type: '', sort: '', dir: 'desc', locationId: '' };

export default function AlertsPage() {
  const { locationId } = useLocationScope();
  const { values, set, page, setPage } = useListParams(DEFAULTS);
  const pageSize = 25;
  const q = useQuery({
    queryKey: ['alerts', 'list', values, page, locationId],
    queryFn: () => api.get<Page<Row>>('/alerts', { ...values, page, pageSize, locationId: values.locationId || locationId }),
    refetchInterval: 30_000,
  });
  const tab = values.statusGroup === 'UNRESOLVED' ? 'UNRESOLVED' : values.status || 'ALL';

  return (
    <>
      <PageHeader title="Alerts" subtitle="Exceptions raised by gate verification and time-based rules. Acknowledging or resolving an alert never deletes the underlying event." />
      <Tabs
        value={tab}
        onChange={(v) => (v === 'UNRESOLVED' ? set({ statusGroup: 'UNRESOLVED', status: '' }) : set({ status: v === 'ALL' ? '' : v, statusGroup: '' }))}
        tabs={[
          { value: 'ALL', label: 'All' },
          { value: 'UNRESOLVED', label: 'Unresolved' },
          ...ALERT_STATUSES.map((s) => ({ value: s, label: ALERT_STATUS_INFO[s].label })),
        ]}
      />
      <FilterBar>
        <SearchInput value={values.q} onChange={(v) => set({ q: v })} placeholder="Search reference, title or related record" />
        <Select aria-label="Severity" className="w-auto" value={values.severity} onChange={(e) => set({ severity: e.target.value })} placeholder="Any severity" options={ALERT_SEVERITIES.map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))} />
        <Select aria-label="Type" className="w-auto max-w-[260px]" value={values.type} onChange={(e) => set({ type: e.target.value })} placeholder="All alert types" options={ALERT_TYPES.map((t) => ({ value: t, label: ALERT_TYPE_INFO[t].label }))} />
      </FilterBar>
      <Card padded={false}>
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <>
            <DataTable
              loading={q.isFetching && !q.data}
              rows={q.data?.items ?? []}
              rowKey={(r) => r.id}
              rowHref={(r) => `/alerts/${r.id}`}
              sort={{ key: values.sort, dir: values.dir as 'asc' | 'desc' }}
              onSort={(sort, dir) => set({ sort, dir })}
              empty={<EmptyState icon={<ShieldAlert className="size-5" />} title="No alerts match" description="Nothing needs attention for these filters. Alerts appear when verification fails or a rule is breached." />}
              columns={[
                { key: 'severity', header: 'Severity', sortKey: 'severity', render: (r) => <SeverityBadge severity={r.severity} /> },
                {
                  key: 'title',
                  header: 'Alert',
                  sortKey: 'type',
                  render: (r) => (
                    <div className="min-w-0 max-w-xl">
                      <div className="font-medium">{r.title}</div>
                      <div className="line-clamp-1 text-xs text-ink-3">{r.description}</div>
                      <div className="mt-0.5 text-[11px] text-ink-3">
                        <span className="font-mono">{r.reference}</span> · {ALERT_TYPE_INFO[r.type as AlertType]?.label ?? r.type}
                      </div>
                    </div>
                  ),
                },
                { key: 'where', header: 'Location / gate', hideBelow: 'lg', render: (r) => <div><div>{r.locationName ?? '—'}</div><div className="text-xs text-ink-3">{r.gateName ?? ''}</div></div> },
                { key: 'count', header: 'Occurrences', hideBelow: 'md', align: 'right', render: (r) => <span className="tabular-nums">{r.occurrenceCount}</span> },
                { key: 'lastSeen', header: 'Last seen', sortKey: 'lastSeenAt', hideBelow: 'sm', render: (r) => <span className="whitespace-nowrap" title={fmtDateTime(r.lastSeenAt)}>{fmtRelative(r.lastSeenAt)}</span> },
                { key: 'status', header: 'Status', sortKey: 'status', render: (r) => <AlertStatusBadge status={r.status} /> },
              ]}
            />
            {q.data && <Pagination page={page} pageSize={pageSize} total={q.data.total} onPage={setPage} />}
          </>
        )}
      </Card>
    </>
  );
}
