import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Building2, DoorOpen, Pencil, Plus } from 'lucide-react';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { Row } from '../../lib/types';
import { GATE_TYPES, GATE_TYPE_LABEL, type GateType } from '../../../../shared/constants';
import { useAction } from '../../components/toast';
import { Badge, Button, Card, Checkbox, EmptyState, ErrorState, Input, Modal, Notice, PageHeader, Select, Spinner } from '../../components/ui';
import { SimulatedTag } from '../../components/status';
import { fieldErrors } from '../../components/ops/common';

export default function LocationsPage() {
  const { me } = useAuth();
  const isSysAdmin = me?.user.role === 'SYSTEM_ADMIN';
  const q = useQuery({ queryKey: ['admin', 'locations'], queryFn: () => api.get<Row[]>('/admin/locations') });
  const [locEdit, setLocEdit] = useState<Row | 'new' | null>(null);
  const [gateEdit, setGateEdit] = useState<{ gate: Row | null; locationId: number } | null>(null);

  return (
    <>
      <PageHeader
        title="Locations & gates"
        subtitle={isSysAdmin ? 'Headquarters and locations, each with its own gates. Users only see locations they are assigned to.' : 'Gates at your location. Only a System Administrator can create or edit locations.'}
        actions={
          isSysAdmin && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setLocEdit('new')}>
              New location
            </Button>
          )
        }
      />
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.data!.length === 0 ? (
        <EmptyState icon={<Building2 className="size-5" />} title="No locations" />
      ) : (
        <div className="grid gap-5 xl:grid-cols-2">
          {q.data!.map((l) => (
            <Card key={l.id}>
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold text-ink">{l.name}</h2>
                    <Badge tone={l.kind === 'HQ' ? 'info' : 'neutral'} icon={false}>
                      {l.kind === 'HQ' ? 'Headquarters' : 'Location'}
                    </Badge>
                    {!l.isActive && <Badge tone="danger">Inactive</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs text-ink-3">
                    <span className="font-mono">{l.code}</span> · {l.personnelCount} personnel · {l.userCount} users{l.addressNote ? ` · ${l.addressNote}` : ''}
                  </div>
                </div>
                <div className="flex gap-2">
                  {isSysAdmin && (
                    <Button size="sm" icon={<Pencil className="size-4" />} onClick={() => setLocEdit(l)}>
                      Edit
                    </Button>
                  )}
                  <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setGateEdit({ gate: null, locationId: l.id })}>
                    Add gate
                  </Button>
                </div>
              </div>
              {(l.gates as Row[]).length === 0 ? (
                <p className="text-sm text-ink-3">No gates yet. Add a gate so guards can record movement here.</p>
              ) : (
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {(l.gates as Row[]).map((g) => (
                    <li key={g.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                      <DoorOpen className="size-4 shrink-0 text-ink-3" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{g.name}</div>
                        <div className="text-xs text-ink-3">
                          <span className="font-mono">{g.code}</span> · {GATE_TYPE_LABEL[g.gateType as GateType] ?? g.gateType}
                        </div>
                      </div>
                      {g.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}
                      <Button size="sm" variant="ghost" aria-label={`Edit ${g.name}`} icon={<Pencil className="size-4" />} onClick={() => setGateEdit({ gate: g, locationId: l.id })} />
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-xs text-ink-3">
                Each gate has a <SimulatedTag>mock reader</SimulatedTag> only. No physical readers, barriers or turnstiles are connected or controlled.
              </p>
            </Card>
          ))}
        </div>
      )}
      {locEdit && <LocationModal location={locEdit === 'new' ? null : locEdit} onClose={() => setLocEdit(null)} />}
      {gateEdit && <GateModal gate={gateEdit.gate} locationId={gateEdit.locationId} onClose={() => setGateEdit(null)} />}
    </>
  );
}

function LocationModal({ location, onClose }: { location: Row | null; onClose: () => void }) {
  const [form, setForm] = useState({
    code: location?.code ?? '',
    name: location?.name ?? '',
    kind: location?.kind ?? 'LOCATION',
    addressNote: location?.addressNote ?? '',
    isActive: location ? !!location.isActive : true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useAction(
    (body: Record<string, unknown>) => (location ? api.patch(`/admin/locations/${location.id}`, body) : api.post('/admin/locations', body)),
    {
      success: location ? 'Location updated' : 'Location created',
      invalidate: [['admin', 'locations'], ['me']],
      onSuccess: onClose,
      onError: (e) => setErrors(e instanceof ApiError && e.code === 'DUPLICATE_LOCATION' ? { code: e.message } : fieldErrors(e)),
    },
  );
  const submit = () => {
    const errs: Record<string, string> = {};
    if (!location && !/^[A-Z0-9-]{2,12}$/.test(form.code)) errs.code = '2–12 upper-case letters, digits or dashes';
    if (!form.name.trim()) errs.name = 'Required';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    if (!location) {
      save.mutate({ code: form.code, name: form.name.trim(), kind: form.kind, addressNote: form.addressNote || null, isActive: form.isActive });
      return;
    }
    const changes: Record<string, unknown> = {};
    if (form.name.trim() !== location.name) changes.name = form.name.trim();
    if (form.kind !== location.kind) changes.kind = form.kind;
    if ((form.addressNote || null) !== (location.addressNote ?? null)) changes.addressNote = form.addressNote || null;
    if (form.isActive !== !!location.isActive) changes.isActive = form.isActive;
    if (Object.keys(changes).length === 0) return onClose();
    save.mutate(changes);
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={location ? `Edit ${location.name}` : 'New location'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {location ? 'Save changes' : 'Create location'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Input label="Code" required value={form.code} disabled={!!location} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} error={errors.code} hint={location ? 'Code cannot be changed' : 'e.g. LOC-E'} />
        <Input label="Name" required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} error={errors.name} />
        <Select
          label="Type"
          value={form.kind}
          onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
          options={[
            { value: 'LOCATION', label: 'Location' },
            { value: 'HQ', label: 'Headquarters' },
          ]}
        />
        <Input label="Note (non-sensitive)" value={form.addressNote} onChange={(e) => setForm((f) => ({ ...f, addressNote: e.target.value }))} hint="Do not record sensitive site details" />
        <Checkbox label="Active" hint="Inactive locations are hidden from users and cannot record movement" checked={form.isActive} onChange={(v) => setForm((f) => ({ ...f, isActive: v }))} />
        {location && !form.isActive && location.isActive ? <Notice tone="warning">Users assigned only to this location will lose access to it.</Notice> : null}
      </div>
    </Modal>
  );
}

function GateModal({ gate, locationId, onClose }: { gate: Row | null; locationId: number; onClose: () => void }) {
  const [form, setForm] = useState({ code: gate?.code ?? '', name: gate?.name ?? '', gateType: gate?.gateType ?? 'MAIN', isActive: gate ? !!gate.isActive : true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useAction((body: Record<string, unknown>) => (gate ? api.patch(`/admin/gates/${gate.id}`, body) : api.post('/admin/gates', body)), {
    success: gate ? 'Gate updated' : 'Gate created',
    invalidate: [['admin', 'locations'], ['me']],
    onSuccess: onClose,
    onError: (e) => setErrors(e instanceof ApiError && e.code === 'DUPLICATE_GATE' ? { code: e.message } : fieldErrors(e)),
  });
  const submit = () => {
    const errs: Record<string, string> = {};
    if (!gate && !/^[A-Z0-9-]{2,12}$/.test(form.code)) errs.code = '2–12 upper-case letters, digits or dashes';
    if (!form.name.trim()) errs.name = 'Required';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    if (!gate) {
      save.mutate({ locationId, code: form.code, name: form.name.trim(), gateType: form.gateType, isActive: form.isActive });
      return;
    }
    const changes: Record<string, unknown> = {};
    if (form.name.trim() !== gate.name) changes.name = form.name.trim();
    if (form.gateType !== gate.gateType) changes.gateType = form.gateType;
    if (form.isActive !== !!gate.isActive) changes.isActive = form.isActive;
    if (Object.keys(changes).length === 0) return onClose();
    save.mutate(changes);
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={gate ? `Edit ${gate.name}` : 'Add gate'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {gate ? 'Save changes' : 'Add gate'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Input label="Code" required value={form.code} disabled={!!gate} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} error={errors.code} hint={gate ? 'Code cannot be changed' : 'Unique within the location, e.g. A4'} />
        <Input label="Name" required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} error={errors.name} />
        <Select label="Gate type" value={form.gateType} onChange={(e) => setForm((f) => ({ ...f, gateType: e.target.value }))} options={GATE_TYPES.map((t) => ({ value: t, label: GATE_TYPE_LABEL[t] }))} />
        <Checkbox label="Active" hint="Inactive gates cannot record verification or movement" checked={form.isActive} onChange={(v) => setForm((f) => ({ ...f, isActive: v }))} />
      </div>
    </Modal>
  );
}
