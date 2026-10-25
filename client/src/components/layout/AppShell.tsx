import { useCallback, useEffect, useId, useRef, useState, type FocusEvent, type ReactNode } from 'react';
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
import { BROWSER_EDITION, browserEditionNote, useBrowserHost } from '../../lib/edition';
import { useLocationScope } from '../../lib/location';
import { fmtRelative } from '../../lib/format';
import type { Permission } from '../../../../shared/constants';
import { Wordmark } from '../Logo';
import { Avatar, cx, trapTabKey } from '../ui';

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
  // Subscribing re-renders the banner when the in-page server's storage changes, e.g. when saving on this device starts failing.
  const host = useBrowserHost();
  if (!config?.demo) return null;
  return (
    <div className="no-print bg-gold-400 px-4 py-1.5 text-center text-[12px] font-medium text-forest-950" role="note">
      <span className="mr-2 rounded bg-forest-950/90 px-1.5 py-0.5 text-[10px] font-bold tracking-widest text-gold-300 uppercase">Demo</span>
      {config.demoBanner}
      {BROWSER_EDITION && (
        <div className="mt-0.5 text-[11.5px] font-normal text-forest-950/85">
          {browserEditionNote()}
          <span role="status">
            {host?.saveError && (
              <>
                {' '}
                <strong className="font-semibold text-forest-950">{host.saveError}</strong>
              </>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: (to: string) => void }) {
  const { can } = useAuth();
  return (
    <nav className="flex h-full flex-col overflow-y-auto px-3 pb-6" aria-label="Main">
      {can('gate.operate') && (
        <Link
          to="/gate"
          onClick={() => onNavigate?.('/gate')}
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
            <div className="px-3 pb-1.5 text-[10.5px] font-semibold tracking-[0.12em] text-forest-200/70 uppercase">{group.section}</div>
            <ul className="space-y-0.5">
              {items.map((i) => (
                <li key={i.to}>
                  <NavLink
                    to={i.to}
                    onClick={() => onNavigate?.(i.to)}
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
    <label className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-white py-1 pr-1 pl-2.5 text-[13px] text-ink-2 sm:pl-3">
      <Building2 className="hidden size-4 shrink-0 text-ink-3 sm:block" aria-hidden />
      <span className="sr-only">Location</span>
      <select
        value={locationId ?? ''}
        onChange={(e) => setLocationId(e.target.value ? Number(e.target.value) : null)}
        className="w-full max-w-[150px] min-w-0 cursor-pointer truncate bg-transparent py-1 pr-1 font-medium text-ink focus:outline-none sm:max-w-[220px]"
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

/**
 * Header dropdown behaviour: closes on an outside click, on Escape and when focus moves to
 * something outside it. `close()` hands focus back to the trigger when it was inside the panel.
 */
function useDropdown() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const close = useCallback(() => {
    if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
    setOpen(false);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => rootRef.current && !rootRef.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  // A click on blank panel space blurs with no relatedTarget: only close when focus really went elsewhere.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node) && setOpen(false);
  const triggerProps = { ref: triggerRef, 'aria-expanded': open, 'aria-controls': open ? panelId : undefined, onClick: () => setOpen((v) => !v) };
  return { open, close, rootRef, onBlur, panelId, triggerProps };
}

function NotificationBell() {
  const { open, close, rootRef, onBlur, panelId, triggerProps } = useDropdown();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['notifications', 'bell'], queryFn: () => api.get<{ items: NotificationRow[]; unread: number }>('/notifications', { limit: 8 }), refetchInterval: 20_000 });
  const unread = q.data?.unread ?? 0;
  return (
    // Below sm the panel is anchored to the (sticky) header rather than the bell, so it spans the screen instead of running off its left edge.
    <div className="sm:relative" ref={rootRef} onBlur={onBlur}>
      <button
        type="button"
        {...triggerProps}
        className="relative rounded-lg p-2 text-ink-2 hover:bg-white hover:text-ink"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
      >
        <Bell className="size-5" />
        {unread > 0 && <span className="absolute top-1 right-1 min-w-[18px] rounded-full bg-bad px-1 text-center text-[10px] leading-[18px] font-bold text-white">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div id={panelId} className="absolute inset-x-3 top-full z-40 mt-2 overflow-hidden rounded-xl border border-line bg-white shadow-[var(--shadow-pop)] sm:inset-x-auto sm:top-auto sm:right-0 sm:w-[380px]">
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
                    close();
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
          <Link to="/notifications" onClick={close} className="block bg-canvas px-4 py-2.5 text-center text-[13px] font-medium text-forest-700 hover:text-forest-900">
            View all notifications
          </Link>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { me } = useAuth();
  const { open, close, rootRef, onBlur, panelId, triggerProps } = useDropdown();
  const navigate = useNavigate();
  if (!me) return null;
  return (
    <div className="relative" ref={rootRef} onBlur={onBlur}>
      <button type="button" {...triggerProps} className="relative flex items-center gap-2.5 rounded-lg py-1 pr-2 pl-1 hover:bg-white">
        <Avatar name={me.user.displayName} size={32} tone="gold" />
        {/* Visually hidden below md but still the button's accessible name. */}
        <span className="sr-only text-left leading-tight md:not-sr-only md:block">
          <span className="block text-[13px] font-semibold text-ink">{me.user.displayName}</span>
          <span className="block text-[11px] text-ink-3">{me.user.roleName}</span>
        </span>
      </button>
      {open && (
        <div id={panelId} className="absolute right-0 z-40 mt-2 w-60 overflow-hidden rounded-xl border border-line bg-white py-1 shadow-[var(--shadow-pop)]">
          <div className="border-b border-line px-4 py-3">
            <div className="text-sm font-semibold">{me.user.displayName}</div>
            <div className="text-xs text-ink-3">
              {me.user.username} · {me.user.roleName}
            </div>
          </div>
          <Link to="/account" onClick={close} className="block px-4 py-2 text-sm text-ink-2 hover:bg-canvas">
            Account & password
          </Link>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-bad hover:bg-bad-bg"
            onClick={() => {
              close();
              // Sign-out is a navigation, so a page with unsaved changes can ask first (see SignOut in App).
              navigate('/sign-out', { state: { signOut: true } });
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
  const drawerId = useId();
  const drawerRef = useRef<HTMLElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  /** Path when the drawer opened; a different path on close means a drawer link was followed. */
  const openedOn = useRef<string | null>(null);

  // A followed link closes the drawer once the route changes, so a navigation that is held back
  // (unsaved changes) leaves it open behind the confirmation. A link to the current page closes it now.
  useEffect(() => setMobileOpen(false), [location.pathname]);
  const onDrawerNavigate = (to: string) => to === location.pathname && setMobileOpen(false);

  // Widths from lg up have no drawer: close it if the window grows while it is open.
  useEffect(() => {
    if (!mobileOpen) return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = () => mq.matches && setMobileOpen(false);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mobileOpen]);

  useEffect(() => {
    if (mobileOpen) {
      openedOn.current = location.pathname;
      closeButtonRef.current?.focus();
      const onKey = (e: KeyboardEvent) => {
        const drawer = drawerRef.current;
        // Leave keys alone while something else (a confirmation dialog) holds focus.
        if (!drawer || (e.target !== document.body && !drawer.contains(e.target as Node))) return;
        if (e.key === 'Escape') setMobileOpen(false);
        else trapTabKey(e, drawer);
      };
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }
    if (openedOn.current === null) return;
    const followedLink = openedOn.current !== location.pathname;
    openedOn.current = null;
    // Only place focus when closing the drawer dropped it (to <body>); a page that focused something itself keeps it.
    if (document.activeElement && document.activeElement !== document.body) return;
    if (followedLink) mainRef.current?.focus({ preventScroll: true });
    else openButtonRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the drawer opens or closes; reads the path of that render
  }, [mobileOpen]);

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
            <aside ref={drawerRef} id={drawerId} role="dialog" aria-modal="true" aria-label="Main menu" className="absolute inset-y-0 left-0 flex w-[min(84vw,300px)] flex-col bg-forest-900">
              <div className="flex items-center justify-between px-5 pt-5 pb-6">
                <Wordmark />
                <button ref={closeButtonRef} type="button" onClick={() => setMobileOpen(false)} className="rounded-md p-1 text-forest-200 hover:text-white" aria-label="Close menu">
                  <X className="size-5" />
                </button>
              </div>
              <Sidebar onNavigate={onDrawerNavigate} />
            </aside>
          </div>
        )}
        {/* Inert while the drawer is open, so Tab and screen readers stay in the drawer. */}
        <div className="flex min-w-0 flex-1 flex-col" inert={mobileOpen}>
          <header className="no-print sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-line bg-canvas/90 px-3 backdrop-blur sm:gap-3 sm:px-6">
            <button
              ref={openButtonRef}
              type="button"
              className="rounded-lg p-2 text-ink-2 hover:bg-white lg:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
              aria-haspopup="dialog"
              aria-expanded={mobileOpen}
              aria-controls={mobileOpen ? drawerId : undefined}
            >
              <Menu className="size-5" />
            </button>
            <div className="hidden sm:block lg:hidden">
              <DoorOpen className="size-5 text-forest-700" aria-hidden />
            </div>
            <div className="min-w-0 flex-1 sm:flex-none">
              <LocationSwitcher />
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <NotificationBell />
              <UserMenu />
            </div>
          </header>
          <main ref={mainRef} tabIndex={-1} className="print-full mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 outline-none sm:px-6 lg:px-8">
            {children ?? <Outlet />}
          </main>
        </div>
      </div>
    </div>
  );
}
