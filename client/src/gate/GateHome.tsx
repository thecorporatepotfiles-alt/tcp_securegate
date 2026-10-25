import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDownLeft,
  ArrowUpRight,
  BadgeCheck,
  BellRing,
  CarFront,
  ClipboardList,
  HardHat,
  History,
  KeyRound,
  Package,
  QrCode,
  ShieldAlert,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtTime } from '../lib/format';
import type { Row } from '../lib/types';
import { cx } from '../components/ui';
import { useGateId } from './GateContext';
import { GateSpinner } from './gateUi';

export interface GateHomeData {
  gate: { id: number; code: string; name: string; gateType: string; locationId: number; locationName: string };
  generatedAt: string;
  insideByCategory: Record<string, number>;
  counts: {
    eventsToday: number;
    failuresToday: number;
    visitorsWaiting: number;
    visitorsExpectedToday: number;
    deliveriesOpen: number;
    openAlerts: number | null;
    myPendingReviews: number;
    myApprovedReviews: number;
  };
}

export function useGateHome(gateId: number) {
  return useQuery({ queryKey: ['gate', gateId, 'home'], queryFn: () => api.get<GateHomeData>(`/gate/${gateId}/home`), refetchInterval: 15_000 });
}

interface Tile {
  to: string;
  title: string;
  hint: string;
  icon: LucideIcon;
  primary?: boolean;
  badge?: number | null;
  badgeTone?: 'gold' | 'red';
}

function TileLink({ t }: { t: Tile }) {
  return (
    <Link
      to={t.to}
      className={cx(
        'group relative flex min-h-[132px] flex-col justify-between rounded-2xl border p-4 transition-colors sm:min-h-[150px] sm:p-5',
        t.primary ? 'border-gold-400/70 bg-gold-400 text-forest-950 hover:bg-gold-300' : 'border-white/10 bg-forest-900 text-white hover:border-gold-400/50 hover:bg-forest-800',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <t.icon className={cx('size-9 sm:size-10', t.primary ? 'text-forest-900' : 'text-gold-400')} aria-hidden />
        {t.badge ? (
          <span className={cx('min-w-7 rounded-full px-2 py-0.5 text-center text-sm font-bold', t.badgeTone === 'red' ? 'bg-[#e34948] text-white' : 'bg-gold-400 text-forest-950')}>{t.badge}</span>
        ) : null}
      </div>
      <div>
        <div className="text-[17px] leading-tight font-semibold sm:text-lg">{t.title}</div>
        <div className={cx('mt-0.5 text-[13px] leading-snug', t.primary ? 'text-forest-900/80' : 'text-forest-200/70')}>{t.hint}</div>
      </div>
    </Link>
  );
}

export function GateHome() {
  const gateId = useGateId();
  const { can } = useAuth();
  const home = useGateHome(gateId);
  const reviews = useQuery({
    queryKey: ['gate', gateId, 'my-reviews'],
    queryFn: () => api.get<{ items: Row[] }>('/manual-reviews', { mine: true, pageSize: 20 }),
    refetchInterval: 15_000,
  });
  const c = home.data?.counts;
  const inside = home.data?.insideByCategory ?? {};
  const contractorsInside = (inside.CONTRACTOR ?? 0) + (inside.VENDOR ?? 0) + (inside.SERVICE ?? 0);
  const approved = (reviews.data?.items ?? []).filter((r) => r.status === 'APPROVED');
  const pending = (reviews.data?.items ?? []).filter((r) => r.status === 'PENDING');

  const tiles: Tile[] = [
    { to: '/gate/verify/personnel', title: 'Verify Personnel', hint: 'Card / mock reader', icon: BadgeCheck, primary: true },
    { to: '/gate/verify/visitor', title: 'Scan Visitor QR', hint: 'Pass QR or visit reference', icon: QrCode, primary: true },
    { to: '/gate/record/ENTRY', title: 'Record Entry', hint: 'Choose type, verify, record', icon: ArrowDownLeft },
    { to: '/gate/record/EXIT', title: 'Record Exit', hint: 'Choose type, verify, record', icon: ArrowUpRight },
    { to: '/gate/verify/contractor', title: 'Verify Contractor', hint: 'Contractors, vendors, service', icon: HardHat },
    { to: '/gate/verify/temporary', title: 'Verify Temporary Access', hint: 'Temporary passes', icon: KeyRound },
    { to: '/gate/verify/vehicle', title: 'Register Vehicle', hint: 'Plate check, entry & exit', icon: CarFront },
    { to: '/gate/deliveries', title: 'Register Delivery', hint: 'Arrivals, entry, departure', icon: Package, badge: c?.deliveriesOpen },
    { to: '/gate/walk-in', title: 'Visitor Arrival', hint: 'Walk-in without a pass', icon: UserPlus },
    { to: '/gate/visitors', title: 'Visitor Queue', hint: 'Expected, waiting, inside', icon: Users, badge: c?.visitorsWaiting },
    { to: '/gate/recent', title: 'View Recent Events', hint: 'This gate, latest first', icon: History },
  ];
  if (can('alerts.view')) tiles.push({ to: '/gate/alerts', title: 'Review Alerts', hint: 'Open alerts at this location', icon: ShieldAlert, badge: c?.openAlerts, badgeTone: 'red' });

  return (
    <div className="space-y-5">
      {/* The tiles are the visual title; screen-reader and heading navigation still need one. */}
      <h1 className="sr-only">Gate home{home.data ? ` · ${home.data.gate.name}` : ''}</h1>
      {approved.length > 0 && (
        <Link to="/gate/reviews" className="flex items-center gap-3 rounded-2xl border border-[#5fd39a]/40 bg-[#1f8a5f]/20 px-4 py-3 text-white hover:bg-[#1f8a5f]/30">
          <ClipboardList className="size-6 text-[#5fd39a]" aria-hidden />
          <span className="text-[15px]">
            <strong>{approved.length} manual review{approved.length > 1 ? 's' : ''} approved</strong> — record the approved movement now.
          </span>
        </Link>
      )}
      {pending.length > 0 && (
        <Link to="/gate/reviews" className="flex items-center gap-3 rounded-2xl border border-gold-400/40 bg-gold-400/10 px-4 py-3 text-gold-200 hover:bg-gold-400/15">
          <BellRing className="size-6 text-gold-400" aria-hidden />
          <span className="text-[15px]">
            {pending.length} manual review{pending.length > 1 ? 's' : ''} awaiting a supervisor decision.
          </span>
        </Link>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
        {tiles.map((t) => (
          <TileLink key={t.to} t={t} />
        ))}
      </div>

      <section aria-label="Location status" className="rounded-2xl border border-white/10 bg-forest-900/70 p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[13px] font-semibold tracking-[0.12em] text-forest-200/70 uppercase">Recorded inside now · {home.data?.gate.locationName ?? '…'}</h2>
          {home.data && <span className="text-xs text-forest-200/70">Updated {fmtTime(home.data.generatedAt)} · refreshes every 15 s</span>}
        </div>
        {home.isLoading ? (
          <GateSpinner />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            {[
              ['Personnel', inside.PERSONNEL ?? 0],
              ['Visitors', inside.VISITOR ?? 0],
              ['Contractors', contractorsInside],
              ['Temporary', inside.TEMPORARY ?? 0],
              ['Delivery staff', inside.DELIVERY ?? 0],
              ['Vehicles', inside.VEHICLE ?? 0],
              ['Gate events today', c?.eventsToday ?? 0],
              ['Failed checks today', c?.failuresToday ?? 0],
            ].map(([label, value]) => (
              <div key={label as string} className="rounded-xl bg-white/[0.04] px-3 py-2.5">
                <div className="text-2xl font-semibold text-white tabular-nums">{value}</div>
                <div className="text-xs text-forest-200/70">{label}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
