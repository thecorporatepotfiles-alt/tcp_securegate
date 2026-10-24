import { useQuery } from '@tanstack/react-query';
import { Plus, Users } from 'lucide-react';
import { api, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLocationScope } from '../lib/location';
import { useListParams } from '../lib/useListParams';
import type { Row } from '../lib/types';
import { ButtonLink, Card, DataTable, EmptyState, ErrorState, FilterBar, PageHeader, Pagination, SearchInput, Select, Avatar } from '../components/ui';
import { PersonStatusBadge, PresenceBadge } from '../components/status';
import { fmtDate } from '../lib/format';

const DEFAULTS = { q: '', status: '', presence: '', credential: '', unit: '', sort: 'name', dir: 'asc', locationId: '' };

export default function PersonnelPage() {
  const { can } = useAuth();
  const { locationId } = useLocationScope();
  const { values, set, page, setPage } = useListParams(DEFAULTS);
  const pageSize = 25;
  const q = useQuery({
    queryKey: ['personnel', 'list', values, page, locationId],
    queryFn: () => api.get<Page<Row>>('/personnel', { ...values, page, pageSize, locationId: values.locationId || locationId }),
  });
  const units = useQuery({ queryKey: ['personnel', 'units'], queryFn: () => api.get<string[]>('/personnel/units'), staleTime: 300_000 });

  return (
    <>
      <PageHeader
        title="Personnel directory"
        subtitle="Synthetic personnel records. Inside/outside status is derived from recorded gate events."
        actions={can('personnel.manage') && <ButtonLink to="/personnel/new" variant="primary" icon={<Plus className="size-4" />}>Add personnel</ButtonLink>}
      />
      <FilterBar>
        <SearchInput value={values.q} onChange={(v) => set({ q: v })} placeholder="Search name, personnel ID, unit or card no." />
        <Select aria-label="Status" value={values.status} onChange={(e) => set({ status: e.target.value })} className="w-auto" options={[{ value: '', label: 'All statuses' }, { value: 'ACTIVE', label: 'Active' }, { value: 'INACTIVE', label: 'Inactive' }]} />
        <Select aria-label="Presence" value={values.presence} onChange={(e) => set({ presence: e.target.value })} className="w-auto" options={[{ value: '', label: 'Inside or outside' }, { value: 'INSIDE', label: 'Recorded inside' }, { value: 'OUTSIDE', label: 'Not inside' }]} />
        <Select aria-label="Credential" value={values.credential} onChange={(e) => set({ credential: e.target.value })} className="w-auto" options={[{ value: '', label: 'Any credential' }, { value: 'ASSIGNED', label: 'Has active credential' }, { value: 'NONE', label: 'No active credential' }]} />
        <Select aria-label="Unit" value={values.unit} onChange={(e) => set({ unit: e.target.value })} className="w-auto max-w-[220px]" placeholder="All units" options={(units.data ?? []).map((u) => ({ value: u, label: u }))} />
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
              rowHref={(r) => `/personnel/${r.id}`}
              sort={{ key: values.sort, dir: values.dir as 'asc' | 'desc' }}
              onSort={(sort, dir) => set({ sort, dir })}
              empty={
                <EmptyState
                  icon={<Users className="size-5" />}
                  title="No personnel match these filters"
                  description="Clear the search or filters, or add a new synthetic personnel record."
                  action={can('personnel.manage') ? <ButtonLink to="/personnel/new">Add personnel</ButtonLink> : undefined}
                />
              }
              columns={[
                {
                  key: 'name',
                  header: 'Name',
                  sortKey: 'name',
                  render: (r) => (
                    <div className="flex items-center gap-3">
                      <Avatar name={r.fullName} size={34} />
                      <div className="min-w-0">
                        <div className="font-medium">{[r.rank, r.fullName].filter(Boolean).join(' ')}</div>
                        <div className="font-mono text-xs text-ink-3">{r.serviceNumber}</div>
                      </div>
                    </div>
                  ),
                },
                { key: 'unit', header: 'Unit / department', sortKey: 'unit', hideBelow: 'md', render: (r) => <div><div>{r.unit ?? '—'}</div><div className="text-xs text-ink-3">{r.designation ?? r.department ?? ''}</div></div> },
                { key: 'location', header: 'Assigned location', sortKey: 'location', hideBelow: 'lg', render: (r) => r.locationName },
                { key: 'credential', header: 'Credential', hideBelow: 'lg', render: (r) => (r.activeCredential ? <span className="font-mono text-xs">{r.activeCredential}</span> : <span className="text-xs text-ink-3">None active</span>) },
                { key: 'presence', header: 'Recorded status', render: (r) => <div><PresenceBadge state={r.presenceState} />{r.presenceState === 'INSIDE' && r.presenceLocation && <div className="mt-0.5 text-xs text-ink-3">{r.presenceLocation}</div>}</div> },
                { key: 'status', header: 'Record', sortKey: 'status', hideBelow: 'sm', render: (r) => <div><PersonStatusBadge status={r.status} />{r.accessValidUntil && <div className="mt-0.5 text-xs text-ink-3">until {fmtDate(r.accessValidUntil)}</div>}</div> },
              ]}
            />
            {q.data && <Pagination page={page} pageSize={pageSize} total={q.data.total} onPage={setPage} />}
          </>
        )}
      </Card>
    </>
  );
}
