import { useQuery } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { fmtTime, fmtDate } from '../lib/format';
import type { Row } from '../lib/types';
import { REGISTER_CATEGORY_LABEL, type RegisterCategory } from '../../../shared/constants';
import { ResultBadge } from '../components/status';
import { cx } from '../components/ui';
import { useGateId } from './GateContext';
import { EmptyGate, GateError, GateSpinner, ScreenHeader, SectionTitle } from './gateUi';

export function RecentEvents() {
  const gateId = useGateId();
  const q = useQuery({ queryKey: ['gate', gateId, 'recent'], queryFn: () => api.get<{ events: Row[]; attempts: Row[] }>(`/gate/${gateId}/recent`), refetchInterval: 15_000 });
  return (
    <>
      <ScreenHeader title="Recent events at this gate" subtitle="Recorded movements and verification attempts, latest first." />
      {q.isLoading ? (
        <GateSpinner />
      ) : q.isError ? (
        <GateError>{errorMessage(q.error)}</GateError>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <section>
            <SectionTitle>Recorded movements</SectionTitle>
            {q.data!.events.length === 0 ? (
              <EmptyGate title="No movements recorded at this gate yet" />
            ) : (
              <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-2xl border border-white/10 bg-forest-900">
                {q.data!.events.map((e) => (
                  <li key={e.id} className="flex items-center gap-3 px-4 py-3">
                    <span
                      className={cx(
                        'flex size-10 shrink-0 items-center justify-center rounded-full',
                        e.voided ? 'bg-white/10 text-forest-200/50' : e.eventType === 'ENTRY' ? 'bg-[#1f8a5f]/25 text-[#5fd39a]' : 'bg-[#2a5698]/30 text-[#9dbcf0]',
                      )}
                      aria-hidden
                    >
                      {e.eventType === 'ENTRY' ? <ArrowDownLeft className="size-5" /> : <ArrowUpRight className="size-5" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className={cx('truncate text-[15px] font-medium text-white', e.voided && 'line-through opacity-60')}>{e.subjectName ?? '—'}</div>
                      <div className="truncate text-xs text-forest-200/70">
                        {e.eventType === 'ENTRY' ? 'Entry' : 'Exit'} · {REGISTER_CATEGORY_LABEL[(e.temporaryAccessId ? 'TEMPORARY' : e.category) as RegisterCategory] ?? e.category} · {e.operatorName ?? 'System'}
                        {e.voided ? ' · voided by correction' : ''}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm font-semibold text-white tabular-nums">{fmtTime(e.recordedAt)}</div>
                      <div className="text-[11px] text-forest-200/50">{fmtDate(e.recordedAt)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <SectionTitle>Verification attempts</SectionTitle>
            {q.data!.attempts.length === 0 ? (
              <EmptyGate title="No verification attempts yet" />
            ) : (
              <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-2xl border border-white/10 bg-forest-900">
                {q.data!.attempts.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <ResultBadge result={a.result} />
                        <span className="text-xs text-forest-200/60">{a.mode.toLowerCase()}</span>
                      </div>
                      <div className="mt-0.5 truncate text-sm text-white">{a.subjectName ?? <span className="font-mono text-forest-200/70">{a.inputDisplay}</span>}</div>
                      <div className="text-xs text-forest-200/60">
                        {a.operatorName ?? '—'}
                        {a.eventReference ? ` · recorded ${a.eventReference}` : ' · verification only'}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm font-semibold text-white tabular-nums">{fmtTime(a.createdAt)}</div>
                      <div className="text-[11px] text-forest-200/50">{fmtDate(a.createdAt)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </>
  );
}
