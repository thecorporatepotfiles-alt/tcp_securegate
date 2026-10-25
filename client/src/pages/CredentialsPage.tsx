import { useQuery } from '@tanstack/react-query';
import { CreditCard } from 'lucide-react';
import { api, type Page } from '../lib/api';
import { serverCopy } from '../lib/edition';
import { useLocationScope } from '../lib/location';
import { useListParams } from '../lib/useListParams';
import { fmtDateTime } from '../lib/format';
import type { Row } from '../lib/types';
import { CREDENTIAL_STATUSES, CREDENTIAL_STATUS_INFO, CREDENTIAL_TYPES, CREDENTIAL_TYPE_LABEL, type CredentialType } from '../../../shared/constants';
import { Card, DataTable, EmptyState, ErrorState, FilterBar, Notice, PageHeader, Pagination, SearchInput, Select } from '../components/ui';
import { CredentialStatusBadge, SimulatedTag } from '../components/status';
import { InlineLink, holderLink } from '../components/ops/common';

const DEFAULTS = { q: '', status: '', type: '', holderType: '', temporary: '', sort: '', dir: 'desc', locationId: '' };

export default function CredentialsPage() {
  const { locationId } = useLocationScope();
  const { values, set, page, setPage } = useListParams(DEFAULTS);
  const pageSize = 25;
  const q = useQuery({
    queryKey: ['credentials', 'list', values, page, locationId],
    queryFn: () => api.get<Page<Row>>('/credentials', { ...values, page, pageSize, locationId: values.locationId || locationId }),
  });

  return (
    <>
      <PageHeader
        title="Credentials"
        subtitle="RFID/NFC credential register. Assign new credentials from a personnel or contractor record."
        actions={<SimulatedTag>Mock reader — no hardware</SimulatedTag>}
      />
      <Notice tone="info" className="mb-4" title="Integration boundary">
        A credential carries only an opaque card/tag number. {serverCopy('Personal details stay in the protected database.', 'Personal details stay in the SecureGate database, not on the credential.')} Compatible, separately approved readers can later submit the
        same number to the existing verification service; hardware compatibility is not claimed until tested.
      </Notice>
      <FilterBar>
        <SearchInput value={values.q} onChange={(v) => set({ q: v })} placeholder="Search number, holder or reference" />
        <Select aria-label="Status" className="w-auto" value={values.status} onChange={(e) => set({ status: e.target.value })} placeholder="All statuses" options={CREDENTIAL_STATUSES.map((s) => ({ value: s, label: CREDENTIAL_STATUS_INFO[s].label }))} />
        <Select aria-label="Type" className="w-auto" value={values.type} onChange={(e) => set({ type: e.target.value })} placeholder="All types" options={CREDENTIAL_TYPES.map((t) => ({ value: t, label: CREDENTIAL_TYPE_LABEL[t] }))} />
        <Select
          aria-label="Holder type"
          className="w-auto"
          value={values.holderType}
          onChange={(e) => set({ holderType: e.target.value })}
          options={[
            { value: '', label: 'All holders' },
            { value: 'PERSONNEL', label: 'Personnel' },
            { value: 'CONTRACTOR', label: 'Contractors' },
          ]}
        />
        <Select
          aria-label="Permanence"
          className="w-auto"
          value={values.temporary}
          onChange={(e) => set({ temporary: e.target.value })}
          options={[
            { value: '', label: 'Permanent & temporary' },
            { value: 'false', label: 'Permanent only' },
            { value: 'true', label: 'Temporary only' },
          ]}
        />
      </FilterBar>
      <Card padded={false}>
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <>
            <DataTable
              loading={q.isFetching && !q.data}
              rows={q.data?.items ?? []}
              rowKey={(r) => r.id}
              rowHref={(r) => `/credentials/${r.id}`}
              sort={{ key: values.sort, dir: values.dir as 'asc' | 'desc' }}
              onSort={(sort, dir) => set({ sort, dir })}
              empty={<EmptyState icon={<CreditCard className="size-5" />} title="No credentials match" description="Clear the filters, or assign a credential from a personnel or contractor record." />}
              columns={[
                { key: 'number', header: 'Credential', sortKey: 'number', render: (r) => <span className="font-mono text-[13px] font-semibold whitespace-nowrap">{r.credentialNumber}</span> },
                {
                  key: 'holder',
                  header: 'Holder',
                  sortKey: 'holder',
                  render: (r) => {
                    const to = holderLink(r.holderType, r.personnelId, r.contractorId);
                    return (
                      <div className="min-w-0">
                        {to ? <InlineLink to={to}>{r.holderName ?? '—'}</InlineLink> : (r.holderName ?? '—')}
                        <div className="font-mono text-xs whitespace-nowrap text-ink-3">{r.holderReference}</div>
                      </div>
                    );
                  },
                },
                { key: 'holderType', header: 'Holder type', hideBelow: 'md', render: (r) => (r.holderType === 'PERSONNEL' ? 'Personnel' : 'Contractor') },
                {
                  key: 'type',
                  header: 'Type',
                  hideBelow: 'lg',
                  render: (r) => (
                    <span>
                      {CREDENTIAL_TYPE_LABEL[r.credentialType as CredentialType] ?? r.credentialType}
                      {r.isTemporary && r.credentialType !== 'TEMPORARY_CARD' ? <span className="ml-1 text-xs font-medium text-gold-600">· temporary</span> : null}
                    </span>
                  ),
                },
                { key: 'status', header: 'Status', sortKey: 'status', render: (r) => <CredentialStatusBadge status={r.status} /> },
                { key: 'validUntil', header: 'Valid until', hideBelow: 'lg', render: (r) => (r.validUntil ? <span className="whitespace-nowrap">{fmtDateTime(r.validUntil)}</span> : <span className="text-ink-3">No expiry</span>) },
                { key: 'issuedAt', header: 'Issued', sortKey: 'issuedAt', hideBelow: 'md', render: (r) => <span className="whitespace-nowrap">{fmtDateTime(r.issuedAt)}</span> },
              ]}
            />
            {q.data && <Pagination page={page} pageSize={pageSize} total={q.data.total} onPage={setPage} />}
          </>
        )}
      </Card>
    </>
  );
}
