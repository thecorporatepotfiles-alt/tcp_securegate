import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import { fmtTime } from '../lib/format';
import type { Row } from '../lib/types';
import { VisitStatusBadge } from '../components/status';
import { useToast } from '../components/toast';
import { cx } from '../components/ui';
import { useGateId } from './GateContext';
import { EmptyGate, GateButton, GateError, GateSpinner, ScreenHeader } from './gateUi';

type Filter = 'all' | 'waiting' | 'expected' | 'inside';
const FILTERS: { value: Filter; label: string; statuses: string[] | null }[] = [
  { value: 'all', label: 'All', statuses: null },
  { value: 'waiting', label: 'Waiting for action', statuses: ['ARRIVED', 'HOST_NOTIFIED', 'WAITING'] },
  { value: 'expected', label: 'Expected / approved', statuses: ['EXPECTED', 'APPROVED'] },
  { value: 'inside', label: 'Inside', statuses: ['INSIDE', 'OVERDUE'] },
];

const WAIT_TEXT: Record<string, string> = {
  ARRIVED: 'Arrived — host not yet notified.',
  HOST_NOTIFIED: 'Host notified — awaiting host acknowledgement.',
  WAITING: 'Host acknowledged — awaiting authorization.',
};

export function VisitorQueue() {
  const gateId = useGateId();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['gate', gateId, 'visitors'], queryFn: () => api.get<Row[]>(`/gate/${gateId}/visitors`), refetchInterval: 15_000 });

  const arrive = async (v: Row) => {
    setBusy(v.id);
    setError(null);
    try {
      await api.post(`/gate/visits/${v.id}/arrive`, { gateId });
      toast.success(`Arrival recorded and host notified for ${v.visitorName}`);
      qc.invalidateQueries({ queryKey: ['gate', gateId] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const verifyLink = (v: Row, action: 'ENTRY' | 'EXIT') =>
    `/gate/verify/visitor?input=${encodeURIComponent(v.reference)}&method=REFERENCE&action=${action}&return=/gate/visitors`;

  const rows = (q.data ?? []).filter((v) => {
    const f = FILTERS.find((x) => x.value === filter)!;
    return !f.statuses || f.statuses.includes(v.status);
  });

  return (
    <>
      <ScreenHeader title="Visitor queue" subtitle="Today's visitors for this location. Refreshes every 15 seconds." />
      <div className="mb-4 flex gap-2 overflow-x-auto pb-1" role="tablist">
        {FILTERS.map((f) => {
          const n = (q.data ?? []).filter((v) => !f.statuses || f.statuses.includes(v.status)).length;
          return (
            <button
              key={f.value}
              type="button"
              role="tab"
              aria-selected={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={cx(
                'min-h-12 shrink-0 rounded-xl px-4 text-[15px] font-semibold whitespace-nowrap transition-colors',
                filter === f.value ? 'bg-gold-400 text-forest-950' : 'border border-white/10 bg-forest-900 text-forest-200 hover:bg-forest-800',
              )}
            >
              {f.label} <span className="ml-1 opacity-70">{n}</span>
            </button>
          );
        })}
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
      ) : rows.length === 0 ? (
        <EmptyGate title="No visitors in this view">Pre-registered visitors for today and walk-ins waiting at the gate appear here.</EmptyGate>
      ) : (
        <ul className="space-y-3">
          {rows.map((v) => (
            <li key={v.id} className="rounded-2xl border border-white/10 bg-forest-900 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-lg font-semibold text-white">{v.visitorName}</span>
                    <VisitStatusBadge status={v.status} />
                    {v.source === 'WALK_IN' && <span className="rounded-full border border-white/15 px-2 py-0.5 text-xs text-forest-200">Walk-in</span>}
                  </div>
                  <div className="mt-1 text-sm text-forest-200/80">
                    {v.visitorCompany ? `${v.visitorCompany} · ` : ''}Host {v.hostName} · {v.destination}
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-forest-200/60">
                    {v.reference} · expected {fmtTime(v.expectedArrival)}–{fmtTime(v.expectedDeparture)}
                    {v.arrivedAt ? ` · arrived ${fmtTime(v.arrivedAt)}` : ''}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {(v.status === 'EXPECTED' || v.status === 'APPROVED') && (
                  <GateButton loading={busy === v.id} onClick={() => arrive(v)}>
                    Mark arrived{v.status === 'APPROVED' ? ' & notify host' : ''}
                  </GateButton>
                )}
                {v.status === 'APPROVED' && (
                  <GateButton variant="success" onClick={() => navigate(verifyLink(v, 'ENTRY'))}>
                    Verify by reference
                  </GateButton>
                )}
                {(v.status === 'INSIDE' || v.status === 'OVERDUE') && (
                  <GateButton variant="info" onClick={() => navigate(verifyLink(v, 'EXIT'))}>
                    Verify & record exit
                  </GateButton>
                )}
                {WAIT_TEXT[v.status] && <span className="text-sm text-gold-300">{WAIT_TEXT[v.status]}</span>}
                {v.status === 'EXPECTED' && <span className="text-sm text-forest-200/70">Not yet authorized — entry not permitted.</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
