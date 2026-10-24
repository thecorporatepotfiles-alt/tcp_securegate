import type { ReactNode } from 'react';
import { UserCheck } from 'lucide-react';
import { fmtDate, fmtTime } from '../../lib/format';
import type { Row } from '../../lib/types';
import { Avatar, DataTable, EmptyState, Pill, type Column } from '../ui';
import { VisitStatusBadge } from '../status';

export function visitColumns(opts: { showLocation?: boolean; extra?: Column<Row>[] } = {}): Column<Row>[] {
  return [
    {
      key: 'visitor',
      header: 'Visitor',
      sortKey: 'visitorName',
      render: (r) => (
        <div className="flex items-center gap-3">
          <Avatar name={r.visitorName} size={34} tone="gold" />
          <div className="min-w-0">
            <div className="font-medium">{r.visitorName}</div>
            <div className="truncate text-xs text-ink-3">{r.visitorCompany ?? 'Individual'}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'reference',
      header: 'Reference',
      sortKey: 'reference',
      hideBelow: 'md',
      render: (r) => (
        <div>
          <div className="font-mono text-xs">{r.reference}</div>
          {r.source === 'WALK_IN' && <Pill className="mt-1">Walk-in</Pill>}
        </div>
      ),
    },
    {
      key: 'when',
      header: 'Expected',
      sortKey: 'expectedArrival',
      render: (r) => (
        <div className="whitespace-nowrap">
          <div>{fmtDate(r.visitDate)}</div>
          <div className="text-xs text-ink-3">
            {fmtTime(r.expectedArrival)}–{fmtTime(r.expectedDeparture)}
          </div>
        </div>
      ),
    },
    {
      key: 'host',
      header: 'Host / purpose',
      hideBelow: 'lg',
      render: (r) => (
        <div className="max-w-[240px]">
          <div className="truncate">{r.hostName}</div>
          <div className="truncate text-xs text-ink-3">{r.purpose}</div>
        </div>
      ),
    },
    ...(opts.showLocation ? [{ key: 'location', header: 'Location', hideBelow: 'lg' as const, render: (r: Row) => r.locationName }] : []),
    { key: 'status', header: 'Status', sortKey: 'status', render: (r) => <VisitStatusBadge status={r.status} /> },
    ...(opts.extra ?? []),
  ];
}

export function VisitTable({
  rows,
  loading,
  sort,
  onSort,
  showLocation,
  extra,
  empty,
}: {
  rows: Row[];
  loading?: boolean;
  sort?: { key?: string; dir?: 'asc' | 'desc' };
  onSort?: (key: string, dir: 'asc' | 'desc') => void;
  showLocation?: boolean;
  extra?: Column<Row>[];
  empty?: ReactNode;
}) {
  return (
    <DataTable
      loading={loading}
      rows={rows}
      rowKey={(r) => r.id}
      rowHref={(r) => `/visitors/${r.id}`}
      sort={sort}
      onSort={onSort}
      columns={visitColumns({ showLocation, extra })}
      empty={empty ?? <EmptyState icon={<UserCheck className="size-5" />} title="No visits match" description="Adjust the filters or search." />}
    />
  );
}
