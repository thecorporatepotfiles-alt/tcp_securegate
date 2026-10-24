import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { useLocationScope } from '../lib/location';
import type { Row } from '../lib/types';
import { useAction } from '../components/toast';
import { Button, Card, Checkbox, ErrorState, Field, Input, PageHeader, Select, Spinner, Textarea } from '../components/ui';

const RANKS = ['', 'Sep', 'L/Nk', 'Nk', 'Hav', 'Nb Sub', 'Sub', 'Lt', 'Capt', 'Maj', 'Lt Col', 'Col'];

export default function PersonnelFormPage() {
  const params = useParams();
  const editId = params.id ? Number(params.id) : null;
  const navigate = useNavigate();
  const { locations, locationId } = useLocationScope();
  const existing = useQuery({ queryKey: ['personnel', 'detail', editId], queryFn: () => api.get<Row>(`/personnel/${editId}`), enabled: !!editId });
  const [form, setForm] = useState({
    serviceNumber: '',
    fullName: '',
    rank: '',
    designation: '',
    unit: '',
    department: '',
    locationId: String(locationId ?? locations[0]?.id ?? ''),
    authorizedLocationIds: [] as number[],
    accessValidFrom: '',
    accessValidUntil: '',
    notes: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const p = existing.data;
    if (!p) return;
    setForm({
      serviceNumber: p.serviceNumber,
      fullName: p.fullName,
      rank: p.rank ?? '',
      designation: p.designation ?? '',
      unit: p.unit ?? '',
      department: p.department ?? '',
      locationId: String(p.locationId),
      authorizedLocationIds: p.authorizedLocations.map((l: Row) => l.id).filter((x: number) => x !== p.locationId),
      accessValidFrom: p.accessValidFrom ?? '',
      accessValidUntil: p.accessValidUntil ?? '',
      notes: p.notes ?? '',
    });
  }, [existing.data]);

  const save = useAction(
    (body: Record<string, unknown>) => (editId ? api.patch<Row>(`/personnel/${editId}`, body) : api.post<Row>('/personnel', body)),
    {
      success: editId ? 'Personnel record updated' : 'Personnel record created',
      invalidate: [['personnel']],
      onSuccess: (r) => navigate(`/personnel/${r.id}`),
      onError: (e) => {
        if (e instanceof ApiError && e.code === 'DUPLICATE_PERSONNEL_ID') setErrors({ serviceNumber: e.message });
        const fields = (e as ApiError).details as { fields?: { path: string; message: string }[] } | undefined;
        if (fields?.fields) setErrors(Object.fromEntries(fields.fields.map((f) => [f.path, f.message])));
      },
    },
  );

  if (editId && existing.isLoading) return <Spinner />;
  if (editId && existing.isError) return <ErrorState error={existing.error} />;

  const upd = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!editId && !/^[A-Za-z0-9-/]{3,30}$/.test(form.serviceNumber)) errs.serviceNumber = 'Use 3–30 letters, digits, - or /';
    if (!form.fullName.trim()) errs.fullName = 'Required';
    if (!form.locationId) errs.locationId = 'Required';
    if (form.accessValidFrom && form.accessValidUntil && form.accessValidUntil < form.accessValidFrom) errs.accessValidUntil = 'Must be on or after valid from';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const body: Record<string, unknown> = {
      fullName: form.fullName.trim(),
      rank: form.rank || null,
      designation: form.designation || null,
      unit: form.unit || null,
      department: form.department || null,
      locationId: Number(form.locationId),
      authorizedLocationIds: form.authorizedLocationIds,
      accessValidFrom: form.accessValidFrom || null,
      accessValidUntil: form.accessValidUntil || null,
      notes: form.notes || null,
    };
    if (!editId) body.serviceNumber = form.serviceNumber.trim().toUpperCase();
    save.mutate(body);
  };

  return (
    <>
      <PageHeader
        back={{ to: editId ? `/personnel/${editId}` : '/personnel', label: editId ? 'Back to record' : 'Personnel directory' }}
        title={editId ? 'Edit personnel record' : 'Add personnel record'}
        subtitle="Use fictional data only in this demonstration environment."
      />
      <form onSubmit={submit} noValidate>
        <Card className="max-w-3xl">
          <div className="grid gap-5 sm:grid-cols-2">
            <Input label="Personnel ID" required value={form.serviceNumber} onChange={upd('serviceNumber')} disabled={!!editId} error={errors.serviceNumber} hint={editId ? 'Personnel ID cannot be changed' : 'Must be unique, e.g. TCP-A-20001'} />
            <Input label="Full name" required value={form.fullName} onChange={upd('fullName')} error={errors.fullName} />
            <Select label="Rank" value={form.rank} onChange={upd('rank')} options={RANKS.map((r) => ({ value: r, label: r || 'None (civilian staff)' }))} />
            <Input label="Designation" value={form.designation} onChange={upd('designation')} />
            <Input label="Unit" value={form.unit} onChange={upd('unit')} />
            <Input label="Department" value={form.department} onChange={upd('department')} />
            <Select label="Assigned location" required value={form.locationId} onChange={upd('locationId')} error={errors.locationId} options={locations.map((l) => ({ value: l.id, label: l.name }))} />
            <Field label="Additional authorized locations" hint="The assigned location is always authorized.">
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
              </div>
            </Field>
            <Input label="Access valid from" type="date" value={form.accessValidFrom} onChange={upd('accessValidFrom')} />
            <Input label="Access valid until" type="date" value={form.accessValidUntil} onChange={upd('accessValidUntil')} error={errors.accessValidUntil} hint="Leave blank for no end date" />
            <Textarea label="Notes" containerClassName="sm:col-span-2" value={form.notes} onChange={upd('notes')} />
          </div>
          <div className="mt-6 flex justify-end gap-2 border-t border-line pt-4">
            <Button onClick={() => navigate(-1)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={save.isPending}>
              {editId ? 'Save changes' : 'Create record'}
            </Button>
          </div>
        </Card>
      </form>
    </>
  );
}
