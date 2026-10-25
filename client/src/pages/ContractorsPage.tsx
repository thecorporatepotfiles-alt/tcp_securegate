import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Building2, HardHat, Pencil, Plus } from 'lucide-react';
import { ApiError, api, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLocationScope } from '../lib/location';
import { useListParams } from '../lib/useListParams';
import { fmtDate, todayLocal } from '../lib/format';
import type { Row } from '../lib/types';
import { CONTRACTOR_CATEGORIES, CONTRACTOR_CATEGORY_LABEL, type ContractorCategory } from '../../../shared/constants';
import { useAction } from '../components/toast';
import { Avatar, Badge, Button, ButtonLink, Card, DataTable, EmptyState, ErrorState, FilterBar, Input, Modal, Notice, PageHeader, Pagination, Pill, SearchInput, Select, Tabs, Textarea } from '../components/ui';
import { PersonStatusBadge, PresenceBadge } from '../components/status';
import { hoursLabel, fieldErrors } from '../components/visitors/helpers';

const DEFAULTS = { tab: 'people', q: '', category: '', companyId: '', status: '', validity: '', presence: '', sort: 'name', dir: 'asc', locationId: '' };
const CATEGORY_OPTIONS = CONTRACTOR_CATEGORIES.map((c) => ({ value: c, label: CONTRACTOR_CATEGORY_LABEL[c] }));

function CompanyModal({ company, open, onClose }: { company: Row | null; open: boolean; onClose: () => void }) {
  const [form, setForm] = useState({ name: '', category: 'CONTRACTOR', contactName: '', contactPhone: '', contactEmail: '', status: 'ACTIVE', notes: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setForm(
      company
        ? {
            name: company.name,
            category: company.category,
            contactName: company.contactName ?? '',
            contactPhone: company.contactPhone ?? '',
            contactEmail: company.contactEmail ?? '',
            status: company.status,
            notes: company.notes ?? '',
          }
        : { name: '', category: 'CONTRACTOR', contactName: '', contactPhone: '', contactEmail: '', status: 'ACTIVE', notes: '' },
    );
  }, [open, company]);
  const save = useAction(
    (body: Record<string, unknown>) => (company ? api.patch(`/contractor-companies/${company.id}`, body) : api.post('/contractor-companies', body)),
    {
      success: company ? 'Organization updated' : 'Organization added',
      invalidate: [['contractor-companies'], ['contractors']],
      onSuccess: onClose,
      onError: (e) => {
        const fe = fieldErrors(e);
        if (e instanceof ApiError && e.code === 'DUPLICATE_COMPANY') fe.name = e.message;
        setErrors(fe);
      },
    },
  );
  const upd = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = () => {
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = 'Required';
    if (form.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.contactEmail)) errs.contactEmail = 'Invalid email address';
    if (form.contactPhone && !/^[+0-9 ()-]{6,20}$/.test(form.contactPhone)) errs.contactPhone = 'Digits, spaces, +, - and brackets only';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      category: form.category,
      contactName: form.contactName || null,
      contactPhone: form.contactPhone || null,
      contactEmail: form.contactEmail || null,
      status: form.status,
      notes: form.notes || null,
    };
    if (company) {
      // Send only what changed.
      const original: Record<string, unknown> = { name: company.name, category: company.category, contactName: company.contactName, contactPhone: company.contactPhone, contactEmail: company.contactEmail, status: company.status, notes: company.notes };
      for (const k of Object.keys(body)) if ((body[k] ?? null) === (original[k] ?? null)) delete body[k];
      if (Object.keys(body).length === 0) return onClose();
    }
    save.mutate(body);
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={company ? 'Edit organization' : 'Add organization'}
      description="Contractor, vendor or service organization. Keep to access and visit management."
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {company ? 'Save changes' : 'Add organization'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Organization name" required value={form.name} onChange={upd('name')} error={errors.name} containerClassName="sm:col-span-2" />
        <Select label="Category" value={form.category} onChange={upd('category')} options={CATEGORY_OPTIONS} />
        <Select
          label="Status"
          value={form.status}
          onChange={upd('status')}
          options={[
            { value: 'ACTIVE', label: 'Active' },
            { value: 'INACTIVE', label: 'Inactive — all its people are rejected at the gate' },
          ]}
        />
        <Input label="Contact name" value={form.contactName} onChange={upd('contactName')} />
        <Input label="Contact phone" value={form.contactPhone} onChange={upd('contactPhone')} error={errors.contactPhone} />
        <Input label="Contact email" type="email" value={form.contactEmail} onChange={upd('contactEmail')} error={errors.contactEmail} containerClassName="sm:col-span-2" />
        <Textarea label="Notes" value={form.notes} onChange={upd('notes')} containerClassName="sm:col-span-2" />
      </div>
      {company && form.status === 'INACTIVE' && company.status === 'ACTIVE' && (
        <Notice tone="warning" className="mt-4">
          Deactivating the organization causes verification of all its contractors to be rejected.
        </Notice>
      )}
    </Modal>
  );
}

export default function ContractorsPage() {
  const { can } = useAuth();
  const canManage = can('contractors.manage');
  const { locationId, allowAll } = useLocationScope();
  const { values, set, page, setPage } = useListParams(DEFAULTS);
  const pageSize = 25;
  const today = todayLocal();
  const tab = values.tab === 'organizations' ? 'organizations' : 'people';
  const [companyModal, setCompanyModal] = useState<{ open: boolean; company: Row | null }>({ open: false, company: null });

  const companies = useQuery({ queryKey: ['contractor-companies', 'all'], queryFn: () => api.get<Row[]>('/contractor-companies') });
  const people = useQuery({
    queryKey: ['contractors', 'list', values, page, locationId],
    queryFn: () =>
      api.get<Page<Row>>('/contractors', {
        q: values.q,
        category: values.category,
        companyId: values.companyId,
        status: values.status,
        validity: values.validity,
        presence: values.presence,
        sort: values.sort,
        dir: values.dir,
        page,
        pageSize,
        locationId: values.locationId || locationId,
      }),
    enabled: tab === 'people',
  });

  return (
    <>
      <PageHeader
        title="Contractors, vendors & service personnel"
        subtitle="Recurring access for approved organizations — validity periods, permitted hours and visit history. Expired, cancelled or inactive access is rejected at the gate."
        actions={
          canManage && (
            <>
              <Button icon={<Building2 className="size-4" />} onClick={() => setCompanyModal({ open: true, company: null })}>
                Add organization
              </Button>
              <ButtonLink to="/contractors/new" variant="primary" icon={<Plus className="size-4" />}>
                Add person
              </ButtonLink>
            </>
          )
        }
      />
      <Tabs
        value={tab}
        onChange={(t) => set({ tab: t })}
        tabs={[
          { value: 'people', label: 'People', count: people.data?.total },
          { value: 'organizations', label: 'Organizations', count: companies.data?.length },
        ]}
      />

      {tab === 'people' ? (
        <>
          <FilterBar>
            <SearchInput value={values.q} onChange={(v) => set({ q: v })} placeholder="Search name, reference, organization, purpose" />
            <Select aria-label="Category" className="w-auto" value={values.category} onChange={(e) => set({ category: e.target.value })} placeholder="All categories" options={CATEGORY_OPTIONS} />
            <Select
              aria-label="Organization"
              className="w-auto max-w-[240px]"
              value={values.companyId}
              onChange={(e) => set({ companyId: e.target.value })}
              placeholder="All organizations"
              options={(companies.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
            />
            <Select
              aria-label="Validity"
              className="w-auto"
              value={values.validity}
              onChange={(e) => set({ validity: e.target.value })}
              options={[
                { value: '', label: 'Any validity' },
                { value: 'CURRENT', label: 'Currently valid' },
                { value: 'EXPIRED', label: 'Expired' },
                { value: 'UPCOMING', label: 'Not yet valid' },
              ]}
            />
            <Select
              aria-label="Status"
              className="w-auto"
              value={values.status}
              onChange={(e) => set({ status: e.target.value })}
              options={[
                { value: '', label: 'All statuses' },
                { value: 'ACTIVE', label: 'Active' },
                { value: 'INACTIVE', label: 'Inactive' },
                { value: 'CANCELLED', label: 'Cancelled' },
              ]}
            />
            <Select
              aria-label="Presence"
              className="w-auto"
              value={values.presence}
              onChange={(e) => set({ presence: e.target.value })}
              options={[
                { value: '', label: 'Inside or outside' },
                { value: 'INSIDE', label: 'Recorded inside' },
                { value: 'OUTSIDE', label: 'Not inside' },
              ]}
            />
          </FilterBar>
          <Card padded={false}>
            {people.isError ? (
              <ErrorState error={people.error} onRetry={() => people.refetch()} />
            ) : (
              <>
                <DataTable
                  loading={people.isFetching && !people.data}
                  rows={people.data?.items ?? []}
                  rowKey={(r) => r.id}
                  rowHref={(r) => `/contractors/people/${r.id}`}
                  sort={{ key: values.sort, dir: values.dir as 'asc' | 'desc' }}
                  onSort={(sort, dir) => set({ sort, dir })}
                  empty={
                    <EmptyState
                      icon={<HardHat className="size-5" />}
                      title="No contractors match these filters"
                      description={canManage ? 'Clear the filters, or add a person under an approved organization.' : 'Clear the search or filters.'}
                      action={canManage ? <ButtonLink to="/contractors/new">Add person</ButtonLink> : undefined}
                    />
                  }
                  columns={[
                    {
                      key: 'name',
                      header: 'Name',
                      sortKey: 'name',
                      render: (r) => (
                        <div className="flex items-center gap-3">
                          <Avatar name={r.fullName} size={34} />
                          <div className="min-w-0">
                            <div className="font-medium">{r.fullName}</div>
                            <div className="font-mono text-xs whitespace-nowrap text-ink-3">{r.reference}</div>
                          </div>
                        </div>
                      ),
                    },
                    {
                      key: 'company',
                      header: 'Organization',
                      sortKey: 'company',
                      render: (r) => (
                        <div className="max-w-[220px]">
                          <div className="truncate">{r.companyName}</div>
                          <Pill className="mt-0.5">{CONTRACTOR_CATEGORY_LABEL[r.category as ContractorCategory]}</Pill>
                        </div>
                      ),
                    },
                    {
                      key: 'purpose',
                      header: 'Assignment',
                      hideBelow: 'lg',
                      render: (r) => (
                        <div className="max-w-[240px]">
                          <div className="truncate">{r.purpose}</div>
                          <div className="truncate text-xs text-ink-3">Sponsor: {r.sponsoringDepartment}</div>
                        </div>
                      ),
                    },
                    ...(allowAll && !locationId ? [{ key: 'location', header: 'Location', hideBelow: 'lg' as const, render: (r: Row) => r.locationName }] : []),
                    {
                      key: 'validity',
                      header: 'Validity',
                      sortKey: 'validUntil',
                      hideBelow: 'md',
                      render: (r) => (
                        <div className="whitespace-nowrap">
                          <div className={r.validUntil < today ? 'text-bad' : ''}>until {fmtDate(r.validUntil)}</div>
                          <div className="text-xs text-ink-3">{hoursLabel(r.windowStart, r.windowEnd, r.allowedDays)}</div>
                        </div>
                      ),
                    },
                    { key: 'presence', header: 'Recorded status', render: (r) => <PresenceBadge state={r.presenceState} /> },
                    {
                      key: 'status',
                      header: 'Access',
                      hideBelow: 'sm',
                      render: (r) =>
                        r.status === 'ACTIVE' && r.validUntil < today ? <Badge tone="danger">Expired</Badge> : r.status === 'ACTIVE' && r.companyStatus !== 'ACTIVE' ? <Badge tone="danger">Organization inactive</Badge> : <PersonStatusBadge status={r.status} />,
                    },
                  ]}
                />
                {people.data && <Pagination page={page} pageSize={pageSize} total={people.data.total} onPage={setPage} />}
              </>
            )}
          </Card>
        </>
      ) : (
        <Card padded={false}>
          {companies.isError ? (
            <ErrorState error={companies.error} onRetry={() => companies.refetch()} />
          ) : (
            <DataTable
              loading={companies.isLoading}
              rows={companies.data ?? []}
              rowKey={(r) => r.id}
              onRowClick={(r) => set({ tab: 'people', companyId: String(r.id) })}
              empty={
                <EmptyState
                  icon={<Building2 className="size-5" />}
                  title="No organizations yet"
                  description="Add an approved contractor, vendor or service organization before adding its people."
                  action={canManage ? <Button onClick={() => setCompanyModal({ open: true, company: null })}>Add organization</Button> : undefined}
                />
              }
              columns={[
                { key: 'name', header: 'Organization', render: (r) => <div><div className="font-medium">{r.name}</div><div className="text-xs text-ink-3">{[r.contactName, r.contactPhone].filter(Boolean).join(' · ') || 'No contact recorded'}</div></div> },
                { key: 'category', header: 'Category', hideBelow: 'sm', render: (r) => <Pill>{CONTRACTOR_CATEGORY_LABEL[r.category as ContractorCategory]}</Pill> },
                { key: 'people', header: 'People (your locations)', align: 'right', hideBelow: 'sm', render: (r) => r.peopleInScope },
                { key: 'inside', header: 'Inside now', align: 'right', hideBelow: 'sm', render: (r) => r.insideNow },
                { key: 'status', header: 'Status', render: (r) => <PersonStatusBadge status={r.status} /> },
                ...(canManage
                  ? [
                      {
                        key: 'edit',
                        header: '',
                        align: 'right' as const,
                        render: (r: Row) => (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<Pencil className="size-3.5" />}
                            onClick={(e) => {
                              e.stopPropagation();
                              setCompanyModal({ open: true, company: r });
                            }}
                          >
                            Edit
                          </Button>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          )}
        </Card>
      )}
      <CompanyModal open={companyModal.open} company={companyModal.company} onClose={() => setCompanyModal({ open: false, company: null })} />
    </>
  );
}
