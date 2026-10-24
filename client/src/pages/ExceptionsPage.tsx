import { useQuery } from '@tanstack/react-query';
import { FileWarning, Plus } from 'lucide-react';
import { api, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLocationScope } from '../lib/location';
import { useListParams } from '../lib/useListParams';
import { fmtDateTime, fmtRelative, titleCase } from '../lib/format';
import type { Row } from '../lib/types';
import { EXCEPTION_CATEGORIES, EXCEPTION_CATEGORY_LABEL, EXCEPTION_STATUSES, EXCEPTION_STATUS_INFO, ROLE_INFO, type ExceptionCategory, type RoleCode } from '../../../shared/constants';
import { ButtonLink, Card, DataTable, EmptyState, ErrorState, FilterBar, PageHeader, Pagination, SearchInput, Select, Tabs } from '../components/ui';
import { ExceptionStatusBadge } from '../components/status';

const DEFAULTS = { q: '', status: '', statusGroup: '', category: '', mine: '', sort: '', dir: 'desc', locationId: '' };

export default function ExceptionsPage() {
  const { can } = useAuth();
  const { locationId } = useLocationScope();
  const { values, set, page, setPage } = useListParams(DEFAULTS);
  const pageSize = 25;
  const q = useQuery({
    queryKey: ['exceptions', 'list', values, page, locationId],
    queryFn: () => api.get<Page<Row>>('/exceptions', { ...values, mine: values.mine || undefined, page, pageSize, locationId: values.locationId || locationId }),
  });
  const tab = values.statusGroup === 'UNRESOLVED' ? 'UNRESOLVED' : values.status || 'ALL';

  return (
    <>
      <PageHeader
        title="Administrative exceptions"
        subtitle="Record discrepancies, missing exits and other administrative matters through Open → Under Review → Resolved. History is never deleted."
        actions={can('exceptions.manage') && <ButtonLink to="/exceptions/new" variant="primary" icon={<Plus className="size-4" />}>New exception</ButtonLink>}
      />
      <Tabs
        value={tab}
        onChange={(v) => (v === 'UNRESOLVED' ? set({ statusGroup: 'UNRESOLVED', status: '' }) : set({ status: v === 'ALL' ? '' : v, statusGroup: '' }))}
        tabs={[{ value: 'ALL', label: 'All' }, { value: 'UNRESOLVED', label: 'Unresolved' }, ...EXCEPTION_STATUSES.map((s) => ({ value: s, label: EXCEPTION_STATUS_INFO[s].label }))]}
      />
      <FilterBar>
        <SearchInput value={values.q} onChange={(v) => set({ q: v })} placeholder="Search reference, title or related record" />
        <Select aria-label="Category" className="w-auto" value={values.category} onChange={(e) => set({ category: e.target.value })} placeholder="All categories" options={EXCEPTION_CATEGORIES.map((c) => ({ value: c, label: EXCEPTION_CATEGORY_LABEL[c] }))} />
        <Select
          aria-label="Responsibility"
          className="w-auto"
          value={values.mine}
          onChange={(e) => set({ mine: e.target.value })}
          options={[
            { value: '', label: 'Anyone responsible' },
            { value: 'true', label: 'Assigned to me or my role' },
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
              rowHref={(r) => `/exceptions/${r.id}`}
              sort={{ key: values.sort, dir: values.dir as 'asc' | 'desc' }}
              onSort={(sort, dir) => set({ sort, dir })}
              empty={
                <EmptyState
                  icon={<FileWarning className="size-5" />}
                  title="No exceptions match"
                  description="Nothing outstanding for these filters."
                  action={can('exceptions.manage') ? <ButtonLink to="/exceptions/new">Record an exception</ButtonLink> : undefined}
                />
              }
              columns={[
                {
                  key: 'title',
                  header: 'Exception',
                  render: (r) => (
                    <div className="min-w-0 max-w-xl">
                      <div className="font-medium">{r.title}</div>
                      <div className="text-xs text-ink-3">
                        <span className="font-mono">{r.reference}</span>
                        {r.relatedReference ? ` · ${r.relatedReference}` : ''}
                      </div>
                    </div>
                  ),
                },
                { key: 'category', header: 'Category', sortKey: 'category', hideBelow: 'md', render: (r) => EXCEPTION_CATEGORY_LABEL[r.category as ExceptionCategory] ?? titleCase(r.category) },
                { key: 'responsible', header: 'Responsible', hideBelow: 'lg', render: (r) => r.responsibleUserName ?? (r.responsibleRole ? ROLE_INFO[r.responsibleRole as RoleCode]?.name : '—') },
                { key: 'location', header: 'Location', hideBelow: 'lg', render: (r) => r.locationName },
                { key: 'createdAt', header: 'Created', sortKey: 'createdAt', hideBelow: 'sm', render: (r) => <span className="whitespace-nowrap" title={fmtDateTime(r.createdAt)}>{fmtRelative(r.createdAt)}</span> },
                { key: 'status', header: 'Status', sortKey: 'status', render: (r) => <ExceptionStatusBadge status={r.status} /> },
              ]}
            />
            {q.data && <Pagination page={page} pageSize={pageSize} total={q.data.total} onPage={setPage} />}
          </>
        )}
      </Card>
    </>
  );
}
