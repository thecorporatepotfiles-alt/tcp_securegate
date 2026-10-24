import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtRelative } from '../lib/format';
import type { Row } from '../lib/types';
import { AlertStatusBadge, SeverityBadge } from '../components/status';
import { useToast } from '../components/toast';
import { useGateId } from './GateContext';
import { EmptyGate, GateButton, GateError, GateInput, GateNote, GateSpinner, ScreenHeader } from './gateUi';

export function GateAlerts() {
  const gateId = useGateId();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['gate', gateId, 'alerts'], queryFn: () => api.get<{ items: Row[]; total: number }>(`/gate/${gateId}/alerts`), refetchInterval: 20_000 });
  const [acking, setAcking] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const acknowledge = async (id: number) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/alerts/${id}/acknowledge`, { note: note.trim() || undefined });
      toast.success('Alert acknowledged');
      setAcking(null);
      setNote('');
      qc.invalidateQueries({ queryKey: ['gate', gateId] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ScreenHeader title="Alerts" subtitle="Unresolved alerts for this location. Acknowledging does not delete the underlying record." />
      <div className="mb-4">
        <GateNote>Acknowledge to show you have seen an alert. Resolution is recorded by an authorized administrator. Follow established procedures; this system does not define escalation steps.</GateNote>
      </div>
      {error && (
        <div className="mb-3">
          <GateError>{error}</GateError>
        </div>
      )}
      {q.isLoading ? (
        <GateSpinner />
      ) : q.isError ? (
        <GateError>{errorMessage(q.error)}</GateError>
      ) : (q.data?.items ?? []).length === 0 ? (
        <EmptyGate title="No unresolved alerts">New alerts from failed verifications or overdue visitors will appear here.</EmptyGate>
      ) : (
        <ul className="space-y-3">
          {q.data!.items.map((a) => (
            <li key={a.id} className="rounded-2xl border border-white/10 bg-forest-900 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <SeverityBadge severity={a.severity} />
                <AlertStatusBadge status={a.status} />
                <span className="text-base font-semibold text-white">{a.title}</span>
              </div>
              <p className="mt-2 text-[15px] text-forest-200/90">{a.description}</p>
              <div className="mt-1 text-xs text-forest-200/60">
                {a.reference} · {a.gateName ?? a.locationName} · last seen {fmtRelative(a.lastSeenAt)}
                {a.occurrenceCount > 1 ? ` · ${a.occurrenceCount} occurrences` : ''}
                {a.acknowledgedBy ? ` · acknowledged by ${a.acknowledgedBy}` : ''}
              </div>
              {a.status === 'OPEN' && can('alerts.acknowledge') && (
                <div className="mt-3">
                  {acking === a.id ? (
                    <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                      <GateInput aria-label="Acknowledgement note" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
                      <GateButton variant="gold" loading={busy} onClick={() => acknowledge(a.id)}>
                        Confirm
                      </GateButton>
                      <GateButton onClick={() => setAcking(null)}>Cancel</GateButton>
                    </div>
                  ) : (
                    <GateButton
                      onClick={() => {
                        setAcking(a.id);
                        setNote('');
                      }}
                    >
                      Acknowledge
                    </GateButton>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
