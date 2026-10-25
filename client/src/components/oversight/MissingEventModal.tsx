import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Page } from '../../lib/api';
import { serverCopy } from '../../lib/edition';
import { useLocationScope } from '../../lib/location';
import { fmtDateTime, nowLocalTime, todayLocal, zonedIso, timezone } from '../../lib/format';
import type { Row } from '../../lib/types';
import type { SubjectType } from '../../../../shared/constants';
import { useAction } from '../toast';
import { Button, Field, Input, Modal, Notice, SearchInput, Select, Textarea, cx } from '../ui';
import { CategoryPill } from '../status';

export interface CorrectionSubject {
  type: SubjectType;
  id: number;
  name: string;
  reference?: string | null;
  locationId?: number | null;
}

/**
 * Record a movement that happened but was never captured (typically a missing
 * exit). The original register is untouched; the new entry is clearly marked
 * as an administrative correction and audited.
 */
export function MissingEventModal({
  open,
  onClose,
  subject: initialSubject,
  defaultEventType = 'EXIT',
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  subject?: CorrectionSubject | null;
  defaultEventType?: 'ENTRY' | 'EXIT';
  onDone?: () => void;
}) {
  const { locations, locationId } = useLocationScope();
  const [subject, setSubject] = useState<CorrectionSubject | null>(initialSubject ?? null);
  const [search, setSearch] = useState('');
  const [eventType, setEventType] = useState<'ENTRY' | 'EXIT'>(defaultEventType);
  const [gateId, setGateId] = useState('');
  const [when, setWhen] = useState(`${todayLocal()}T${nowLocalTime(-30)}`);
  const [reason, setReason] = useState('');

  const subjectKey = initialSubject ? `${initialSubject.type}:${initialSubject.id}` : '';
  useEffect(() => {
    if (open) {
      setSubject(initialSubject ?? null);
      setEventType(defaultEventType);
      setGateId('');
      setReason('');
      setSearch('');
      setWhen(`${todayLocal()}T${nowLocalTime(-30)}`);
    }
    // Reset only when the dialog opens or the subject changes — not on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, subjectKey, defaultEventType]);

  const candidates = useQuery({
    queryKey: ['presence', 'correction-picker', search, locationId],
    queryFn: () => api.get<Page<Row>>('/presence', { state: 'INSIDE', q: search, pageSize: 8, locationId }),
    enabled: open && !initialSubject && !subject,
  });

  const gateOptions = (subject?.locationId ? locations.filter((l) => l.id === subject.locationId) : locations).flatMap((l) =>
    l.gates.map((g) => ({ value: g.id, label: subject?.locationId ? g.name : `${g.name} (${l.name})` })),
  );

  const save = useAction(
    () => {
      const [date, time] = when.split('T');
      return api.post<{ reference: string }>('/corrections/missing-event', {
        subjectType: subject!.type,
        subjectId: subject!.id,
        eventType,
        gateId: Number(gateId),
        reportedOccurredAt: zonedIso(date, time),
        reason: reason.trim(),
      });
    },
    {
      success: (r) => `Correction ${r.reference} recorded`,
      invalidate: [['events'], ['presence'], ['dashboard'], ['personnel'], ['visits'], ['vehicles']],
      onSuccess: () => {
        onClose();
        onDone?.();
      },
    },
  );

  const future = (() => {
    if (!when.includes('T')) return false;
    const [date, time] = when.split('T');
    return Date.parse(zonedIso(date, time)) > Date.now();
  })();
  const valid = !!subject && !!gateId && reason.trim().length >= 5 && !future && when.length >= 16;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Record a missing movement"
      description="Adds an administrative correction entry. Original records are preserved and the correction is written to the audit trail."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Record correction
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {subject ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-canvas/60 px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-sm font-medium text-ink">{subject.name}</div>
              <div className="text-xs text-ink-3">
                {subject.type.charAt(0) + subject.type.slice(1).toLowerCase()}
                {subject.reference ? ` · ${subject.reference}` : ''}
              </div>
            </div>
            {!initialSubject && (
              <Button size="sm" variant="ghost" onClick={() => setSubject(null)}>
                Change
              </Button>
            )}
          </div>
        ) : (
          <Field label="Who is recorded inside but has left?" hint="Missing exits are the most common correction. To add a missing entry, open the subject's latest event instead.">
            <SearchInput value={search} onChange={setSearch} placeholder="Search name, reference or registration" className="sm:max-w-none" />
            <ul className="mt-2 max-h-56 divide-y divide-line overflow-y-auto rounded-lg border border-line">
              {(candidates.data?.items ?? []).map((r) => (
                <li key={`${r.subjectType}:${r.subjectId}`}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-forest-50"
                    onClick={() => {
                      setSubject({ type: r.subjectType, id: r.subjectId, name: r.subjectName, reference: r.subjectReference, locationId: r.locationId });
                      setEventType('EXIT');
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink">{r.subjectName}</span>
                      <span className="block text-xs text-ink-3">
                        Inside at {r.locationName} since {fmtDateTime(r.since)}
                      </span>
                    </span>
                    <CategoryPill category={r.category} />
                  </button>
                </li>
              ))}
              {candidates.data && candidates.data.items.length === 0 && <li className="px-3 py-4 text-center text-sm text-ink-3">Nobody matching is recorded inside.</li>}
            </ul>
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Movement to record" required>
            <div className="inline-flex rounded-lg border border-line-strong p-0.5" role="group">
              {(['EXIT', 'ENTRY'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={eventType === t}
                  onClick={() => setEventType(t)}
                  className={cx('rounded-md px-4 py-1.5 text-sm font-medium', eventType === t ? 'bg-forest-800 text-white' : 'text-ink-2 hover:bg-forest-50')}
                >
                  {t === 'EXIT' ? 'Missing exit' : 'Missing entry'}
                </button>
              ))}
            </div>
          </Field>
          <Select label="Gate" required value={gateId} onChange={(e) => setGateId(e.target.value)} placeholder="Select gate" options={gateOptions} />
          <Input
            label={`When it occurred (${timezone()})`}
            type="datetime-local"
            required
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            error={future ? 'Cannot be in the future' : null}
            hint={serverCopy('Stored as the reported time; the record time is set by the server.', 'Stored as the reported time; the record time is set when the correction is saved.')}
          />
        </div>
        <Textarea label="Reason for correction" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Exit not recorded during register changeover; confirmed with duty NCO" />
        <Notice tone="info">The correction appears in the register as a separate entry marked “Correction entry”. Nothing is deleted or overwritten.</Notice>
      </div>
    </Modal>
  );
}
