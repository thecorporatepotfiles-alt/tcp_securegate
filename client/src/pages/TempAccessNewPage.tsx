import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api } from '../lib/api';
import { useLocationScope } from '../lib/location';
import { addDaysStr, nowLocalTime, todayLocal, zonedIso } from '../lib/format';
import type { Row } from '../lib/types';
import { useAction } from '../components/toast';
import { Button, Card, CardHeader, Input, Notice, PageHeader, Select, Tabs, Textarea } from '../components/ui';
import { PersonStatusBadge } from '../components/status';
import { LookupSearch } from '../components/visitors/LookupSearch';
import { fieldErrors, splitLocal } from '../components/visitors/helpers';

type HolderType = 'PERSONNEL' | 'CONTRACTOR' | 'INDIVIDUAL';
interface PersonHit { id: number; serviceNumber: string; name: string; unit: string | null; status: string }
interface ContractorHit { id: number; reference: string; name: string; company: string; status: string }

export default function TempAccessNewPage() {
  const navigate = useNavigate();
  const { locations, locationId } = useLocationScope();
  const today = todayLocal();
  const [holderType, setHolderType] = useState<HolderType>('PERSONNEL');
  const [person, setPerson] = useState<PersonHit | null>(null);
  const [contractor, setContractor] = useState<ContractorHit | null>(null);
  const [form, setForm] = useState({
    locationId: String(locationId ?? locations[0]?.id ?? ''),
    holderName: '',
    holderOrganization: '',
    holderPhone: '',
    reason: '',
    sponsoringDepartment: '',
    validFrom: `${today}T${nowLocalTime()}`,
    validUntil: `${addDaysStr(today, 1)}T18:00`,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const upd = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = useAction((body: Record<string, unknown>) => api.post<Row>('/temporary-access', body), {
    success: (r) => `Temporary access ${r.reference} issued`,
    invalidate: [['temporary-access']],
    onSuccess: (r) => navigate(`/temporary-access/${r.id}`),
    silentError: true,
    onError: (e) => {
      setServerError(e instanceof ApiError ? e.message : 'Could not issue temporary access');
      setErrors(fieldErrors(e));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setServerError(null);
    const errs: Record<string, string> = {};
    if (holderType === 'PERSONNEL' && !person) errs.holder = 'Search and select the personnel record';
    if (holderType === 'CONTRACTOR' && !contractor) errs.holder = 'Search and select the contractor';
    if (holderType === 'INDIVIDUAL' && !form.holderName.trim()) errs.holderName = 'Holder name is required';
    if (form.holderPhone && !/^[+0-9 ()-]{6,20}$/.test(form.holderPhone)) errs.holderPhone = 'Digits, spaces, +, - and brackets only';
    if (!form.reason.trim()) errs.reason = 'Required';
    if (!form.validFrom) errs.validFrom = 'Required';
    if (!form.validUntil) errs.validUntil = 'Required';
    let fromIso = '';
    let untilIso = '';
    if (form.validFrom && form.validUntil) {
      fromIso = zonedIso(...splitLocal(form.validFrom));
      untilIso = zonedIso(...splitLocal(form.validUntil));
      if (untilIso <= fromIso) errs.validUntil = 'Must be after valid from';
      else if (Date.parse(untilIso) - Date.parse(fromIso) > 31 * 86_400_000) errs.validUntil = 'Temporary access may not exceed 31 days';
      else if (Date.parse(untilIso) <= Date.now()) errs.validUntil = 'Must be in the future';
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    save.mutate({
      locationId: Number(form.locationId),
      holderType,
      personnelId: holderType === 'PERSONNEL' ? person!.id : null,
      contractorId: holderType === 'CONTRACTOR' ? contractor!.id : null,
      holderName: holderType === 'INDIVIDUAL' ? form.holderName.trim() : null,
      holderOrganization: form.holderOrganization || null,
      holderPhone: form.holderPhone || null,
      reason: form.reason.trim(),
      sponsoringDepartment: form.sponsoringDepartment || null,
      validFrom: fromIso,
      validUntil: untilIso,
    });
  };

  return (
    <>
      <PageHeader
        back={{ to: '/temporary-access', label: 'Temporary access' }}
        title="Issue temporary access"
        subtitle="Generates a time-limited QR pass for one location. It is verified by the server at the gate and expires automatically."
      />
      <form onSubmit={submit} noValidate className="grid max-w-3xl gap-5">
        {serverError && <Notice tone="danger" title="Not issued">{serverError}</Notice>}
        <Card>
          <CardHeader title="Holder" subtitle="Link to an existing record where possible instead of creating a duplicate identity." />
          <Tabs
            value={holderType}
            onChange={(v) => {
              setHolderType(v);
              setErrors({});
            }}
            tabs={[
              { value: 'PERSONNEL', label: 'Personnel' },
              { value: 'CONTRACTOR', label: 'Contractor' },
              { value: 'INDIVIDUAL', label: 'Other individual' },
            ]}
          />
          {holderType === 'PERSONNEL' && (
            <LookupSearch<PersonHit>
              label="Personnel record"
              required
              path="/lookups/personnel"
              placeholder="Search by name or personnel ID"
              error={errors.holder}
              selected={person}
              onSelect={setPerson}
              onClear={() => setPerson(null)}
              renderItem={(p) => (
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-ink-3">
                      <span className="font-mono">{p.serviceNumber}</span> · {p.unit ?? '—'}
                    </div>
                  </div>
                  <PersonStatusBadge status={p.status} />
                </div>
              )}
              renderSelected={(p) => (
                <div>
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-ink-3">
                    <span className="font-mono">{p.serviceNumber}</span> · {p.unit ?? '—'} {p.status !== 'ACTIVE' && '· inactive records cannot receive temporary access'}
                  </div>
                </div>
              )}
            />
          )}
          {holderType === 'CONTRACTOR' && (
            <LookupSearch<ContractorHit>
              label="Contractor record"
              required
              path="/lookups/contractors"
              placeholder="Search by name or reference"
              error={errors.holder}
              selected={contractor}
              onSelect={setContractor}
              onClear={() => setContractor(null)}
              renderItem={(c) => (
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">{c.name}</div>
                    <div className="text-xs text-ink-3">
                      <span className="font-mono">{c.reference}</span> · {c.company}
                    </div>
                  </div>
                  <PersonStatusBadge status={c.status} />
                </div>
              )}
              renderSelected={(c) => (
                <div>
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-ink-3">
                    <span className="font-mono">{c.reference}</span> · {c.company}
                  </div>
                </div>
              )}
            />
          )}
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {holderType === 'INDIVIDUAL' && <Input label="Holder name" required value={form.holderName} onChange={upd('holderName')} error={errors.holderName} />}
            <Input label="Organization" value={form.holderOrganization} onChange={upd('holderOrganization')} hint={holderType === 'INDIVIDUAL' ? undefined : 'Defaults to the unit or company on record'} />
            <Input label="Phone" value={form.holderPhone} onChange={upd('holderPhone')} error={errors.holderPhone} hint="Only where required" />
          </div>
        </Card>
        <Card>
          <CardHeader title="Access window" subtitle={`Times are in the establishment time zone. Maximum 31 days.`} />
          <div className="grid gap-4 sm:grid-cols-2">
            {locations.length > 1 ? (
              <Select label="Location" required value={form.locationId} onChange={upd('locationId')} options={locations.map((l) => ({ value: String(l.id), label: l.name }))} />
            ) : (
              <Input label="Location" value={locations[0]?.name ?? ''} disabled />
            )}
            <Input label="Sponsoring department" value={form.sponsoringDepartment} onChange={upd('sponsoringDepartment')} />
            <Input label="Valid from" type="datetime-local" required value={form.validFrom} onChange={upd('validFrom')} error={errors.validFrom} />
            <Input label="Valid until" type="datetime-local" required value={form.validUntil} onChange={upd('validUntil')} error={errors.validUntil} />
            <Textarea label="Reason" required containerClassName="sm:col-span-2" value={form.reason} onChange={upd('reason')} error={errors.reason} placeholder="e.g. Permanent card left at home; temporary duty attachment" />
          </div>
        </Card>
        <div className="flex justify-end gap-2">
          <Button onClick={() => navigate(-1)}>Cancel</Button>
          <Button type="submit" variant="primary" size="lg" loading={save.isPending}>
            Issue temporary access
          </Button>
        </div>
      </form>
    </>
  );
}
