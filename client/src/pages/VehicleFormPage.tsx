import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLocationScope } from '../lib/location';
import { titleCase } from '../lib/format';
import type { Row } from '../lib/types';
import { VEHICLE_AUTH_INFO, VEHICLE_AUTH_STATUSES, VEHICLE_OWNER_TYPES } from '../../../shared/constants';
import { useAction } from '../components/toast';
import { Button, Card, Checkbox, ErrorState, Field, Input, Notice, PageHeader, Select, Spinner, Textarea } from '../components/ui';
import { LookupPicker } from '../components/ops/LookupPicker';
import { fieldErrors } from '../components/ops/common';

export default function VehicleFormPage() {
  const params = useParams();
  const editId = params.id ? Number(params.id) : null;
  const navigate = useNavigate();
  const { me } = useAuth();
  const { locations, locationId } = useLocationScope();
  const categories = me?.options.vehicleCategories ?? [];
  const existing = useQuery({ queryKey: ['vehicles', 'detail', editId], queryFn: () => api.get<Row>(`/vehicles/${editId}`), enabled: !!editId });
  const [form, setForm] = useState({
    registration: '',
    category: categories[0]?.code ?? 'CAR',
    makeModel: '',
    colour: '',
    ownerType: 'PERSONNEL',
    ownerName: '',
    locationId: String(locationId ?? locations[0]?.id ?? ''),
    authorizationStatus: 'PENDING',
    authorizedUntil: '',
    authorizedLocationIds: [] as number[],
    notes: '',
    reason: '',
  });
  const [personnel, setPersonnel] = useState<Row | null>(null);
  const [contractor, setContractor] = useState<Row | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const v = existing.data;
    if (!v) return;
    setForm({
      registration: v.registration,
      category: v.category,
      makeModel: v.makeModel ?? '',
      colour: v.colour ?? '',
      ownerType: v.ownerType,
      ownerName: v.ownerName ?? '',
      locationId: String(v.locationId),
      authorizationStatus: v.authorizationStatus,
      authorizedUntil: v.authorizedUntil ?? '',
      authorizedLocationIds: (v.authorizedLocations as Row[]).map((l) => l.id),
      notes: v.notes ?? '',
      reason: '',
    });
    if (v.personnelId) setPersonnel({ id: v.personnelId, name: v.ownerDisplay });
    if (v.contractorId) setContractor({ id: v.contractorId, name: v.ownerDisplay });
  }, [existing.data]);

  const save = useAction((body: Record<string, unknown>) => (editId ? api.patch<Row>(`/vehicles/${editId}`, body) : api.post<Row>('/vehicles', body)), {
    success: editId ? 'Vehicle updated' : 'Vehicle registered',
    invalidate: [['vehicles']],
    onSuccess: (r) => navigate(`/vehicles/${r.id}`),
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'DUPLICATE_VEHICLE') setErrors({ registration: e.message });
      else setErrors(fieldErrors(e));
    },
  });

  if (editId && existing.isLoading) return <Spinner />;
  if (editId && existing.isError) return <ErrorState error={existing.error} />;

  const upd = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const authChanged = !!editId && existing.data && existing.data.authorizationStatus !== form.authorizationStatus;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!editId && form.registration.replace(/[^A-Za-z0-9]/g, '').length < 4) errs.registration = 'Enter a complete registration number';
    if (form.ownerType === 'PERSONNEL' && !personnel) errs.owner = 'Select the associated personnel record';
    if (form.ownerType === 'CONTRACTOR' && !contractor) errs.owner = 'Select the associated contractor';
    if (!form.locationId) errs.locationId = 'Required';
    if (authChanged && form.reason.trim().length < 3) errs.reason = 'Give a reason for the authorization change';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const body: Record<string, unknown> = {
      category: form.category,
      makeModel: form.makeModel || null,
      colour: form.colour || null,
      ownerType: form.ownerType,
      personnelId: form.ownerType === 'PERSONNEL' ? personnel?.id : null,
      contractorId: form.ownerType === 'CONTRACTOR' ? contractor?.id : null,
      ownerName: form.ownerName || null,
      locationId: Number(form.locationId),
      authorizationStatus: form.authorizationStatus,
      authorizedUntil: form.authorizedUntil || null,
      authorizedLocationIds: form.authorizedLocationIds.filter((id) => id !== Number(form.locationId)),
      notes: form.notes || null,
    };
    if (editId) body.reason = form.reason || null;
    else body.registration = form.registration.trim();
    save.mutate(body);
  };

  return (
    <>
      <PageHeader
        back={{ to: editId ? `/vehicles/${editId}` : '/vehicles', label: editId ? 'Back to vehicle' : 'Vehicle register' }}
        title={editId ? 'Edit vehicle' : 'Register vehicle'}
        subtitle="Use fictional registration numbers in this demonstration environment."
      />
      <form onSubmit={submit} noValidate>
        <Card className="max-w-3xl">
          <div className="grid gap-5 sm:grid-cols-2">
            <Input
              label="Registration number"
              required
              value={form.registration}
              onChange={(e) => setForm((f) => ({ ...f, registration: e.target.value.toUpperCase() }))}
              disabled={!!editId}
              error={errors.registration}
              hint={editId ? 'Registration cannot be changed' : 'e.g. DM 21 AX 4821'}
              className="font-mono tracking-wide"
            />
            <Select label="Category" required value={form.category} onChange={upd('category')} options={categories.map((c) => ({ value: c.code, label: c.label }))} />
            <Input label="Make / model" value={form.makeModel} onChange={upd('makeModel')} />
            <Input label="Colour" value={form.colour} onChange={upd('colour')} />
            <Select
              label="Owner / association"
              required
              value={form.ownerType}
              onChange={(e) => {
                setForm((f) => ({ ...f, ownerType: e.target.value }));
                setErrors((x) => ({ ...x, owner: '' }));
              }}
              options={VEHICLE_OWNER_TYPES.map((o) => ({ value: o, label: titleCase(o) }))}
            />
            {form.ownerType === 'PERSONNEL' ? (
              <LookupPicker
                label="Personnel record"
                required
                endpoint="/lookups/personnel"
                value={personnel}
                onChange={setPersonnel}
                error={errors.owner}
                render={(r) => ({ title: r.name, subtitle: [r.serviceNumber, r.unit].filter(Boolean).join(' · ') })}
              />
            ) : form.ownerType === 'CONTRACTOR' ? (
              <LookupPicker
                label="Contractor"
                required
                endpoint="/lookups/contractors"
                value={contractor}
                onChange={setContractor}
                error={errors.owner}
                render={(r) => ({ title: r.name, subtitle: [r.reference, r.company].filter(Boolean).join(' · ') })}
              />
            ) : (
              <Input label="Owner name / organization" value={form.ownerName} onChange={upd('ownerName')} />
            )}
            <Select label="Registered location" required value={form.locationId} onChange={upd('locationId')} error={errors.locationId} options={locations.map((l) => ({ value: l.id, label: l.name }))} />
            <Select label="Authorization status" required value={form.authorizationStatus} onChange={upd('authorizationStatus')} options={VEHICLE_AUTH_STATUSES.map((s) => ({ value: s, label: VEHICLE_AUTH_INFO[s].label }))} />
            <Input label="Authorized until" type="date" value={form.authorizedUntil} onChange={upd('authorizedUntil')} hint="Leave blank for no end date" />
            <Field label="Also authorized at" hint="The registered location is always included.">
              <div className="grid gap-2 rounded-lg border border-line p-3">
                {locations
                  .filter((l) => String(l.id) !== form.locationId)
                  .map((l) => (
                    <Checkbox
                      key={l.id}
                      label={l.name}
                      checked={form.authorizedLocationIds.includes(l.id)}
                      onChange={(v) => setForm((f) => ({ ...f, authorizedLocationIds: v ? [...f.authorizedLocationIds, l.id] : f.authorizedLocationIds.filter((x) => x !== l.id) }))}
                    />
                  ))}
                {locations.length <= 1 && <span className="text-xs text-ink-3">No other locations in your scope.</span>}
              </div>
            </Field>
            <Textarea label="Notes" containerClassName="sm:col-span-2" value={form.notes} onChange={upd('notes')} />
            {authChanged && (
              <Textarea
                label="Reason for authorization change"
                required
                containerClassName="sm:col-span-2"
                value={form.reason}
                onChange={upd('reason')}
                error={errors.reason}
                hint="Recorded in the audit trail"
              />
            )}
          </div>
          {form.authorizationStatus === 'BLOCKED' && (
            <Notice tone="warning" className="mt-5">
              Blocked vehicles are refused at verification and raise no automatic barrier action — guards follow established procedure.
            </Notice>
          )}
          <div className="mt-6 flex justify-end gap-2 border-t border-line pt-4">
            <Button onClick={() => navigate(-1)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={save.isPending}>
              {editId ? 'Save changes' : 'Register vehicle'}
            </Button>
          </div>
        </Card>
      </form>
    </>
  );
}
