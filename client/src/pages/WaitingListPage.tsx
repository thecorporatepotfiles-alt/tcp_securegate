import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Timer } from 'lucide-react';
import { api } from '../lib/api';
import { useLocationScope } from '../lib/location';
import { useListParams } from '../lib/useListParams';
import { fmtDate, fmtDateTime, fmtRelative, fmtTime, todayLocal } from '../lib/format';
import type { Row } from '../lib/types';
import type { Tone } from '../../../shared/constants';
import { Avatar, Button, Card, ErrorState, FilterBar, Input, PageHeader, Spinner, cx } from '../components/ui';
import { VisitStatusBadge } from '../components/status';

const SECTIONS: { key: string; title: string; hint: string; tone: Tone }[] = [
  { key: 'overdue', title: 'Overdue', hint: 'Inside beyond expected departure', tone: 'danger' },
  { key: 'awaitingHostAcknowledgement', title: 'Awaiting host acknowledgement', hint: 'Host notified in-app; not yet acknowledged', tone: 'warning' },
  { key: 'awaitingAuthorization', title: 'Awaiting authorization', hint: 'Needs an approving officer decision', tone: 'warning' },
  { key: 'arrived', title: 'Arrived', hint: 'Reported at the gate; host not yet notified', tone: 'warning' },
  { key: 'approvedNotInside', title: 'Approved, not yet inside', hint: 'Pass issued; entry not recorded', tone: 'info' },
  { key: 'expected', title: 'Expected', hint: 'Pre-registered for this date', tone: 'neutral' },
  { key: 'inside', title: 'Inside', hint: 'Entry recorded', tone: 'success' },
  { key: 'completed', title: 'Completed', hint: 'Exit recorded on this date', tone: 'neutral' },
];

const ACCENT: Record<Tone, string> = { danger: 'bg-bad', warning: 'bg-gold-500', info: 'bg-info', neutral: 'bg-ink-3', success: 'bg-ok' };

function VisitRow({ r, section }: { r: Row; section: string }) {
  const when =
    section === 'inside' || section === 'overdue'
      ? `Entered ${fmtTime(r.enteredAt)} · due out ${fmtTime(r.expectedDeparture)}`
      : section === 'completed'
        ? `Exited ${fmtTime(r.exitedAt)}`
        : r.arrivedAt && ['arrived', 'awaitingHostAcknowledgement', 'awaitingAuthorization'].includes(section)
          ? `At gate since ${fmtTime(r.arrivedAt)} (${fmtRelative(r.arrivedAt)})`
          : `${fmtDate(r.visitDate)} · ${fmtTime(r.expectedArrival)}–${fmtTime(r.expectedDeparture)}`;
  return (
    <li>
      <Link to={`/visitors/${r.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-forest-50/60">
        <Avatar name={r.visitorName} size={32} tone="gold" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">{r.visitorName}</span>
            <VisitStatusBadge status={r.status} />
          </div>
          <div className="truncate text-xs text-ink-3">
            {when} · Host {r.hostName} · {r.locationName}
          </div>
        </div>
        <span className="hidden font-mono text-[11px] text-ink-3 sm:block">{r.reference}</span>
      </Link>
    </li>
  );
}

export default function WaitingListPage() {
  const { locationId } = useLocationScope();
  const today = todayLocal();
  const { values, set } = useListParams({ date: today, locationId: '' });
  const q = useQuery({
    queryKey: ['visits', 'waiting', values.date, values.locationId || locationId],
    queryFn: () => api.get<{ date: string; generatedAt: string; counts: Record<string, number>; groups: Record<string, Row[]> }>('/visits/waiting-list', { date: values.date, locationId: values.locationId || locationId }),
    refetchInterval: 20_000,
  });

  return (
    <>
      <PageHeader
        title="Visitor waiting list"
        subtitle="Live view of visitors who need action, are expected, or are inside. Refreshes every 20 seconds."
        actions={
          <Button icon={<RefreshCw className={cx('size-4', q.isFetching && 'animate-spin')} />} onClick={() => q.refetch()}>
            Refresh
          </Button>
        }
      />
      <FilterBar>
        <Input aria-label="Date" type="date" className="w-auto" value={values.date} onChange={(e) => set({ date: e.target.value || today })} />
        {values.date !== today && (
          <Button size="sm" variant="ghost" onClick={() => set({ date: today })}>
            Back to today
          </Button>
        )}
        {q.data && <span className="ml-auto text-xs text-ink-3">Last updated {fmtDateTime(q.data.generatedAt)}</span>}
      </FilterBar>
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
            {SECTIONS.map((s) => (
              <a key={s.key} href={`#wl-${s.key}`} className="relative overflow-hidden rounded-xl border border-line bg-card p-3 shadow-[var(--shadow-card)] hover:border-forest-200">
                <span className={cx('absolute top-0 left-0 h-full w-[3px]', ACCENT[s.tone])} aria-hidden />
                <div className="text-[12px] leading-snug font-medium text-ink-2">{s.title}</div>
                <div className="mt-1 text-2xl font-semibold text-ink">{q.data!.counts[s.key] ?? 0}</div>
              </a>
            ))}
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            {SECTIONS.map((s) => {
              const rows = q.data!.groups[s.key] ?? [];
              return (
                <Card key={s.key} padded={false} className="min-w-0 scroll-mt-24">
                  <div id={`wl-${s.key}`} className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={cx('size-2 rounded-full', ACCENT[s.tone])} aria-hidden />
                      <h2 className="text-sm font-semibold text-ink">{s.title}</h2>
                      <span className="rounded-full bg-canvas px-2 text-xs font-medium text-ink-2">{rows.length}</span>
                    </div>
                    <span className="hidden text-xs text-ink-3 sm:block">{s.hint}</span>
                  </div>
                  {rows.length === 0 ? (
                    <div className="flex items-center gap-2 px-4 py-6 text-sm text-ink-3">
                      <Timer className="size-4" aria-hidden /> None right now.
                    </div>
                  ) : (
                    <ul className="max-h-[360px] divide-y divide-line/70 overflow-y-auto">
                      {rows.map((r) => (
                        <VisitRow key={r.id} r={r} section={s.key} />
                      ))}
                    </ul>
                  )}
                </Card>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
