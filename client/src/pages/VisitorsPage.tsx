import { useQuery } from '@tanstack/react-query';
import { Plus, UserCheck } from 'lucide-react';
import { api, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLocationScope } from '../lib/location';
import { useListParams } from '../lib/useListParams';
import type { Row } from '../lib/types';
import { VISIT_STATUSES, VISIT_STATUS_INFO } from '../../../shared/constants';
import { ButtonLink, Card, EmptyState, ErrorState, FilterBar, Input, PageHeader, Pagination, SearchInput, Select, Checkbox } from '../components/ui';
import { VisitTable } from '../components/visitors/VisitTable';

const DEFAULTS = { q: '', status: '', statusGroup: '', from: '', to: '', source: '', mine: '', sort: 'expectedArrival', dir: 'desc', locationId: '' };

const GROUPS = [
  { value: 'G:AWAITING_AUTHORIZATION', label: 'Awaiting authorization' },
  { value: 'G:ACTIVE', label: 'Approved or inside' },
  { value: 'G:CLOSED', label: 'Closed (exited, rejected, cancelled, expired)' },
];

export default function VisitorsPage() {
  const { can } = useAuth();
  const { locationId, allowAll } = useLocationScope();
  const { values, set, page, setPage } = useListParams(DEFAULTS);
  const pageSize = 25;
  const q = useQuery({
    queryKey: ['visits', 'list', values, page, locationId],
    queryFn: () => api.get<Page<Row>>('/visits', { ...values, page, pageSize, locationId: values.locationId || locationId }),
    refetchInterval: 30_000,
  });
  const statusValue = values.statusGroup ? `G:${values.statusGroup}` : values.status;
  const canCreate = can('visitors.create');

  return (
    <>
      <PageHeader
        title="Visitors"
        subtitle={can('visitors.view_all') ? 'All visitor requests and visits in your authorized locations.' : 'Visits you host, requested or must approve.'}
        actions={canCreate && <ButtonLink to="/visitors/new" variant="primary" icon={<Plus className="size-4" />}>New visitor request</ButtonLink>}
      />
      <FilterBar>
        <SearchInput value={values.q} onChange={(v) => set({ q: v })} placeholder="Search visitor, company, reference, host" />
        <Select
          aria-label="Status"
          className="w-auto max-w-[260px]"
          value={statusValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith('G:')) set({ statusGroup: v.slice(2), status: '' });
            else set({ status: v, statusGroup: '' });
          }}
        >
          <option value="">All statuses</option>
          <optgroup label="Groups">
            {GROUPS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Status">
            {VISIT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {VISIT_STATUS_INFO[s].label}
              </option>
            ))}
          </optgroup>
        </Select>
        <Input aria-label="From date" type="date" className="w-auto" value={values.from} onChange={(e) => set({ from: e.target.value })} title="Visit date from" />
        <Input aria-label="To date" type="date" className="w-auto" value={values.to} onChange={(e) => set({ to: e.target.value })} title="Visit date to" />
        <Select
          aria-label="Source"
          className="w-auto"
          value={values.source}
          onChange={(e) => set({ source: e.target.value })}
          options={[
            { value: '', label: 'Pre-registered & walk-in' },
            { value: 'PRE_REGISTERED', label: 'Pre-registered' },
            { value: 'WALK_IN', label: 'Walk-in' },
          ]}
        />
        {can('visitors.view_all') && canCreate && (
          <div className="px-1">
            <Checkbox label="Only mine" checked={values.mine === 'true'} onChange={(v) => set({ mine: v ? 'true' : '' })} />
          </div>
        )}
      </FilterBar>
      <Card padded={false}>
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <>
            <VisitTable
              loading={q.isFetching && !q.data}
              rows={q.data?.items ?? []}
              showLocation={allowAll && !locationId}
              sort={{ key: values.sort, dir: values.dir as 'asc' | 'desc' }}
              onSort={(sort, dir) => set({ sort, dir })}
              empty={
                <EmptyState
                  icon={<UserCheck className="size-5" />}
                  title="No visits match these filters"
                  description={canCreate ? 'Clear the filters, or create a visitor request for an expected visitor.' : 'Clear the search or filters to see more visits.'}
                  action={canCreate ? <ButtonLink to="/visitors/new">New visitor request</ButtonLink> : undefined}
                />
              }
            />
            {q.data && <Pagination page={page} pageSize={pageSize} total={q.data.total} onPage={setPage} />}
          </>
        )}
      </Card>
    </>
  );
}
