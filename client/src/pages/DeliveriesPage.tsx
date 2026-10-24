import { useQuery } from '@tanstack/react-query';
import { Package, Plus } from 'lucide-react';
import { api, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLocationScope } from '../lib/location';
import { useListParams } from '../lib/useListParams';
import { fmtDateTime, titleCase } from '../lib/format';
import type { Row } from '../lib/types';
import { DELIVERY_STATUSES, DELIVERY_STATUS_INFO } from '../../../shared/constants';
import { ButtonLink, Card, DataTable, EmptyState, ErrorState, FilterBar, Input, PageHeader, Pagination, SearchInput, Select, Tabs } from '../components/ui';
import { DeliveryStatusBadge } from '../components/status';

const DEFAULTS = { q: '', status: '', statusGroup: '', category: '', from: '', to: '', mine: '', sort: '', dir: 'desc', locationId: '' };

export default function DeliveriesPage() {
  const { can, me } = useAuth();
  const { locationId } = useLocationScope();
  const { values, set, page, setPage } = useListParams(DEFAULTS);
  const pageSize = 25;
  const fullRegister = can('deliveries.view', 'deliveries.manage');
  const categories = me?.options.deliveryCategories ?? [];
  const catLabel = (code: string) => categories.find((c) => c.code === code)?.label ?? titleCase(code);
  const q = useQuery({
    queryKey: ['deliveries', 'list', values, page, locationId],
    queryFn: () => api.get<Page<Row>>('/deliveries', { ...values, mine: values.mine || undefined, page, pageSize, locationId: values.locationId || locationId }),
  });
  const group = values.statusGroup || (values.status ? '' : 'ALL');

  return (
    <>
      <PageHeader
        title={fullRegister ? 'Delivery register' : 'My deliveries'}
        subtitle={
          fullRegister
            ? 'Courier, parcel, food and supplier deliveries from arrival to departure. Authorization to proceed is not proof of inspection or acceptance.'
            : 'Deliveries addressed to you or sponsored by you. Acknowledge receipt once you have received them.'
        }
        actions={can('deliveries.manage') && <ButtonLink to="/deliveries/new" variant="primary" icon={<Plus className="size-4" />}>Register expected delivery</ButtonLink>}
      />
      <Tabs
        value={group}
        onChange={(v) => set({ statusGroup: v === 'ALL' ? '' : v, status: '' })}
        tabs={[
          { value: 'ALL', label: 'All' },
          { value: 'AWAITING_COMPLETION', label: 'Awaiting completion' },
          { value: 'OPEN', label: 'Open' },
          { value: 'CLOSED', label: 'Closed' },
        ]}
      />
      <FilterBar>
        <SearchInput value={values.q} onChange={(v) => set({ q: v })} placeholder="Search reference, company, courier, recipient" />
        <Select aria-label="Status" className="w-auto" value={values.status} onChange={(e) => set({ status: e.target.value, statusGroup: '' })} placeholder="Any status" options={DELIVERY_STATUSES.map((s) => ({ value: s, label: DELIVERY_STATUS_INFO[s].label }))} />
        <Select aria-label="Category" className="w-auto" value={values.category} onChange={(e) => set({ category: e.target.value })} placeholder="All categories" options={categories.map((c) => ({ value: c.code, label: c.label }))} />
        <Input aria-label="From date" type="date" className="w-auto" value={values.from} onChange={(e) => set({ from: e.target.value })} />
        <Input aria-label="To date" type="date" className="w-auto" value={values.to} onChange={(e) => set({ to: e.target.value })} />
        {fullRegister && can('deliveries.acknowledge') && (
          <Select
            aria-label="Scope"
            className="w-auto"
            value={values.mine}
            onChange={(e) => set({ mine: e.target.value })}
            options={[
              { value: '', label: 'All deliveries' },
              { value: 'true', label: 'Addressed to me' },
            ]}
          />
        )}
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
              rowHref={(r) => `/deliveries/${r.id}`}
              sort={{ key: values.sort, dir: values.dir as 'asc' | 'desc' }}
              onSort={(sort, dir) => set({ sort, dir })}
              empty={
                <EmptyState
                  icon={<Package className="size-5" />}
                  title="No deliveries match"
                  description={fullRegister ? 'Clear the filters. Guards register arrivals at the gate; administrators can pre-register expected deliveries.' : 'Deliveries addressed to you will appear here once registered.'}
                  action={can('deliveries.manage') ? <ButtonLink to="/deliveries/new">Register expected delivery</ButtonLink> : undefined}
                />
              }
              columns={[
                {
                  key: 'company',
                  header: 'Delivery',
                  sortKey: 'company',
                  render: (r) => (
                    <div className="min-w-0">
                      <div className="font-medium">{r.company}</div>
                      <div className="text-xs text-ink-3">
                        <span className="font-mono">{r.reference}</span> · {catLabel(r.category)}
                      </div>
                    </div>
                  ),
                },
                { key: 'courier', header: 'Courier', hideBelow: 'lg', render: (r) => <div><div>{r.courierName}</div>{r.vehicleRegistration && <div className="font-mono text-xs text-ink-3">{r.vehicleRegistration}</div>}</div> },
                { key: 'recipient', header: 'Recipient', hideBelow: 'md', render: (r) => <div><div>{r.recipientUserName ?? r.recipientName ?? '—'}</div><div className="text-xs text-ink-3">{r.recipientDepartment}</div></div> },
                { key: 'items', header: 'Items', hideBelow: 'lg', align: 'right', render: (r) => r.itemCount },
                { key: 'arrivedAt', header: 'Arrived', sortKey: 'arrivedAt', hideBelow: 'sm', render: (r) => <span className="whitespace-nowrap">{r.arrivedAt ? fmtDateTime(r.arrivedAt) : r.expectedAt ? `Expected ${fmtDateTime(r.expectedAt)}` : '—'}</span> },
                { key: 'status', header: 'Status', sortKey: 'status', render: (r) => <DeliveryStatusBadge status={r.status} /> },
                { key: 'location', header: 'Location', hideBelow: 'lg', render: (r) => r.locationName },
              ]}
            />
            {q.data && <Pagination page={page} pageSize={pageSize} total={q.data.total} onPage={setPage} />}
          </>
        )}
      </Card>
    </>
  );
}
