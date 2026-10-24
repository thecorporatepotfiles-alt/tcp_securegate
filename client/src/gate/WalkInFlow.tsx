import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, UserPlus } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useMe } from '../lib/auth';
import { nowLocalTime } from '../lib/format';
import type { Row } from '../lib/types';
import { VisitStatusBadge } from '../components/status';
import { useGateId } from './GateContext';
import { GateButton, GateError, GateInput, GateNote, GateSelect, GateTextarea, ScreenHeader } from './gateUi';

function defaultDeparture(): string {
  const now = nowLocalTime();
  const plus = nowLocalTime(120);
  // Keep the default within today (the API requires a departure later today).
  return plus > now ? plus : '23:30';
}

const EMPTY = { fullName: '', company: '', phone: '', hostUserId: '', purpose: '', destination: '', departureTime: '', vehicleRegistration: '', vehicleCategory: 'CAR', notes: '' };

/** Register a visitor who arrived without pre-registration. Entry still needs host acknowledgement and authorization. */
export function WalkInFlow() {
  const gateId = useGateId();
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const hosts = useQuery({ queryKey: ['gate', gateId, 'hosts'], queryFn: () => api.get<Row[]>(`/gate/${gateId}/hosts`) });
  const [form, setForm] = useState({ ...EMPTY, departureTime: defaultDeparture() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Row | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<Row>('/gate/walk-in', {
        gateId,
        visitor: { fullName: form.fullName.trim(), company: form.company.trim() || null, phone: form.phone.trim() || null, email: null },
        hostUserId: Number(form.hostUserId),
        purpose: form.purpose.trim(),
        destination: form.destination.trim(),
        departureTime: form.departureTime,
        vehicle: form.vehicleRegistration.trim() ? { registration: form.vehicleRegistration.trim(), category: form.vehicleCategory } : null,
        notes: form.notes.trim() || null,
      });
      setCreated(r);
      qc.invalidateQueries({ queryKey: ['gate', gateId] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <>
        <ScreenHeader title="Visitor arrival registered" />
        <div className="mx-auto max-w-2xl space-y-5">
          <div className="rounded-2xl border border-gold-400/50 bg-forest-900 p-6 text-center" role="status" aria-live="polite">
            <BellRing className="mx-auto size-12 text-gold-400" aria-hidden />
            <div className="mt-3 text-2xl font-semibold text-white">{created.visitorName}</div>
            <div className="mt-1 font-mono text-sm text-forest-200/70">{created.reference}</div>
            <div className="mt-3 flex justify-center">
              <VisitStatusBadge status={created.status} />
            </div>
            <p className="mx-auto mt-4 max-w-md text-[15px] text-forest-200/90">
              {created.hostName} has been notified in-app. <strong className="text-white">Entry is not permitted yet</strong> — the host must acknowledge and an approving officer must authorize the visit. When approved, verify the visitor from the visitor queue.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <GateButton variant="gold" size="xl" onClick={() => navigate('/gate/visitors')}>
              Open visitor queue
            </GateButton>
            <GateButton
              size="xl"
              onClick={() => {
                setCreated(null);
                setForm({ ...EMPTY, departureTime: defaultDeparture() });
              }}
            >
              Register another
            </GateButton>
          </div>
        </div>
      </>
    );
  }

  const valid = form.fullName.trim() && form.hostUserId && form.purpose.trim() && form.destination.trim() && /^\d{2}:\d{2}$/.test(form.departureTime);

  return (
    <>
      <ScreenHeader title="Visitor arrival (walk-in)" subtitle="For visitors without a pass. Registering an arrival does not admit the visitor." />
      <form onSubmit={submit} className="space-y-5 rounded-2xl border border-white/10 bg-forest-900 p-4 sm:p-6">
        <div className="flex items-center gap-2">
          <UserPlus className="size-6 text-gold-400" aria-hidden />
          <h2 className="text-lg font-semibold text-white">Visitor details</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <GateInput label="Visitor name" required value={form.fullName} onChange={set('fullName')} autoComplete="off" />
          <GateInput label="Organization" value={form.company} onChange={set('company')} />
          <GateInput label="Contact number" inputMode="tel" value={form.phone} onChange={set('phone')} />
          <GateSelect
            label="Host / approving officer"
            required
            value={form.hostUserId}
            onChange={set('hostUserId')}
            placeholder={hosts.isLoading ? 'Loading…' : 'Select the person being visited'}
            options={(hosts.data ?? []).map((h) => ({ value: h.id, label: `${h.name}${h.department ? ` · ${h.department}` : ''}` }))}
          />
          <GateInput label="Purpose of visit" required value={form.purpose} onChange={set('purpose')} />
          <GateInput label="Destination" required value={form.destination} onChange={set('destination')} placeholder="e.g. Admin Block" />
          <GateInput label="Expected departure (today)" required type="time" value={form.departureTime} onChange={set('departureTime')} />
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <GateInput label="Vehicle registration (optional)" value={form.vehicleRegistration} onChange={(e) => setForm((f) => ({ ...f, vehicleRegistration: e.target.value.toUpperCase() }))} />
            <GateSelect label="Type" value={form.vehicleCategory} onChange={set('vehicleCategory')} options={me.options.vehicleCategories.map((c) => ({ value: c.code, label: c.label }))} />
          </div>
        </div>
        <GateTextarea label="Notes" rows={2} value={form.notes} onChange={set('notes')} />
        {error && <GateError>{error}</GateError>}
        <GateNote>The host is notified in-app only. SecureGate does not claim the host has seen the notification until they acknowledge it.</GateNote>
        <GateButton type="submit" variant="gold" size="xl" className="w-full" loading={busy} disabled={!valid}>
          Register arrival and notify host
        </GateButton>
      </form>
    </>
  );
}
