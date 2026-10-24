import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLocationScope } from '../lib/location';
import type { Row } from '../lib/types';
import { useAction } from '../components/toast';
import { Button, Card, Input, Notice, PageHeader, Select, Textarea } from '../components/ui';
import { fieldErrors } from '../components/ops/common';

export default function DeliveryNewPage() {
  const navigate = useNavigate();
  const { me } = useAuth();
  const { locations, locationId } = useLocationScope();
  const categories = me?.options.deliveryCategories ?? [];
  const [form, setForm] = useState({
    locationId: String(locationId ?? locations[0]?.id ?? ''),
    category: categories[0]?.code ?? 'COURIER',
    company: '',
    courierName: '',
    courierPhone: '',
    vehicleRegistration: '',
    recipientUserId: '',
    recipientName: '',
    recipientDepartment: '',
    description: '',
    itemCount: '1',
    expectedAt: '',
    notes: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const recipients = useQuery({
    queryKey: ['lookup', 'recipients', form.locationId],
    queryFn: () => api.get<Row[]>('/lookups/recipients', { locationId: form.locationId }),
    enabled: !!form.locationId,
  });
  useEffect(() => {
    const r = recipients.data?.find((x) => String(x.id) === form.recipientUserId);
    if (r?.department && !form.recipientDepartment) setForm((f) => ({ ...f, recipientDepartment: r.department }));
  }, [form.recipientUserId, recipients.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useAction((body: Record<string, unknown>) => api.post<Row>('/deliveries', body), {
    success: 'Expected delivery registered',
    invalidate: [['deliveries']],
    onSuccess: (r) => navigate(`/deliveries/${r.id}`),
    onError: (e) => setErrors(fieldErrors(e)),
  });

  const upd = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    for (const k of ['company', 'courierName', 'recipientDepartment', 'description'] as const) if (!form[k].trim()) errs[k] = 'Required';
    const items = Number(form.itemCount);
    if (!Number.isInteger(items) || items < 0 || items > 10000) errs.itemCount = 'Whole number 0–10,000';
    if (form.courierPhone && !/^[+0-9 ()-]{6,20}$/.test(form.courierPhone)) errs.courierPhone = 'Digits, spaces, +, - and brackets only';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    save.mutate({
      locationId: Number(form.locationId),
      category: form.category,
      company: form.company.trim(),
      courierName: form.courierName.trim(),
      courierPhone: form.courierPhone || null,
      vehicleRegistration: form.vehicleRegistration || null,
      recipientUserId: form.recipientUserId ? Number(form.recipientUserId) : null,
      recipientName: form.recipientName || null,
      recipientDepartment: form.recipientDepartment.trim(),
      description: form.description.trim(),
      itemCount: items,
      expectedAt: form.expectedAt ? new Date(form.expectedAt).toISOString() : null,
      notes: form.notes || null,
    });
  };

  return (
    <>
      <PageHeader back={{ to: '/deliveries', label: 'Delivery register' }} title="Register expected delivery" subtitle="Pre-register a delivery so the gate can record its arrival quickly. Arrivals without pre-registration are recorded at the gate." />
      <form onSubmit={submit} noValidate>
        <Card className="max-w-3xl">
          <div className="grid gap-5 sm:grid-cols-2">
            <Select label="Location" required value={form.locationId} onChange={upd('locationId')} options={locations.map((l) => ({ value: l.id, label: l.name }))} />
            <Select label="Category" required value={form.category} onChange={upd('category')} options={categories.map((c) => ({ value: c.code, label: c.label }))} />
            <Input label="Delivery company / supplier" required value={form.company} onChange={upd('company')} error={errors.company} />
            <Input label="Courier name" required value={form.courierName} onChange={upd('courierName')} error={errors.courierName} />
            <Input label="Courier phone" type="tel" value={form.courierPhone} onChange={upd('courierPhone')} error={errors.courierPhone} />
            <Input label="Vehicle registration (optional)" value={form.vehicleRegistration} onChange={(e) => setForm((f) => ({ ...f, vehicleRegistration: e.target.value.toUpperCase() }))} hint="Linked to the vehicle register; created as pending if new" />
            <Select
              label="Recipient (user)"
              value={form.recipientUserId}
              onChange={upd('recipientUserId')}
              placeholder={recipients.isLoading ? 'Loading…' : 'Not a system user'}
              options={(recipients.data ?? []).map((r) => ({ value: r.id, label: `${r.name}${r.department ? ` · ${r.department}` : ''}` }))}
              hint="Selected recipients can acknowledge receipt in the app"
            />
            <Input label="Recipient name (if not a user)" value={form.recipientName} onChange={upd('recipientName')} />
            <Input label="Recipient department" required value={form.recipientDepartment} onChange={upd('recipientDepartment')} error={errors.recipientDepartment} />
            <Input label="Number of items" type="number" min={0} max={10000} required value={form.itemCount} onChange={upd('itemCount')} error={errors.itemCount} />
            <Textarea label="Description" required containerClassName="sm:col-span-2" rows={2} value={form.description} onChange={upd('description')} error={errors.description} />
            <Input label="Expected at" type="datetime-local" value={form.expectedAt} onChange={upd('expectedAt')} />
            <Textarea label="Notes" rows={2} value={form.notes} onChange={upd('notes')} />
          </div>
          <Notice tone="info" className="mt-5">
            Authorization to proceed is not proof of inspection or acceptance. Any package handling and inspection follow the establishment's approved procedures.
          </Notice>
          <div className="mt-6 flex justify-end gap-2 border-t border-line pt-4">
            <Button onClick={() => navigate(-1)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={save.isPending}>
              Register delivery
            </Button>
          </div>
        </Card>
      </form>
    </>
  );
}
