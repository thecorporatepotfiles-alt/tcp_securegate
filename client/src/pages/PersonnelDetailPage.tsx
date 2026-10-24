import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Power } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime } from '../lib/format';
import type { Row } from '../lib/types';
import { useAction } from '../components/toast';
import { Avatar, Button, ButtonLink, Card, CardHeader, ErrorState, KeyValue, Modal, Notice, PageHeader, Pill, Spinner, Textarea } from '../components/ui';
import { PersonStatusBadge, PresenceBadge } from '../components/status';
import { CredentialPanel } from '../components/CredentialActions';
import { MovementTable } from '../components/MovementTable';

export default function PersonnelDetailPage() {
  const id = Number(useParams().id);
  const { can } = useAuth();
  const key = ['personnel', 'detail', id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Row>(`/personnel/${id}`) });
  const [statusOpen, setStatusOpen] = useState(false);
  const [reason, setReason] = useState('');
  const toggle = useAction((v: { status: string; reason: string }) => api.post(`/personnel/${id}/status`, v), {
    success: (r: any) => `Record ${r.status === 'ACTIVE' ? 'activated' : 'deactivated'}`,
    invalidate: [key, ['personnel', 'list']],
    onSuccess: () => {
      setStatusOpen(false);
      setReason('');
    },
  });

  if (q.isLoading) return <Spinner />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const p = q.data;
  const nextStatus = p.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';

  return (
    <>
      <PageHeader
        back={{ to: '/personnel', label: 'Personnel directory' }}
        eyebrow="Personnel record"
        title={
          <span className="flex flex-wrap items-center gap-3">
            <Avatar name={p.fullName} size={44} />
            {[p.rank, p.fullName].filter(Boolean).join(' ')}
            <PersonStatusBadge status={p.status} />
          </span>
        }
        subtitle={<span className="font-mono">{p.serviceNumber}</span>}
        actions={
          p.canManage && (
            <>
              <ButtonLink to={`/personnel/${id}/edit`} icon={<Pencil className="size-4" />}>
                Edit
              </ButtonLink>
              <Button variant={p.status === 'ACTIVE' ? 'danger' : 'primary'} icon={<Power className="size-4" />} onClick={() => setStatusOpen(true)}>
                {p.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
              </Button>
            </>
          )
        }
      />
      {p.status === 'INACTIVE' && (
        <Notice tone="warning" className="mb-5" title="Inactive record">
          Gate verification rejects this person while the record is inactive{p.statusReason ? ` — ${p.statusReason}` : ''}.
        </Notice>
      )}
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Record details" />
          <KeyValue
            items={[
              { label: 'Rank', value: p.rank },
              { label: 'Designation', value: p.designation },
              { label: 'Unit', value: p.unit },
              { label: 'Department', value: p.department },
              { label: 'Assigned location', value: p.locationName },
              {
                label: 'Authorized locations',
                value: (
                  <span className="flex flex-wrap gap-1">
                    {p.authorizedLocations.map((l: Row) => (
                      <Pill key={l.id}>{l.name}</Pill>
                    ))}
                  </span>
                ),
              },
              { label: 'Access valid from', value: fmtDate(p.accessValidFrom) },
              { label: 'Access valid until', value: p.accessValidUntil ? fmtDate(p.accessValidUntil) : 'No end date' },
              { label: 'Notes', value: p.notes },
              { label: 'Last updated', value: fmtDateTime(p.updatedAt) },
            ]}
          />
        </Card>
        <Card>
          <CardHeader title="Recorded movement status" subtitle="Derived from the latest valid gate event" />
          <div className="space-y-2">
            <PresenceBadge state={p.presenceState} />
            {p.presenceState && (
              <p className="text-sm text-ink-2">
                {p.presenceState === 'INSIDE' ? 'Inside' : 'Exited'} {p.presenceLocation ? `at ${p.presenceLocation}` : ''} since {fmtDateTime(p.presenceSince)}
              </p>
            )}
            <p className="text-xs text-ink-3">Status cannot be edited directly. Authorized corrections are made from the gate register and are audited.</p>
          </div>
        </Card>
      </div>
      {can('credentials.view') && (
        <Card className="mt-5">
          <CardHeader title="Credentials" subtitle="Simulated RFID/NFC credentials. Blocked, lost or inactive credentials are rejected at the gate." />
          <CredentialPanel credentials={p.credentials} holderType="PERSONNEL" holderId={id} canManage={can('credentials.manage') && p.canManage} invalidate={[key]} />
        </Card>
      )}
      <Card className="mt-5" padded={false}>
        <div className="p-5 pb-0">
          <CardHeader title="Entry–exit history" subtitle="Most recent 100 movements in your authorized locations" />
        </div>
        <MovementTable events={p.events} />
      </Card>

      <Modal
        open={statusOpen}
        onClose={() => setStatusOpen(false)}
        title={nextStatus === 'INACTIVE' ? 'Deactivate personnel record' : 'Activate personnel record'}
        description={`${p.fullName} · ${p.serviceNumber}`}
        footer={
          <>
            <Button onClick={() => setStatusOpen(false)}>Cancel</Button>
            <Button variant={nextStatus === 'INACTIVE' ? 'danger' : 'primary'} loading={toggle.isPending} disabled={reason.trim().length < 3} onClick={() => toggle.mutate({ status: nextStatus, reason })}>
              {nextStatus === 'INACTIVE' ? 'Deactivate' : 'Activate'}
            </Button>
          </>
        }
      >
        {nextStatus === 'INACTIVE' && <Notice tone="warning" className="mb-4">Subsequent verification of this person's credentials will be rejected.</Notice>}
        <Textarea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Recorded in the audit trail" />
      </Modal>
    </>
  );
}
