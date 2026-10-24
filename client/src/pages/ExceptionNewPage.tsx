import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useGoBack } from '../lib/browserRouting';
import { useLocationScope } from '../lib/location';
import type { Row } from '../lib/types';
import { EXCEPTION_CATEGORIES, EXCEPTION_CATEGORY_LABEL, ROLES, ROLE_INFO } from '../../../shared/constants';
import { useAction } from '../components/toast';
import { Button, Card, Input, Notice, PageHeader, Select, Textarea } from '../components/ui';
import { fieldErrors } from '../components/ops/common';

export default function ExceptionNewPage() {
  const navigate = useNavigate();
  const goBack = useGoBack('/exceptions');
  const [sp] = useSearchParams();
  const { locations, locationId } = useLocationScope();
  const [form, setForm] = useState({
    locationId: sp.get('locationId') ?? String(locationId ?? locations[0]?.id ?? ''),
    category: sp.get('category') ?? 'RECORD_DISCREPANCY',
    title: sp.get('title') ?? '',
    description: '',
    relatedReference: sp.get('relatedReference') ?? '',
    relatedType: sp.get('relatedType') ?? '',
    relatedId: sp.get('relatedId') ?? '',
    responsibleRole: 'LOCATION_ADMIN',
    responsibleUserId: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const users = useQuery({
    queryKey: ['lookup', 'users', form.locationId],
    queryFn: () => api.get<Row[]>('/lookups/users', { locationId: form.locationId }),
    enabled: !!form.locationId,
  });
  const save = useAction((body: Record<string, unknown>) => api.post<Row>('/exceptions', body), {
    success: 'Exception recorded',
    invalidate: [['exceptions']],
    onSuccess: (r) => navigate(`/exceptions/${r.id}`),
    onError: (e) => setErrors(fieldErrors(e)),
  });
  const upd = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.title.trim()) errs.title = 'Required';
    if (!form.description.trim()) errs.description = 'Required';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    save.mutate({
      locationId: Number(form.locationId),
      category: form.category,
      title: form.title.trim(),
      description: form.description.trim(),
      relatedType: form.relatedType || null,
      relatedId: form.relatedId ? Number(form.relatedId) : null,
      relatedReference: form.relatedReference || null,
      responsibleRole: form.responsibleRole || null,
      responsibleUserId: form.responsibleUserId ? Number(form.responsibleUserId) : null,
    });
  };
  return (
    <>
      <PageHeader back={{ to: '/exceptions', label: 'Administrative exceptions' }} title="Record administrative exception" subtitle="For record discrepancies, missing exits and other administrative follow-up." />
      <form onSubmit={submit} noValidate>
        <Card className="max-w-3xl">
          <Notice tone="warning" className="mb-5">
            Record administrative facts only. Do not record sensitive operational instructions or security procedures here.
          </Notice>
          <div className="grid gap-5 sm:grid-cols-2">
            <Select label="Location" required value={form.locationId} onChange={upd('locationId')} options={locations.map((l) => ({ value: l.id, label: l.name }))} />
            <Select label="Category" required value={form.category} onChange={upd('category')} options={EXCEPTION_CATEGORIES.map((c) => ({ value: c, label: EXCEPTION_CATEGORY_LABEL[c] }))} />
            <Input label="Title" required containerClassName="sm:col-span-2" value={form.title} onChange={upd('title')} error={errors.title} maxLength={160} />
            <Textarea label="Description" required containerClassName="sm:col-span-2" rows={4} value={form.description} onChange={upd('description')} error={errors.description} />
            <Input label="Related record reference" value={form.relatedReference} onChange={upd('relatedReference')} hint="e.g. EV-2026-0001234, VR-2026-00042" />
            <Select label="Responsible role" value={form.responsibleRole} onChange={upd('responsibleRole')} placeholder="No role" options={ROLES.map((r) => ({ value: r, label: ROLE_INFO[r].name }))} />
            <Select
              label="Responsible user (optional)"
              value={form.responsibleUserId}
              onChange={upd('responsibleUserId')}
              placeholder={users.isLoading ? 'Loading…' : 'Not assigned to a person'}
              options={(users.data ?? []).map((u) => ({ value: u.id, label: `${u.name} · ${ROLE_INFO[u.role as keyof typeof ROLE_INFO]?.name ?? u.role}` }))}
              hint="The user is notified in-app"
            />
          </div>
          <div className="mt-6 flex justify-end gap-2 border-t border-line pt-4">
            <Button onClick={goBack}>Cancel</Button>
            <Button type="submit" variant="primary" loading={save.isPending}>
              Record exception
            </Button>
          </div>
        </Card>
      </form>
    </>
  );
}
