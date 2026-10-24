import { Link } from 'react-router-dom';
import { History } from 'lucide-react';
import { fmtDateTime } from '../lib/format';
import type { Row } from '../lib/types';
import { VERIFICATION_METHOD_LABEL, type VerificationMethod } from '../../../shared/constants';
import { DataTable, EmptyState } from './ui';
import { CategoryPill, EventTypeBadge } from './status';

/** Movement history for a single person/vehicle/visit (from the shared event service). */
export function MovementTable({ events, showSubject = false }: { events: Row[]; showSubject?: boolean }) {
  return (
    <DataTable
      dense
      rows={events}
      rowKey={(r) => r.id}
      rowHref={(r) => `/events/${r.id}`}
      empty={<EmptyState icon={<History className="size-5" />} title="No movement recorded" description="Entries and exits recorded at any gate will appear here." />}
      columns={[
        { key: 'recordedAt', header: 'Recorded', render: (r) => <span className="whitespace-nowrap">{fmtDateTime(r.recordedAt)}</span> },
        { key: 'eventType', header: 'Event', render: (r) => <EventTypeBadge type={r.eventType} voided={r.voided} /> },
        ...(showSubject ? [{ key: 'subjectName', header: 'Subject', render: (r: Row) => <Link to={r.link} className="font-medium hover:text-forest-700" onClick={(e) => e.stopPropagation()}>{r.subjectName}</Link> }] : []),
        { key: 'category', header: 'Category', render: (r) => <CategoryPill category={r.temporaryAccessId ? 'TEMPORARY' : r.category} />, hideBelow: 'sm' as const },
        { key: 'gate', header: 'Gate', render: (r) => `${r.gateName} · ${r.locationName}` },
        { key: 'method', header: 'Method', render: (r) => VERIFICATION_METHOD_LABEL[r.verificationMethod as VerificationMethod] ?? r.verificationMethod, hideBelow: 'md' as const },
        { key: 'operator', header: 'Operator', render: (r) => r.operatorName ?? 'System', hideBelow: 'lg' as const },
        { key: 'reference', header: 'Ref', render: (r) => <span className="font-mono text-xs text-ink-3">{r.reference}</span>, hideBelow: 'lg' as const },
      ]}
    />
  );
}
