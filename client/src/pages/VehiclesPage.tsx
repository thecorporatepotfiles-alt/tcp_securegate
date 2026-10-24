import { useQuery } from '@tanstack/react-query';
import { CarFront, Plus } from 'lucide-react';
import { api, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLocationScope } from '../lib/location';
import { useListParams } from '../lib/useListParams';
import { fmtDate, fmtDateTime, titleCase } from '../lib/format';
import type { Row } from '../lib/types';
import { VEHICLE_AUTH_INFO, VEHICLE_AUTH_STATUSES, VEHICLE_OWNER_TYPES } from '../../../shared/constants';
import { ButtonLink, Card, DataTable, EmptyState, ErrorState, FilterBar, PageHeader, Pagination, SearchInput, Select } from '../components/ui';
import { PresenceBadge, VehicleAuthBadge } from '../components/status';

const DEFAULTS = { q: '', category: '', authorizationStatus: '', presence: '', ownerType: '', sort: '', dir: 'desc', locationId: '' };

export default function VehiclesPage() {
  const { can, me } = useAuth();
  const { locationId } = useLocationScope();
  const { values, set, page, setPage } = useListParams(DEFAULTS);
  const pageSize = 25;
  const categories = me?.options.vehicleCategories ?? [];
  const catLabel = (code: string) => categories.find((c) => c.code === code)?.label ?? titleCase(code);
  const q = useQuery({
    queryKey: ['vehicles', 'list', values, page, locationId],
    queryFn: () => api.get<Page<Row>>('/vehicles', { ...values, page, pageSize, locationId: values.locationId || locationId }),
  });

  return (
    <>
      <PageHeader
        title="Vehicle register"
        subtitle="Registered vehicles and their recorded status. Vehicle movement is recorded separately from occupants; no number-plate recognition is used."
        actions={can('vehicles.manage') && <ButtonLink to="/vehicles/new" variant="primary" icon={<Plus className="size-4" />}>Register vehicle</ButtonLink>}
      />
      <FilterBar>
        <SearchInput value={values.q} onChange={(v) => set({ q: v })} placeholder="Search registration, make or owner" />
        <Select aria-label="Category" className="w-auto" value={values.category} onChange={(e) => set({ category: e.target.value })} placeholder="All categories" options={categories.map((c) => ({ value: c.code, label: c.label }))} />
        <Select aria-label="Authorization" className="w-auto" value={values.authorizationStatus} onChange={(e) => set({ authorizationStatus: e.target.value })} placeholder="Any authorization" options={VEHICLE_AUTH_STATUSES.map((s) => ({ value: s, label: VEHICLE_AUTH_INFO[s].label }))} />
        <Select
          aria-label="Presence"
          className="w-auto"
          value={values.presence}
          onChange={(e) => set({ presence: e.target.value })}
          options={[
            { value: '', label: 'Inside or outside' },
            { value: 'INSIDE', label: 'Recorded inside' },
            { value: 'OUTSIDE', label: 'Not inside' },
          ]}
        />
        <Select aria-label="Owner type" className="w-auto" value={values.ownerType} onChange={(e) => set({ ownerType: e.target.value })} placeholder="Any owner type" options={VEHICLE_OWNER_TYPES.map((o) => ({ value: o, label: titleCase(o) }))} />
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
              rowHref={(r) => `/vehicles/${r.id}`}
              sort={{ key: values.sort, dir: values.dir as 'asc' | 'desc' }}
              onSort={(sort, dir) => set({ sort, dir })}
              empty={
                <EmptyState
                  icon={<CarFront className="size-5" />}
                  title="No vehicles match"
                  description="Clear the filters, or register a vehicle. Gate operators can also add unregistered vehicles as pending."
                  action={can('vehicles.manage') ? <ButtonLink to="/vehicles/new">Register vehicle</ButtonLink> : undefined}
                />
              }
              columns={[
                {
                  key: 'registration',
                  header: 'Registration',
                  sortKey: 'registration',
                  render: (r) => (
                    <div>
                      <div className="font-mono text-[13px] font-semibold tracking-wide">{r.registration}</div>
                      <div className="text-xs text-ink-3">{[r.makeModel, r.colour].filter(Boolean).join(' · ') || '—'}</div>
                    </div>
                  ),
                },
                { key: 'category', header: 'Category', sortKey: 'category', hideBelow: 'md', render: (r) => catLabel(r.category) },
                { key: 'owner', header: 'Owner / association', hideBelow: 'lg', render: (r) => <div><div>{r.ownerDisplay ?? '—'}</div><div className="text-xs text-ink-3">{titleCase(r.ownerType)}</div></div> },
                { key: 'location', header: 'Registered at', hideBelow: 'lg', render: (r) => r.locationName },
                { key: 'auth', header: 'Authorization', render: (r) => <div><VehicleAuthBadge status={r.authorizationStatus} />{r.authorizedUntil && <div className="mt-0.5 text-xs text-ink-3">until {fmtDate(r.authorizedUntil)}</div>}</div> },
                {
                  key: 'presence',
                  header: 'Recorded status',
                  sortKey: 'presenceSince',
                  hideBelow: 'sm',
                  render: (r) => (
                    <div>
                      <PresenceBadge state={r.presenceState} />
                      {r.presenceState === 'INSIDE' && <div className="mt-0.5 text-xs text-ink-3">{r.presenceLocation} · {fmtDateTime(r.presenceSince)}</div>}
                    </div>
                  ),
                },
              ]}
            />
            {q.data && <Pagination page={page} pageSize={pageSize} total={q.data.total} onPage={setPage} />}
          </>
        )}
      </Card>
    </>
  );
}
