import { useQuery } from '@tanstack/react-query';
import { CreditCard, ScanLine } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { serverCopy } from '../lib/edition';
import type { GateMode } from '../../../shared/constants';
import { SimulatedTag } from '../components/status';
import { cx } from '../components/ui';

export interface DemoSample {
  mode: GateMode;
  method: 'QR' | 'MOCK_READER' | 'REFERENCE' | 'PLATE';
  label: string;
  expected: string;
  input: string;
}

/** Demo-only samples served by the API (404 outside demo mode — then nothing renders). */
export function useDemoSamples(gateId: number) {
  return useQuery({
    queryKey: ['gate', gateId, 'demo-samples'],
    queryFn: async () => {
      try {
        return await api.get<DemoSample[]>(`/gate/${gateId}/demo-samples`);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return [];
        throw e;
      }
    },
    staleTime: 20_000,
  });
}

const expectedTone = (expected: string) =>
  /^Verified/.test(expected) ? 'text-[#5fd39a]' : /Manual|Not Yet|Outside|Not Registered/.test(expected) ? 'text-gold-300' : 'text-[#ff8a8a]';

export function SamplesPanel({ gateId, mode, onPick, disabled, variant = 'scanner' }: { gateId: number; mode: GateMode; onPick: (s: DemoSample) => void; disabled?: boolean; variant?: 'scanner' | 'reader' }) {
  const q = useDemoSamples(gateId);
  const samples = (q.data ?? []).filter((s) => s.mode === mode);
  if (!q.data || samples.length === 0) return null;
  const Icon = variant === 'reader' ? CreditCard : ScanLine;
  return (
    <div className="rounded-2xl border border-dashed border-gold-400/40 bg-gold-400/[0.04] p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Icon className="size-5 text-gold-400" aria-hidden />
        <h3 className="text-[15px] font-semibold text-white">{variant === 'reader' ? 'Mock reader — tap a sample card' : 'Simulated scanner — demo passes'}</h3>
        <SimulatedTag>Demo only</SimulatedTag>
      </div>
      <p className="mb-3 text-xs text-forest-200/70">
        Synthetic samples to demonstrate each verification outcome.{' '}
        {serverCopy('The server performs the real check; nothing here bypasses it.', "SecureGate's verification rules perform the real check; nothing here bypasses them.")}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {samples.map((s) => (
          <button
            key={`${s.label}-${s.input}`}
            type="button"
            disabled={disabled}
            onClick={() => onPick(s)}
            className={cx(
              'flex min-h-14 flex-col items-start justify-center rounded-xl border border-white/10 bg-white/[0.05] px-3.5 py-2.5 text-left transition-colors hover:border-gold-400/50 hover:bg-white/[0.09] disabled:opacity-50',
            )}
          >
            <span className="text-[14px] leading-snug font-medium text-white">{s.label}</span>
            <span className={cx('text-xs font-medium', expectedTone(s.expected))}>Expected: {s.expected}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
