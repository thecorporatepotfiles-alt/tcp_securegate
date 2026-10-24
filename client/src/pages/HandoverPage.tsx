import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCheck, Repeat2 } from 'lucide-react';
import { api, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLocationScope } from '../lib/location';
import { fmtDateTime } from '../lib/format';
import type { Row } from '../lib/types';
import { ROLE_INFO, type RoleCode } from '../../../shared/constants';
import { useAction } from '../components/toast';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Input, Notice, PageHeader, Pagination, Select, Spinner, StatTile, Textarea } from '../components/ui';
import { DeliveryStatusBadge, ExceptionStatusBadge, VisitStatusBadge } from '../components/status';

const SUMMARY_LABELS: Record<string, string> = {
  openExceptions: 'Open administrative exceptions',
  pendingApprovals: 'Pending visitor approvals',
  visitorsAwaitingAction: 'Visitors awaiting action',
  visitorsInside: 'Visitors inside',
  overdueVisitors: 'Overdue visitors',
  incompleteDeliveries: 'Incomplete deliveries',
  unresolvedDiscrepancies: 'Unresolved record discrepancies',
  openAlerts: 'Open alerts',
  pendingManualReviews: 'Pending manual reviews',
};
const ATTENTION = new Set(['openExceptions', 'overdueVisitors', 'unresolvedDiscrepancies', 'openAlerts']);

function defaultShiftLabel(): string {
  const h = new Date().getHours();
  return h >= 6 && h < 14 ? 'Morning shift → Afternoon shift' : h >= 14 && h < 22 ? 'Afternoon shift → Night shift' : 'Night shift → Morning shift';
}

export default function HandoverPage() {
  const { can, me } = useAuth();
  const { locations, locationId: scopeLocation } = useLocationScope();
  const [locationId, setLocationId] = useState<number | null>(scopeLocation ?? locations[0]?.id ?? null);
  useEffect(() => {
    if (scopeLocation) setLocationId(scopeLocation);
  }, [scopeLocation]);
  const location = locations.find((l) => l.id === locationId);
  const canRecord = can('handover.manage');
  const [page, setPage] = useState(1);
  const [form, setForm] = useState({ shiftLabel: defaultShiftLabel(), gateId: me?.user.assignedGateId ? String(me.user.assignedGateId) : '', handedOverTo: '', notes: '' });

  const summary = useQuery({
    queryKey: ['handover', 'summary', locationId],
    queryFn: () => api.get<{ generatedAt: string; summary: Record<string, number>; items: Record<string, Row[]> }>('/handover/summary', { locationId: locationId! }),
    enabled: !!locationId,
    refetchInterval: 30_000,
  });
  const history = useQuery({
    queryKey: ['handover', 'history', locationId, page],
    queryFn: () => api.get<Page<Row>>('/handovers', { locationId: locationId ?? undefined, page, pageSize: 10 }),
  });
  const users = useQuery({
    queryKey: ['lookup', 'users', locationId],
    queryFn: () => api.get<Row[]>('/lookups/users', { locationId: locationId! }),
    enabled: !!locationId && canRecord,
  });
  const record = useAction(
    () =>
      api.post<{ reference: string }>('/handovers', {
        locationId,
        gateId: form.gateId ? Number(form.gateId) : null,
        shiftLabel: form.shiftLabel.trim(),
        handedOverTo: form.handedOverTo ? Number(form.handedOverTo) : null,
        notes: form.notes.trim() || null,
      }),
    {
      success: (r) => `Handover ${r.reference} recorded`,
      invalidate: [['handover']],
      onSuccess: () => setForm((f) => ({ ...f, handedOverTo: '', notes: '' })),
    },
  );
  const ack = useAction((id: number) => api.post(`/handovers/${id}/acknowledge`), { success: 'Handover acknowledged', invalidate: [['handover']] });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.shiftLabel.trim() || !locationId) return;
    record.mutate(undefined);
  };

  return (
    <>
      <PageHeader
        title="Shift handover"
        subtitle="A live summary of outstanding administrative items for the incoming shift, and a record of each handover."
        actions={
          locations.length > 1 && (
            <Select aria-label="Location" className="w-auto" value={locationId ?? ''} onChange={(e) => setLocationId(Number(e.target.value))} options={locations.map((l) => ({ value: l.id, label: l.name }))} />
          )
        }
      />
      {!locationId ? (
        <EmptyState title="No location available" />
      ) : (
        <>
          <Card className="mb-5">
            <CardHeader title={`Current summary · ${location?.name ?? ''}`} subtitle={summary.data ? `Updated ${fmtDateTime(summary.data.generatedAt)}` : undefined} />
            {summary.isLoading ? (
              <Spinner />
            ) : summary.isError ? (
              <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                  {Object.entries(summary.data!.summary).map(([k, v]) => (
                    <StatTile key={k} label={SUMMARY_LABELS[k] ?? k} value={v} tone={v > 0 && ATTENTION.has(k) ? 'warning' : 'neutral'} />
                  ))}
                </div>
                <div className="mt-5 grid gap-5 lg:grid-cols-3">
                  <SummaryList
                    title="Open exceptions"
                    rows={summary.data!.items.exceptions}
                    render={(r) => (
                      <>
                        {can('exceptions.view') ? <Link to={`/exceptions/${r.id}`} className="font-medium hover:text-forest-700">{r.title}</Link> : <span className="font-medium">{r.title}</span>}
                        <span className="flex items-center gap-2 text-xs text-ink-3"><span className="font-mono">{r.reference}</span><ExceptionStatusBadge status={r.status} /></span>
                      </>
                    )}
                  />
                  <SummaryList
                    title="Visitors awaiting action"
                    rows={summary.data!.items.visitors}
                    render={(r) => (
                      <>
                        {can('visitors.view', 'visitors.view_all') ? <Link to={`/visitors/${r.id}`} className="font-medium hover:text-forest-700">{r.visitorName}</Link> : <span className="font-medium">{r.visitorName}</span>}
                        <span className="flex items-center gap-2 text-xs text-ink-3"><span className="font-mono">{r.reference}</span><VisitStatusBadge status={r.status} /></span>
                      </>
                    )}
                  />
                  <SummaryList
                    title="Incomplete deliveries"
                    rows={summary.data!.items.deliveries}
                    render={(r) => (
                      <>
                        {can('deliveries.view') ? <Link to={`/deliveries/${r.id}`} className="font-medium hover:text-forest-700">{r.company}</Link> : <span className="font-medium">{r.company}</span>}
                        <span className="flex items-center gap-2 text-xs text-ink-3"><span className="font-mono">{r.reference}</span><DeliveryStatusBadge status={r.status} /></span>
                      </>
                    )}
                  />
                </div>
              </>
            )}
          </Card>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,420px)_1fr]">
            {canRecord && (
              <Card>
                <CardHeader title="Record handover" subtitle="Saves a snapshot of the summary above with your name and the time." />
                <Notice tone="warning" className="mb-4">
                  Keep notes administrative. Do not record sensitive operational instructions or security procedures.
                </Notice>
                <form onSubmit={submit} className="grid gap-4">
                  <Input label="Shift" required value={form.shiftLabel} onChange={(e) => setForm((f) => ({ ...f, shiftLabel: e.target.value }))} maxLength={60} />
                  <Select label="Gate (optional)" value={form.gateId} onChange={(e) => setForm((f) => ({ ...f, gateId: e.target.value }))} placeholder="Whole location" options={(location?.gates ?? []).map((g) => ({ value: g.id, label: g.name }))} />
                  <Select
                    label="Incoming user"
                    value={form.handedOverTo}
                    onChange={(e) => setForm((f) => ({ ...f, handedOverTo: e.target.value }))}
                    placeholder="Anyone on the incoming shift"
                    options={(users.data ?? []).filter((u) => u.id !== me?.user.id).map((u) => ({ value: u.id, label: `${u.name} · ${ROLE_INFO[u.role as RoleCode]?.name ?? u.role}` }))}
                    hint="The selected user is notified in-app and must acknowledge"
                  />
                  <Textarea label="Notes" rows={4} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} maxLength={2000} />
                  <div className="flex justify-end">
                    <Button type="submit" variant="primary" icon={<Repeat2 className="size-4" />} loading={record.isPending} disabled={!form.shiftLabel.trim()}>
                      Record handover
                    </Button>
                  </div>
                </form>
              </Card>
            )}
            <Card padded={false} className={canRecord ? '' : 'lg:col-span-2'}>
              <div className="p-5 pb-0">
                <CardHeader title="Handover history" />
              </div>
              {history.isLoading ? (
                <Spinner />
              ) : history.isError ? (
                <ErrorState error={history.error} onRetry={() => history.refetch()} />
              ) : history.data!.items.length === 0 ? (
                <EmptyState icon={<Repeat2 className="size-5" />} title="No handovers recorded" description="Record the first handover at the end of your shift." />
              ) : (
                <>
                  <ul className="divide-y divide-line">
                    {history.data!.items.map((h) => (
                      <li key={h.id} className="px-5 py-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-ink">{h.shiftLabel}</div>
                            <div className="text-xs text-ink-3">
                              <span className="font-mono">{h.reference}</span> · {h.locationName}
                              {h.gateName ? ` · ${h.gateName}` : ''} · {fmtDateTime(h.createdAt)}
                            </div>
                            <div className="mt-1 text-[13px] text-ink-2">
                              {h.handedOverBy} → {h.handedOverTo ?? 'incoming shift'}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {h.acknowledgedAt ? (
                              <Badge tone="success">Acknowledged by {h.acknowledgedBy}</Badge>
                            ) : h.canAcknowledge ? (
                              <Button size="sm" variant="primary" icon={<CheckCheck className="size-4" />} loading={ack.isPending && ack.variables === h.id} onClick={() => ack.mutate(h.id)}>
                                Acknowledge
                              </Button>
                            ) : (
                              <Badge tone="warning">Awaiting acknowledgement</Badge>
                            )}
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {Object.entries(h.summary as Record<string, number>).map(([k, v]) => (
                            <span key={k} className="rounded-md bg-canvas px-2 py-0.5 text-[11px] text-ink-2">
                              {SUMMARY_LABELS[k] ?? k}: <span className="font-semibold text-ink">{v}</span>
                            </span>
                          ))}
                        </div>
                        {h.notes && <p className="mt-2 text-[13px] text-ink-2">{h.notes}</p>}
                      </li>
                    ))}
                  </ul>
                  <Pagination page={page} pageSize={10} total={history.data!.total} onPage={setPage} />
                </>
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}

function SummaryList({ title, rows, render }: { title: string; rows: Row[]; render: (r: Row) => ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-ink-3 uppercase">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-3">None outstanding.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-col gap-0.5 rounded-lg border border-line px-3 py-2 text-sm">
              {render(r)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
