import { Link } from 'react-router-dom';
import { ArrowRight, ClipboardList, FileBarChart2, Package, ShieldCheck, UserCheck, Users } from 'lucide-react';
import { Card, ErrorState, PageHeader, Spinner } from '../components/ui';
import { useReportDefinitions } from '../components/oversight/ReportView';
import { useAuth } from '../lib/auth';
import { BROWSER_EDITION } from '../lib/edition';

const GROUP_ORDER = ['Movement', 'Visitors', 'Access', 'Deliveries', 'Gate operations', 'Administration'];
const GROUP_ICON: Record<string, typeof Users> = {
  Movement: ClipboardList,
  Visitors: UserCheck,
  Access: ShieldCheck,
  Deliveries: Package,
  'Gate operations': FileBarChart2,
  Administration: Users,
};

export default function ReportsPage() {
  const { can } = useAuth();
  const q = useReportDefinitions();
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const defs = q.data ?? [];
  const groups = GROUP_ORDER.map((g) => ({ group: g, items: defs.filter((d) => d.group === g) })).filter((g) => g.items.length);
  // The browser edition cannot print; CSV export goes through the viewer's file saving.
  const outputs = BROWSER_EDITION
    ? can('reports.export')
      ? 'Every report exports to CSV.'
      : ''
    : can('reports.export')
      ? 'Every report exports to CSV and prints to PDF.'
      : 'Print any report to PDF from your browser.';
  return (
    <>
      <PageHeader
        title="Reports"
        subtitle={['Filterable, sortable reports calculated from the same records as the dashboard.', outputs, 'Results respect your role and location permissions.'].filter(Boolean).join(' ')}
      />
      <div className="space-y-8">
        {groups.map(({ group, items }) => {
          const Icon = GROUP_ICON[group] ?? FileBarChart2;
          return (
            <section key={group} aria-labelledby={`grp-${group}`}>
              <h2 id={`grp-${group}`} className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-wide text-ink-3 uppercase">
                <Icon className="size-4" aria-hidden /> {group}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {items.map((d) => (
                  <Link key={d.key} to={`/reports/${d.key}`} className="group block">
                    <Card className="h-full transition-colors group-hover:border-forest-200 group-hover:bg-forest-50/40">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="text-[15px] font-semibold text-ink">{d.title}</h3>
                          <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{d.description}</p>
                        </div>
                        <ArrowRight className="mt-1 size-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-forest-700" aria-hidden />
                      </div>
                      <p className="mt-3 text-xs text-ink-3">
                        {d.columns.length} columns · {d.dateFiltered ? 'date range' : 'current status'}
                        {d.filters.gate ? ' · gate' : ''}
                        {d.filters.category ? ' · category' : ''}
                        {d.filters.status ? ' · status' : ''}
                      </p>
                    </Card>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
