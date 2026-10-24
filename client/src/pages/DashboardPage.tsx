import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertOctagon,
  CarFront,
  ClipboardCheck,
  FileWarning,
  HardHat,
  Hourglass,
  KeyRound,
  ListChecks,
  Package,
  RefreshCw,
  ShieldAlert,
  ShieldX,
  Truck,
  UserCheck,
  UserMinus,
  Users,
  UsersRound,
  Wrench,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLocationScope } from '../lib/location';
import { useListParams } from '../lib/useListParams';
import { fmtDate, fmtDateTime, fmtRelative, fmtTime, nowLocalTime, titleCase, todayLocal } from '../lib/format';
import type { Row } from '../lib/types';
import {
  DELIVERY_STATUS_INFO,
  REGISTER_CATEGORIES,
  REGISTER_CATEGORY_LABEL,
  RESULT_INFO,
  VISIT_STATUS_INFO,
  type DeliveryStatus,
  type Permission,
  type ResultCode,
  type Tone,
  type VisitStatus,
} from '../../../shared/constants';
import { Button, Card, CardHeader, EmptyState, ErrorState, PageHeader, Select, Spinner, StatTile } from '../components/ui';
import { CategoryPill, EventTypeBadge } from '../components/status';
import { ChartCard, SERIES, STATUS_COLOR } from '../components/charts/chartKit';
import { ActivityLines, GroupedColumns, HorizontalBars } from '../components/charts/Charts';
import { DateRangeFilter, presetRange } from '../components/oversight/DateRangeFilter';

interface Metric {
  key: string;
  label: string;
  value: number;
  link: string;
  tone: Tone;
  hint?: string;
}

interface DashboardData {
  filters: { from: string; to: string };
  generatedAt: string;
  metrics: Metric[];
  totals: { entries: number; exits: number };
  charts: {
    activity: { bucket: string; label: string; entries: number; exits: number }[];
    hourly: boolean;
    locationActivity: { locationId: number; name: string; code: string; entries: number; exits: number }[];
    gateActivity: { gateId: number; name: string; locationName: string; entries: number; exits: number; failures: number }[];
    visitStatus: { status: VisitStatus; count: number }[];
    deliveryActivity: { status: DeliveryStatus; count: number }[];
    verificationOutcomes: { result: ResultCode; count: number }[];
  };
  recentEvents: Row[];
}

const MOVEMENT_KEYS = ['totalPersonnel', 'personnelInside', 'personnelOutside', 'visitorsInside', 'contractorsInside', 'vendorsInside', 'serviceInside', 'temporaryInside', 'deliveryPersonnelInside', 'vehiclesInside'];
const ATTENTION_KEYS = ['visitorsAwaitingAuthorization', 'visitorsAwaitingHostAck', 'deliveriesAwaitingCompletion', 'overdueVisits', 'failedVerifications', 'unresolvedExceptions', 'openAlerts', 'pendingManualReviews'];

const ICONS: Record<string, typeof Users> = {
  totalPersonnel: Users,
  personnelInside: UsersRound,
  personnelOutside: UserMinus,
  visitorsInside: UserCheck,
  contractorsInside: HardHat,
  vendorsInside: Truck,
  serviceInside: Wrench,
  temporaryInside: KeyRound,
  deliveryPersonnelInside: Package,
  vehiclesInside: CarFront,
  visitorsAwaitingAuthorization: ClipboardCheck,
  visitorsAwaitingHostAck: Hourglass,
  deliveriesAwaitingCompletion: Package,
  overdueVisits: AlertOctagon,
  failedVerifications: ShieldX,
  unresolvedExceptions: FileWarning,
  openAlerts: ShieldAlert,
  pendingManualReviews: ListChecks,
};

/** Permission needed to open the page a metric links to (tile stays visible but unlinked otherwise). */
const LINK_PERMS: [string, Permission[]][] = [
  ['/personnel', ['personnel.view']],
  ['/presence', ['presence.view']],
  ['/visitors', ['visitors.view', 'visitors.view_all']],
  ['/deliveries', ['deliveries.view', 'deliveries.manage', 'deliveries.acknowledge']],
  ['/reports', ['reports.view']],
  ['/exceptions', ['exceptions.view']],
  ['/alerts', ['alerts.view']],
  ['/manual-reviews', ['gate.manual_review']],
];

const STATUS_FILL: Record<Tone, string> = {
  success: STATUS_COLOR.good,
  warning: STATUS_COLOR.warning,
  danger: STATUS_COLOR.critical,
  info: STATUS_COLOR.neutral,
  neutral: STATUS_COLOR.neutral,
};

export default function DashboardPage() {
  const { can } = useAuth();
  const { locationId, setLocationId, locations, allowAll, location, gates, locationName } = useLocationScope();
  const today = presetRange('today');
  const defaults = useMemo(() => ({ from: today.from, to: today.to, gateId: '', category: '' }), [today.from, today.to]);
  const { values, set } = useListParams(defaults);
  const gateValid = !values.gateId || gates.some((g) => String(g.id) === values.gateId);
  const params = { from: values.from, to: values.to, gateId: gateValid ? values.gateId : '', category: values.category, locationId };
  const q = useQuery({
    queryKey: ['dashboard', params],
    queryFn: () => api.get<DashboardData>('/dashboard', params),
    refetchInterval: 30_000,
  });

  const linkFor = (link: string) => {
    const rule = LINK_PERMS.find(([prefix]) => link.startsWith(prefix));
    return !rule || can(...rule[1]) ? link : undefined;
  };

  const d = q.data;
  const dim = q.isPlaceholderData;
  const nowKey = `${todayLocal()} ${nowLocalTime().slice(0, 2)}:00`;
  const dayLabel = (date: string) => fmtDate(date).replace(/ \d{4}$/, '');
  const activity = (d?.charts.activity ?? []).map((b) => {
    const label = d?.charts.hourly ? b.label : dayLabel(b.bucket);
    return (d?.charts.hourly ? b.bucket > nowKey : b.bucket > todayLocal()) ? { ...b, label, entries: null, exits: null } : { ...b, label };
  });
  const scopeLabel = location ? location.name : allowAll ? 'All authorized locations' : (locations[0]?.name ?? '');
  const rangeLabel = values.from === values.to ? fmtDate(values.from) : `${fmtDate(values.from)} – ${fmtDate(values.to)}`;

  const renderTiles = (keys: string[]) =>
    keys
      .map((k) => d?.metrics.find((m) => m.key === k))
      .filter((m): m is Metric => !!m)
      .map((m) => {
        const Icon = ICONS[m.key] ?? Users;
        const hint = m.key === 'failedVerifications' ? rangeLabel : m.hint;
        return <StatTile key={m.key} label={m.label} value={m.value.toLocaleString('en-IN')} hint={hint} to={linkFor(m.link)} tone={m.tone} icon={<Icon className="size-4" aria-hidden />} />;
      });

  return (
    <>
      <PageHeader
        eyebrow="Operations overview"
        title="Dashboard"
        subtitle={`${scopeLabel} · ${rangeLabel}. Every figure is calculated from recorded data; select a tile to open the matching records.`}
        actions={
          <div className="flex items-center gap-3 text-[13px] text-ink-3">
            {d && (
              <span title={fmtDateTime(d.generatedAt)}>
                Last updated <span className="font-medium text-ink-2 tabular-nums">{fmtTime(d.generatedAt)}</span>
              </span>
            )}
            <Button size="sm" icon={<RefreshCw className={q.isFetching ? 'size-4 animate-spin' : 'size-4'} />} onClick={() => q.refetch()} aria-label="Refresh dashboard">
              Refresh
            </Button>
          </div>
        }
      />

      <div className="no-print mb-6 flex flex-wrap items-center gap-2">
        <DateRangeFilter from={values.from} to={values.to} onChange={(from, to) => set({ from, to })} />
        {locations.length > 1 && (
          <Select
            aria-label="Location"
            className="w-auto max-w-[220px]"
            value={locationId ?? ''}
            onChange={(e) => {
              setLocationId(e.target.value ? Number(e.target.value) : null);
              set({ gateId: '' });
            }}
          >
            {allowAll && <option value="">All locations</option>}
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        )}
        <Select aria-label="Gate" className="w-auto max-w-[240px]" value={gateValid ? values.gateId : ''} onChange={(e) => set({ gateId: e.target.value })}>
          <option value="">All gates</option>
          {gates.map((g) => (
            <option key={g.id} value={g.id}>
              {location ? g.name : `${g.name} (${locationName(g.locationId)})`}
            </option>
          ))}
        </Select>
        <Select aria-label="Record category" className="w-auto" value={values.category} onChange={(e) => set({ category: e.target.value })}>
          <option value="">All record categories</option>
          {REGISTER_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {REGISTER_CATEGORY_LABEL[c]}
            </option>
          ))}
        </Select>
      </div>

      {q.isError && !d ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !d ? (
        <Spinner label="Calculating dashboard…" />
      ) : (
        <div className={dim ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          <section aria-labelledby="dash-movement" className="mb-6">
            <h2 id="dash-movement" className="mb-2.5 text-xs font-semibold tracking-wide text-ink-3 uppercase">
              Recorded movement status · now
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{renderTiles(MOVEMENT_KEYS)}</div>
          </section>
          <section aria-labelledby="dash-attention" className="mb-6">
            <h2 id="dash-attention" className="mb-2.5 text-xs font-semibold tracking-wide text-ink-3 uppercase">
              Requires attention
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{renderTiles(ATTENTION_KEYS)}</div>
          </section>

          <div className="grid gap-5 lg:grid-cols-3">
            <ChartCard
              className="lg:col-span-2"
              title="Entry and exit activity"
              subtitle={`${d.totals.entries.toLocaleString('en-IN')} entries · ${d.totals.exits.toLocaleString('en-IN')} exits · ${d.charts.hourly ? 'by hour' : 'by day'}${values.category ? ` · ${REGISTER_CATEGORY_LABEL[values.category as keyof typeof REGISTER_CATEGORY_LABEL]}` : ''}`}
              legend={[
                { label: 'Entries', color: SERIES.s1, kind: 'line' },
                { label: 'Exits', color: SERIES.s2, kind: 'line' },
              ]}
              empty={d.totals.entries + d.totals.exits === 0}
              table={{
                columns: [
                  { key: 'bucket', label: d.charts.hourly ? 'Hour' : 'Date' },
                  { key: 'entries', label: 'Entries', numeric: true },
                  { key: 'exits', label: 'Exits', numeric: true },
                ],
                rows: d.charts.activity,
              }}
            >
              <ActivityLines
                data={activity}
                xKey="label"
                series={[
                  { key: 'entries', label: 'Entries', color: SERIES.s1 },
                  { key: 'exits', label: 'Exits', color: SERIES.s2 },
                ]}
              />
            </ChartCard>

            <ChartCard
              title="Verification outcomes"
              subtitle={`Gate verifications · ${rangeLabel}`}
              legend={[
                { label: 'Verified', color: STATUS_COLOR.good },
                { label: 'Needs review', color: STATUS_COLOR.warning },
                { label: 'Denied', color: STATUS_COLOR.critical },
              ]}
              empty={d.charts.verificationOutcomes.length === 0}
              table={{
                columns: [
                  { key: 'label', label: 'Result' },
                  { key: 'count', label: 'Attempts', numeric: true },
                ],
                rows: d.charts.verificationOutcomes.map((r) => ({ label: RESULT_INFO[r.result]?.label ?? titleCase(r.result), count: r.count })),
              }}
            >
              <HorizontalBars
                data={d.charts.verificationOutcomes.map((r) => ({ label: RESULT_INFO[r.result]?.label ?? titleCase(r.result), count: r.count, tone: RESULT_INFO[r.result]?.tone ?? 'neutral' }))}
                yKey="label"
                labelWidth={150}
                series={[{ key: 'count', label: 'Attempts', color: STATUS_COLOR.critical }]}
                colorOf={(row) => STATUS_FILL[row.tone as Tone]}
              />
            </ChartCard>

            {d.charts.locationActivity.length > 1 && (
              <ChartCard
                title="Location-wise activity"
                subtitle="Valid entries and exits per location"
                legend={[
                  { label: 'Entries', color: SERIES.s1 },
                  { label: 'Exits', color: SERIES.s2 },
                ]}
                empty={d.charts.locationActivity.every((l) => l.entries + l.exits === 0)}
                table={{
                  columns: [
                    { key: 'name', label: 'Location' },
                    { key: 'entries', label: 'Entries', numeric: true },
                    { key: 'exits', label: 'Exits', numeric: true },
                  ],
                  rows: d.charts.locationActivity,
                }}
              >
                <GroupedColumns
                  data={d.charts.locationActivity.map((l) => ({ ...l, short: l.name.replace(/^Location /, '').replace(' (Demo)', '').replace('Headquarters', 'HQ') }))}
                  xKey="short"
                  series={[
                    { key: 'entries', label: 'Entries', color: SERIES.s1 },
                    { key: 'exits', label: 'Exits', color: SERIES.s2 },
                  ]}
                />
              </ChartCard>
            )}

            <ChartCard
              className={d.charts.locationActivity.length > 1 ? 'lg:col-span-2' : 'lg:col-span-3'}
              title="Gate-wise activity"
              subtitle="Busiest gates; failed verifications shown on hover and in the table"
              legend={[
                { label: 'Entries', color: SERIES.s1 },
                { label: 'Exits', color: SERIES.s2 },
              ]}
              empty={d.charts.gateActivity.every((g) => g.entries + g.exits === 0)}
              table={{
                columns: [
                  { key: 'name', label: 'Gate' },
                  { key: 'locationName', label: 'Location' },
                  { key: 'entries', label: 'Entries', numeric: true },
                  { key: 'exits', label: 'Exits', numeric: true },
                  { key: 'failures', label: 'Failed verifications', numeric: true },
                ],
                rows: d.charts.gateActivity,
              }}
            >
              <HorizontalBars
                data={d.charts.gateActivity.slice(0, 8)}
                yKey="name"
                labelWidth={140}
                valueLabels={false}
                series={[
                  { key: 'entries', label: 'Entries', color: SERIES.s1 },
                  { key: 'exits', label: 'Exits', color: SERIES.s2 },
                ]}
                tooltipExtra={(row) => `${row.locationName as string} · ${Number(row.failures).toLocaleString('en-IN')} failed verifications`}
              />
            </ChartCard>

            <ChartCard
              title="Visitor status"
              subtitle={`Visits scheduled ${rangeLabel}`}
              empty={d.charts.visitStatus.length === 0}
              table={{
                columns: [
                  { key: 'label', label: 'Status' },
                  { key: 'count', label: 'Visits', numeric: true },
                ],
                rows: d.charts.visitStatus.map((s) => ({ label: VISIT_STATUS_INFO[s.status]?.label ?? s.status, count: s.count })),
              }}
            >
              <HorizontalBars
                data={d.charts.visitStatus.map((s) => ({ label: VISIT_STATUS_INFO[s.status]?.label ?? s.status, count: s.count }))}
                yKey="label"
                labelWidth={110}
                series={[{ key: 'count', label: 'Visits', color: SERIES.s1 }]}
              />
            </ChartCard>

            <ChartCard
              title="Delivery activity"
              subtitle={`Deliveries arriving or expected · ${rangeLabel}`}
              empty={d.charts.deliveryActivity.length === 0}
              table={{
                columns: [
                  { key: 'label', label: 'Status' },
                  { key: 'count', label: 'Deliveries', numeric: true },
                ],
                rows: d.charts.deliveryActivity.map((s) => ({ label: DELIVERY_STATUS_INFO[s.status]?.label ?? s.status, count: s.count })),
              }}
            >
              <HorizontalBars
                data={d.charts.deliveryActivity.map((s) => ({ label: DELIVERY_STATUS_INFO[s.status]?.label ?? s.status, count: s.count }))}
                yKey="label"
                labelWidth={140}
                series={[{ key: 'count', label: 'Deliveries', color: SERIES.s2 }]}
              />
            </ChartCard>

            <Card padded={false} className="flex flex-col">
              <div className="p-5 pb-2">
                <CardHeader
                  className="mb-0"
                  title="Recent entries and exits"
                  subtitle="Latest recorded movements"
                  actions={
                    can('events.view') ? (
                      <Link to="/register" className="text-[13px] font-medium text-forest-700 hover:text-forest-900">
                        Open register
                      </Link>
                    ) : undefined
                  }
                />
              </div>
              {d.recentEvents.length === 0 ? (
                <EmptyState title="No movement recorded yet" description="Entries and exits recorded at the gates will appear here." />
              ) : (
                <ul className="divide-y divide-line/70">
                  {d.recentEvents.slice(0, 8).map((e) => (
                    <li key={e.id} className="flex items-start gap-3 px-5 py-2.5">
                      <div className="w-14 shrink-0 pt-0.5">
                        <EventTypeBadge type={e.eventType} voided={e.voided} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <Link to={e.link} className="block truncate text-[13px] font-medium text-ink hover:text-forest-700">
                          {e.subjectName ?? '—'}
                        </Link>
                        <div className="truncate text-xs text-ink-3" title={`${e.gateName} · ${e.locationName}`}>
                          {e.gateName}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <CategoryPill category={e.temporaryAccessId ? 'TEMPORARY' : e.category} />
                        <div className="mt-0.5 text-[11px] text-ink-3" title={fmtDateTime(e.recordedAt)}>
                          {fmtRelative(e.recordedAt)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
