import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtDateTime, titleCase } from '../lib/format';
import type { Row } from '../lib/types';
import { EXCEPTION_CATEGORY_LABEL, EXCEPTION_STATUS_INFO, EXCEPTION_TRANSITIONS, ROLES, ROLE_INFO, type ExceptionCategory, type ExceptionStatus, type RoleCode } from '../../../shared/constants';
import { useAction } from '../components/toast';
import { Button, Card, CardHeader, ErrorState, KeyValue, Modal, PageHeader, Select, Spinner, Textarea, Timeline } from '../components/ui';
import { ExceptionStatusBadge } from '../components/status';
import { relatedLink } from '../components/ops/common';

const ACTION_LABEL: Record<ExceptionStatus, string> = { OPEN: 'Reopen', UNDER_REVIEW: 'Start review', RESOLVED: 'Resolve' };

export default function ExceptionDetailPage() {
  const id = Number(useParams().id);
  const key = ['exceptions', 'detail', id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Row>(`/exceptions/${id}`) });
  const [target, setTarget] = useState<ExceptionStatus | null>(null);
  const [note, setNote] = useState('');
  const [assignOpen, setAssignOpen] = useState(false);
  const [role, setRole] = useState('');
  const [userId, setUserId] = useState('');
  const users = useQuery({
    queryKey: ['lookup', 'users', q.data?.locationId],
    queryFn: () => api.get<Row[]>('/lookups/users', { locationId: q.data!.locationId }),
    enabled: assignOpen && !!q.data?.locationId,
  });
  const change = useAction((v: { status: ExceptionStatus; note: string }) => api.post(`/exceptions/${id}/status`, { status: v.status, note: v.note || undefined }), {
    success: 'Exception updated',
    invalidate: [key, ['exceptions', 'list']],
    onSuccess: () => {
      setTarget(null);
      setNote('');
    },
  });
  const assign = useAction(() => api.post(`/exceptions/${id}/assign`, { responsibleRole: role || null, responsibleUserId: userId ? Number(userId) : null }), {
    success: 'Responsibility updated',
    invalidate: [key, ['exceptions', 'list']],
    onSuccess: () => setAssignOpen(false),
  });

  if (q.isLoading) return <Spinner />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const x = q.data;
  const status = x.status as ExceptionStatus;
  const next = EXCEPTION_TRANSITIONS[status];
  const related = relatedLink(x.relatedType, x.relatedId);

  return (
    <>
      <PageHeader
        back={{ to: '/exceptions', label: 'Administrative exceptions' }}
        eyebrow={EXCEPTION_CATEGORY_LABEL[x.category as ExceptionCategory] ?? titleCase(x.category)}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {x.title}
            <ExceptionStatusBadge status={status} />
          </span>
        }
        subtitle={<span className="font-mono">{x.reference}</span>}
        actions={
          x.canManage && (
            <>
              {status !== 'RESOLVED' && (
                <Button
                  onClick={() => {
                    setRole(x.responsibleRole ?? '');
                    setUserId(x.responsibleUserId ? String(x.responsibleUserId) : '');
                    setAssignOpen(true);
                  }}
                >
                  Reassign
                </Button>
              )}
              {next.map((s) => (
                <Button key={s} variant={s === 'RESOLVED' ? 'primary' : 'secondary'} onClick={() => setTarget(s)}>
                  {ACTION_LABEL[s]}
                </Button>
              ))}
            </>
          )
        }
      />
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Details" />
          <p className="mb-5 text-sm leading-relaxed whitespace-pre-line text-ink">{x.description}</p>
          <KeyValue
            items={[
              { label: 'Location', value: x.locationName },
              { label: 'Category', value: EXCEPTION_CATEGORY_LABEL[x.category as ExceptionCategory] ?? titleCase(x.category) },
              { label: 'Related record', value: related ? <Link to={related} className="text-forest-700 hover:underline">{x.relatedReference ?? 'View record'}</Link> : x.relatedReference },
              { label: 'Responsible', value: [x.responsibleUserName, x.responsibleRole ? ROLE_INFO[x.responsibleRole as RoleCode]?.name : null].filter(Boolean).join(' · ') || 'Unassigned' },
              { label: 'Created', value: `${fmtDateTime(x.createdAt)}${x.createdBy ? ` by ${x.createdBy}` : ''}` },
              { label: 'Last updated', value: fmtDateTime(x.updatedAt) },
              { label: 'Resolved', value: x.resolvedAt ? `${fmtDateTime(x.resolvedAt)} by ${x.resolvedBy}` : 'Not resolved' },
              { label: 'Resolution note', value: x.resolutionNote, hidden: !x.resolutionNote },
            ]}
          />
        </Card>
        <Card>
          <CardHeader title="History" subtitle="All status changes are preserved" />
          <Timeline
            items={(x.history as Row[]).map((h, i) => ({
              id: i,
              tone: EXCEPTION_STATUS_INFO[h.toStatus as ExceptionStatus]?.tone ?? 'neutral',
              title: h.fromStatus ? `${EXCEPTION_STATUS_INFO[h.fromStatus as ExceptionStatus]?.label ?? h.fromStatus} → ${EXCEPTION_STATUS_INFO[h.toStatus as ExceptionStatus]?.label ?? h.toStatus}` : 'Created',
              meta: `${fmtDateTime(h.createdAt)} · ${h.actor}`,
              body: h.note && h.note !== 'Created' ? h.note : null,
            }))}
          />
        </Card>
      </div>

      <Modal
        open={!!target}
        onClose={() => setTarget(null)}
        title={target ? ACTION_LABEL[target] : ''}
        description={`${x.reference} · ${x.title}`}
        footer={
          <>
            <Button onClick={() => setTarget(null)}>Cancel</Button>
            <Button variant="primary" loading={change.isPending} disabled={target === 'RESOLVED' && note.trim().length < 5} onClick={() => target && change.mutate({ status: target, note })}>
              {target ? ACTION_LABEL[target] : ''}
            </Button>
          </>
        }
      >
        <Textarea
          label={target === 'RESOLVED' ? 'Resolution note' : 'Note (optional)'}
          required={target === 'RESOLVED'}
          rows={4}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          hint={target === 'RESOLVED' ? 'Minimum 5 characters. Recorded with your name and the time.' : undefined}
        />
      </Modal>

      <Modal
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        title="Reassign responsibility"
        footer={
          <>
            <Button onClick={() => setAssignOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={assign.isPending} onClick={() => assign.mutate(undefined)}>
              Save
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <Select label="Responsible role" value={role} onChange={(e) => setRole(e.target.value)} placeholder="No role" options={ROLES.map((r) => ({ value: r, label: ROLE_INFO[r].name }))} />
          <Select
            label="Responsible user"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder={users.isLoading ? 'Loading…' : 'Not assigned to a person'}
            options={(users.data ?? []).map((u) => ({ value: u.id, label: `${u.name} · ${ROLE_INFO[u.role as RoleCode]?.name ?? u.role}` }))}
          />
        </div>
      </Modal>
    </>
  );
}
