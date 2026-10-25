import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Ban, CheckCircle2, ClipboardCheck, Hand, ShieldCheck, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDate, fmtDateTime, fmtTime } from '../lib/format';
import type { Row } from '../lib/types';
import { VISIT_STATUS_INFO, type Tone, type VisitStatus } from '../../../shared/constants';
import { useAction } from '../components/toast';
import { Avatar, Badge, Button, Card, CardHeader, DataTable, EmptyState, ErrorState, KeyValue, Notice, PageHeader, Pill, Spinner, Timeline } from '../components/ui';
import { VisitStatusBadge } from '../components/status';
import { MovementTable } from '../components/MovementTable';
import { ReasonModal } from '../components/visitors/ReasonModal';
import { PassCard, PassPrintStyle } from '../components/visitors/PassCard';

type ActionKind = 'approve' | 'reject' | 'security' | 'cancel' | null;

const PASS_TONE: Record<string, Tone> = { ACTIVE: 'success', USED: 'neutral', EXPIRED: 'neutral', REVOKED: 'danger' };
const PASS_LABEL: Record<string, string> = { ACTIVE: 'Active', USED: 'Used', EXPIRED: 'Expired', REVOKED: 'Cancelled' };

export default function VisitorDetailPage() {
  const id = Number(useParams().id);
  const key = ['visits', 'detail', id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Row>(`/visits/${id}`), refetchInterval: 30_000 });
  const [action, setAction] = useState<ActionKind>(null);
  const v = q.data;
  const showPass = !!v?.permissions?.canViewPass && (v?.passes ?? []).some((p: Row) => ['ACTIVE', 'USED', 'EXPIRED'].includes(p.status));
  const pass = useQuery({ queryKey: ['visits', 'pass', id], queryFn: () => api.get<Row>(`/visits/${id}/pass`), enabled: showPass });

  const invalidate = [key, ['visits', 'list'], ['visits', 'pass', id], ['visits'], ['notifications']];
  const done = { invalidate, onSuccess: () => setAction(null) };
  const approve = useAction((note: string) => api.post(`/visits/${id}/approve`, { reason: note || undefined }), { success: 'Visit approved', ...done });
  const reject = useAction((reason: string) => api.post(`/visits/${id}/reject`, { reason }), { success: 'Visit rejected', ...done });
  const security = useAction((note: string) => api.post(`/visits/${id}/security-check`, { note }), { success: 'Security verification step recorded; pass generated', ...done });
  const cancel = useAction((reason: string) => api.post(`/visits/${id}/cancel`, { reason }), { success: 'Visit cancelled and pass revoked', ...done });
  const acknowledge = useAction(() => api.post(`/visits/${id}/acknowledge`), { success: 'Arrival acknowledged', invalidate });

  if (q.isLoading) return <Spinner />;
  if (q.isError || !v) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  const perms = v.permissions as Record<string, boolean>;
  const status = v.status as VisitStatus;
  const awaitingCheck = status === 'APPROVED' && !!v.requiresSecurityCheck && !v.securityCheckedAt;

  return (
    <>
      <PassPrintStyle />
      <PageHeader
        back={{ to: '/visitors', label: 'Visitors' }}
        eyebrow={`Visit ${v.reference}${v.source === 'WALK_IN' ? ' · Walk-in' : ''}`}
        title={
          <span className="flex flex-wrap items-center gap-3">
            <Avatar name={v.visitorName} size={44} tone="gold" />
            {v.visitorName}
            <VisitStatusBadge status={status} />
          </span>
        }
        subtitle={`${v.visitorCompany ?? 'Individual visitor'} · ${VISIT_STATUS_INFO[status].description}`}
        actions={
          <>
            {perms.canAcknowledge && (
              <Button variant="gold" icon={<Hand className="size-4" />} loading={acknowledge.isPending} onClick={() => acknowledge.mutate(undefined)}>
                Acknowledge arrival
              </Button>
            )}
            {perms.canSecurityCheck && (
              <Button variant="primary" icon={<ShieldCheck className="size-4" />} onClick={() => setAction('security')}>
                Record security verification
              </Button>
            )}
            {perms.canApprove && (
              <>
                <Button variant="primary" icon={<CheckCircle2 className="size-4" />} onClick={() => setAction('approve')}>
                  Approve
                </Button>
                <Button variant="danger" icon={<XCircle className="size-4" />} onClick={() => setAction('reject')}>
                  Reject
                </Button>
              </>
            )}
            {perms.canCancel && (
              <Button icon={<Ban className="size-4" />} onClick={() => setAction('cancel')}>
                Cancel visit
              </Button>
            )}
          </>
        }
      />

      <div className="no-print mb-5 grid gap-3">
        {perms.selfApprovalBlocked && (
          <Notice tone="info" title="You cannot decide this request">
            You created this request, and the configured rules do not allow self-approval. Another approving officer must review it.
          </Notice>
        )}
        {awaitingCheck && (
          <Notice tone="warning" title="Security verification step pending">
            This visit is approved but requires a recorded security verification step before a digital pass is generated.
          </Notice>
        )}
        {status === 'HOST_NOTIFIED' && (
          <Notice tone="warning" title="Visitor waiting at the gate">
            The host has been notified in-app and has not yet acknowledged the arrival. Entry still requires authorization.
          </Notice>
        )}
        {status === 'OVERDUE' && (
          <Notice tone="danger" title="Overdue">
            The visitor is recorded inside beyond the expected departure ({fmtDateTime(v.expectedDeparture)}). Exit can still be recorded at the gate.
          </Notice>
        )}
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="no-print grid content-start gap-5">
          <Card>
            <CardHeader title="Visit details" />
            <KeyValue
              items={[
                { label: 'Visit date', value: fmtDate(v.visitDate) },
                { label: 'Expected window', value: `${fmtTime(v.expectedArrival)} – ${fmtTime(v.expectedDeparture)}` },
                { label: 'Location', value: v.locationName },
                { label: 'Destination', value: v.destination },
                { label: 'Purpose', value: v.purpose },
                { label: 'Host', value: `${v.hostName}${v.hostDepartment ? ` · ${v.hostDepartment}` : ''}` },
                { label: 'Approving officer', value: v.approvingOfficerName },
                { label: 'Requested by', value: `${v.createdByName} · ${fmtDateTime(v.createdAt)}` },
                { label: 'Visitor contact', value: [v.visitorPhone, v.visitorEmail].filter(Boolean).join(' · ') || '—' },
                { label: 'Vehicle', value: v.vehicleRegistration ? <Pill className="font-mono">{v.vehicleRegistration}</Pill> : 'None' },
                { label: 'Arrived at gate', value: v.arrivedAt ? fmtDateTime(v.arrivedAt) : '—', hidden: !v.arrivedAt },
                { label: 'Host acknowledged', value: fmtDateTime(v.hostAcknowledgedAt), hidden: !v.hostAcknowledgedAt },
                { label: 'Entered', value: fmtDateTime(v.enteredAt), hidden: !v.enteredAt },
                { label: 'Exited', value: fmtDateTime(v.exitedAt), hidden: !v.exitedAt },
                { label: 'Cancellation reason', value: v.cancelledReason, hidden: !v.cancelledReason },
                { label: 'Notes', value: v.notes, hidden: !v.notes },
              ]}
            />
          </Card>

          <Card>
            <CardHeader title="Authorization" subtitle="Visitor request → authorization → security verification (where required) → pass → gate verification → recorded entry" />
            {v.approval ? (
              <div className="flex items-start gap-3">
                {v.approval.decision === 'APPROVED' ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" /> : <XCircle className="mt-0.5 size-5 shrink-0 text-bad" />}
                <div className="text-sm">
                  <div className="font-semibold">
                    {v.approval.decision === 'APPROVED' ? 'Approved' : 'Rejected'} by {v.approval.reviewer}
                  </div>
                  <div className="text-xs text-ink-3">{fmtDateTime(v.approval.createdAt)}</div>
                  {v.approval.reason && <div className="mt-1 text-ink-2">“{v.approval.reason}”</div>}
                </div>
              </div>
            ) : ['CANCELLED', 'EXPIRED'].includes(status) ? (
              <p className="text-sm text-ink-3">No decision was recorded before the request was {status.toLowerCase()}.</p>
            ) : (
              <p className="flex items-center gap-2 text-sm text-ink-2">
                <ClipboardCheck className="size-4 text-gold-600" /> Awaiting decision by {v.approvingOfficerName}.
              </p>
            )}
            {v.requiresSecurityCheck ? (
              <div className="mt-4 border-t border-line pt-3 text-sm">
                <span className="font-medium">Security verification step: </span>
                {v.securityCheckedAt ? (
                  <span className="text-ink-2">
                    recorded by {v.securityCheckedBy} · {fmtDateTime(v.securityCheckedAt)}
                    {v.securityCheckNote ? ` — ${v.securityCheckNote}` : ''}
                  </span>
                ) : (
                  <span className="text-warn">pending</span>
                )}
              </div>
            ) : null}
          </Card>

          <Card padded={false}>
            <div className="p-5 pb-0">
              <CardHeader title="Movement history" subtitle="Entries and exits recorded at the gate for this visit" />
            </div>
            <MovementTable events={v.events} />
          </Card>

          <Card padded={false}>
            <div className="p-5 pb-0">
              <CardHeader title="Digital passes" subtitle="Rejected, cancelled and expired visits never carry a valid pass" />
            </div>
            <DataTable<Row>
              dense
              rows={v.passes as Row[]}
              rowKey={(p) => p.id}
              empty={<EmptyState title="No pass issued" description={status === 'APPROVED' && awaitingCheck ? 'Generated after the security verification step.' : 'A pass is generated when the visit is approved.'} />}
              columns={[
                { key: 'passNumber', header: 'Pass', render: (p) => <span className="font-mono text-xs">{p.passNumber}</span> },
                { key: 'status', header: 'Status', render: (p) => <Badge tone={PASS_TONE[p.status]}>{PASS_LABEL[p.status] ?? p.status}</Badge> },
                { key: 'valid', header: 'Valid', hideBelow: 'md', render: (p) => <span className="text-xs">{fmtDateTime(p.validFrom)} → {fmtDateTime(p.validUntil)}</span> },
                { key: 'issued', header: 'Issued', hideBelow: 'lg', render: (p) => <span className="text-xs">{fmtDateTime(p.issuedAt)}{p.issuedBy ? ` · ${p.issuedBy}` : ''}</span> },
                { key: 'use', header: 'Use', render: (p) => <span className="text-xs text-ink-2">{p.revokedReason ?? (p.exitUsedAt ? 'Entry & exit recorded' : p.entryUsedAt ? 'Entry recorded' : p.singleUse ? 'Single use' : 'Multi-use')}</span> },
              ]}
            />
          </Card>

          <Card>
            <CardHeader title="Status history" />
            <Timeline
              items={(v.history as Row[]).map((h, i) => ({
                id: i,
                title: h.fromStatus && h.fromStatus !== h.toStatus ? `${VISIT_STATUS_INFO[h.fromStatus as VisitStatus]?.label ?? h.fromStatus} → ${VISIT_STATUS_INFO[h.toStatus as VisitStatus]?.label ?? h.toStatus}` : (h.reason ?? VISIT_STATUS_INFO[h.toStatus as VisitStatus]?.label),
                meta: `${fmtDateTime(h.createdAt)} · ${h.actor}`,
                body: h.fromStatus && h.fromStatus !== h.toStatus ? h.reason : undefined,
                tone: VISIT_STATUS_INFO[h.toStatus as VisitStatus]?.tone,
              }))}
            />
          </Card>
        </div>

        <div className="order-first grid content-start gap-5 lg:order-none">
          {showPass ? (
            pass.isLoading ? (
              <Card>
                <Spinner label="Loading pass…" />
              </Card>
            ) : pass.isError || !pass.data ? (
              <ErrorState error={pass.error} onRetry={() => pass.refetch()} />
            ) : (
              <PassCard
                kind="Visitor pass"
                title={pass.data.visitorName}
                reference={pass.data.passNumber}
                qrSvg={pass.data.qrSvg}
                token={pass.data.token}
                status={<Badge tone={PASS_TONE[pass.data.status]}>{PASS_LABEL[pass.data.status] ?? pass.data.status}</Badge>}
                validFrom={pass.data.validFrom}
                validUntil={pass.data.validUntil}
                lines={[
                  { label: 'Organization', value: pass.data.visitorCompany ?? 'Individual' },
                  { label: 'Host', value: pass.data.hostName },
                  { label: 'Location', value: pass.data.locationName },
                  { label: 'Destination', value: pass.data.destination },
                  { label: 'Visit ref', value: pass.data.visitReference },
                ]}
              />
            )
          ) : (
            <Card className="no-print">
              <CardHeader title="Digital pass" />
              <p className="text-sm text-ink-2">
                {v.passes.length === 0
                  ? status === 'REJECTED' || status === 'CANCELLED' || status === 'EXPIRED'
                    ? 'No valid pass exists for this visit.'
                    : awaitingCheck
                      ? 'The pass will be generated after the security verification step is recorded.'
                      : 'A pass is generated automatically once the request is approved.'
                  : perms.canViewPass
                    ? 'The pass for this visit has been cancelled and can no longer be used.'
                    : 'Only the host, requester, approving officer or a visitor administrator can display the pass.'}
              </p>
            </Card>
          )}
        </div>
      </div>

      <ReasonModal
        open={action === 'approve'}
        onClose={() => setAction(null)}
        title="Approve visitor request"
        description={`${v.visitorName} · ${fmtDate(v.visitDate)} ${fmtTime(v.expectedArrival)}–${fmtTime(v.expectedDeparture)}`}
        label="Note"
        required={false}
        confirmLabel="Approve"
        loading={approve.isPending}
        warning={v.requiresSecurityCheck ? 'A security verification step is required before the pass is generated.' : undefined}
        onConfirm={(t) => approve.mutate(t)}
      />
      <ReasonModal
        open={action === 'reject'}
        onClose={() => setAction(null)}
        title="Reject visitor request"
        description={`${v.visitorName} · ${v.reference}`}
        confirmLabel="Reject request"
        variant="danger"
        loading={reject.isPending}
        onConfirm={(t) => reject.mutate(t)}
      />
      <ReasonModal
        open={action === 'security'}
        onClose={() => setAction(null)}
        title="Record security verification step"
        description="Records that the establishment's required verification step was completed. It does not perform any check itself."
        label="Note"
        confirmLabel="Record and generate pass"
        loading={security.isPending}
        onConfirm={(t) => security.mutate(t)}
      />
      <ReasonModal
        open={action === 'cancel'}
        onClose={() => setAction(null)}
        title="Cancel visit"
        description={`${v.visitorName} · ${v.reference}`}
        confirmLabel="Cancel visit"
        variant="danger"
        loading={cancel.isPending}
        warning="Any active pass is revoked immediately and will be rejected at the gate."
        onConfirm={(t) => cancel.mutate(t)}
      />
    </>
  );
}
