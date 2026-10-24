import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ClipboardCheck, XCircle } from 'lucide-react';
import { api, type Page } from '../lib/api';
import { useMe } from '../lib/auth';
import { fmtDate, fmtRelative, fmtTime } from '../lib/format';
import type { Row } from '../lib/types';
import { useAction } from '../components/toast';
import { Avatar, Button, ButtonLink, Card, EmptyState, ErrorState, Notice, PageHeader, Pagination, Pill, Spinner } from '../components/ui';
import { VisitStatusBadge } from '../components/status';
import { ReasonModal } from '../components/visitors/ReasonModal';

export default function ApprovalsPage() {
  const me = useMe();
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const q = useQuery({
    queryKey: ['visits', 'approvals', page],
    queryFn: () => api.get<Page<Row>>('/visits', { approvalQueue: true, page, pageSize, sort: 'expectedArrival', dir: 'asc' }),
    refetchInterval: 20_000,
  });
  const [target, setTarget] = useState<{ row: Row; kind: 'approve' | 'reject' } | null>(null);
  const invalidate = [['visits'], ['notifications']];
  const approve = useAction((v: { id: number; note: string }) => api.post(`/visits/${v.id}/approve`, { reason: v.note || undefined }), {
    success: 'Visit approved',
    invalidate,
    onSuccess: () => setTarget(null),
  });
  const reject = useAction((v: { id: number; reason: string }) => api.post(`/visits/${v.id}/reject`, { reason: v.reason }), {
    success: 'Visit rejected',
    invalidate,
    onSuccess: () => setTarget(null),
  });

  return (
    <>
      <PageHeader title="My approvals" subtitle="Visitor requests assigned to you for authorization. Each decision is recorded with your name, the time and any reason." />
      <Notice tone="info" className="mb-4">
        Approval generates a digital pass (unless a security verification step is required). A pass alone never admits anyone — the gate verifies it and records entry separately.
      </Notice>
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.data!.items.length === 0 ? (
        <Card>
          <EmptyState icon={<ClipboardCheck className="size-5" />} title="No requests awaiting your decision" description="New requests assigned to you will appear here and in your notifications." action={<ButtonLink to="/visitors">View all visitors</ButtonLink>} />
        </Card>
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-line">
            {q.data!.items.map((r) => (
                <li key={r.id} className="flex flex-col gap-4 p-5 md:flex-row md:items-center">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <Avatar name={r.visitorName} size={40} tone="gold" />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link to={`/visitors/${r.id}`} className="font-semibold text-ink hover:text-forest-700">
                          {r.visitorName}
                        </Link>
                        <VisitStatusBadge status={r.status} />
                        {r.source === 'WALK_IN' && <Pill>Walk-in · at gate</Pill>}
                        {r.requiresSecurityCheck ? <Pill>Security step required</Pill> : null}
                      </div>
                      <div className="mt-0.5 text-sm text-ink-2">
                        {r.visitorCompany ?? 'Individual'} · {r.purpose} · {r.destination}
                      </div>
                      <div className="mt-0.5 text-xs text-ink-3">
                        {fmtDate(r.visitDate)} {fmtTime(r.expectedArrival)}–{fmtTime(r.expectedDeparture)} · {r.locationName} · Host {r.hostName} · requested by {r.createdByName} {fmtRelative(r.createdAt)} ·{' '}
                        <span className="font-mono">{r.reference}</span>
                      </div>
                    </div>
                  </div>
                  {r.createdById === me.user.id ? (
                    <p className="max-w-[260px] shrink-0 text-xs text-ink-3">You created this request; another approving officer must decide it.</p>
                  ) : (
                  <div className="flex shrink-0 gap-2">
                    <Button variant="danger" icon={<XCircle className="size-4" />} onClick={() => setTarget({ row: r, kind: 'reject' })}>
                      Reject
                    </Button>
                    <Button variant="primary" icon={<CheckCircle2 className="size-4" />} onClick={() => setTarget({ row: r, kind: 'approve' })}>
                      Approve
                    </Button>
                  </div>
                  )}
                </li>
            ))}
          </ul>
          <Pagination page={page} pageSize={pageSize} total={q.data!.total} onPage={setPage} />
        </Card>
      )}
      <ReasonModal
        open={target?.kind === 'approve'}
        onClose={() => setTarget(null)}
        title="Approve visitor request"
        description={target ? `${target.row.visitorName} · ${target.row.reference}` : undefined}
        label="Note"
        required={false}
        confirmLabel="Approve"
        loading={approve.isPending}
        onConfirm={(note) => target && approve.mutate({ id: target.row.id, note })}
      />
      <ReasonModal
        open={target?.kind === 'reject'}
        onClose={() => setTarget(null)}
        title="Reject visitor request"
        description={target ? `${target.row.visitorName} · ${target.row.reference}` : undefined}
        confirmLabel="Reject request"
        variant="danger"
        loading={reject.isPending}
        onConfirm={(reason) => target && reject.mutate({ id: target.row.id, reason })}
      />
    </>
  );
}
