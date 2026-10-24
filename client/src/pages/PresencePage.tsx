import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Info, UsersRound } from 'lucide-react';
import { api, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLocationScope } from '../lib/location';
import { useListParams } from '../lib/useListParams';
import { fmtDateTime, fmtRelative, fmtTime } from '../lib/format';
import type { Row } from '../lib/types';
import { REGISTER_CATEGORY_LABEL, type RegisterCategory } from '../../../shared/constants';
import { Badge, Card, DataTable, EmptyState, ErrorState, FilterBar, PageHeader, Pagination, SearchInput, Select, Tabs, cx, type Column } from '../components/ui';
import { CategoryPill } from '../components/status';

const TABS: { value: string; label: string; metric: string }[] = [
  { value: 'PERSONNEL', label: 'Personnel', metric: 'personnelInside' },
  { value: 'VISITOR', label: 'Visitors', metric: 'visitorsInside' },
  { value: 'CONTRACTOR', label: 'Contractors', metric: 'contractorsInside' },
  { value: 'VENDOR', label: 'Vendors', metric: 'vendorsInside' },
  { value: 'SERVICE', label: 'Service personnel', metric: 'serviceInside' },
  { value: 'TEMPORARY', label: 'Temporary access', metric: 'temporaryInside' },
  { value: 'DELIVERY', label: 'Delivery personnel', metric: 'deliveryPersonnelInside' },
  { value: 'VEHICLE', label: 'Vehicles', metric: 'vehiclesInside' },
];

const DEFAULTS = { category: 'PERSONNEL', state: 'INSIDE', q: '', gateId: '', locationId: '', sort: '', dir: '' };

export default function PresencePage() {
  const { can } = useAuth();
  const { locationId, gates, location, locationName } = useLocationScope();
  const { values, set, page, setPage } = useListParams(DEFAULTS);
  const pageSize = 25;
  const loc = values.locationId || locationId;
  const outside = values.state === 'OUTSIDE' && values.category === 'PERSONNEL';
  const params = {
    category: values.category || undefined,
    state: outside ? 'OUTSIDE' : 'INSIDE',
    q: values.q,
    gateId: outside ? undefined : values.gateId,
    sort: values.sort,
    dir: values.dir,
    locationId: loc,
    page,
    pageSize,
  };
  const q = useQuery({ queryKey: ['presence', params], queryFn: () => api.get<Page<Row>>('/presence', params), refetchInterval: 20_000 });
  const counts = useQuery({
    queryKey: ['presence', 'counts', loc, values.gateId],
    queryFn: () => api.get<{ metrics: { key: string; value: number }[]; generatedAt: string }>('/dashboard', { locationId: loc, gateId: values.gateId }),
    enabled: can('dashboard.view'),
    refetchInterval: 20_000,
  });
  const countOf = (metric: string) => counts.data?.metrics.find((m) => m.key === metric)?.value;

  const columns = useMemo<Column<Row>[]>(() => {
    const name: Column<Row> = {
      key: 'name',
      header: values.category === 'VEHICLE' ? 'Registration' : 'Name',
      sortKey: outside ? undefined : 'name',
      render: (r) => (
        <div className="min-w-0">
          <Link to={r.link} className="font-medium text-ink hover:text-forest-700" onClick={(e) => e.stopPropagation()}>
            {r.subjectName ?? '—'}
          </Link>
          <div className="font-mono text-xs text-ink-3">{r.subjectReference ?? ''}</div>
        </div>
      ),
    };
    if (outside) {
      return [
        name,
        { key: 'org', header: 'Unit', hideBelow: 'md', render: (r) => r.subjectOrganization ?? '—' },
        { key: 'loc', header: 'Assigned location', hideBelow: 'sm', render: (r) => r.locationName },
        {
          key: 'last',
          header: 'Last recorded movement',
          render: (r) => (
            <div>
              <div className="text-sm">{r.note}</div>
              {r.since && <div className="text-xs text-ink-3">{fmtDateTime(r.since)}{r.gateName ? ` · ${r.gateName}` : ''}</div>}
            </div>
          ),
        },
      ];
    }
    return [
      name,
      ...(values.category ? [] : [{ key: 'category', header: 'Category', render: (r: Row) => <CategoryPill category={r.category} /> } as Column<Row>]),
      { key: 'org', header: values.category === 'VEHICLE' ? 'Make / owner' : 'Unit / organization', hideBelow: 'md', render: (r) => r.subjectOrganization ?? '—' },
      { key: 'where', header: 'Entered via', hideBelow: 'sm', render: (r) => <div><div>{r.gateName ?? '—'}</div><div className="text-xs text-ink-3">{r.locationName}</div></div> },
      {
        key: 'since',
        header: 'Inside since',
        sortKey: 'since',
        render: (r) => (
          <div title={fmtDateTime(r.since)}>
            <div className="whitespace-nowrap">{fmtTime(r.since)}</div>
            <div className="text-xs text-ink-3">{fmtRelative(r.since)}</div>
          </div>
        ),
      },
      ...(values.category === 'VISITOR'
        ? [
            {
              key: 'departure',
              header: 'Expected departure',
              render: (r: Row) => (
                <div className="flex flex-col items-start gap-1">
                  <span className="whitespace-nowrap">{fmtDateTime(r.expectedDeparture)}</span>
                  {r.visitStatus === 'OVERDUE' && <Badge tone="danger">Overdue</Badge>}
                </div>
              ),
            } as Column<Row>,
          ]
        : []),
    ];
  }, [values.category, outside]);

  const activeTab = TABS.find((t) => t.value === values.category);
  const title = outside ? 'Personnel not recorded inside' : `${activeTab?.label ?? 'Everyone'} recorded inside`;

  return (
    <>
      <PageHeader
        eyebrow="Live status"
        title="Who is inside?"
        subtitle={`${location ? location.name : 'All authorized locations'}. Refreshes automatically every 20 seconds.`}
        actions={
          q.data && (
            <span className="text-[13px] text-ink-3">
              Last updated <span className="font-medium text-ink-2 tabular-nums">{fmtTime(counts.data?.generatedAt ?? new Date(q.dataUpdatedAt).toISOString())}</span>
            </span>
          )
        }
      />
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-line bg-white px-4 py-3 text-[13px] text-ink-2">
        <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
        <span>
          Status is derived from the latest valid recorded entry or exit for each person or vehicle — it cannot be edited directly. Vehicle movement does not mark occupants inside. Unrecorded
          movements are corrected from the gate register with an audited correction.
        </span>
      </div>
      <Tabs
        value={values.category || 'PERSONNEL'}
        onChange={(v) => set({ category: v, state: v === 'PERSONNEL' ? values.state : 'INSIDE', sort: '', dir: '' })}
        tabs={TABS.map((t) => ({ value: t.value, label: t.label, count: countOf(t.metric) }))}
      />
      <FilterBar>
        {values.category === 'PERSONNEL' && (
          <div className="inline-flex rounded-lg border border-line-strong bg-white p-0.5" role="group" aria-label="Recorded state">
            {[
              { v: 'INSIDE', l: 'Inside' },
              { v: 'OUTSIDE', l: 'Not inside' },
            ].map((o) => (
              <button
                key={o.v}
                type="button"
                aria-pressed={values.state === o.v}
                onClick={() => set({ state: o.v, sort: '', dir: '' })}
                className={cx('rounded-md px-3 py-1.5 text-[13px] font-medium', values.state === o.v ? 'bg-forest-800 text-white' : 'text-ink-2 hover:bg-forest-50')}
              >
                {o.l}
                {o.v === 'OUTSIDE' && countOf('personnelOutside') !== undefined ? ` (${countOf('personnelOutside')!.toLocaleString('en-IN')})` : ''}
              </button>
            ))}
          </div>
        )}
        <SearchInput value={values.q} onChange={(v) => set({ q: v })} placeholder={values.category === 'VEHICLE' ? 'Search registration…' : 'Search name or reference…'} />
        {!outside && (
          <Select aria-label="Gate" className="w-auto max-w-[240px]" value={values.gateId} onChange={(e) => set({ gateId: e.target.value })}>
            <option value="">All gates</option>
            {gates.map((g) => (
              <option key={g.id} value={g.id}>
                {location ? g.name : `${g.name} (${locationName(g.locationId)})`}
              </option>
            ))}
          </Select>
        )}
      </FilterBar>
      <Card padded={false}>
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {q.data && <span className="text-[13px] text-ink-3">{q.data.total.toLocaleString('en-IN')} {q.data.total === 1 ? 'record' : 'records'}</span>}
        </div>
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <>
            <DataTable
              loading={q.isFetching && !q.data}
              rows={q.data?.items ?? []}
              rowKey={(r) => `${r.subjectType}:${r.subjectId}`}
              rowHref={(r) => r.link}
              columns={columns}
              sort={{ key: values.sort, dir: (values.dir || 'desc') as 'asc' | 'desc' }}
              onSort={(sort, dir) => set({ sort, dir })}
              empty={
                <EmptyState
                  icon={<UsersRound className="size-5" />}
                  title={outside ? 'Everyone active is recorded inside' : `No ${(REGISTER_CATEGORY_LABEL[values.category as RegisterCategory] ?? 'records').toLowerCase()} recorded inside`}
                  description={outside ? undefined : 'Entries recorded at the gates appear here until a matching exit is recorded.'}
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
