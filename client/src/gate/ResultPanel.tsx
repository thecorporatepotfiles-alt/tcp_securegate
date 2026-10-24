import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, CheckCircle2, ClipboardList, Clock, RotateCcw, ScanLine, ShieldX, XCircle } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { fmtRelative, fmtTime } from '../lib/format';
import type { Row } from '../lib/types';
import { VERIFICATION_METHOD_LABEL, type GateMode, type ResultCode, type SubjectType, type Tone, type VerificationMethod } from '../../../shared/constants';
import { Avatar, cx } from '../components/ui';
import { SimulatedTag } from '../components/status';
import { GateButton, GateError, GateInput, GateNote, GateSelect, GateTextarea, fmtCountdown, useSecondsLeft } from './gateUi';
import { VehicleRegisterForm } from './VehicleRegisterForm';

export type EventType = 'ENTRY' | 'EXIT';

export interface VerifyResult {
  attemptId: number;
  mode: GateMode;
  method: VerificationMethod;
  result: ResultCode;
  label: string;
  tone: Tone;
  message: string;
  subject: null | { type: SubjectType; id: number; category: string; name: string; reference: string; subtitle?: string; lines: { label: string; value: string }[] };
  presence: { state: 'INSIDE' | 'OUTSIDE' | 'NONE'; since?: string; locationName?: string; gateName?: string };
  allowedActions: EventType[];
  manualReviewEligible: boolean;
  expiresAt: string;
  gate: { id: number; name: string; locationName: string };
  simulated: boolean;
}

export interface RecordExtras {
  driverReference?: string;
  purpose?: string;
  sponsoringDepartment?: string;
  notes?: string;
}

const HEADER: Record<Tone, string> = {
  success: 'bg-[#1f8a5f] text-white',
  danger: 'bg-[#b02a2a] text-white',
  warning: 'bg-gold-400 text-forest-950',
  info: 'bg-[#2a5698] text-white',
  neutral: 'bg-white/10 text-white',
};

function ResultIcon({ tone, className }: { tone: Tone; className?: string }) {
  if (tone === 'success') return <CheckCircle2 className={className} aria-hidden />;
  if (tone === 'warning') return <AlertTriangle className={className} aria-hidden />;
  if (tone === 'danger') return <XCircle className={className} aria-hidden />;
  return <ShieldX className={className} aria-hidden />;
}

function PresenceLine({ p }: { p: VerifyResult['presence'] }) {
  if (p.state === 'INSIDE')
    return (
      <span>
        <strong className="text-[#5fd39a]">Recorded inside</strong> at {p.locationName} since {fmtTime(p.since)} {p.gateName ? `(${p.gateName})` : ''}
      </span>
    );
  if (p.state === 'OUTSIDE')
    return (
      <span>
        <strong className="text-white">Recorded outside</strong> — last exit {fmtRelative(p.since)} {p.gateName ? `via ${p.gateName}` : ''}
      </span>
    );
  return <span>No movement recorded yet</span>;
}

export function ResultPanel({
  gateId,
  result,
  intent,
  recording,
  recordError,
  onRecord,
  onReverify,
  onNext,
  lastInput,
}: {
  gateId: number;
  result: VerifyResult;
  intent: EventType | null;
  recording: EventType | null;
  recordError: string | null;
  onRecord: (eventType: EventType, extras: RecordExtras) => void;
  onReverify: () => void;
  onNext: () => void;
  lastInput: string;
}) {
  const secondsLeft = useSecondsLeft(result.expiresAt);
  const expired = secondsLeft === 0;
  const [extras, setExtras] = useState<RecordExtras>({});
  const [registering, setRegistering] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [review, setReview] = useState<Row | null>(null);

  const actions = result.allowedActions.filter((a) => !intent || a === intent);
  const blockedByIntent = intent && result.allowedActions.length > 0 && !result.allowedActions.includes(intent);
  const verified = result.result === 'VERIFIED';
  const exitOnly = !verified && result.allowedActions.includes('EXIT');
  const isVehicle = result.mode === 'VEHICLE';

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-forest-900">
        <div className={cx('flex items-center gap-4 px-5 py-6 sm:px-7 sm:py-8', HEADER[result.tone])} role="status" aria-live="assertive">
          <ResultIcon tone={result.tone} className="size-14 shrink-0 sm:size-16" />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold tracking-[0.14em] uppercase opacity-80">Verification result</div>
            <div className="text-3xl leading-tight font-bold tracking-tight sm:text-4xl">{result.label}</div>
            <div className="mt-1 text-base opacity-95 sm:text-lg">{result.message}</div>
          </div>
        </div>

        {result.subject ? (
          <div className="grid gap-5 px-5 py-5 sm:px-7 lg:grid-cols-[1fr_auto]">
            <div className="min-w-0">
              <div className="flex items-center gap-4">
                {result.subject.type === 'VEHICLE' ? (
                  <span className="flex size-14 items-center justify-center rounded-full bg-white/10 text-lg font-bold text-gold-300">VH</span>
                ) : (
                  <Avatar name={result.subject.name} size={56} tone="gold" />
                )}
                <div className="min-w-0">
                  <div className="text-xs font-semibold tracking-wider text-gold-400 uppercase">{result.subject.subtitle}</div>
                  <div className="truncate text-2xl font-semibold text-white">{result.subject.name}</div>
                  <div className="font-mono text-sm text-forest-200/80">{result.subject.reference}</div>
                </div>
              </div>
              <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
                {result.subject.lines.map((l) => (
                  <div key={l.label} className="min-w-0">
                    <dt className="text-xs text-forest-200/60">{l.label}</dt>
                    <dd className="text-[15px] break-words text-white">{l.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className="space-y-2 text-sm text-forest-200/80 lg:w-72">
              <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
                <div className="mb-1 text-xs text-forest-200/60">Recorded movement status</div>
                <PresenceLine p={result.presence} />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span>{VERIFICATION_METHOD_LABEL[result.method] ?? result.method}</span>
                <SimulatedTag />
              </div>
            </div>
          </div>
        ) : (
          <div className="px-5 py-5 text-[15px] text-forest-200/80 sm:px-7">
            No matching record was found for <span className="font-mono text-white">{lastInput.length > 30 ? `${lastInput.slice(0, 12)}…` : lastInput}</span>. Check the reference and try again.
          </div>
        )}
      </div>

      {/* Record movement — only for actions the server permitted */}
      {actions.length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-forest-900 p-4 sm:p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[15px] font-semibold text-white">{exitOnly ? 'Exit may be recorded — entry is not permitted' : 'Confirm the movement to record'}</div>
            {secondsLeft !== null && (
              <div className={cx('flex items-center gap-1.5 text-sm', expired ? 'text-[#ff8a8a]' : 'text-forest-200/70')}>
                <Clock className="size-4" aria-hidden />
                {expired ? 'Verification expired — verify again' : `Verification valid for ${fmtCountdown(secondsLeft)}`}
              </div>
            )}
          </div>
          {isVehicle && (
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <GateInput label="Driver reference (optional)" value={extras.driverReference ?? ''} onChange={(e) => setExtras((x) => ({ ...x, driverReference: e.target.value }))} placeholder="Name or ID of driver" />
              <GateInput label="Purpose (optional)" value={extras.purpose ?? ''} onChange={(e) => setExtras((x) => ({ ...x, purpose: e.target.value }))} />
              <GateInput label="Sponsoring department (optional)" value={extras.sponsoringDepartment ?? ''} onChange={(e) => setExtras((x) => ({ ...x, sponsoringDepartment: e.target.value }))} />
              <p className="text-xs text-gold-300 sm:col-span-3">Recording a vehicle does not mark its occupants inside. Verify each person separately.</p>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {actions.map((a) => (
              <GateButton
                key={a}
                size="xl"
                variant={a === 'ENTRY' ? 'success' : 'info'}
                className="w-full"
                disabled={expired || recording !== null}
                loading={recording === a}
                icon={a === 'ENTRY' ? <ArrowDownLeft className="size-6" /> : <ArrowUpRight className="size-6" />}
                onClick={() => onRecord(a, extras)}
              >
                Record {a === 'ENTRY' ? 'Entry' : 'Exit'}
              </GateButton>
            ))}
          </div>
          {recordError && (
            <div className="mt-3">
              <GateError>{recordError}</GateError>
            </div>
          )}
          <p className="mt-3 text-xs text-forest-200/60">Nothing is recorded until you confirm. The server re-checks the record before saving.</p>
        </div>
      )}

      {blockedByIntent && (
        <GateNote tone="gold">
          {intent === 'ENTRY'
            ? 'Entry cannot be recorded: this record is currently recorded inside. Use Record Exit if they are leaving.'
            : 'Exit cannot be recorded: no entry is recorded for this record. Use Record Entry if they are arriving.'}
        </GateNote>
      )}

      {!verified && actions.length === 0 && !blockedByIntent && result.result !== 'UNREGISTERED_VEHICLE' && (
        <div className="rounded-2xl border border-[#e66767]/30 bg-[#b02a2a]/10 p-4 text-[15px] text-white">
          <strong>Do not admit on this verification.</strong> Follow the establishment's approved procedure. There is no bypass in this system
          {result.manualReviewEligible ? '; you may refer the case for an authorized manual review.' : '.'}
        </div>
      )}

      {result.result === 'UNREGISTERED_VEHICLE' &&
        (registering ? (
          <VehicleRegisterForm
            gateId={gateId}
            registration={lastInput.toUpperCase()}
            onCancel={() => setRegistering(false)}
            onRegistered={() => {
              setRegistering(false);
              onReverify();
            }}
          />
        ) : (
          <GateButton variant="gold" size="xl" className="w-full" onClick={() => setRegistering(true)}>
            Register this vehicle
          </GateButton>
        ))}

      {result.manualReviewEligible && !review && (
        <>
          {reviewOpen ? (
            <ManualReviewForm
              attemptId={result.attemptId}
              defaultAction={intent ?? (result.presence.state === 'INSIDE' && result.presence.locationName === result.gate.locationName ? 'EXIT' : 'ENTRY')}
              onCancel={() => setReviewOpen(false)}
              onDone={setReview}
            />
          ) : (
            <GateButton variant="solid" size="lg" className="w-full border-gold-400/50" icon={<ClipboardList className="size-5 text-gold-400" />} onClick={() => setReviewOpen(true)}>
              Refer for manual review
            </GateButton>
          )}
        </>
      )}
      {review && (
        <GateNote tone="gold">
          Referred for manual review as <strong className="font-mono text-white">{review.reference}</strong> — status: <strong className="text-white">pending decision</strong>. An authorized supervisor must decide; nothing is recorded until they approve and you record the movement.{' '}
          <Link to="/gate/reviews" className="font-semibold text-white underline">
            View my manual reviews
          </Link>
        </GateNote>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <GateButton size="lg" variant="solid" icon={<ScanLine className="size-5" />} onClick={onNext}>
          Verify another
        </GateButton>
        <GateButton size="lg" variant="ghost" icon={<RotateCcw className="size-5" />} onClick={onReverify}>
          Verify this again
        </GateButton>
      </div>
      <p className="text-center text-xs text-forest-200/50">
        Verification attempt #{result.attemptId} · {result.gate.name}, {result.gate.locationName}
      </p>
    </div>
  );
}

function ManualReviewForm({ attemptId, defaultAction, onCancel, onDone }: { attemptId: number; defaultAction: EventType; onCancel: () => void; onDone: (r: Row) => void }) {
  const [action, setAction] = useState<EventType>(defaultAction);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.post<Row>('/gate/manual-reviews', { attemptId, requestedAction: action, note: note.trim() }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4 rounded-2xl border border-gold-400/40 bg-forest-900 p-4 sm:p-5">
      <div>
        <h3 className="text-base font-semibold text-white">Refer for manual review</h3>
        <p className="text-sm text-forest-200/70">An authorized supervisor (not you) decides. The request, decision and any movement are recorded in the audit trail.</p>
      </div>
      <GateSelect
        label="Movement requested"
        value={action}
        onChange={(e) => setAction(e.target.value as EventType)}
        options={[
          { value: 'ENTRY', label: 'Entry' },
          { value: 'EXIT', label: 'Exit' },
        ]}
      />
      <GateTextarea label="Reason for the request" required value={note} onChange={(e) => setNote(e.target.value)} placeholder="What the person states and what you observed" />
      {error && <GateError>{error}</GateError>}
      <div className="flex flex-wrap justify-end gap-2">
        <GateButton onClick={onCancel}>Cancel</GateButton>
        <GateButton variant="gold" loading={busy} disabled={note.trim().length < 5} onClick={submit}>
          Submit for review
        </GateButton>
      </div>
    </div>
  );
}
