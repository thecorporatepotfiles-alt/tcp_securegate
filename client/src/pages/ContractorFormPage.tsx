import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { useGoBack } from '../lib/browserRouting';
import { useLocationScope } from '../lib/location';
import { addDaysStr, todayLocal } from '../lib/format';
import type { Row } from '../lib/types';
import { CONTRACTOR_CATEGORIES, CONTRACTOR_CATEGORY_LABEL } from '../../../shared/constants';
import { useAction } from '../components/toast';
import { Button, ButtonLink, Card, CardHeader, ErrorState, Field, Input, Notice, PageHeader, Select, Spinner, Textarea, cx } from '../components/ui';
import { WEEKDAYS, fieldErrors } from '../components/visitors/helpers';

interface FormState {
  companyId: string;
  fullName: string;
  category: string;
  phone: string;
  sponsoringDepartment: string;
  sponsorUserId: string;
  purpose: string;
  locationId: string;
  validFrom: string;
  validUntil: string;
  windowStart: string;
  windowEnd: string;
  allowedDays: string;
  notes: string;
  status: string;
  statusReason: string;
}

function toBody(f: FormState): Record<string, unknown> {
  return {
    companyId: Number(f.companyId),
    fullName: f.fullName.trim(),
    category: f.category || undefined,
    phone: f.phone || null,
    sponsoringDepartment: f.sponsoringDepartment.trim(),
    sponsorUserId: f.sponsorUserId ? Number(f.sponsorUserId) : null,
    purpose: f.purpose.trim(),
    locationId: Number(f.locationId),
    validFrom: f.validFrom,
    validUntil: f.validUntil,
    windowStart: f.windowStart,
    windowEnd: f.windowEnd,
    allowedDays: f.allowedDays,
    notes: f.notes || null,
  };
}

export default function ContractorFormPage() {
  const params = useParams();
  const editId = params.id ? Number(params.id) : null;
  const navigate = useNavigate();
  const goBack = useGoBack('/contractors');
  const { locations, locationId } = useLocationScope();
  const today = todayLocal();
  const existing = useQuery({ queryKey: ['contractors', 'detail', editId], queryFn: () => api.get<Row>(`/contractors/${editId}`), enabled: !!editId });
  const companies = useQuery({ queryKey: ['contractor-companies', 'all'], queryFn: () => api.get<Row[]>('/contractor-companies') });
  const blank: FormState = {
    companyId: '',
    fullName: '',
    category: '',
    phone: '',
    sponsoringDepartment: '',
    sponsorUserId: '',
    purpose: '',
    locationId: String(locationId ?? locations[0]?.id ?? ''),
    validFrom: today,
    validUntil: addDaysStr(today, 90),
    windowStart: '08:00',
    windowEnd: '18:00',
    allowedDays: '1111100',
    notes: '',
    status: 'ACTIVE',
    statusReason: '',
  };
  const [form, setForm] = useState<FormState>(blank);
  const [initial, setInitial] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const sponsors = useQuery({
    queryKey: ['lookups', 'hosts', form.locationId],
    queryFn: () => api.get<Row[]>('/lookups/hosts', { locationId: form.locationId }),
    enabled: !!form.locationId,
  });

  useEffect(() => {
    const c = existing.data;
    if (!c) return;
    const f: FormState = {
      companyId: String(c.companyId),
      fullName: c.fullName,
      category: c.category,
      phone: c.phone ?? '',
      sponsoringDepartment: c.sponsoringDepartment,
      sponsorUserId: c.sponsorUserId ? String(c.sponsorUserId) : '',
      purpose: c.purpose,
      locationId: String(c.locationId),
      validFrom: c.validFrom,
      validUntil: c.validUntil,
      windowStart: c.windowStart,
      windowEnd: c.windowEnd,
      allowedDays: c.allowedDays,
      notes: c.notes ?? '',
      status: c.status,
      statusReason: '',
    };
    setForm(f);
    setInitial(f);
  }, [existing.data]);

  const save = useAction((body: Record<string, unknown>) => (editId ? api.patch<Row>(`/contractors/${editId}`, body) : api.post<Row>('/contractors', body)), {
    success: editId ? 'Contractor record updated' : 'Contractor record created',
    invalidate: [['contractors'], ['contractor-companies']],
    onSuccess: (r) => navigate(`/contractors/people/${r.id}`),
    silentError: true,
    onError: (e) => {
      setServerError(e instanceof ApiError ? e.message : 'Could not save');
      setErrors(fieldErrors(e));
    },
  });

  if (editId && existing.isLoading) return <Spinner />;
  if (editId && existing.isError) return <ErrorState error={existing.error} />;
  if (!editId && companies.data && companies.data.filter((c) => c.status === 'ACTIVE').length === 0) {
    return (
      <>
        <PageHeader back={{ to: '/contractors', label: 'Contractors' }} title="Add contractor" />
        <Notice tone="info" title="Add an organization first">
          People are always registered under an active contractor, vendor or service organization.{' '}
          <ButtonLink to="/contractors?tab=organizations" size="sm" className="ml-2">
            Go to organizations
          </ButtonLink>
        </Notice>
      </>
    );
  }

  const upd = (k: keyof FormState) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggleDay = (i: number) => setForm((f) => ({ ...f, allowedDays: f.allowedDays.split('').map((c, j) => (j === i ? (c === '1' ? '0' : '1') : c)).join('') }));
  const statusChanged = !!initial && form.status !== initial.status;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setServerError(null);
    const errs: Record<string, string> = {};
    if (!form.companyId) errs.companyId = 'Select the organization';
    if (!form.fullName.trim()) errs.fullName = 'Required';
    if (!form.sponsoringDepartment.trim()) errs.sponsoringDepartment = 'Required';
    if (!form.purpose.trim()) errs.purpose = 'Required';
    if (!form.locationId) errs.locationId = 'Required';
    if (!form.validFrom) errs.validFrom = 'Required';
    if (!form.validUntil) errs.validUntil = 'Required';
    else if (form.validUntil < form.validFrom) errs.validUntil = 'Must be on or after valid from';
    if (form.windowEnd <= form.windowStart) errs.windowEnd = 'End must be after start';
    if (!form.allowedDays.includes('1')) errs.allowedDays = 'Select at least one day';
    if (form.phone && !/^[+0-9 ()-]{6,20}$/.test(form.phone)) errs.phone = 'Digits, spaces, +, - and brackets only';
    if (statusChanged && form.statusReason.trim().length < 3) errs.statusReason = 'A reason is required to change status';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    if (!editId || !initial) return save.mutate(toBody(form));
    // Edit: send only the fields that changed.
    const now = toBody(form);
    const before = toBody(initial);
    const body: Record<string, unknown> = {};
    for (const k of Object.keys(now)) if (JSON.stringify(now[k]) !== JSON.stringify(before[k])) body[k] = now[k];
    if (statusChanged) {
      body.status = form.status;
      body.statusReason = form.statusReason.trim();
    }
    if (Object.keys(body).length === 0) return navigate(`/contractors/people/${editId}`);
    save.mutate(body);
  };

  const activeCompanies = (companies.data ?? []).filter((c) => c.status === 'ACTIVE' || String(c.id) === form.companyId);

  return (
    <>
      <PageHeader
        back={{ to: editId ? `/contractors/people/${editId}` : '/contractors', label: editId ? 'Back to record' : 'Contractors' }}
        title={editId ? 'Edit contractor record' : 'Add contractor, vendor or service person'}
        subtitle="Access is valid only within the validity period, at the authorized location, on permitted days and hours. Use fictional data in this demonstration."
      />
      <form onSubmit={submit} noValidate className="grid max-w-4xl gap-5">
        {serverError && <Notice tone="danger" title="Not saved">{serverError}</Notice>}
        <Card>
          <CardHeader title="Person and organization" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label="Organization"
              required
              value={form.companyId}
              onChange={upd('companyId')}
              error={errors.companyId}
              placeholder="Select organization"
              options={activeCompanies.map((c) => ({ value: String(c.id), label: `${c.name} (${CONTRACTOR_CATEGORY_LABEL[c.category as keyof typeof CONTRACTOR_CATEGORY_LABEL]})` }))}
            />
            <Select
              label="Category"
              value={form.category}
              onChange={upd('category')}
              placeholder="Same as organization"
              options={CONTRACTOR_CATEGORIES.map((c) => ({ value: c, label: CONTRACTOR_CATEGORY_LABEL[c] }))}
            />
            <Input label="Full name" required value={form.fullName} onChange={upd('fullName')} error={errors.fullName} />
            <Input label="Phone" value={form.phone} onChange={upd('phone')} error={errors.phone} hint="Only where required" />
          </div>
        </Card>
        <Card>
          <CardHeader title="Assignment and sponsor" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Assignment / service purpose" required containerClassName="sm:col-span-2" value={form.purpose} onChange={upd('purpose')} error={errors.purpose} />
            <Input label="Sponsoring department" required value={form.sponsoringDepartment} onChange={upd('sponsoringDepartment')} error={errors.sponsoringDepartment} />
            <Select
              label="Sponsoring officer (optional)"
              value={form.sponsorUserId}
              onChange={upd('sponsorUserId')}
              placeholder="None"
              options={(sponsors.data ?? []).map((s) => ({ value: String(s.id), label: `${s.name}${s.department ? ` · ${s.department}` : ''}` }))}
            />
            <Select label="Authorized location" required value={form.locationId} onChange={upd('locationId')} error={errors.locationId} options={locations.map((l) => ({ value: String(l.id), label: l.name }))} />
          </div>
        </Card>
        <Card>
          <CardHeader title="Validity and permitted hours" subtitle="Recurring visits are permitted only on the selected days and hours, within the validity period." />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Valid from" type="date" required value={form.validFrom} onChange={upd('validFrom')} error={errors.validFrom} />
            <Input label="Valid until" type="date" required value={form.validUntil} min={form.validFrom} onChange={upd('validUntil')} error={errors.validUntil} />
            <Input label="Permitted from" type="time" value={form.windowStart} onChange={upd('windowStart')} />
            <Input label="Permitted until" type="time" value={form.windowEnd} onChange={upd('windowEnd')} error={errors.windowEnd} hint="00:00–23:59 means any time" />
            <Field label="Permitted days" error={errors.allowedDays} className="sm:col-span-2">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Permitted days">
                {WEEKDAYS.map((d, i) => {
                  const on = form.allowedDays[i] === '1';
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleDay(i)}
                      className={cx(
                        'h-10 min-w-[52px] rounded-lg border px-3 text-sm font-medium transition-colors',
                        on ? 'border-forest-700 bg-forest-800 text-white' : 'border-line-strong bg-white text-ink-2 hover:bg-canvas',
                      )}
                    >
                      {d}
                    </button>
                  );
                })}
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setForm((f) => ({ ...f, allowedDays: '1111100' }))}>
                    Weekdays
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setForm((f) => ({ ...f, allowedDays: '1111111', windowStart: '00:00', windowEnd: '23:59' }))}>
                    Any time
                  </Button>
                </div>
              </div>
            </Field>
            <Textarea label="Notes" containerClassName="sm:col-span-2" value={form.notes} onChange={upd('notes')} />
          </div>
        </Card>
        {editId && (
          <Card>
            <CardHeader title="Access status" subtitle="Inactive or cancelled records are rejected at the gate. Cancelled records cannot be reactivated." />
            <div className="grid gap-4 sm:grid-cols-2">
              <Select
                label="Status"
                value={form.status}
                onChange={upd('status')}
                disabled={initial?.status === 'CANCELLED'}
                options={[
                  { value: 'ACTIVE', label: 'Active' },
                  { value: 'INACTIVE', label: 'Inactive (suspended)' },
                  { value: 'CANCELLED', label: 'Cancelled (permanent)' },
                ]}
              />
              {statusChanged && <Input label="Reason for status change" required value={form.statusReason} onChange={upd('statusReason')} error={errors.statusReason} />}
            </div>
          </Card>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={goBack}>Cancel</Button>
          <Button type="submit" variant="primary" size="lg" loading={save.isPending}>
            {editId ? 'Save changes' : 'Create record'}
          </Button>
        </div>
      </form>
    </>
  );
}
