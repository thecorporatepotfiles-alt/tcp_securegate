import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Ban, FilePlus2, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDateTime, titleCase } from '../lib/format';
import type { Row } from '../lib/types';
import { REGISTER_CATEGORY_LABEL, VERIFICATION_METHOD_LABEL, type RegisterCategory, type ResultCode, type VerificationMethod } from '../../../shared/constants';
import { useAction } from '../components/toast';
import { Button, Card, CardHeader, ErrorState, KeyValue, Modal, Notice, PageHeader, Spinner, Textarea, Timeline } from '../components/ui';
import { CategoryPill, EventTypeBadge, ResultBadge } from '../components/status';
import { OutcomeBadge } from '../components/oversight/OutcomeBadge';
import { MissingEventModal } from '../components/oversight/MissingEventModal';

export default function EventDetailPage() {
  const id = Number(useParams().id);
  const key = ['events', 'detail', id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Row>(`/events/${id}`) });
  const [voidOpen, setVoidOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [missingOpen, setMissingOpen] = useState(false);
  const voidEvent = useAction(() => api.post<{ reference: string }>(`/events/${id}/void`, { reason: reason.trim() }), {
    success: (r) => `Event voided by correction ${r.reference}`,
    invalidate: [key, ['events'], ['presence'], ['dashboard']],
    onSuccess: () => {
      setVoidOpen(false);
      setReason('');
    },
  });

  if (q.isLoading) return <Spinner />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const e = q.data;
  const category = (e.temporaryAccessId ? 'TEMPORARY' : e.category) as RegisterCategory;

  return (
    <>
      <PageHeader
        back={{ to: '/register', label: 'Gate register' }}
        eyebrow="Movement event"
        title={
          <span className="flex flex-wrap items-center gap-3">
            <EventTypeBadge type={e.eventType} voided={e.voided} />
            <span>{e.subjectName ?? 'Unknown subject'}</span>
            <OutcomeBadge outcome={e.outcome} voided={e.voided} />
          </span>
        }
        subtitle={<span className="font-mono">{e.reference}</span>}
        actions={
          e.canCorrect && (
            <>
              <Button icon={<FilePlus2 className="size-4" />} onClick={() => setMissingOpen(true)}>
                Record missing movement
              </Button>
              {!e.voided && (
                <Button variant="danger" icon={<Ban className="size-4" />} onClick={() => setVoidOpen(true)}>
                  Void event
                </Button>
              )}
            </>
          )
        }
      />
      {e.voided ? (
        <Notice tone="warning" className="mb-5" title="This event has been voided">
          It is kept in the register for accountability but no longer counts toward inside/outside status. See the correction record below.
        </Notice>
      ) : null}
      {e.outcome === 'CORRECTION_ENTRY' && (
        <Notice tone="info" className="mb-5" title="Administrative correction entry">
          Added after the fact by an authorized user. Reported to have occurred at {fmtDateTime(e.reportedOccurredAt)}; recorded by the server at {fmtDateTime(e.recordedAt)}.
        </Notice>
      )}
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Event details" subtitle="Timestamps are server-generated and authoritative." />
          <KeyValue
            items={[
              { label: 'Event', value: <EventTypeBadge type={e.eventType} voided={e.voided} /> },
              { label: 'Category', value: <CategoryPill category={category} /> },
              {
                label: 'Subject',
                value: (
                  <Link to={e.link} className="font-medium text-forest-700 hover:text-forest-900">
                    {e.subjectName ?? '—'}
                  </Link>
                ),
              },
              { label: 'Subject reference', value: e.subjectReference },
              { label: 'Unit / organization', value: e.subjectOrganization },
              { label: 'Record type', value: REGISTER_CATEGORY_LABEL[category] ?? titleCase(e.subjectType) },
              { label: 'Location', value: e.locationName },
              { label: 'Gate', value: e.gateName },
              { label: 'Recorded at (server)', value: fmtDateTime(e.recordedAt) },
              { label: 'Reported occurrence time', value: fmtDateTime(e.reportedOccurredAt), hidden: !e.reportedOccurredAt },
              { label: 'Verification method', value: VERIFICATION_METHOD_LABEL[e.verificationMethod as VerificationMethod] ?? e.verificationMethod },
              { label: 'Outcome', value: <OutcomeBadge outcome={e.outcome} voided={e.voided} /> },
              { label: 'Operator', value: e.operatorName ?? 'System' },
              { label: 'Driver reference', value: e.driverReference, hidden: !e.driverReference },
              { label: 'Notes', value: e.notes, hidden: !e.notes },
              { label: 'Event reference', value: <span className="font-mono">{e.reference}</span> },
            ]}
          />
        </Card>
        <div className="space-y-5">
          <Card>
            <CardHeader title="Verification" subtitle="The check that preceded this movement" />
            {e.attempt ? (
              <KeyValue
                columns={1}
                items={[
                  { label: 'Result', value: <ResultBadge result={e.attempt.resultCode as ResultCode} /> },
                  { label: 'Presented (masked)', value: <span className="font-mono">{e.attempt.inputDisplay}</span> },
                  { label: 'Method', value: VERIFICATION_METHOD_LABEL[e.attempt.method as VerificationMethod] ?? e.attempt.method },
                  { label: 'Verified at', value: fmtDateTime(e.attempt.createdAt) },
                ]}
              />
            ) : (
              <p className="text-sm text-ink-3">{e.outcome === 'CORRECTION_ENTRY' ? 'Not applicable — administrative correction.' : 'No linked verification attempt (historical synthetic record).'}</p>
            )}
          </Card>
          {e.manualReview && (
            <Card>
              <CardHeader title="Manual review" subtitle={<span className="font-mono">{e.manualReview.reference}</span>} />
              <KeyValue
                columns={1}
                items={[
                  { label: 'Requested because', value: e.manualReview.requestNote },
                  { label: 'Decided by', value: `${e.manualReview.decidedBy ?? '—'} · ${fmtDateTime(e.manualReview.decidedAt)}` },
                  { label: 'Decision note', value: e.manualReview.decisionNote },
                ]}
              />
            </Card>
          )}
          <Card>
            <CardHeader title="Corrections" subtitle="Append-only; originals are never rewritten" />
            {e.corrections.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-ink-3">
                <ShieldCheck className="size-4 text-ok" aria-hidden /> No corrections recorded.
              </p>
            ) : (
              <Timeline
                items={e.corrections.map((c: Row) => ({
                  id: c.reference,
                  tone: c.type === 'VOID_EVENT' ? 'warning' : 'info',
                  title: `${c.type === 'VOID_EVENT' ? 'Voided' : 'Missing movement added'} · ${c.reference}`,
                  meta: `${c.requestedBy} · ${fmtDateTime(c.createdAt)}`,
                  body: c.reason,
                }))}
              />
            )}
          </Card>
        </div>
      </div>

      <Modal
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        title="Void this movement event"
        description={`${e.reference} · ${e.subjectName ?? ''}`}
        footer={
          <>
            <Button onClick={() => setVoidOpen(false)}>Cancel</Button>
            <Button variant="danger" disabled={reason.trim().length < 5} loading={voidEvent.isPending} onClick={() => voidEvent.mutate(undefined)}>
              Void event
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <Notice tone="info">The event stays in the register, marked as voided, and a correction record is created and audited. Inside/outside status is recalculated from the remaining valid events.</Notice>
          <Textarea label="Reason" required value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="e.g. Duplicate entry recorded in error at shift change (min 5 characters)" />
        </div>
      </Modal>
      <MissingEventModal
        open={missingOpen}
        onClose={() => setMissingOpen(false)}
        subject={{ type: e.subjectType, id: e.subjectId, name: e.subjectName ?? 'Subject', reference: e.subjectReference, locationId: e.locationId }}
        defaultEventType={e.eventType === 'ENTRY' ? 'EXIT' : 'ENTRY'}
        onDone={() => q.refetch()}
      />
    </>
  );
}
