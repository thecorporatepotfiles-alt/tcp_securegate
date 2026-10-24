import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { useMe } from '../lib/auth';
import { useLocationScope } from '../lib/location';
import { addDaysStr, fmtDate, nowLocalTime, todayLocal } from '../lib/format';
import type { Row } from '../lib/types';
import { useAction } from '../components/toast';
import { Button, Card, CardHeader, Checkbox, Input, Notice, PageHeader, Select, Tabs, Textarea } from '../components/ui';
import { LookupSearch } from '../components/visitors/LookupSearch';
import { fieldErrors } from '../components/visitors/helpers';

interface VisitorHit {
  id: number;
  fullName: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  lastVisit: string | null;
  visitCount: number;
}

function roundTime(offsetMin: number): string {
  const [h, m] = nowLocalTime(offsetMin).split(':').map(Number);
  const total = Math.min(23 * 60 + 45, Math.ceil((h * 60 + m) / 15) * 15);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export default function VisitorNewPage() {
  const me = useMe();
  const navigate = useNavigate();
  const { locations, locationId } = useLocationScope();
  const today = todayLocal();
  const defaultLoc = locationId ?? me.user.primaryLocationId ?? locations[0]?.id;
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [existing, setExisting] = useState<VisitorHit | null>(null);
  const [form, setForm] = useState({
    locationId: String(defaultLoc ?? ''),
    fullName: '',
    company: '',
    phone: '',
    email: '',
    hostUserId: String(me.user.id),
    hostDepartment: me.user.department ?? '',
    approvingOfficerId: '',
    purpose: '',
    destination: '',
    visitDate: today,
    arrivalTime: roundTime(60),
    departureTime: roundTime(180),
    hasVehicle: false,
    vehicleRegistration: '',
    vehicleCategory: 'CAR',
    vehicleMake: '',
    notes: '',
    requiresSecurityCheck: me.options.requireSecurityCheck,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);

  const locId = Number(form.locationId) || undefined;
  const approvers = useQuery({ queryKey: ['lookups', 'approvers', locId], queryFn: () => api.get<Row[]>('/lookups/approvers', { locationId: locId }), enabled: !!locId });
  const hosts = useQuery({ queryKey: ['lookups', 'hosts', locId], queryFn: () => api.get<Row[]>('/lookups/hosts', { locationId: locId }), enabled: !!locId });
  const approverOptions = useMemo(() => (approvers.data ?? []).filter((a) => a.id !== me.user.id), [approvers.data, me.user.id]);

  useEffect(() => {
    if (form.approvingOfficerId && !approverOptions.some((a) => String(a.id) === form.approvingOfficerId)) setForm((f) => ({ ...f, approvingOfficerId: '' }));
    if (!form.approvingOfficerId && approverOptions.length === 1) setForm((f) => ({ ...f, approvingOfficerId: String(approverOptions[0].id) }));
  }, [approverOptions, form.approvingOfficerId]);

  const save = useAction((body: Record<string, unknown>) => api.post<Row>('/visits', body), {
    success: (r) => `Visitor request ${r.reference} submitted for authorization`,
    invalidate: [['visits']],
    onSuccess: (r) => navigate(`/visitors/${r.id}`),
    silentError: true,
    onError: (e) => {
      setServerError(e instanceof ApiError ? e.message : 'Could not submit the request');
      const fe = fieldErrors(e);
      if (Object.keys(fe).length) setErrors((prev) => ({ ...prev, ...fe }));
    },
  });

  const upd = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setServerError(null);
    const errs: Record<string, string> = {};
    if (!form.locationId) errs.locationId = 'Select a location';
    if (mode === 'existing' && !existing) errs.visitor = 'Search and select a returning visitor, or switch to "New visitor"';
    if (mode === 'new' && !form.fullName.trim()) errs.fullName = 'Visitor name is required';
    if (form.phone && !/^[+0-9 ()-]{6,20}$/.test(form.phone)) errs.phone = 'Digits, spaces, +, - and brackets only';
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errs.email = 'Invalid email address';
    if (!form.approvingOfficerId) errs.approvingOfficerId = 'Select the approving officer';
    if (!form.purpose.trim()) errs.purpose = 'Required';
    if (!form.destination.trim()) errs.destination = 'Required';
    if (!form.visitDate || form.visitDate < today) errs.visitDate = 'Visit date cannot be in the past';
    if (form.visitDate > addDaysStr(today, 90)) errs.visitDate = 'Up to 90 days ahead';
    if (form.departureTime <= form.arrivalTime) errs.departureTime = 'Must be after expected arrival';
    if (form.visitDate === today && form.departureTime <= nowLocalTime()) errs.departureTime = 'Expected departure has already passed';
    if (form.hasVehicle && form.vehicleRegistration.trim().length < 4) errs.vehicleRegistration = 'Enter the full registration number';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    save.mutate({
      locationId: Number(form.locationId),
      ...(mode === 'existing' && existing
        ? { visitorId: existing.id }
        : { visitor: { fullName: form.fullName.trim(), company: form.company || null, phone: form.phone || null, email: form.email || null } }),
      hostUserId: Number(form.hostUserId),
      hostDepartment: form.hostDepartment || null,
      approvingOfficerId: Number(form.approvingOfficerId),
      purpose: form.purpose.trim(),
      destination: form.destination.trim(),
      visitDate: form.visitDate,
      arrivalTime: form.arrivalTime,
      departureTime: form.departureTime,
      vehicle: form.hasVehicle ? { registration: form.vehicleRegistration.trim(), category: form.vehicleCategory, makeModel: form.vehicleMake || undefined } : null,
      notes: form.notes || null,
      requiresSecurityCheck: form.requiresSecurityCheck,
    });
  };

  const hostOptions = [
    { value: String(me.user.id), label: `${me.user.displayName} (you)` },
    ...(hosts.data ?? []).filter((h) => h.id !== me.user.id).map((h) => ({ value: String(h.id), label: `${h.name}${h.department ? ` · ${h.department}` : ''}` })),
  ];

  return (
    <>
      <PageHeader
        back={{ to: '/visitors', label: 'Visitors' }}
        title="New visitor request"
        subtitle="The request goes to the approving officer. A digital pass is generated only after authorization (and the security verification step, where required)."
      />
      <form onSubmit={submit} noValidate className="grid max-w-4xl gap-5">
        {serverError && <Notice tone="danger" title="Request not submitted">{serverError}</Notice>}
        <Card>
          <CardHeader title="Visitor" subtitle="Reuse a returning visitor's record instead of creating a duplicate." />
          <Tabs
            value={mode}
            onChange={(v) => {
              setMode(v);
              setErrors({});
            }}
            tabs={[
              { value: 'new', label: 'New visitor' },
              { value: 'existing', label: 'Returning visitor' },
            ]}
          />
          {mode === 'existing' ? (
            <LookupSearch<VisitorHit>
              label="Find visitor"
              required
              path="/lookups/visitors"
              placeholder="Search by name, phone or organization"
              error={errors.visitor}
              selected={existing}
              onSelect={setExisting}
              onClear={() => setExisting(null)}
              renderItem={(v) => (
                <div>
                  <div className="font-medium">{v.fullName}</div>
                  <div className="text-xs text-ink-3">
                    {[v.company, v.phone].filter(Boolean).join(' · ') || 'No contact details'} · {v.visitCount} previous visit{v.visitCount === 1 ? '' : 's'}
                    {v.lastVisit ? `, last ${fmtDate(v.lastVisit)}` : ''}
                  </div>
                </div>
              )}
              renderSelected={(v) => (
                <div>
                  <div className="font-medium">{v.fullName}</div>
                  <div className="text-xs text-ink-3">{[v.company, v.phone, v.email].filter(Boolean).join(' · ') || 'No contact details on record'}</div>
                </div>
              )}
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Full name" required value={form.fullName} onChange={upd('fullName')} error={errors.fullName ?? errors['visitor.fullName']} />
              <Input label="Organization" value={form.company} onChange={upd('company')} placeholder="Leave blank for individuals" />
              <Input label="Phone" type="tel" value={form.phone} onChange={upd('phone')} error={errors.phone ?? errors['visitor.phone']} hint="Only where required" />
              <Input label="Email" type="email" value={form.email} onChange={upd('email')} error={errors.email ?? errors['visitor.email']} />
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Visit details" />
          <div className="grid gap-4 sm:grid-cols-2">
            {locations.length > 1 ? (
              <Select label="Location" required value={form.locationId} onChange={upd('locationId')} error={errors.locationId} options={locations.map((l) => ({ value: l.id, label: l.name }))} />
            ) : (
              <Input label="Location" value={locations[0]?.name ?? ''} disabled />
            )}
            <Input label="Destination / department" required value={form.destination} onChange={upd('destination')} error={errors.destination} placeholder="e.g. Admin Block, Conference Room 2" />
            <Input label="Purpose of visit" required containerClassName="sm:col-span-2" value={form.purpose} onChange={upd('purpose')} error={errors.purpose} />
            <Input label="Visit date" type="date" required min={today} max={addDaysStr(today, 90)} value={form.visitDate} onChange={upd('visitDate')} error={errors.visitDate} />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Expected arrival" type="time" required value={form.arrivalTime} onChange={upd('arrivalTime')} error={errors.arrivalTime} />
              <Input label="Expected departure" type="time" required value={form.departureTime} onChange={upd('departureTime')} error={errors.departureTime} />
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Host and authorization" subtitle="You cannot approve a request you create; choose another approving officer." />
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label="Host" required value={form.hostUserId} onChange={upd('hostUserId')} options={hostOptions} />
            <Input label="Host department" value={form.hostDepartment} onChange={upd('hostDepartment')} />
            <Select
              label="Approving officer"
              required
              value={form.approvingOfficerId}
              onChange={upd('approvingOfficerId')}
              error={errors.approvingOfficerId}
              placeholder={approvers.isLoading ? 'Loading…' : approverOptions.length ? 'Select approving officer' : 'No eligible officer at this location'}
              options={approverOptions.map((a) => ({ value: String(a.id), label: `${a.name}${a.designation ? ` · ${a.designation}` : ''}` }))}
            />
            <div className="flex items-end pb-2">
              <Checkbox
                label="Security verification step required"
                hint="Pass is generated only after an authorized user records this step."
                checked={form.requiresSecurityCheck}
                onChange={(v) => setForm((f) => ({ ...f, requiresSecurityCheck: v }))}
              />
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Vehicle and notes" />
          <div className="grid gap-4">
            <Checkbox label="Visitor will arrive by vehicle" checked={form.hasVehicle} onChange={(v) => setForm((f) => ({ ...f, hasVehicle: v }))} />
            {form.hasVehicle && (
              <div className="grid gap-4 sm:grid-cols-3">
                <Input label="Registration number" required value={form.vehicleRegistration} onChange={(e) => setForm((f) => ({ ...f, vehicleRegistration: e.target.value.toUpperCase() }))} error={errors.vehicleRegistration} />
                <Select label="Category" value={form.vehicleCategory} onChange={upd('vehicleCategory')} options={me.options.vehicleCategories.map((c) => ({ value: c.code, label: c.label }))} />
                <Input label="Make / model" value={form.vehicleMake} onChange={upd('vehicleMake')} />
                <p className="text-xs text-ink-3 sm:col-span-3">The vehicle is linked to this visit. Vehicle movement is recorded separately from the visitor's own entry and exit.</p>
              </div>
            )}
            <Textarea label="Notes" value={form.notes} onChange={upd('notes')} hint="Do not record sensitive operational information." />
          </div>
        </Card>

        <div className="flex justify-end gap-2">
          <Button onClick={() => navigate(-1)}>Cancel</Button>
          <Button type="submit" variant="primary" size="lg" loading={save.isPending}>
            Submit for authorization
          </Button>
        </div>
      </form>
    </>
  );
}
