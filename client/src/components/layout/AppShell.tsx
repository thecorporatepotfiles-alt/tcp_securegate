import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bell,
  Building2,
  CarFront,
  ClipboardCheck,
  ClipboardList,
  CreditCard,
  DoorOpen,
  FileBarChart2,
  FileWarning,
  Gauge,
  HardHat,
  History,
  KeyRound,
  ListChecks,
  LogOut,
  Map as MapIcon,
  Menu,
  Package,
  Repeat2,
  ScanLine,
  Settings,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Timer,
  UserCheck,
  UserCog,
  Users,
  UsersRound,
  X,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLocationScope } from '../../lib/location';
import { fmtRelative } from '../../lib/format';
import type { Permission } from '../../../../shared/constants';
import { Wordmark } from '../Logo';
import { Avatar, cx } from '../ui';

interface NavItem {
  to: string;
  label: string;
  icon: typeof Gauge;
  perms: Permission[];
}

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Overview',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: Gauge, perms: ['dashboard.view'] },
      { to: '/presence', label: 'Who Is Inside?', icon: UsersRound, perms: ['presence.view'] },
      { to: '/register', label: 'Gate Register', icon: ClipboardList, perms: ['events.view'] },
      { to: '/waiting-list', label: 'Waiting List', icon: Timer, perms: ['visitors.view', 'visitors.view_all'] },
    ],
  },
  {
    section: 'Visitors',
    items: [
      { to: '/visitors', label: 'Visitors', icon: UserCheck, perms: ['visitors.view', 'visitors.view_all'] },
      { to: '/approvals', label: 'My Approvals', icon: ClipboardCheck, perms: ['visitors.approve'] },
    ],
  },
  {
    section: 'People & access',
    items: [
      { to: '/personnel', label: 'Personnel', icon: Users, perms: ['personnel.view'] },
      { to: '/credentials', label: 'Credentials', icon: CreditCard, perms: ['credentials.view'] },
      { to: '/contractors', label: 'Contractors & Vendors', icon: HardHat, perms: ['contractors.view'] },
      { to: '/temporary-access', label: 'Temporary Access', icon: KeyRound, perms: ['temp_access.view'] },
    ],
  },
  {
    section: 'Vehicles & deliveries',
    items: [
      { to: '/vehicles', label: 'Vehicles', icon: CarFront, perms: ['vehicles.view'] },
      { to: '/deliveries', label: 'Deliveries', icon: Package, perms: ['deliveries.view', 'deliveries.manage', 'deliveries.acknowledge'] },
    ],
  },
  {
    section: 'Oversight',
    items: [
      { to: '/alerts', label: 'Alerts', icon: ShieldAlert, perms: ['alerts.view'] },
      { to: '/manual-reviews', label: 'Manual Reviews', icon: ListChecks, perms: ['gate.manual_review'] },
      { to: '/exceptions', label: 'Admin Exceptions', icon: FileWarning, perms: ['exceptions.view'] },
      { to: '/handover', label: 'Shift Handover', icon: Repeat2, perms: ['handover.manage', 'exceptions.view'] },
      { to: '/reports', label: 'Reports', icon: FileBarChart2, perms: ['reports.view'] },
      { to: '/audit', label: 'Audit Trail', icon: History, perms: ['audit.view'] },
    ],
  },
  {
    section: 'Administration',
    items: [
      { to: '/admin/users', label: 'Users', icon: UserCog, perms: ['users.manage'] },
      { to: '/admin/roles', label: 'Roles & Permissions', icon: ShieldCheck, perms: ['roles.manage'] },
      { to: '/admin/locations', label: 'Locations & Gates', icon: MapIcon, perms: ['locations.manage'] },
      { to: '/admin/settings', label: 'Workflow Settings', icon: SlidersHorizontal, perms: ['settings.manage'] },
      { to: '/admin/system', label: 'System & Demo', icon: Settings, perms: ['settings.manage', 'demo.reset'] },
    ],
  },
];

export function DemoBanner() {
  const { config } = useAuth();
  if (!config?.demo) return null;
  return (
    <div className="no-print bg-gold-400 px-4 py-1.5 text-center text-[12px] font-medium text-forest-950" role="note">
      <span className="mr-2 rounded bg-forest-950/90 px-1.5 py-0.5 text-[10px] font-bold tracking-widest text-gold-300 uppercase">Demo</span>
      {config.demoBanner}
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { can } = useAuth();
  return (
    <nav className="flex h-full flex-col overflow-y-auto px-3 pb-6" aria-label="Main">
      {can('gate.operate') && (
        <Link
          to="/gate"
          onClick={onNavigate}
          className="mb-5 flex items-center gap-3 rounded-lg border border-gold-500/40 bg-gold-500/10 px-3 py-2.5 text-sm font-semibold text-gold-300 transition-colors hover:bg-gold-500/20"
        >
          <ScanLine className="size-[18px]" aria-hidden />
          Open gate interface
        </Link>
      )}
      {NAV.map((group) => {
        const items = group.items.filter((i) => can(...i.perms));
        if (!items.length) return null;
        return (
          <div key={group.section} className="mb-5">
            <div className="px-3 pb-1.5 text-[10.5px] font-semibold tracking-[0.12em] text-forest-200/50 uppercase">{group.section}</div>
            <ul className="space-y-0.5">
              {items.map((i) => (
                <li key={i.to}>
                  <NavLink
                    to={i.to}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cx(
                        'flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium transition-colors',
                        isActive ? 'bg-forest-700 text-white shadow-[inset_3px_0_0_var(--color-gold-400)]' : 'text-forest-200/80 hover:bg-forest-800 hover:text-white',
                      )
                    }
                  >
                    <i.icon className="size-[18px] shrink-0" aria-hidden />
                    {i.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function LocationSwitcher() {
  const { locations, locationId, setLocationId, allowAll } = useLocationScope();
  if (locations.length === 0) return null;
  if (locations.length === 1)
    return (
      <div className="hidden items-center gap-2 rounded-lg border border-line bg-white px-3 py-1.5 text-[13px] text-ink-2 sm:flex">
        <Building2 className="size-4 text-ink-3" aria-hidden />
        {locations[0].name}
      </div>
    );
  return (
    <label className="flex items-center gap-2 rounded-lg border border-line bg-white py-1 pr-1 pl-3 text-[13px] text-ink-2">
      <Building2 className="size-4 shrink-0 text-ink-3" aria-hidden />
      <span className="sr-only">Location</span>
      <select
        value={locationId ?? ''}
        onChange={(e) => setLocationId(e.target.value ? Number(e.target.value) : null)}
        className="max-w-[170px] cursor-pointer bg-transparent py-1 pr-1 font-medium text-ink focus:outline-none sm:max-w-[220px]"
      >
        {allowAll && <option value="">All authorized locations</option>}
        {locations.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
    </label>
  );
}

interface NotificationRow {
  id: number;
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
  readAt: string | null;
}

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['notifications', 'bell'], queryFn: () => api.get<{ items: NotificationRow[]; unread: number }>('/notifications', { limit: 8 }), refetchInterval: 20_000 });
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const unread = q.data?.unread ?? 0;
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-lg p-2 text-ink-2 hover:bg-white hover:text-ink"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        aria-expanded={open}
      >
        <Bell className="size-5" />
        {unread > 0 && <span className="absolute top-1 right-1 min-w-[18px] rounded-full bg-bad px-1 text-center text-[10px] leading-[18px] font-bold text-white">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[min(92vw,380px)] overflow-hidden rounded-xl border border-line bg-white shadow-[var(--shadow-pop)]">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="text-sm font-semibold">Notifications</span>
            <span className="text-xs text-ink-3">In-app only</span>
          </div>
          <ul className="max-h-[60vh] overflow-y-auto">
            {(q.data?.items ?? []).length === 0 && <li className="px-4 py-8 text-center text-sm text-ink-3">You're all caught up.</li>}
            {q.data?.items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className={cx('block w-full border-b border-line/70 px-4 py-3 text-left hover:bg-canvas', !n.readAt && 'bg-gold-100/40')}
                  onClick={async () => {
                    setOpen(false);
                    if (!n.readAt) await api.post(`/notifications/${n.id}/read`).catch(() => undefined);
                    q.refetch();
                    if (n.link) navigate(n.link);
                  }}
                >
                  <div className="flex items-start gap-2">
                    {!n.readAt && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-gold-500" aria-label="Unread" />}
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-ink">{n.title}</div>
                      <div className="line-clamp-2 text-xs text-ink-3">{n.body}</div>
                      <div className="mt-1 text-[11px] text-ink-3">{fmtRelative(n.createdAt)}</div>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <Link to="/notifications" onClick={() => setOpen(false)} className="block bg-canvas px-4 py-2.5 text-center text-[13px] font-medium text-forest-700 hover:text-forest-900">
            View all notifications
          </Link>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { me, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  if (!me) return null;
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-2.5 rounded-lg py-1 pr-2 pl-1 hover:bg-white" aria-expanded={open}>
        <Avatar name={me.user.displayName} size={32} tone="gold" />
        <span className="hidden text-left leading-tight md:block">
          <span className="block text-[13px] font-semibold text-ink">{me.user.displayName}</span>
          <span className="block text-[11px] text-ink-3">{me.user.roleName}</span>
        </span>
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-60 overflow-hidden rounded-xl border border-line bg-white py-1 shadow-[var(--shadow-pop)]">
          <div className="border-b border-line px-4 py-3">
            <div className="text-sm font-semibold">{me.user.displayName}</div>
            <div className="text-xs text-ink-3">
              {me.user.username} · {me.user.roleName}
            </div>
          </div>
          <Link to="/account" onClick={() => setOpen(false)} className="block px-4 py-2 text-sm text-ink-2 hover:bg-canvas">
            Account & password
          </Link>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-bad hover:bg-bad-bg"
            onClick={async () => {
              await logout();
              navigate('/login');
            }}
          >
            <LogOut className="size-4" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function AppShell({ children }: { children?: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMobileOpen(false), [location.pathname]);
  return (
    <div className="flex min-h-screen flex-col">
      <DemoBanner />
      <div className="flex flex-1">
        <aside className="no-print sticky top-0 hidden h-screen w-64 shrink-0 flex-col bg-forest-900 lg:flex">
          <div className="px-5 pt-5 pb-6">
            <Wordmark />
          </div>
          <Sidebar />
        </aside>
        {mobileOpen && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <div className="absolute inset-0 bg-forest-950/60" onClick={() => setMobileOpen(false)} />
            <aside className="absolute inset-y-0 left-0 flex w-[min(84vw,300px)] flex-col bg-forest-900">
              <div className="flex items-center justify-between px-5 pt-5 pb-6">
                <Wordmark />
                <button type="button" onClick={() => setMobileOpen(false)} className="rounded-md p-1 text-forest-200 hover:text-white" aria-label="Close menu">
                  <X className="size-5" />
                </button>
              </div>
              <Sidebar onNavigate={() => setMobileOpen(false)} />
            </aside>
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="no-print sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-canvas/90 px-4 backdrop-blur sm:px-6">
            <button type="button" className="rounded-lg p-2 text-ink-2 hover:bg-white lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu">
              <Menu className="size-5" />
            </button>
            <div className="lg:hidden">
              <DoorOpen className="size-5 text-forest-700" aria-hidden />
            </div>
            <LocationSwitcher />
            <div className="ml-auto flex items-center gap-1">
              <NotificationBell />
              <UserMenu />
            </div>
          </header>
          <main className="print-full mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6 lg:px-8">{children ?? <Outlet />}</main>
        </div>
      </div>
    </div>
  );
}
