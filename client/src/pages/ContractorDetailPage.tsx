import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Pencil, RefreshCcw } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, todayLocal } from '../lib/format';
import type { Row } from '../lib/types';
import { CONTRACTOR_CATEGORY_LABEL, type ContractorCategory } from '../../../shared/constants';
import { useAction } from '../components/toast';
import { Avatar, Badge, Button, ButtonLink, Card, CardHeader, DataTable, EmptyState, ErrorState, KeyValue, Modal, Notice, PageHeader, Pill, Spinner } from '../components/ui';
import { PersonStatusBadge, PresenceBadge } from '../components/status';
import { CredentialPanel } from '../components/CredentialActions';
import { MovementTable } from '../components/MovementTable';
import { PassCard, PassPrintStyle } from '../components/visitors/PassCard';
import { hoursLabel } from '../components/visitors/helpers';

export default function ContractorDetailPage() {
  const id = Number(useParams().id);
  const { can } = useAuth();
  const key = ['contractors', 'detail', id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Row>(`/contractors/${id}`) });
  const canManage = !!q.data?.canManage;
  const pass = useQuery({ queryKey: ['contractors', 'pass', id], queryFn: () => api.get<Row>(`/contractors/${id}/pass`), enabled: canManage });
  const [reissueOpen, setReissueOpen] = useState(false);
  const reissue = useAction(() => api.post(`/contractors/${id}/pass/reissue`), {
    success: 'New contractor pass issued; the previous code no longer works',
    invalidate: [['contractors', 'pass', id]],
    onSuccess: () => setReissueOpen(false),
  });
  const today = todayLocal();

  if (q.isLoading) return <Spinner />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const c = q.data;
  const expired = c.validUntil < today;
  const upcoming = c.validFrom > today;
  const usable = c.status === 'ACTIVE' && c.companyStatus === 'ACTIVE' && !expired && !upcoming;

  return (
    <>
      <PassPrintStyle />
      <PageHeader
        back={{ to: '/contractors', label: 'Contractors' }}
        eyebrow={`${CONTRACTOR_CATEGORY_LABEL[c.category as ContractorCategory]} · ${c.reference}`}
        title={
          <span className="flex flex-wrap items-center gap-3">
            <Avatar name={c.fullName} size={44} />
            {c.fullName}
            <PersonStatusBadge status={c.status} />
            {c.status === 'ACTIVE' && expired && <Badge tone="danger">Expired</Badge>}
            {c.status === 'ACTIVE' && upcoming && <Badge tone="warning">Not yet valid</Badge>}
          </span>
        }
        subtitle={c.companyName}
        actions={
          canManage && (
            <ButtonLink to={`/contractors/people/${id}/edit`} icon={<Pencil className="size-4" />}>
              Edit
            </ButtonLink>
          )
        }
      />
      {!usable && (
        <Notice tone="warning" className="no-print mb-5" title="Access currently rejected at the gate">
          {c.status !== 'ACTIVE'
            ? `Record is ${String(c.status).toLowerCase()}${c.statusReason ? ` — ${c.statusReason}` : ''}.`
            : c.companyStatus !== 'ACTIVE'
              ? 'The organization is inactive.'
              : expired
                ? `Validity ended on ${fmtDate(c.validUntil)}.`
                : `Validity starts on ${fmtDate(c.validFrom)}.`}{' '}
          A person already recorded inside can still be recorded leaving.
        </Notice>
      )}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="no-print grid content-start gap-5">
          <Card>
            <CardHeader title="Access details" />
            <KeyValue
              items={[
                { label: 'Organization', value: <span>{c.companyName}{c.companyStatus !== 'ACTIVE' && <Badge tone="danger" className="ml-2">Inactive</Badge>}</span> },
                { label: 'Category', value: <Pill>{CONTRACTOR_CATEGORY_LABEL[c.category as ContractorCategory]}</Pill> },
                { label: 'Assignment / purpose', value: c.purpose },
                { label: 'Sponsoring department', value: c.sponsoringDepartment },
                { label: 'Sponsoring officer', value: c.sponsorName ?? '—' },
                { label: 'Authorized location', value: c.locationName },
                { label: 'Validity', value: `${fmtDate(c.validFrom)} – ${fmtDate(c.validUntil)}` },
                { label: 'Permitted hours', value: hoursLabel(c.windowStart, c.windowEnd, c.allowedDays) },
                { label: 'Phone', value: c.phone ?? '—' },
                { label: 'Last updated', value: fmtDateTime(c.updatedAt) },
                { label: 'Status reason', value: c.statusReason, hidden: !c.statusReason },
                { label: 'Notes', value: c.notes, hidden: !c.notes },
              ]}
            />
          </Card>
          {can('credentials.view') && (
            <Card>
              <CardHeader title="Credentials" subtitle="Optional contractor card. The QR pass can be used instead." />
              <CredentialPanel credentials={c.credentials} holderType="CONTRACTOR" holderId={id} canManage={can('credentials.manage') && canManage} invalidate={[key]} />
            </Card>
          )}
          <Card padded={false}>
            <div className="p-5 pb-0">
              <CardHeader title="Temporary access" subtitle="Short-term access issued to this person" />
            </div>
            <DataTable<Row>
              dense
              rows={c.temporaryAccess as Row[]}
              rowKey={(t) => t.id}
              rowHref={(t) => `/temporary-access/${t.id}`}
              empty={<EmptyState title="No temporary access issued" />}
              columns={[
                { key: 'reference', header: 'Reference', render: (t) => <span className="font-mono text-xs">{t.reference}</span> },
                { key: 'reason', header: 'Reason', render: (t) => t.reason },
                { key: 'valid', header: 'Valid', hideBelow: 'md', render: (t) => <span className="text-xs">{fmtDateTime(t.validFrom)} → {fmtDateTime(t.validUntil)}</span> },
                { key: 'status', header: 'Status', render: (t) => <PersonStatusBadge status={t.status} /> },
              ]}
            />
          </Card>
          <Card padded={false}>
            <div className="p-5 pb-0">
              <CardHeader title="Visit history" subtitle="Entries and exits at any gate in your authorized locations (latest 100)" />
            </div>
            <MovementTable events={c.events} />
          </Card>
        </div>
        <div className="grid content-start gap-5">
          <Card className="no-print">
            <CardHeader title="Recorded movement status" />
            <PresenceBadge state={c.presenceState} />
            {c.presenceSince && <p className="mt-2 text-sm text-ink-2">Since {fmtDateTime(c.presenceSince)}</p>}
            {c.lastMovementAt && (
              <p className="mt-1 text-xs text-ink-3">
                Last movement {fmtDateTime(c.lastMovementAt)}
              </p>
            )}
          </Card>
          {canManage &&
            (pass.isLoading ? (
              <Card>
                <Spinner label="Loading pass…" />
              </Card>
            ) : pass.data ? (
              <>
                <PassCard
                  kind="Contractor pass"
                  title={pass.data.fullName}
                  reference={pass.data.reference}
                  qrSvg={pass.data.qrSvg}
                  token={pass.data.token}
                  status={usable ? <Badge tone="success">Valid</Badge> : <Badge tone="danger">Not currently valid</Badge>}
                  lines={[
                    { label: 'Organization', value: pass.data.companyName },
                    { label: 'Location', value: pass.data.locationName },
                    { label: 'Valid', value: `${fmtDate(pass.data.validFrom)} – ${fmtDate(pass.data.validUntil)}` },
                    { label: 'Hours', value: hoursLabel(c.windowStart, c.windowEnd, c.allowedDays) },
                  ]}
                />
                <div className="no-print flex justify-center">
                  <Button size="sm" variant="ghost" icon={<RefreshCcw className="size-3.5" />} onClick={() => setReissueOpen(true)}>
                    Reissue pass (invalidate current code)
                  </Button>
                </div>
              </>
            ) : (
              <ErrorState error={pass.error} onRetry={() => pass.refetch()} />
            ))}
        </div>
      </div>
      <Modal
        open={reissueOpen}
        onClose={() => setReissueOpen(false)}
        title="Reissue contractor pass?"
        description="Use this if a printed pass is lost or may have been copied."
        footer={
          <>
            <Button onClick={() => setReissueOpen(false)}>Cancel</Button>
            <Button variant="danger" loading={reissue.isPending} onClick={() => reissue.mutate(undefined)}>
              Reissue pass
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">The current QR code stops working immediately. Print or share the new pass with the contractor. This action is audited.</p>
      </Modal>
    </>
  );
}
