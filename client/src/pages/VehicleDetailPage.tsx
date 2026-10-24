import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CarFront, Pencil } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, titleCase } from '../lib/format';
import type { Row } from '../lib/types';
import { ButtonLink, Card, CardHeader, ErrorState, KeyValue, Notice, PageHeader, Pill, Spinner } from '../components/ui';
import { DeliveryStatusBadge, PresenceBadge, VehicleAuthBadge, VisitStatusBadge } from '../components/status';
import { MovementTable } from '../components/MovementTable';

export default function VehicleDetailPage() {
  const id = Number(useParams().id);
  const { me } = useAuth();
  const q = useQuery({ queryKey: ['vehicles', 'detail', id], queryFn: () => api.get<Row>(`/vehicles/${id}`) });
  if (q.isLoading) return <Spinner />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const v = q.data;
  const catLabel = me?.options.vehicleCategories.find((c) => c.code === v.category)?.label ?? titleCase(v.category);
  const ownerLink = v.personnelId ? `/personnel/${v.personnelId}` : v.contractorId ? `/contractors/people/${v.contractorId}` : null;

  return (
    <>
      <PageHeader
        back={{ to: '/vehicles', label: 'Vehicle register' }}
        eyebrow="Vehicle"
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-full bg-forest-100 text-forest-700">
              <CarFront className="size-5" aria-hidden />
            </span>
            <span className="font-mono tracking-wide">{v.registration}</span>
            <VehicleAuthBadge status={v.authorizationStatus} />
          </span>
        }
        subtitle={[catLabel, v.makeModel, v.colour].filter(Boolean).join(' · ')}
        actions={v.canManage && <ButtonLink to={`/vehicles/${id}/edit`} icon={<Pencil className="size-4" />}>Edit</ButtonLink>}
      />
      <Notice tone="info" className="mb-5">
        Vehicle entry and exit are recorded for the vehicle only and never mark occupants inside. Registration numbers are entered or looked up manually — no automatic
        number-plate recognition is used.
      </Notice>
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Vehicle details" />
          <KeyValue
            items={[
              { label: 'Registration', value: <span className="font-mono">{v.registration}</span> },
              { label: 'Category', value: catLabel },
              { label: 'Make / model', value: v.makeModel },
              { label: 'Colour', value: v.colour },
              { label: 'Owner type', value: titleCase(v.ownerType) },
              { label: 'Owner / association', value: ownerLink ? <Link to={ownerLink} className="text-forest-700 hover:underline">{v.ownerDisplay}</Link> : v.ownerDisplay },
              { label: 'Registered at', value: v.locationName },
              { label: 'Also authorized at', value: v.authorizedLocations.length ? <span className="flex flex-wrap gap-1">{(v.authorizedLocations as Row[]).map((l) => <Pill key={l.id}>{l.name}</Pill>)}</span> : 'Registered location only' },
              { label: 'Authorization', value: <VehicleAuthBadge status={v.authorizationStatus} /> },
              { label: 'Authorized until', value: v.authorizedUntil ? fmtDate(v.authorizedUntil) : 'No end date' },
              { label: 'Notes', value: v.notes },
              { label: 'Last updated', value: fmtDateTime(v.updatedAt) },
            ]}
          />
        </Card>
        <Card>
          <CardHeader title="Recorded status" subtitle="Derived from the latest valid vehicle event" />
          <PresenceBadge state={v.presenceState} />
          {v.presenceState && (
            <p className="mt-2 text-sm text-ink-2">
              {v.presenceState === 'INSIDE' ? 'Inside' : 'Exited'} {v.presenceLocation ? `at ${v.presenceLocation}` : ''} since {fmtDateTime(v.presenceSince)}
            </p>
          )}
        </Card>
      </div>
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Linked visits" subtitle="Visits that registered this vehicle" />
          {(v.linkedVisits as Row[]).length === 0 ? (
            <p className="text-sm text-ink-3">No linked visits.</p>
          ) : (
            <ul className="divide-y divide-line">
              {(v.linkedVisits as Row[]).map((x) => (
                <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <Link to={`/visitors/${x.id}`} className="text-sm font-medium hover:text-forest-700">
                    {x.visitorName} <span className="font-mono text-xs text-ink-3">{x.reference}</span>
                  </Link>
                  <span className="flex items-center gap-2 text-xs text-ink-3">
                    {fmtDate(x.visitDate)} <VisitStatusBadge status={x.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Linked deliveries" />
          {(v.linkedDeliveries as Row[]).length === 0 ? (
            <p className="text-sm text-ink-3">No linked deliveries.</p>
          ) : (
            <ul className="divide-y divide-line">
              {(v.linkedDeliveries as Row[]).map((x) => (
                <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <Link to={`/deliveries/${x.id}`} className="text-sm font-medium hover:text-forest-700">
                    {x.company} <span className="font-mono text-xs text-ink-3">{x.reference}</span>
                  </Link>
                  <span className="flex items-center gap-2 text-xs text-ink-3">
                    {fmtDateTime(x.arrivedAt)} <DeliveryStatusBadge status={x.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card className="mt-5" padded={false}>
        <div className="p-5 pb-0">
          <CardHeader title="Vehicle movement history" subtitle="Entries and exits recorded at vehicle gates" />
        </div>
        <MovementTable events={v.events} />
      </Card>
    </>
  );
}
