import { useQuery } from '@tanstack/react-query';
import { KeyRound, Plus } from 'lucide-react';
import { api, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLocationScope } from '../lib/location';
import { useListParams } from '../lib/useListParams';
import { fmtDateTime } from '../lib/format';
import type { Row } from '../lib/types';
import { Avatar, ButtonLink, Card, DataTable, EmptyState, ErrorState, FilterBar, PageHeader, Pagination, Pill, SearchInput, Select } from '../components/ui';
import { HOLDER_LABEL, TempStatusBadge } from '../components/visitors/TempStatusBadge';

const DEFAULTS = { q: '', effectiveStatus: '', holderType: '', sort: 'createdAt', dir: 'desc', locationId: '' };

export default function TempAccessPage() {
  const { can } = useAuth();
  const canManage = can('temp_access.manage');
  const { locationId, allowAll } = useLocationScope();
  const { values, set, page, setPage } = useListParams(DEFAULTS);
  const pageSize = 25;
  const q = useQuery({
    queryKey: ['temporary-access', 'list', values, page, locationId],
    queryFn: () => api.get<Page<Row>>('/temporary-access', { ...values, page, pageSize, locationId: values.locationId || locationId }),
  });

  return (
    <>
      <PageHeader
        title="Temporary access"
        subtitle="Short-term access for personnel without their credential, attached staff, trainees and short-term workers. Access expires automatically at the end of its validity."
        actions={canManage && <ButtonLink to="/temporary-access/new" variant="primary" icon={<Plus className="size-4" />}>Issue temporary access</ButtonLink>}
      />
      <FilterBar>
        <SearchInput value={values.q} onChange={(v) => set({ q: v })} placeholder="Search holder, reference, organization, reason" />
        <Select
          aria-label="Status"
          className="w-auto"
          value={values.effectiveStatus}
          onChange={(e) => set({ effectiveStatus: e.target.value })}
          options={[
            { value: '', label: 'All statuses' },
            { value: 'ACTIVE', label: 'Active now' },
            { value: 'UPCOMING', label: 'Not yet valid' },
            { value: 'EXPIRED', label: 'Expired' },
            { value: 'REVOKED', label: 'Revoked' },
          ]}
        />
        <Select
          aria-label="Holder type"
          className="w-auto"
          value={values.holderType}
          onChange={(e) => set({ holderType: e.target.value })}
          options={[
            { value: '', label: 'All holders' },
            { value: 'PERSONNEL', label: 'Personnel' },
            { value: 'CONTRACTOR', label: 'Contractors' },
            { value: 'INDIVIDUAL', label: 'Individuals' },
          ]}
        />
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
              rowHref={(r) => `/temporary-access/${r.id}`}
              sort={{ key: values.sort, dir: values.dir as 'asc' | 'desc' }}
              onSort={(sort, dir) => set({ sort, dir })}
              empty={
                <EmptyState
                  icon={<KeyRound className="size-5" />}
                  title="No temporary access records match"
                  description={canManage ? 'Clear the filters, or issue temporary access for a specific person and time window.' : 'Clear the search or filters.'}
                  action={canManage ? <ButtonLink to="/temporary-access/new">Issue temporary access</ButtonLink> : undefined}
                />
              }
              columns={[
                {
                  key: 'holder',
                  header: 'Holder',
                  sortKey: 'holder',
                  render: (r) => (
                    <div className="flex items-center gap-3">
                      <Avatar name={r.holderName} size={34} tone="gold" />
                      <div className="min-w-0">
                        <div className="font-medium">{r.holderName}</div>
                        <div className="truncate text-xs text-ink-3">{r.holderOrganization ?? '—'}</div>
                      </div>
                    </div>
                  ),
                },
                { key: 'reference', header: 'Reference', hideBelow: 'md', render: (r) => <div><div className="font-mono text-xs">{r.reference}</div><Pill className="mt-1">{HOLDER_LABEL[r.holderType]}</Pill></div> },
                { key: 'reason', header: 'Reason', hideBelow: 'lg', render: (r) => <span className="line-clamp-2 max-w-[260px]">{r.reason}</span> },
                ...(allowAll && !locationId ? [{ key: 'location', header: 'Location', hideBelow: 'lg' as const, render: (r: Row) => r.locationName }] : []),
                {
                  key: 'valid',
                  header: 'Valid',
                  sortKey: 'validUntil',
                  render: (r) => (
                    <div className="text-xs whitespace-nowrap">
                      <div>{fmtDateTime(r.validFrom)}</div>
                      <div className="text-ink-3">→ {fmtDateTime(r.validUntil)}</div>
                    </div>
                  ),
                },
                { key: 'status', header: 'Status', render: (r) => <TempStatusBadge status={r.effectiveStatus} /> },
              ]}
            />
            {q.data && <Pagination page={page} pageSize={pageSize} total={q.data.total} onPage={setPage} />}
          </>
        )}
      </Card>
    </>
  );
}
