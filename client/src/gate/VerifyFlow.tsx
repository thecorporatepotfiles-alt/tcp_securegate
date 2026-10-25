import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, CheckCircle2, Home, Keyboard, ScanLine } from 'lucide-react';
import { api, errorMessage, ApiError, newIdempotencyKey } from '../lib/api';
import { serverCopy } from '../lib/edition';
import { fmtTime } from '../lib/format';
import type { Row } from '../lib/types';
import type { GateMode } from '../../../shared/constants';
import { SimulatedTag } from '../components/status';
import { cx } from '../components/ui';
import { GateButton, GateError, GateInput, ScreenHeader } from './gateUi';
import { useGateId } from './GateContext';
import { MODES, isGateMode } from './modes';
import { QrScanner } from './QrScanner';
import { Keypad } from './Keypad';
import { SamplesPanel, type DemoSample } from './SamplesPanel';
import { ResultPanel, type EventType, type RecordExtras, type VerifyResult } from './ResultPanel';

type Method = 'CREDENTIAL' | 'MOCK_READER' | 'QR' | 'REFERENCE' | 'PLATE';

function friendlyError(e: unknown): string {
  if (e instanceof ApiError && e.status === 429) return 'Too many requests from this gate. Wait a moment and try again.';
  return errorMessage(e);
}

export function VerifyFlow() {
  const params = useParams();
  const modeParam = params.mode?.toUpperCase();
  if (!isGateMode(modeParam)) return <div className="text-white">Unknown record type.</div>;
  return <VerifyFlowInner key={modeParam} mode={modeParam} />;
}

function VerifyFlowInner({ mode }: { mode: GateMode }) {
  const gateId = useGateId();
  const info = MODES[mode];
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const intentParam = sp.get('action');
  const intent: EventType | null = intentParam === 'ENTRY' || intentParam === 'EXIT' ? intentParam : null;
  const returnTo = sp.get('return');

  const [input, setInput] = useState('');
  const [lastInput, setLastInput] = useState<{ input: string; method?: Method } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [recording, setRecording] = useState<EventType | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [done, setDone] = useState<{ event: Row; duplicate: boolean } | null>(null);
  const [showKeypad, setShowKeypad] = useState(info.keypad);
  const keys = useRef(new Map<number, string>());
  const autoRan = useRef(false);

  // Each new result or confirmation starts at the top so the outcome is seen first.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [result, done]);

  const verify = async (raw: string, method?: Method) => {
    const value = raw.trim();
    if (!value) return;
    setVerifying(true);
    setVerifyError(null);
    setRecordError(null);
    setLastInput({ input: value, method });
    try {
      const r = await api.post<VerifyResult>('/gate/verify', { gateId, mode, input: value, method });
      setResult(r);
      setInput('');
      qc.invalidateQueries({ queryKey: ['gate', gateId] });
    } catch (e) {
      setVerifyError(friendlyError(e));
    } finally {
      setVerifying(false);
    }
  };

  // Deep links (e.g. from the visitor queue or deliveries) can pre-fill and verify.
  useEffect(() => {
    const preset = sp.get('input');
    if (preset && !autoRan.current) {
      autoRan.current = true;
      verify(preset, (sp.get('method') as Method) ?? undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const record = async (eventType: EventType, extras: RecordExtras) => {
    if (!result) return;
    let key = keys.current.get(result.attemptId);
    if (!key) {
      key = newIdempotencyKey();
      keys.current.set(result.attemptId, key);
    }
    setRecording(eventType);
    setRecordError(null);
    try {
      const clean = Object.fromEntries(Object.entries(extras).filter(([, v]) => v && String(v).trim()));
      const r = await api.post<{ duplicate: boolean; event: Row }>('/gate/events', { attemptId: result.attemptId, eventType, idempotencyKey: key, ...clean });
      setDone(r);
      qc.invalidateQueries({ queryKey: ['gate', gateId] });
    } catch (e) {
      setRecordError(friendlyError(e));
    } finally {
      setRecording(null);
    }
  };

  const reset = () => {
    setResult(null);
    setDone(null);
    setRecordError(null);
    setVerifyError(null);
    setInput('');
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = input.trim();
    const isToken = /^SG[VTC]1\./.test(v);
    verify(v, mode === 'VEHICLE' ? 'PLATE' : isToken ? 'QR' : mode === 'PERSONNEL' ? 'CREDENTIAL' : 'REFERENCE');
  };

  const title = intent ? `Record ${intent === 'ENTRY' ? 'entry' : 'exit'} — ${info.short.toLowerCase()}` : info.title;
  const back = returnTo ?? (intent ? `/gate/record/${intent}` : '/gate');

  if (done) {
    return (
      <>
        <ScreenHeader title={title} back={back} backLabel={returnTo ? 'Back' : intent ? 'Record type' : 'Home'} />
        <DoneScreen
          done={done}
          onNext={() => {
            if (returnTo) navigate(returnTo);
            else reset();
          }}
          nextLabel={returnTo ? 'Back to list' : `Next ${info.short.toLowerCase()}`}
        />
      </>
    );
  }

  return (
    <>
      <ScreenHeader
        title={title}
        subtitle={result ? undefined : info.instruction}
        back={back}
        backLabel={returnTo ? 'Back' : intent ? 'Record type' : 'Home'}
        right={
          intent && (
            <span className={cx('inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold', intent === 'ENTRY' ? 'bg-[#1f8a5f]/25 text-[#5fd39a]' : 'bg-[#2a5698]/30 text-[#9dbcf0]')}>
              {intent === 'ENTRY' ? <ArrowDownLeft className="size-4" /> : <ArrowUpRight className="size-4" />}
              {intent === 'ENTRY' ? 'Entry only' : 'Exit only'}
            </span>
          )
        }
      />

      {result ? (
        <ResultPanel
          gateId={gateId}
          result={result}
          intent={intent}
          recording={recording}
          recordError={recordError}
          onRecord={record}
          onReverify={() => lastInput && verify(lastInput.input, lastInput.method)}
          onNext={reset}
          lastInput={lastInput?.input ?? ''}
        />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            {info.camera && <QrScanner disabled={verifying} onDetected={(text) => verify(text, 'QR')} />}
            <form onSubmit={submit} className="space-y-3 rounded-2xl border border-white/10 bg-forest-900/80 p-4 sm:p-5">
              <GateInput
                big
                label={info.inputLabel}
                value={input}
                autoFocus={!info.camera}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder={info.placeholder}
                onChange={(e) => setInput(info.uppercase ? e.target.value.toUpperCase() : e.target.value)}
              />
              {verifyError && <GateError>{verifyError}</GateError>}
              {!showKeypad && (
                <div className="flex flex-wrap gap-2">
                  <GateButton type="submit" variant="gold" size="xl" className="flex-1" loading={verifying} disabled={input.trim().length < 2} icon={<ScanLine className="size-6" />}>
                    Verify
                  </GateButton>
                  {info.keypad && (
                    <GateButton size="xl" onClick={() => setShowKeypad(true)} icon={<Keyboard className="size-5" />} aria-label="Show keypad">
                      Keypad
                    </GateButton>
                  )}
                </div>
              )}
              {showKeypad && (
                <>
                  <Keypad value={input} onChange={(v) => setInput(v.toUpperCase())} onSubmit={() => verify(input, 'CREDENTIAL')} disabled={verifying} />
                  {/* A 48 px target like the other gate controls; unlike GateButton the text may wrap on narrow phones. */}
                  <button
                    type="button"
                    className="-mx-3 inline-flex min-h-12 items-center rounded-xl px-3 text-left text-sm text-forest-200/70 underline underline-offset-2 hover:bg-white/[0.06] hover:text-white"
                    onClick={() => setShowKeypad(false)}
                  >
                    Hide keypad (use device keyboard)
                  </button>
                </>
              )}
              {verifying && (
                <p className="text-sm text-forest-200/70" role="status">
                  {serverCopy('Checking with the server…', 'Checking…')}
                </p>
              )}
            </form>
            <div className="flex flex-wrap items-center gap-2 text-xs text-forest-200/60">
              <SimulatedTag>Simulated verification</SimulatedTag>
              Not connected to any access-control hardware. Verification only — movement is recorded after you confirm.
            </div>
          </div>
          <div className="space-y-4">
            <SamplesPanel gateId={gateId} mode={mode} disabled={verifying} variant={mode === 'PERSONNEL' ? 'reader' : 'scanner'} onPick={(s: DemoSample) => verify(s.input, s.method)} />
          </div>
        </div>
      )}
    </>
  );
}

function DoneScreen({ done, onNext, nextLabel }: { done: { event: Row; duplicate: boolean }; onNext: () => void; nextLabel: string }) {
  const [left, setLeft] = useState(6);
  const navigate = useNavigate();
  useEffect(() => {
    const t = setInterval(() => setLeft((s) => s - 1), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (left <= 0) onNext();
  }, [left, onNext]);
  const e = done.event;
  const entry = e.eventType === 'ENTRY';
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className={cx('rounded-2xl px-6 py-8 text-center text-white', entry ? 'bg-[#1f8a5f]' : 'bg-[#2a5698]')} role="status" aria-live="assertive">
        <CheckCircle2 className="mx-auto size-16" aria-hidden />
        <div className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">{entry ? 'Entry recorded' : 'Exit recorded'}</div>
        <div className="mt-2 text-lg opacity-95">{e.subjectName}</div>
        <div className="mt-1 font-mono text-sm opacity-90">{e.reference}</div>
      </div>
      {done.duplicate && (
        <div className="rounded-xl border border-gold-400/40 bg-gold-400/10 px-4 py-3 text-sm text-gold-200">
          This was a repeated submission. No duplicate was created — the original record is shown.
        </div>
      )}
      <dl className="grid gap-3 rounded-2xl border border-white/10 bg-forest-900 p-5 text-[15px] sm:grid-cols-3">
        <div>
          <dt className="text-xs text-forest-200/60">{serverCopy('Recorded at (server time)', 'Recorded at (device time)')}</dt>
          <dd className="text-white">{fmtTime(e.recordedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-forest-200/60">Gate</dt>
          <dd className="text-white">{e.gateName}</dd>
        </div>
        <div>
          <dt className="text-xs text-forest-200/60">Recorded by</dt>
          <dd className="text-white">{e.operatorName ?? '—'}</dd>
        </div>
      </dl>
      <div className="grid gap-3 sm:grid-cols-2">
        <GateButton variant="gold" size="xl" onClick={onNext}>
          {nextLabel} ({Math.max(0, left)})
        </GateButton>
        <GateButton size="xl" icon={<Home className="size-5" />} onClick={() => navigate('/gate')}>
          Gate home
        </GateButton>
      </div>
    </div>
  );
}
