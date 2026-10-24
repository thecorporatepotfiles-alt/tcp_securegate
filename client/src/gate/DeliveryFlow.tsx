import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Minus, Package, Plus, Truck } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useMe } from '../lib/auth';
import { fmtTime } from '../lib/format';
import type { Row } from '../lib/types';
import { DeliveryStatusBadge } from '../components/status';
import { useToast } from '../components/toast';
import { cx } from '../components/ui';
import { useGateId } from './GateContext';
import { EmptyGate, GateButton, GateError, GateInput, GateNote, GateSelect, GateSpinner, GateTextarea, ScreenHeader } from './gateUi';

type Tab = 'open' | 'register';

export function DeliveryFlow() {
  const gateId = useGateId();
  const [tab, setTab] = useState<Tab>('open');
  return (
    <>
      <ScreenHeader title="Deliveries" subtitle="Register arrivals, record courier entry and departure." />
      <GateNote tone="gold">
        Authorization to proceed is <strong className="text-white">not</strong> proof of inspection or acceptance. Package handling and any inspection follow the establishment's approved procedures.
      </GateNote>
      <div className="my-5 grid grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-forest-900 p-1.5" role="tablist">
        {(
          [
            ['open', 'Open deliveries'],
            ['register', 'Register arrival'],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={tab === v}
            onClick={() => setTab(v)}
            className={cx('min-h-12 rounded-xl text-base font-semibold transition-colors', tab === v ? 'bg-gold-400 text-forest-950' : 'text-forest-200 hover:bg-white/[0.06]')}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'open' ? <OpenDeliveries gateId={gateId} /> : <RegisterDelivery gateId={gateId} onDone={() => setTab('open')} />}
    </>
  );
}

function OpenDeliveries({ gateId }: { gateId: number }) {
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['gate', gateId, 'deliveries'], queryFn: () => api.get<Row[]>(`/gate/${gateId}/deliveries`), refetchInterval: 15_000 });
  const [busy, setBusy] = useState<number | null>(null);
  const [departing, setDeparting] = useState<Row | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['gate', gateId] });

  const arrive = async (d: Row) => {
    setBusy(d.id);
    setError(null);
    try {
      await api.post(`/gate/deliveries/${d.id}/arrive`, { gateId });
      toast.success(`Arrival recorded for ${d.reference}`);
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const needsReason = (d: Row) => !['RECEIVED', 'REJECTED', 'RETURNED'].includes(d.status);

  const depart = async () => {
    if (!departing) return;
    setBusy(departing.id);
    setError(null);
    try {
      await api.post(`/gate/deliveries/${departing.id}/depart`, { gateId, reason: reason.trim() || null });
      toast.success(`Departure recorded for ${departing.reference}`);
      setDeparting(null);
      setReason('');
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (q.isLoading) return <GateSpinner />;
  if (q.isError) return <GateError>{errorMessage(q.error)}</GateError>;
  const rows = q.data ?? [];

  return (
    <div className="space-y-3">
      {error && <GateError>{error}</GateError>}
      {departing && (
        <div className="space-y-3 rounded-2xl border border-gold-400/50 bg-forest-900 p-4">
          <div className="text-base font-semibold text-white">
            Record departure — {departing.company} ({departing.reference})
          </div>
          {departing.presenceState === 'INSIDE' && <p className="text-sm text-forest-200/80">The courier is recorded inside; an exit will be recorded at this gate.</p>}
          {needsReason(departing) && (
            <GateTextarea
              label="Reason (delivery not received)"
              required
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              hint="The delivery will be marked Returned because receipt was not acknowledged."
            />
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <GateButton onClick={() => setDeparting(null)}>Cancel</GateButton>
            <GateButton variant="gold" loading={busy === departing.id} disabled={needsReason(departing) && reason.trim().length < 3} onClick={depart}>
              Confirm departure
            </GateButton>
          </div>
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyGate title="No open deliveries at this location">Use “Register arrival” when a courier or supplier arrives.</EmptyGate>
      ) : (
        rows.map((d) => (
          <div key={d.id} className="rounded-2xl border border-white/10 bg-forest-900 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-lg font-semibold text-white">{d.company}</span>
                  <DeliveryStatusBadge status={d.status} />
                  {d.presenceState === 'INSIDE' && <span className="rounded-full bg-[#1f8a5f]/30 px-2 py-0.5 text-xs font-semibold text-[#5fd39a]">Courier inside</span>}
                </div>
                <div className="mt-1 text-sm text-forest-200/80">
                  {d.courierName} · for {d.recipientUserName ?? d.recipientName ?? 'recipient'} ({d.recipientDepartment}) · {d.itemCount} item{d.itemCount === 1 ? '' : 's'}: {d.description}
                </div>
                <div className="mt-0.5 font-mono text-xs text-forest-200/60">
                  {d.reference}
                  {d.arrivedAt ? ` · arrived ${fmtTime(d.arrivedAt)}` : ''}
                  {d.vehicleRegistration ? ` · vehicle ${d.vehicleRegistration}` : ''}
                </div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {d.status === 'EXPECTED' && (
                <GateButton variant="gold" loading={busy === d.id} onClick={() => arrive(d)}>
                  Record arrival
                </GateButton>
              )}
              {d.status === 'AUTHORIZED' && d.presenceState !== 'INSIDE' && (
                <GateButton variant="success" onClick={() => navigate(`/gate/verify/delivery?input=${encodeURIComponent(d.reference)}&method=REFERENCE&action=ENTRY&return=/gate/deliveries`)}>
                  Verify & record courier entry
                </GateButton>
              )}
              {d.status !== 'EXPECTED' && !d.departedAt && (
                <GateButton
                  onClick={() => {
                    setDeparting(d);
                    setReason('');
                  }}
                >
                  Record departure
                </GateButton>
              )}
              {['ARRIVED', 'AWAITING_AUTHORIZATION'].includes(d.status) && (
                <span className="self-center text-sm text-gold-300">Awaiting authorization by the recipient or an administrator.</span>
              )}
              {d.status === 'AUTHORIZED' && <span className="self-center text-sm text-forest-200/70">Awaiting receipt acknowledgement by the recipient.</span>}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function RegisterDelivery({ gateId, onDone }: { gateId: number; onDone: () => void }) {
  const me = useMe();
  const toast = useToast();
  const qc = useQueryClient();
  const recipients = useQuery({ queryKey: ['gate', gateId, 'recipients'], queryFn: () => api.get<Row[]>(`/gate/${gateId}/recipients`) });
  const [form, setForm] = useState({
    category: me.options.deliveryCategories[0]?.code ?? 'COURIER',
    company: '',
    courierName: '',
    courierPhone: '',
    vehicleRegistration: '',
    recipientUserId: '',
    recipientName: '',
    recipientDepartment: '',
    description: '',
    itemCount: 1,
    notes: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<Row>('/gate/deliveries', {
        gateId,
        category: form.category,
        company: form.company.trim(),
        courierName: form.courierName.trim(),
        courierPhone: form.courierPhone.trim() || null,
        vehicleRegistration: form.vehicleRegistration.trim() || null,
        recipientUserId: form.recipientUserId ? Number(form.recipientUserId) : null,
        recipientName: form.recipientName.trim() || null,
        recipientDepartment: form.recipientDepartment.trim(),
        description: form.description.trim(),
        itemCount: form.itemCount,
        notes: form.notes.trim() || null,
      });
      toast.success(`Delivery ${r.reference} registered — ${r.status === 'AUTHORIZED' ? 'authorized to proceed' : 'awaiting authorization'}`);
      qc.invalidateQueries({ queryKey: ['gate', gateId] });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const valid = form.company.trim() && form.courierName.trim() && form.recipientDepartment.trim() && form.description.trim();

  return (
    <form onSubmit={submit} className="space-y-5 rounded-2xl border border-white/10 bg-forest-900 p-4 sm:p-6">
      <div className="flex items-center gap-2">
        <Truck className="size-6 text-gold-400" aria-hidden />
        <h2 className="text-lg font-semibold text-white">Register delivery arrival</h2>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <GateSelect label="Category" required value={form.category} onChange={set('category')} options={me.options.deliveryCategories.map((c) => ({ value: c.code, label: c.label }))} />
        <GateInput label="Company / supplier" required value={form.company} onChange={set('company')} />
        <GateInput label="Delivery person's name" required value={form.courierName} onChange={set('courierName')} />
        <GateInput label="Contact number" inputMode="tel" value={form.courierPhone} onChange={set('courierPhone')} />
        <GateSelect
          label="Recipient"
          value={form.recipientUserId}
          onChange={(e) => {
            const r = (recipients.data ?? []).find((x) => String(x.id) === e.target.value);
            setForm((f) => ({ ...f, recipientUserId: e.target.value, recipientDepartment: r?.department ?? f.recipientDepartment }));
          }}
          placeholder="Not listed / enter name"
          options={(recipients.data ?? []).map((r) => ({ value: r.id, label: `${r.name}${r.department ? ` · ${r.department}` : ''}` }))}
        />
        {!form.recipientUserId && <GateInput label="Recipient name" value={form.recipientName} onChange={set('recipientName')} />}
        <GateInput label="Recipient department" required value={form.recipientDepartment} onChange={set('recipientDepartment')} />
        <GateInput label="Vehicle registration (optional)" value={form.vehicleRegistration} onChange={(e) => setForm((f) => ({ ...f, vehicleRegistration: e.target.value.toUpperCase() }))} />
        <GateInput label="Description" required value={form.description} onChange={set('description')} placeholder="e.g. Boxed spare parts" />
        <div>
          <span className="mb-1.5 block text-sm font-medium text-forest-200">
            Number of parcels / items<span className="ml-0.5 text-gold-400">*</span>
          </span>
          <div className="flex items-center gap-2">
            <GateButton aria-label="Fewer items" onClick={() => setForm((f) => ({ ...f, itemCount: Math.max(0, f.itemCount - 1) }))} icon={<Minus className="size-5" />} />
            <input
              aria-label="Item count"
              type="number"
              min={0}
              max={10000}
              value={form.itemCount}
              onChange={(e) => setForm((f) => ({ ...f, itemCount: Math.max(0, Math.min(10000, Number(e.target.value) || 0)) }))}
              className="h-14 w-24 rounded-xl border border-white/15 bg-forest-950/70 text-center text-2xl font-semibold text-white focus:border-gold-400 focus:outline-none"
            />
            <GateButton aria-label="More items" onClick={() => setForm((f) => ({ ...f, itemCount: Math.min(10000, f.itemCount + 1) }))} icon={<Plus className="size-5" />} />
          </div>
        </div>
      </div>
      <GateTextarea label="Notes" rows={2} value={form.notes} onChange={set('notes')} />
      {error && <GateError>{error}</GateError>}
      <GateNote>
        <Package className="mr-1 inline size-4 align-text-bottom" aria-hidden />
        The recipient and authorized administrators are notified in-app. Entry is recorded separately, only after authorization.
      </GateNote>
      <GateButton type="submit" variant="gold" size="xl" className="w-full" loading={busy} disabled={!valid}>
        Register arrival
      </GateButton>
    </form>
  );
}
