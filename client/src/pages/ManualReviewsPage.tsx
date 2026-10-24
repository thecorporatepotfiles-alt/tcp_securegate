import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ListChecks, XCircle } from 'lucide-react';
import { api, type Page } from '../lib/api';
import { useMe } from '../lib/auth';
import { useLocationScope } from '../lib/location';
import { useListParams } from '../lib/useListParams';
import { fmtDateTime, fmtRelative } from '../lib/format';
import type { Row } from '../lib/types';
import { MANUAL_REVIEW_INFO, MANUAL_REVIEW_STATUSES, REGISTER_CATEGORY_LABEL, type ManualReviewStatus, type ResultCode, type SubjectType } from '../../../shared/constants';
import { useAction } from '../components/toast';
import { Button, Card, EmptyState, ErrorState, Modal, Notice, PageHeader, Pagination, Spinner, Tabs, Textarea, Pill } from '../components/ui';
import { EventTypeBadge, ResultBadge, ReviewStatusBadge } from '../components/status';

const DEFAULTS = { status: 'PENDING', locationId: '' };

function subjectLink(type: SubjectType | null, id: number | null): string | null {
  if (!type || !id) return null;
  const map: Record<SubjectType, string> = {
    PERSONNEL: `/personnel/${id}`,
    VISITOR: `/visitors/${id}`,
    CONTRACTOR: `/contractors/people/${id}`,
    TEMPORARY: `/temporary-access/${id}`,
    DELIVERY: `/deliveries/${id}`,
    VEHICLE: `/vehicles/${id}`,
  };
  return map[type];
}

export default function ManualReviewsPage() {
  const me = useMe();
  const { locationId } = useLocationScope();
  const { values, set, page, setPage } = useListParams(DEFAULTS);
  const pageSize = 20;
  const params = { status: values.status === 'ALL' ? '' : values.status, locationId: values.locationId || locationId, page, pageSize };
  const q = useQuery({ queryKey: ['manual-reviews', params], queryFn: () => api.get<Page<Row>>('/manual-reviews', params), refetchInterval: 20_000 });
  const pending = useQuery({
    queryKey: ['manual-reviews', 'pending-count', params.locationId],
    queryFn: () => api.get<Page<Row>>('/manual-reviews', { status: 'PENDING', locationId: params.locationId, pageSize: 1 }),
    refetchInterval: 20_000,
  });
  const [decision, setDecision] = useState<{ review: Row; decision: 'APPROVED' | 'DECLINED' } | null>(null);
  const [note, setNote] = useState('');
  const decide = useAction(() => api.post(`/manual-reviews/${decision!.review.id}/decide`, { decision: decision!.decision, note: note.trim() }), {
    success: () => (decision?.decision === 'APPROVED' ? 'Approved — the gate may record this one movement' : 'Manual review declined'),
    invalidate: [['manual-reviews'], ['dashboard']],
    onSuccess: () => {
      setDecision(null);
      setNote('');
    },
  });

  const tabs = [...MANUAL_REVIEW_STATUSES.map((s) => ({ value: s as string, label: MANUAL_REVIEW_INFO[s].label.replace(' for one movement', ''), count: s === 'PENDING' ? pending.data?.total : undefined })), { value: 'ALL', label: 'All' }];

  return (
    <>
      <PageHeader
        eyebrow="Gate operations"
        title="Manual reviews"
        subtitle="Cases a gate operator referred instead of bypassing a failed verification. An approval authorizes one recorded movement only; every decision is audited."
      />
      <Tabs value={values.status} onChange={(v) => set({ status: v })} tabs={tabs} />
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.data!.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ListChecks className="size-5" />}
            title={values.status === 'PENDING' ? 'No reviews awaiting a decision' : 'No manual reviews in this view'}
            description="When a guard refers a denied verification for review, it appears here for an authorized decision."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {q.data!.items.map((r) => {
            const own = r.requestedById === me.user.id;
            const link = subjectLink(r.subjectType, r.subjectId);
            return (
              <Card key={r.id}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <ReviewStatusBadge status={r.status as ManualReviewStatus} />
                      <ResultBadge result={r.resultCode as ResultCode} />
                      <span className="text-xs text-ink-3">requested</span>
                      <EventTypeBadge type={r.requestedAction} />
                      <span className="font-mono text-xs text-ink-3">{r.reference}</span>
                    </div>
                    <div className="mt-2 text-[15px] font-semibold text-ink">
                      {link ? (
                        <Link to={link} className="hover:text-forest-700">
                          {r.subjectName ?? 'Unidentified subject'}
                        </Link>
                      ) : (
                        (r.subjectName ?? 'Unidentified subject')
                      )}
                      {r.mode && <Pill className="ml-2 align-middle">{REGISTER_CATEGORY_LABEL[r.mode as keyof typeof REGISTER_CATEGORY_LABEL] ?? r.mode}</Pill>}
                    </div>
                    <div className="mt-0.5 text-[13px] text-ink-2">
                      {r.gateName} · {r.locationName} · presented <span className="font-mono">{r.inputDisplay}</span>
                    </div>
                    {r.verificationMessage && <div className="mt-1 text-[13px] text-ink-3">System: {r.verificationMessage}</div>}
                    <blockquote className="mt-3 border-l-2 border-gold-400 pl-3 text-sm text-ink">
                      “{r.requestNote}”
                      <footer className="mt-1 text-xs text-ink-3">
                        {r.requestedBy} · {fmtDateTime(r.createdAt)} ({fmtRelative(r.createdAt)})
                      </footer>
                    </blockquote>
                    {r.decidedAt && (
                      <div className="mt-3 rounded-lg bg-canvas px-3 py-2 text-[13px] text-ink-2">
                        <span className="font-medium text-ink">{r.status === 'DECLINED' ? 'Declined' : 'Approved'}</span> by {r.decidedBy} · {fmtDateTime(r.decidedAt)}
                        {r.decisionNote ? ` — ${r.decisionNote}` : ''}
                        {r.eventId ? (
                          <>
                            {' · '}
                            <Link to={`/events/${r.eventId}`} className="font-medium text-forest-700 hover:text-forest-900">
                              View recorded event
                            </Link>
                          </>
                        ) : null}
                      </div>
                    )}
                  </div>
                  {r.status === 'PENDING' && (
                    <div className="flex shrink-0 flex-col items-stretch gap-2 sm:w-44">
                      {own ? (
                        <Notice tone="neutral">You requested this review; another authorized user must decide it.</Notice>
                      ) : (
                        <>
                          <Button variant="primary" icon={<CheckCircle2 className="size-4" />} onClick={() => setDecision({ review: r, decision: 'APPROVED' })}>
                            Approve
                          </Button>
                          <Button variant="danger" icon={<XCircle className="size-4" />} onClick={() => setDecision({ review: r, decision: 'DECLINED' })}>
                            Decline
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
          <Card padded={false}>
            <Pagination page={page} pageSize={pageSize} total={q.data!.total} onPage={setPage} />
          </Card>
        </div>
      )}

      <Modal
        open={!!decision}
        onClose={() => setDecision(null)}
        title={decision?.decision === 'APPROVED' ? 'Approve one movement' : 'Decline manual review'}
        description={decision ? `${decision.review.reference} · ${decision.review.subjectName ?? ''} · ${decision.review.gateName}` : undefined}
        footer={
          <>
            <Button onClick={() => setDecision(null)}>Cancel</Button>
            <Button variant={decision?.decision === 'APPROVED' ? 'primary' : 'danger'} disabled={note.trim().length < 5} loading={decide.isPending} onClick={() => decide.mutate(undefined)}>
              {decision?.decision === 'APPROVED' ? 'Approve' : 'Decline'}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          {decision?.decision === 'APPROVED' ? (
            <Notice tone="warning">
              Approval lets the requesting gate operator record this single {decision.review.requestedAction === 'ENTRY' ? 'entry' : 'exit'} within the configured validity window. It does not change the
              underlying record’s status.
            </Notice>
          ) : (
            <Notice tone="info">The gate operator is notified in-app. No movement is recorded.</Notice>
          )}
          <Textarea label="Decision note" required value={note} onChange={(e) => setNote(e.target.value)} placeholder="Basis for the decision (min 5 characters) — recorded in the audit trail" />
        </div>
      </Modal>
    </>
  );
}
