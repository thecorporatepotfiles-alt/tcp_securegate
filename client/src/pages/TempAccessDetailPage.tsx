import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Ban } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import type { Row } from '../lib/types';
import { useAction } from '../components/toast';
import { Avatar, Button, Card, CardHeader, DataTable, EmptyState, ErrorState, KeyValue, Notice, PageHeader, Pill, Spinner } from '../components/ui';
import { EventTypeBadge } from '../components/status';
import { PassCard, PassPrintStyle } from '../components/visitors/PassCard';
import { ReasonModal } from '../components/visitors/ReasonModal';
import { HOLDER_LABEL, TempStatusBadge } from '../components/visitors/TempStatusBadge';

export default function TempAccessDetailPage() {
  const id = Number(useParams().id);
  const key = ['temporary-access', 'detail', id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Row>(`/temporary-access/${id}`) });
  const canManage = !!q.data?.canManage;
  const pass = useQuery({ queryKey: ['temporary-access', 'pass', id], queryFn: () => api.get<Row>(`/temporary-access/${id}/pass`), enabled: canManage });
  const [revokeOpen, setRevokeOpen] = useState(false);
  const revoke = useAction((reason: string) => api.post(`/temporary-access/${id}/revoke`, { reason }), {
    success: 'Temporary access revoked',
    invalidate: [key, ['temporary-access', 'list'], ['temporary-access', 'pass', id]],
    onSuccess: () => setRevokeOpen(false),
  });

  if (q.isLoading) return <Spinner />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const t = q.data;
  const holderLink = t.holderType === 'PERSONNEL' ? `/personnel/${t.personnelId}` : t.holderType === 'CONTRACTOR' ? `/contractors/people/${t.contractorId}` : null;

  return (
    <>
      <PassPrintStyle />
      <PageHeader
        back={{ to: '/temporary-access', label: 'Temporary access' }}
        eyebrow={`Temporary access · ${t.reference}`}
        title={
          <span className="flex flex-wrap items-center gap-3">
            <Avatar name={t.holderName} size={44} tone="gold" />
            {t.holderName}
            <TempStatusBadge status={t.effectiveStatus} />
          </span>
        }
        subtitle={`${HOLDER_LABEL[t.holderType]}${t.holderOrganization ? ` · ${t.holderOrganization}` : ''}`}
        actions={
          canManage &&
          t.status !== 'REVOKED' && (
            <Button variant="danger" icon={<Ban className="size-4" />} onClick={() => setRevokeOpen(true)}>
              Revoke
            </Button>
          )
        }
      />
      {t.effectiveStatus === 'REVOKED' && (
        <Notice tone="danger" className="no-print mb-5" title="Revoked">
          {t.revokedBy ? `By ${t.revokedBy}` : ''} {t.revokedAt ? `on ${fmtDateTime(t.revokedAt)}` : ''}
          {t.revokedReason ? ` — ${t.revokedReason}` : ''}. The pass is rejected at the gate.
        </Notice>
      )}
      {t.effectiveStatus === 'EXPIRED' && (
        <Notice tone="info" className="no-print mb-5" title="Expired">
          Validity ended {fmtDateTime(t.validUntil)}. The pass is rejected at the gate; an exit can still be recorded for someone already inside.
        </Notice>
      )}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="no-print grid content-start gap-5">
          <Card>
            <CardHeader title="Access details" />
            <KeyValue
              items={[
                { label: 'Holder', value: holderLink ? <Link to={holderLink} className="font-medium text-forest-700 hover:underline">{t.holderName}</Link> : t.holderName },
                { label: 'Holder type', value: <Pill>{HOLDER_LABEL[t.holderType]}</Pill> },
                { label: 'Organization', value: t.holderOrganization ?? '—' },
                { label: 'Phone', value: t.holderPhone ?? '—' },
                { label: 'Location', value: t.locationName },
                { label: 'Sponsoring department', value: t.sponsoringDepartment ?? '—' },
                { label: 'Valid from', value: fmtDateTime(t.validFrom) },
                { label: 'Valid until', value: fmtDateTime(t.validUntil) },
                { label: 'Reason', value: t.reason },
                { label: 'Issued', value: `${fmtDateTime(t.createdAt)}${t.issuedBy ? ` · ${t.issuedBy}` : ''}` },
              ]}
            />
          </Card>
          <Card padded={false}>
            <div className="p-5 pb-0">
              <CardHeader title="Movements on this access" subtitle="Entries and exits recorded using this temporary access" />
            </div>
            <DataTable<Row>
              dense
              rows={t.events as Row[]}
              rowKey={(e) => e.id}
              rowHref={(e) => `/events/${e.id}`}
              empty={<EmptyState title="No movement recorded with this access" />}
              columns={[
                { key: 'recordedAt', header: 'Recorded', render: (e) => fmtDateTime(e.recordedAt) },
                { key: 'type', header: 'Event', render: (e) => <EventTypeBadge type={e.eventType} /> },
                { key: 'gate', header: 'Gate', render: (e) => `${e.gateName} · ${e.locationName}` },
                { key: 'ref', header: 'Ref', hideBelow: 'md', render: (e) => <span className="font-mono text-xs text-ink-3">{e.reference}</span> },
              ]}
            />
          </Card>
        </div>
        <div className="order-first grid content-start gap-5 lg:order-none">
          {canManage ? (
            pass.isLoading ? (
              <Card>
                <Spinner label="Loading pass…" />
              </Card>
            ) : pass.data ? (
              <PassCard
                kind="Temporary access pass"
                title={pass.data.holderName}
                reference={pass.data.reference}
                qrSvg={pass.data.qrSvg}
                token={t.effectiveStatus === 'ACTIVE' || t.effectiveStatus === 'UPCOMING' ? pass.data.token : undefined}
                status={<TempStatusBadge status={pass.data.effectiveStatus} />}
                validFrom={pass.data.validFrom}
                validUntil={pass.data.validUntil}
                lines={[
                  { label: 'Organization', value: pass.data.holderOrganization ?? '—' },
                  { label: 'Location', value: pass.data.locationName },
                ]}
              />
            ) : (
              <ErrorState error={pass.error} onRetry={() => pass.refetch()} />
            )
          ) : (
            <Card className="no-print">
              <CardHeader title="Pass" />
              <p className="text-sm text-ink-2">Only users who manage temporary access can display the pass.</p>
            </Card>
          )}
        </div>
      </div>
      <ReasonModal
        open={revokeOpen}
        onClose={() => setRevokeOpen(false)}
        title="Revoke temporary access"
        description={`${t.holderName} · ${t.reference}`}
        confirmLabel="Revoke access"
        variant="danger"
        loading={revoke.isPending}
        warning="The pass will be rejected at the gate immediately. A person already inside can still be recorded leaving."
        onConfirm={(r) => revoke.mutate(r)}
      />
    </>
  );
}
