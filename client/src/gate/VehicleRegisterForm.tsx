import { useState, type FormEvent } from 'react';
import { CarFront } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useMe } from '../lib/auth';
import { GateButton, GateError, GateInput, GateNote, GateSelect, GateTextarea } from './gateUi';

/** Quick registration of an unregistered vehicle at the gate. New vehicles start as Pending. */
export function VehicleRegisterForm({ gateId, registration, onRegistered, onCancel }: { gateId: number; registration: string; onRegistered: () => void; onCancel: () => void }) {
  const me = useMe();
  const [form, setForm] = useState({ registration, category: me.options.vehicleCategories[0]?.code ?? 'CAR', makeModel: '', colour: '', ownerType: 'VISITOR', ownerName: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/gate/vehicles', {
        gateId,
        registration: form.registration.trim(),
        category: form.category,
        makeModel: form.makeModel || null,
        colour: form.colour || null,
        ownerType: form.ownerType,
        ownerName: form.ownerName || null,
        notes: form.notes || null,
      });
      onRegistered();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4 rounded-2xl border border-white/10 bg-forest-950/50 p-4">
      <div className="flex items-center gap-2">
        <CarFront className="size-5 text-gold-400" aria-hidden />
        <h3 className="text-base font-semibold text-white">Register this vehicle</h3>
      </div>
      <GateNote>New vehicles are registered as <strong className="text-white">Pending</strong>. Entry still requires an authorized link (approved visit or delivery), administrator authorization, or a manual review.</GateNote>
      <div className="grid gap-4 sm:grid-cols-2">
        <GateInput label="Registration number" required value={form.registration} onChange={(e) => setForm((f) => ({ ...f, registration: e.target.value.toUpperCase() }))} />
        <GateSelect label="Category" required value={form.category} onChange={set('category')} options={me.options.vehicleCategories.map((c) => ({ value: c.code, label: c.label }))} />
        <GateInput label="Make / model" value={form.makeModel} onChange={set('makeModel')} />
        <GateInput label="Colour" value={form.colour} onChange={set('colour')} />
        <GateSelect
          label="Associated with"
          value={form.ownerType}
          onChange={set('ownerType')}
          options={[
            { value: 'VISITOR', label: 'Visitor' },
            { value: 'CONTRACTOR', label: 'Contractor / vendor' },
            { value: 'DELIVERY', label: 'Delivery' },
            { value: 'OTHER', label: 'Other' },
          ]}
        />
        <GateInput label="Owner / driver name" value={form.ownerName} onChange={set('ownerName')} />
      </div>
      <GateTextarea label="Notes" rows={2} value={form.notes} onChange={set('notes')} />
      {error && <GateError>{error}</GateError>}
      <div className="flex flex-wrap justify-end gap-2">
        <GateButton onClick={onCancel}>Cancel</GateButton>
        <GateButton type="submit" variant="gold" loading={busy} disabled={form.registration.trim().length < 4}>
          Register and verify
        </GateButton>
      </div>
    </form>
  );
}
