import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCheck, Eye } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime, titleCase } from '../lib/format';
import type { Row } from '../lib/types';
import { ALERT_TYPE_INFO, type AlertType } from '../../../shared/constants';
import { useAction } from '../components/toast';
import { Button, Card, CardHeader, ErrorState, KeyValue, Modal, Notice, PageHeader, Spinner, Textarea, Timeline } from '../components/ui';
import { AlertStatusBadge, ResultBadge, SeverityBadge } from '../components/status';
import { relatedLink } from '../components/ops/common';

const ACTION_TONE: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = { RAISED: 'danger', REPEATED: 'warning', ACKNOWLEDGED: 'info', RESOLVED: 'success' };

export default function AlertDetailPage() {
  const id = Number(useParams().id);
  const { can } = useAuth();
  const key = ['alerts', 'detail', id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Row>(`/alerts/${id}`) });
  const [mode, setMode] = useState<'acknowledge' | 'resolve' | null>(null);
  const [note, setNote] = useState('');
  const close = () => {
    setMode(null);
    setNote('');
  };
  const act = useAction((m: 'acknowledge' | 'resolve') => api.post(`/alerts/${id}/${m}`, { note: note || undefined }), {
    success: (_r) => (mode === 'resolve' ? 'Alert resolved' : 'Alert acknowledged'),
    invalidate: [key, ['alerts', 'list']],
    onSuccess: close,
  });

  if (q.isLoading) return <Spinner />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const a = q.data;
  const related = relatedLink(a.relatedType, a.relatedId);

  return (
    <>
      <PageHeader
        back={{ to: '/alerts', label: 'Alerts' }}
        eyebrow={ALERT_TYPE_INFO[a.type as AlertType]?.label ?? titleCase(a.type)}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {a.title}
            <SeverityBadge severity={a.severity} />
            <AlertStatusBadge status={a.status} />
          </span>
        }
        subtitle={<span className="font-mono">{a.reference}</span>}
        actions={
          <>
            {a.status === 'OPEN' && can('alerts.acknowledge') && (
              <Button icon={<Eye className="size-4" />} onClick={() => setMode('acknowledge')}>
                Acknowledge
              </Button>
            )}
            {a.status !== 'RESOLVED' && can('alerts.resolve') && (
              <Button variant="primary" icon={<CheckCheck className="size-4" />} onClick={() => setMode('resolve')}>
                Resolve
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="What happened" />
          <p className="mb-5 text-sm leading-relaxed text-ink">{a.description}</p>
          <KeyValue
            items={[
              { label: 'Location', value: a.locationName },
              { label: 'Gate', value: a.gateName },
              { label: 'Related record', value: related ? <Link to={related} className="text-forest-700 hover:underline">{a.relatedReference ?? `${titleCase(a.relatedType)} #${a.relatedId}`}</Link> : a.relatedReference },
              { label: 'Related event', value: a.eventId ? <Link to={`/events/${a.eventId}`} className="text-forest-700 hover:underline">View event</Link> : null, hidden: !a.eventId },
              { label: 'Occurrences', value: a.occurrenceCount },
              { label: 'First seen', value: fmtDateTime(a.firstSeenAt) },
              { label: 'Last seen', value: fmtDateTime(a.lastSeenAt) },
              { label: 'Acknowledged', value: a.acknowledgedAt ? `${fmtDateTime(a.acknowledgedAt)} by ${a.acknowledgedBy}` : 'Not acknowledged' },
              { label: 'Acknowledgement note', value: a.acknowledgementNote, hidden: !a.acknowledgementNote },
              { label: 'Resolved', value: a.resolvedAt ? `${fmtDateTime(a.resolvedAt)} by ${a.resolvedBy}` : 'Not resolved' },
              { label: 'Resolution note', value: a.resolutionNote, hidden: !a.resolutionNote },
            ]}
          />
          <Notice tone="info" className="mt-5">
            Acknowledging or resolving records a decision on this alert only. The underlying verification attempt or movement event is preserved unchanged.
          </Notice>
        </Card>
        <div className="grid content-start gap-5">
          {a.attempt && (
            <Card>
              <CardHeader title="Verification attempt" subtitle="Input shown masked" />
              <KeyValue
                columns={1}
                items={[
                  { label: 'Result', value: <ResultBadge result={a.attempt.resultCode} /> },
                  { label: 'Record type / method', value: `${titleCase(a.attempt.mode)} · ${titleCase(a.attempt.method)}` },
                  { label: 'Presented', value: <span className="font-mono">{a.attempt.inputDisplay}</span> },
                  { label: 'Operator', value: a.attempt.operatorName },
                  { label: 'Time', value: fmtDateTime(a.attempt.createdAt) },
                ]}
              />
            </Card>
          )}
          <Card>
            <CardHeader title="History" />
            <Timeline
              items={(a.history as Row[]).map((h) => ({
                id: h.id,
                tone: ACTION_TONE[h.action] ?? 'neutral',
                title: titleCase(h.action),
                meta: `${fmtDateTime(h.createdAt)} · ${h.actor}`,
                body: h.note,
              }))}
            />
          </Card>
        </div>
      </div>
      <Modal
        open={!!mode}
        onClose={close}
        title={mode === 'resolve' ? 'Resolve alert' : 'Acknowledge alert'}
        description={`${a.reference} · ${a.title}`}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" loading={act.isPending} disabled={mode === 'resolve' && note.trim().length < 3} onClick={() => mode && act.mutate(mode)}>
              {mode === 'resolve' ? 'Resolve alert' : 'Acknowledge'}
            </Button>
          </>
        }
      >
        <Textarea
          label={mode === 'resolve' ? 'Resolution note' : 'Note (optional)'}
          required={mode === 'resolve'}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={4}
          hint={mode === 'resolve' ? 'Describe how the matter was handled. Do not record sensitive operational instructions.' : undefined}
        />
      </Modal>
    </>
  );
}
