import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtDateTime, titleCase } from '../lib/format';
import type { Row } from '../lib/types';
import { CREDENTIAL_TYPE_LABEL, type CredentialStatus, type CredentialType } from '../../../shared/constants';
import { Button, Card, CardHeader, DataTable, ErrorState, KeyValue, Notice, PageHeader, Spinner, Timeline } from '../components/ui';
import { CredentialStatusBadge, ResultBadge, SimulatedTag } from '../components/status';
import { CredentialStatusModal } from '../components/CredentialActions';
import { holderLink } from '../components/ops/common';

type Action = 'BLOCK' | 'REPORT_LOST' | 'DEACTIVATE' | 'REACTIVATE' | 'REPLACE';

const HISTORY_TONE: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  ISSUED: 'success',
  ISSUED_AS_REPLACEMENT: 'success',
  REACTIVATED: 'success',
  BLOCKED: 'danger',
  REPORTED_LOST: 'danger',
  DEACTIVATED: 'warning',
  REPLACED: 'info',
  EXPIRED: 'neutral',
};

export default function CredentialDetailPage() {
  const id = Number(useParams().id);
  const key = ['credentials', 'detail', id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Row>(`/credentials/${id}`) });
  const [action, setAction] = useState<Action | null>(null);

  if (q.isLoading) return <Spinner />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const c = q.data;
  const status = c.status as CredentialStatus;
  const holderTo = holderLink(c.holderType, c.personnelId, c.contractorId);
  const blocked = ['BLOCKED', 'LOST', 'INACTIVE', 'REPLACED', 'EXPIRED'].includes(status);

  return (
    <>
      <PageHeader
        back={{ to: '/credentials', label: 'Credentials' }}
        eyebrow="Credential"
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="font-mono">{c.credentialNumber}</span>
            <CredentialStatusBadge status={status} />
            {c.isTemporary ? <span className="text-sm font-medium text-gold-600">Temporary</span> : null}
          </span>
        }
        subtitle={
          <>
            {CREDENTIAL_TYPE_LABEL[c.credentialType as CredentialType]} held by {holderTo ? <Link to={holderTo} className="font-medium text-forest-700 hover:underline">{c.holderName}</Link> : c.holderName}
          </>
        }
        actions={
          c.canManage && (
            <>
              {status === 'ACTIVE' && (
                <>
                  <Button onClick={() => setAction('REPLACE')}>Replace</Button>
                  <Button onClick={() => setAction('REPORT_LOST')}>Report lost</Button>
                  <Button onClick={() => setAction('DEACTIVATE')}>Deactivate</Button>
                  <Button variant="danger" onClick={() => setAction('BLOCK')}>
                    Block
                  </Button>
                </>
              )}
              {(status === 'INACTIVE' || status === 'BLOCKED') && <Button onClick={() => setAction('REACTIVATE')}>Reactivate</Button>}
              {status === 'INACTIVE' && (
                <Button variant="danger" onClick={() => setAction('BLOCK')}>
                  Block
                </Button>
              )}
            </>
          )
        }
      />
      {blocked && (
        <Notice tone={status === 'BLOCKED' || status === 'LOST' ? 'danger' : 'warning'} className="mb-5" title={`This credential is ${titleCase(status).toLowerCase()}`}>
          Gate verification rejects it{c.statusReason ? ` — ${c.statusReason}` : ''}.
        </Notice>
      )}
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Credential details" />
          <KeyValue
            items={[
              { label: 'Credential number', value: <span className="font-mono">{c.credentialNumber}</span> },
              { label: 'Type', value: CREDENTIAL_TYPE_LABEL[c.credentialType as CredentialType] },
              { label: 'Holder', value: holderTo ? <Link to={holderTo} className="text-forest-700 hover:underline">{c.holderName}</Link> : c.holderName },
              { label: 'Holder reference', value: <span className="font-mono">{c.holderReference}</span> },
              { label: 'Valid from', value: fmtDateTime(c.validFrom) },
              { label: 'Valid until', value: c.validUntil ? fmtDateTime(c.validUntil) : 'No expiry' },
              { label: 'Issued', value: `${fmtDateTime(c.issuedAt)}${c.issuedBy ? ` by ${c.issuedBy}` : ''}` },
              { label: 'Status reason', value: c.statusReason },
              { label: 'Replaces', value: c.replacesId ? <Link to={`/credentials/${c.replacesId}`} className="text-forest-700 hover:underline">Previous credential</Link> : null, hidden: !c.replacesId },
              { label: 'Replaced by', value: c.replacedById ? <Link to={`/credentials/${c.replacedById}`} className="text-forest-700 hover:underline">Replacement credential</Link> : null, hidden: !c.replacedById },
            ]}
          />
        </Card>
        <Card>
          <CardHeader title="Future RFID/NFC readers" subtitle={<SimulatedTag>Simulated in this prototype</SimulatedTag>} />
          <p className="text-sm leading-relaxed text-ink-2">
            The credential stores only an opaque number. Readers approved later would submit that number to the same server-side verification service used by the gate
            interface, so every rule, alert and audit record applies unchanged. No hardware is connected or claimed to be compatible.
          </p>
        </Card>
      </div>
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Credential history" subtitle="Every issue, status change and replacement" />
          <Timeline
            items={(c.history as Row[]).map((h) => ({
              id: h.id,
              tone: HISTORY_TONE[h.action] ?? 'neutral',
              title: titleCase(h.action),
              meta: `${fmtDateTime(h.createdAt)} · ${h.actor}${h.fromStatus || h.toStatus ? ` · ${h.fromStatus ? titleCase(h.fromStatus) : '—'} → ${h.toStatus ? titleCase(h.toStatus) : '—'}` : ''}`,
              body: h.reason,
            }))}
          />
        </Card>
        <Card padded={false}>
          <div className="p-5 pb-0">
            <CardHeader title="Recent verification uses" subtitle="Last 20 presentations at a gate" />
          </div>
          <DataTable
            dense
            rows={c.recentUse as Row[]}
            rowKey={(r) => `${r.createdAt}-${r.gateName}`}
            empty={<p className="px-5 py-8 text-center text-sm text-ink-3">This credential has not been presented at a gate yet.</p>}
            columns={[
              { key: 'createdAt', header: 'Time', render: (r) => <span className="whitespace-nowrap">{fmtDateTime(r.createdAt)}</span> },
              { key: 'gateName', header: 'Gate' },
              { key: 'resultCode', header: 'Result', render: (r) => <ResultBadge result={r.resultCode} /> },
            ]}
          />
        </Card>
      </div>
      <CredentialStatusModal credential={c} action={action} onClose={() => setAction(null)} invalidate={[key]} />
    </>
  );
}
