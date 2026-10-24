import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Cpu, PlayCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, titleCase } from '../../lib/format';
import type { Row } from '../../lib/types';
import { useAction } from '../../components/toast';
import { Badge, Button, Card, CardHeader, DataTable, Input, KeyValue, Modal, Notice, PageHeader } from '../../components/ui';
import { SimulatedTag } from '../../components/status';

const CHECK_LABELS: Record<string, string> = {
  expiredVisits: 'Visits expired (window passed without entry)',
  overdueVisits: 'Visitors marked overdue',
  unclosedVisitAlerts: 'Unclosed-visit alerts raised',
  deliveryAckAlerts: 'Delivery acknowledgement alerts raised',
  unresolvedExceptionAlerts: 'Unresolved-exception alerts raised',
  expiredCredentials: 'Credentials expired',
  expiredReviews: 'Manual review approvals expired',
};

export default function SystemPage() {
  const { config, can, logout } = useAuth();
  const navigate = useNavigate();
  const [checks, setChecks] = useState<{ at: string; result: Record<string, number> } | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const readers = useQuery({
    queryKey: ['integrations', 'readers'],
    queryFn: () => api.get<Row[]>('/integrations/readers'),
    enabled: can('locations.manage', 'credentials.manage', 'gate.operate'),
  });
  const verify = useQuery({ queryKey: ['audit', 'verify'], queryFn: () => api.get<{ ok: boolean; checked: number; brokenAtId: number | null }>('/audit/verify'), enabled: false });
  const run = useAction(() => api.post<Record<string, number>>('/admin/run-checks'), {
    success: 'Time-based checks completed',
    invalidate: [['alerts'], ['visits'], ['dashboard']],
    onSuccess: (r) => setChecks({ at: new Date().toISOString(), result: r }),
  });
  const reset = useAction(() => api.post<{ summary: string }>('/admin/demo/reset'), {
    success: 'Demonstration data reset. Please sign in again.',
    onSuccess: async () => {
      setResetOpen(false);
      await logout();
      navigate('/login');
    },
  });

  return (
    <>
      <PageHeader title="System & demo" subtitle="Runtime information, maintenance actions and the simulated integration boundary." />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Environment" />
          <KeyValue
            items={[
              { label: 'Application mode', value: config?.mode === 'demo' ? <Badge tone="warning">Demonstration</Badge> : <Badge tone="info">Production configuration</Badge> },
              { label: 'Establishment time zone', value: config?.timezone },
              { label: 'Session idle timeout', value: config ? `${config.sessionIdleMinutes} minutes` : '—' },
              { label: 'Data', value: config?.demo ? 'Synthetic demonstration records only' : 'Configured database' },
            ]}
          />
          <Notice tone="info" className="mt-5">
            This prototype is not security-certified or approved for operational use. Hosting, networking, retention, backups and integrations require approval by the
            establishment.
          </Notice>
        </Card>

        <Card>
          <CardHeader
            title="Time-based checks"
            subtitle="Run automatically every minute: expiry, overstay, unclosed visits, delivery acknowledgement, unresolved exceptions."
            actions={
              <Button variant="primary" icon={<PlayCircle className="size-4" />} loading={run.isPending} onClick={() => run.mutate(undefined)}>
                Run now
              </Button>
            }
          />
          {checks ? (
            <div>
              <p className="mb-2 text-xs text-ink-3">Last manual run {fmtDateTime(checks.at)}</p>
              <ul className="divide-y divide-line text-sm">
                {Object.entries(checks.result).map(([k, v]) => (
                  <li key={k} className="flex justify-between py-1.5">
                    <span className="text-ink-2">{CHECK_LABELS[k] ?? titleCase(k)}</span>
                    <span className="font-semibold tabular-nums">{v}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-ink-3">Run the checks to apply time-based rules immediately (useful during a demonstration).</p>
          )}
        </Card>

        {can('audit.view') && (
          <Card>
            <CardHeader
              title="Audit trail integrity"
              subtitle="Each audit record is hash-chained to the previous one; tampering breaks the chain."
              actions={
                <Button icon={<ShieldCheck className="size-4" />} loading={verify.isFetching} onClick={() => verify.refetch()}>
                  Verify chain
                </Button>
              }
            />
            {verify.data ? (
              verify.data.ok ? (
                <Notice tone="success" title="Chain intact">
                  {verify.data.checked.toLocaleString('en-IN')} audit records verified.
                </Notice>
              ) : (
                <Notice tone="danger" title="Chain broken">
                  Verification failed at audit record #{verify.data.brokenAtId} after {verify.data.checked.toLocaleString('en-IN')} records.
                </Notice>
              )
            ) : verify.isError ? (
              <Notice tone="danger">{(verify.error as Error).message}</Notice>
            ) : (
              <p className="text-sm text-ink-3">Audit records cannot be edited or deleted by any user; the database rejects updates and deletes.</p>
            )}
          </Card>
        )}

        <Card padded={false} className="lg:col-span-2">
          <div className="p-5 pb-0">
            <CardHeader
              title="Credential reader integrations"
              subtitle={
                <span className="flex flex-wrap items-center gap-2">
                  <SimulatedTag>Mock adapters only</SimulatedTag> No physical RFID/NFC readers, barriers or vehicle-recognition devices are connected.
                </span>
              }
              actions={<Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} onClick={() => readers.refetch()}>Refresh</Button>}
            />
          </div>
          <DataTable
            dense
            loading={readers.isFetching}
            rows={readers.data ?? []}
            rowKey={(r) => r.readerId}
            empty={<p className="px-5 py-8 text-center text-sm text-ink-3">No readers in your locations.</p>}
            columns={[
              { key: 'label', header: 'Reader', render: (r) => <div className="flex items-center gap-2"><Cpu className="size-4 text-ink-3" aria-hidden /><div><div className="font-medium">{r.label}</div><div className="font-mono text-xs text-ink-3">{r.readerId}</div></div></div> },
              { key: 'technology', header: 'Technology', hideBelow: 'md', render: (r) => titleCase(r.technology) },
              { key: 'status', header: 'Status', render: (r) => (r.simulated ? <Badge tone="warning">Simulated</Badge> : r.online ? <Badge tone="success">Online</Badge> : <Badge tone="danger">Offline</Badge>) },
              { key: 'note', header: 'Note', hideBelow: 'lg', render: (r) => <span className="text-xs text-ink-3">{r.note}</span> },
            ]}
          />
        </Card>

        {config?.demo && can('demo.reset') && (
          <Card className="border-bad/30 lg:col-span-2">
            <CardHeader
              title="Reset demonstration data"
              subtitle="Deletes every record and rebuilds the synthetic dataset. All users are signed out."
              actions={
                <Button variant="danger" icon={<AlertTriangle className="size-4" />} onClick={() => setResetOpen(true)}>
                  Reset demo data
                </Button>
              }
            />
            <p className="text-sm text-ink-2">Available only in demonstration mode and only to authorized demo administrators. Disabled in production configurations.</p>
          </Card>
        )}
      </div>

      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Reset demonstration data?"
        description="This cannot be undone. All demo records, events, alerts and audit history are replaced with a fresh synthetic dataset."
        footer={
          <>
            <Button onClick={() => setResetOpen(false)}>Cancel</Button>
            <Button variant="danger" loading={reset.isPending} disabled={confirmText !== 'RESET'} onClick={() => reset.mutate(undefined)}>
              Reset now
            </Button>
          </>
        }
      >
        <Input label='Type "RESET" to confirm' value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
      </Modal>
    </>
  );
}
