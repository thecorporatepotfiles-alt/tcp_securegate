import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, FilePlus2 } from 'lucide-react';
import { api, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLocationScope } from '../lib/location';
import { useListParams } from '../lib/useListParams';
import { fmtDate, fmtDateTime, fmtTime } from '../lib/format';
import type { Row } from '../lib/types';
import { REGISTER_CATEGORIES, REGISTER_CATEGORY_LABEL, VERIFICATION_METHOD_LABEL, type VerificationMethod } from '../../../shared/constants';
import { methodLabel } from '../components/oversight/reportCells';
import { Button, Card, DataTable, EmptyState, ErrorState, FilterBar, PageHeader, Pagination, SearchInput, Select } from '../components/ui';
import { CategoryPill, EventTypeBadge } from '../components/status';
import { DateRangeFilter } from '../components/oversight/DateRangeFilter';
import { MissingEventModal } from '../components/oversight/MissingEventModal';
import { OutcomeBadge } from '../components/oversight/OutcomeBadge';

const DEFAULTS = { q: '', category: '', eventType: '', gateId: '', outcome: '', from: '', to: '', sort: 'recordedAt', dir: 'desc', locationId: '' };

export default function RegisterPage() {
  const { can } = useAuth();
  const { locationId, gates, location, locationName } = useLocationScope();
  const { values, set, page, setPage } = useListParams(DEFAULTS);
  const [correcting, setCorrecting] = useState(false);
  const pageSize = 30;
  const params = { ...values, locationId: values.locationId || locationId, page, pageSize };
  const q = useQuery({ queryKey: ['events', 'register', params], queryFn: () => api.get<Page<Row>>('/events', params), refetchInterval: 30_000 });

  return (
    <>
      <PageHeader
        eyebrow="Unified register"
        title="Gate register"
        subtitle="Every recorded entry and exit — personnel, visitors, contractors, vendors, delivery personnel, vehicles and temporary access — from one shared event service."
        actions={
          can('events.correct') && (
            <Button icon={<FilePlus2 className="size-4" />} onClick={() => setCorrecting(true)}>
              Record missing exit
            </Button>
          )
        }
      />
      <FilterBar>
        <DateRangeFilter allowAll from={values.from} to={values.to} onChange={(from, to) => set({ from, to })} />
      </FilterBar>
      <FilterBar>
        <SearchInput value={values.q} onChange={(v) => set({ q: v })} placeholder="Search name, reference, registration…" />
        <Select aria-label="Category" className="w-auto" value={values.category} onChange={(e) => set({ category: e.target.value })}>
          <option value="">All categories</option>
          {REGISTER_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {REGISTER_CATEGORY_LABEL[c]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Event type"
          className="w-auto"
          value={values.eventType}
          onChange={(e) => set({ eventType: e.target.value })}
          options={[
            { value: '', label: 'Entries and exits' },
            { value: 'ENTRY', label: 'Entries only' },
            { value: 'EXIT', label: 'Exits only' },
          ]}
        />
        <Select aria-label="Gate" className="w-auto max-w-[240px]" value={values.gateId} onChange={(e) => set({ gateId: e.target.value })}>
          <option value="">All gates</option>
          {gates.map((g) => (
            <option key={g.id} value={g.id}>
              {location ? g.name : `${g.name} (${locationName(g.locationId)})`}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Outcome"
          className="w-auto"
          value={values.outcome}
          onChange={(e) => set({ outcome: e.target.value })}
          options={[
            { value: '', label: 'Any outcome' },
            { value: 'RECORDED', label: 'Recorded' },
            { value: 'RECORDED_AFTER_REVIEW', label: 'After manual review' },
            { value: 'CORRECTION_ENTRY', label: 'Correction entries' },
            { value: 'VOIDED', label: 'Voided' },
          ]}
        />
      </FilterBar>
      <Card padded={false}>
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Movement events</h2>
          {q.data && <span className="text-[13px] text-ink-3">{q.data.total.toLocaleString('en-IN')} events</span>}
        </div>
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <>
            <DataTable
              dense
              loading={q.isFetching && !q.data}
              rows={q.data?.items ?? []}
              rowKey={(r) => r.id}
              rowHref={(r) => `/events/${r.id}`}
              sort={{ key: values.sort, dir: values.dir as 'asc' | 'desc' }}
              onSort={(sort, dir) => set({ sort, dir })}
              empty={<EmptyState icon={<ClipboardList className="size-5" />} title="No movement events match" description="Widen the date range or clear filters to see more of the register." />}
              columns={[
                {
                  key: 'recordedAt',
                  header: 'Recorded',
                  sortKey: 'recordedAt',
                  render: (r) => (
                    <div className="whitespace-nowrap" title={fmtDateTime(r.recordedAt)}>
                      <div className="font-medium tabular-nums">{fmtTime(r.recordedAt)}</div>
                      <div className="text-xs text-ink-3">{fmtDate(r.recordedAt)}</div>
                    </div>
                  ),
                },
                { key: 'eventType', header: 'Event', sortKey: 'eventType', render: (r) => <EventTypeBadge type={r.eventType} voided={r.voided} /> },
                { key: 'category', header: 'Category', sortKey: 'category', hideBelow: 'sm', render: (r) => <CategoryPill category={r.temporaryAccessId ? 'TEMPORARY' : r.category} /> },
                {
                  key: 'subject',
                  header: 'Name / registration',
                  render: (r) => (
                    <div className="min-w-0">
                      <Link to={r.link} onClick={(e) => e.stopPropagation()} className="font-medium text-ink hover:text-forest-700">
                        {r.subjectName ?? '—'}
                      </Link>
                      <div className="truncate text-xs text-ink-3">{[r.subjectReference, r.subjectOrganization].filter(Boolean).join(' · ')}</div>
                    </div>
                  ),
                },
                { key: 'gate', header: 'Gate', sortKey: 'gate', hideBelow: 'md', render: (r) => <div className="whitespace-nowrap"><div>{r.gateName}</div><div className="text-xs text-ink-3">{r.locationName}</div></div> },
                {
                  key: 'method',
                  header: 'Verification',
                  hideBelow: 'lg',
                  render: (r) => (
                    <span className="text-[13px] whitespace-nowrap" title={VERIFICATION_METHOD_LABEL[r.verificationMethod as VerificationMethod]}>
                      {methodLabel(r.verificationMethod)}
                    </span>
                  ),
                },
                { key: 'outcome', header: 'Outcome', hideBelow: 'md', render: (r) => <OutcomeBadge outcome={r.outcome} voided={r.voided} /> },
                { key: 'operator', header: 'Operator', className: 'hidden xl:table-cell', render: (r) => <span className="whitespace-nowrap">{r.operatorName ?? 'System'}</span> },
                { key: 'reference', header: 'Ref', className: 'hidden 2xl:table-cell', render: (r) => <span className="font-mono text-xs whitespace-nowrap text-ink-3">{r.reference}</span> },
              ]}
            />
            {q.data && <Pagination page={page} pageSize={pageSize} total={q.data.total} onPage={setPage} />}
          </>
        )}
      </Card>
      <MissingEventModal open={correcting} onClose={() => setCorrecting(false)} />
    </>
  );
}
