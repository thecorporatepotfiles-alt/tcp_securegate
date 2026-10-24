import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Ban, CheckCircle2, PackageCheck, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime, titleCase } from '../lib/format';
import type { Row } from '../lib/types';
import { DELIVERY_STATUS_INFO, type DeliveryStatus } from '../../../shared/constants';
import { useAction } from '../components/toast';
import { Button, Card, CardHeader, ErrorState, Input, KeyValue, Modal, Notice, PageHeader, Spinner, Textarea, Timeline } from '../components/ui';
import { DeliveryStatusBadge, PresenceBadge } from '../components/status';
import { MovementTable } from '../components/MovementTable';

type Act = 'authorize' | 'reject' | 'acknowledge' | 'cancel';
const ACT: Record<Act, { title: string; button: string; noteLabel: string; required: boolean; variant: 'primary' | 'danger' }> = {
  authorize: { title: 'Authorize to proceed', button: 'Authorize', noteLabel: 'Note (optional)', required: false, variant: 'primary' },
  reject: { title: 'Reject delivery', button: 'Reject delivery', noteLabel: 'Reason', required: true, variant: 'danger' },
  acknowledge: { title: 'Acknowledge receipt', button: 'Acknowledge receipt', noteLabel: 'Receipt note (optional)', required: false, variant: 'primary' },
  cancel: { title: 'Cancel delivery', button: 'Cancel delivery', noteLabel: 'Reason', required: true, variant: 'danger' },
};

export default function DeliveryDetailPage() {
  const id = Number(useParams().id);
  const { me } = useAuth();
  const key = ['deliveries', 'detail', id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Row>(`/deliveries/${id}`) });
  const [act, setAct] = useState<Act | null>(null);
  const [note, setNote] = useState('');
  const [receivedByName, setReceivedByName] = useState('');
  const close = () => {
    setAct(null);
    setNote('');
    setReceivedByName('');
  };
  const run = useAction(
    (a: Act) => {
      const body =
        a === 'authorize' ? { note: note || undefined } : a === 'acknowledge' ? { receivedByName: receivedByName || null, note: note || null } : { reason: note };
      return api.post(`/deliveries/${id}/${a}`, body);
    },
    {
      success: (_r) => (act ? `${ACT[act].button} — done` : 'Updated'),
      invalidate: [key, ['deliveries', 'list']],
      onSuccess: close,
    },
  );

  if (q.isLoading) return <Spinner />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const p = d.permissions as Record<string, boolean>;
  const status = d.status as DeliveryStatus;
  const catLabel = me?.options.deliveryCategories.find((c) => c.code === d.category)?.label ?? titleCase(d.category);
  const cfg = act ? ACT[act] : null;

  return (
    <>
      <PageHeader
        back={{ to: '/deliveries', label: 'Delivery register' }}
        eyebrow={`Delivery · ${catLabel}`}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {d.company}
            <DeliveryStatusBadge status={status} />
          </span>
        }
        subtitle={<span className="font-mono">{d.reference}</span>}
        actions={
          <>
            {p.canAuthorize && (
              <Button variant="primary" icon={<CheckCircle2 className="size-4" />} onClick={() => setAct('authorize')}>
                Authorize to proceed
              </Button>
            )}
            {p.canAcknowledge && (
              <Button variant="primary" icon={<PackageCheck className="size-4" />} onClick={() => setAct('acknowledge')}>
                Acknowledge receipt
              </Button>
            )}
            {p.canReject && (
              <Button variant="danger" icon={<XCircle className="size-4" />} onClick={() => setAct('reject')}>
                Reject
              </Button>
            )}
            {p.canCancel && (
              <Button icon={<Ban className="size-4" />} onClick={() => setAct('cancel')}>
                Cancel
              </Button>
            )}
          </>
        }
      />
      <Notice tone="info" className="mb-5" title="Authorization is not inspection">
        "Authorized to proceed" records an administrative decision only. It is not proof of inspection or acceptance; package handling and inspection follow the
        establishment's approved procedures.
      </Notice>
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Delivery details" subtitle={DELIVERY_STATUS_INFO[status]?.description} />
          <KeyValue
            items={[
              { label: 'Company / supplier', value: d.company },
              { label: 'Category', value: catLabel },
              { label: 'Courier', value: d.courierName },
              { label: 'Courier phone', value: d.courierPhone },
              { label: 'Vehicle', value: d.vehicleId ? <Link to={`/vehicles/${d.vehicleId}`} className="font-mono text-forest-700 hover:underline">{d.vehicleRegistration}</Link> : null },
              { label: 'Recipient', value: d.recipientUserName ?? d.recipientName },
              { label: 'Recipient department', value: d.recipientDepartment },
              { label: 'Sponsor', value: d.sponsorName, hidden: !d.sponsorName },
              { label: 'Description', value: d.description },
              { label: 'Items', value: d.itemCount },
              { label: 'Location / gate', value: `${d.locationName}${d.gateName ? ` · ${d.gateName}` : ''}` },
              { label: 'Expected at', value: fmtDateTime(d.expectedAt), hidden: !d.expectedAt },
              { label: 'Arrived', value: fmtDateTime(d.arrivedAt) },
              { label: 'Authorization', value: d.authorizedAt ? `${fmtDateTime(d.authorizedAt)}${d.authorizedBy ? ` by ${d.authorizedBy}` : ''}${d.authorizationNote ? ` — ${d.authorizationNote}` : ''}` : 'Not authorized' },
              { label: 'Departed', value: fmtDateTime(d.departedAt) },
              { label: 'Status reason', value: d.statusReason, hidden: !d.statusReason },
              { label: 'Notes', value: d.notes, hidden: !d.notes },
              { label: 'Registered by', value: `${d.createdBy ?? '—'} · ${fmtDateTime(d.createdAt)}` },
            ]}
          />
        </Card>
        <div className="grid content-start gap-5">
          <Card>
            <CardHeader title="Receipt acknowledgement" />
            {d.receivedAt ? (
              <div className="space-y-1.5 text-sm">
                <div className="flex items-center gap-2 font-medium text-ok">
                  <PackageCheck className="size-4" aria-hidden /> Receipt acknowledged
                </div>
                <div className="text-ink-2">
                  Received by <span className="font-medium text-ink">{d.receivedByName ?? d.receivedByUser}</span>
                  {d.receivedByUser && d.receivedByName && d.receivedByName !== d.receivedByUser ? ` (recorded by ${d.receivedByUser})` : ''}
                </div>
                <div className="text-ink-3">{fmtDateTime(d.receivedAt)}</div>
                {d.receiptNote && <p className="text-ink-2">{d.receiptNote}</p>}
              </div>
            ) : (
              <p className="text-sm text-ink-3">{status === 'AUTHORIZED' ? 'Awaiting acknowledgement by the recipient.' : 'Not yet received.'}</p>
            )}
          </Card>
          <Card>
            <CardHeader title="Delivery person" subtitle="Movement status from recorded gate events" />
            <PresenceBadge state={d.presenceState} />
          </Card>
        </div>
      </div>
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Status history" />
          <Timeline
            items={(d.history as Row[]).map((h, i) => ({
              id: i,
              tone: DELIVERY_STATUS_INFO[h.toStatus as DeliveryStatus]?.tone ?? 'neutral',
              title: h.fromStatus === h.toStatus ? h.reason ?? 'Updated' : DELIVERY_STATUS_INFO[h.toStatus as DeliveryStatus]?.label ?? h.toStatus,
              meta: `${fmtDateTime(h.createdAt)} · ${h.actor}`,
              body: h.fromStatus === h.toStatus ? null : h.reason,
            }))}
          />
        </Card>
        <Card padded={false}>
          <div className="p-5 pb-0">
            <CardHeader title="Delivery person movement" />
          </div>
          <MovementTable events={d.events} />
        </Card>
      </div>

      <Modal
        open={!!act}
        onClose={close}
        title={cfg?.title ?? ''}
        description={`${d.reference} · ${d.company}`}
        footer={
          <>
            <Button onClick={close}>Close</Button>
            <Button variant={cfg?.variant ?? 'primary'} loading={run.isPending} disabled={!!cfg?.required && note.trim().length < 3} onClick={() => act && run.mutate(act)}>
              {cfg?.button}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          {act === 'authorize' && <Notice tone="info">Records that the delivery may proceed under applicable procedures. This is not inspection or acceptance.</Notice>}
          {act === 'acknowledge' && (
            <Input label="Received by (if not you)" value={receivedByName} onChange={(e) => setReceivedByName(e.target.value)} hint={`Defaults to ${me?.user.displayName}. Your account is recorded as acknowledging.`} />
          )}
          <Textarea label={cfg?.noteLabel} required={cfg?.required} value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
        </div>
      </Modal>
    </>
  );
}
