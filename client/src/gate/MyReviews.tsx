import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { api, errorMessage, newIdempotencyKey } from '../lib/api';
import { fmtRelative } from '../lib/format';
import type { Row } from '../lib/types';
import { ResultBadge, ReviewStatusBadge } from '../components/status';
import { useToast } from '../components/toast';
import { useGateId } from './GateContext';
import { EmptyGate, GateButton, GateError, GateSpinner, ScreenHeader } from './gateUi';

const STATUS_TEXT: Record<string, string> = {
  PENDING: 'Waiting for an authorized supervisor to decide. Do not admit meanwhile.',
  DECLINED: 'Declined — do not record the movement. Follow established procedure.',
  USED: 'Approved movement has been recorded.',
  EXPIRED: 'The approval expired before the movement was recorded. Verify again if still needed.',
};

/** The operator's own manual-review requests; an approved one allows recording that single movement. */
export function MyReviews() {
  const gateId = useGateId();
  const toast = useToast();
  const qc = useQueryClient();
  const keys = useRef(new Map<number, string>());
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['gate', gateId, 'my-reviews'], queryFn: () => api.get<{ items: Row[] }>('/manual-reviews', { mine: true, pageSize: 50 }), refetchInterval: 10_000 });

  const record = async (r: Row) => {
    let key = keys.current.get(r.attemptId);
    if (!key) {
      key = newIdempotencyKey();
      keys.current.set(r.attemptId, key);
    }
    setBusy(r.id);
    setError(null);
    try {
      const res = await api.post<{ event: Row; duplicate: boolean }>('/gate/events', { attemptId: r.attemptId, eventType: r.requestedAction, idempotencyKey: key });
      toast.success(`${r.requestedAction === 'ENTRY' ? 'Entry' : 'Exit'} recorded after review — ${res.event.reference}`);
      qc.invalidateQueries({ queryKey: ['gate', gateId] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <ScreenHeader title="My manual reviews" subtitle="Cases you referred. Refreshes every 10 seconds." />
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
        <EmptyGate title="No manual reviews">When a verification needs an authorized decision, use “Refer for manual review” on the result screen.</EmptyGate>
      ) : (
        <ul className="space-y-3">
          {q.data!.items.map((r) => (
            <li key={r.id} className="rounded-2xl border border-white/10 bg-forest-900 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <ReviewStatusBadge status={r.status} />
                <ResultBadge result={r.resultCode} />
                <span className="text-base font-semibold text-white">{r.subjectName ?? r.inputDisplay}</span>
              </div>
              <div className="mt-1 text-sm text-forest-200/80">
                Requested {r.requestedAction === 'ENTRY' ? 'entry' : 'exit'} at {r.gateName} · {fmtRelative(r.createdAt)} · <span className="font-mono">{r.reference}</span>
              </div>
              <div className="mt-1 text-sm text-forest-200/70">“{r.requestNote}”</div>
              {r.decidedBy && (
                <div className="mt-2 rounded-xl bg-white/[0.04] px-3 py-2 text-sm text-forest-200/90">
                  <strong className="text-white">{r.decidedBy}</strong> {r.status === 'DECLINED' ? 'declined' : 'approved'} {fmtRelative(r.decidedAt)}: {r.decisionNote}
                </div>
              )}
              <div className="mt-3">
                {r.status === 'APPROVED' ? (
                  <GateButton
                    variant={r.requestedAction === 'ENTRY' ? 'success' : 'info'}
                    size="xl"
                    loading={busy === r.id}
                    icon={r.requestedAction === 'ENTRY' ? <ArrowDownLeft className="size-6" /> : <ArrowUpRight className="size-6" />}
                    onClick={() => record(r)}
                  >
                    Record approved {r.requestedAction === 'ENTRY' ? 'entry' : 'exit'}
                  </GateButton>
                ) : (
                  <p className="text-sm text-gold-300">{STATUS_TEXT[r.status]}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
