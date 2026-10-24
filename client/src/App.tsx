import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ShieldOff } from 'lucide-react';
import { useAuth } from './lib/auth';
import { LocationProvider } from './lib/location';
import { AppShell } from './components/layout/AppShell';
import { ButtonLink, EmptyState, Spinner } from './components/ui';
import type { Permission } from '../../shared/constants';
import LoginPage from './pages/LoginPage';

const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const PresencePage = lazy(() => import('./pages/PresencePage'));
const RegisterPage = lazy(() => import('./pages/RegisterPage'));
const EventDetailPage = lazy(() => import('./pages/EventDetailPage'));
const WaitingListPage = lazy(() => import('./pages/WaitingListPage'));
const VisitorsPage = lazy(() => import('./pages/VisitorsPage'));
const VisitorNewPage = lazy(() => import('./pages/VisitorNewPage'));
const VisitorDetailPage = lazy(() => import('./pages/VisitorDetailPage'));
const ApprovalsPage = lazy(() => import('./pages/ApprovalsPage'));
const PersonnelPage = lazy(() => import('./pages/PersonnelPage'));
const PersonnelFormPage = lazy(() => import('./pages/PersonnelFormPage'));
const PersonnelDetailPage = lazy(() => import('./pages/PersonnelDetailPage'));
const CredentialsPage = lazy(() => import('./pages/CredentialsPage'));
const CredentialDetailPage = lazy(() => import('./pages/CredentialDetailPage'));
const ContractorsPage = lazy(() => import('./pages/ContractorsPage'));
const ContractorFormPage = lazy(() => import('./pages/ContractorFormPage'));
const ContractorDetailPage = lazy(() => import('./pages/ContractorDetailPage'));
const TempAccessPage = lazy(() => import('./pages/TempAccessPage'));
const TempAccessNewPage = lazy(() => import('./pages/TempAccessNewPage'));
const TempAccessDetailPage = lazy(() => import('./pages/TempAccessDetailPage'));
const VehiclesPage = lazy(() => import('./pages/VehiclesPage'));
const VehicleFormPage = lazy(() => import('./pages/VehicleFormPage'));
const VehicleDetailPage = lazy(() => import('./pages/VehicleDetailPage'));
const DeliveriesPage = lazy(() => import('./pages/DeliveriesPage'));
const DeliveryNewPage = lazy(() => import('./pages/DeliveryNewPage'));
const DeliveryDetailPage = lazy(() => import('./pages/DeliveryDetailPage'));
const AlertsPage = lazy(() => import('./pages/AlertsPage'));
const AlertDetailPage = lazy(() => import('./pages/AlertDetailPage'));
const ManualReviewsPage = lazy(() => import('./pages/ManualReviewsPage'));
const ExceptionsPage = lazy(() => import('./pages/ExceptionsPage'));
const ExceptionNewPage = lazy(() => import('./pages/ExceptionNewPage'));
const ExceptionDetailPage = lazy(() => import('./pages/ExceptionDetailPage'));
const HandoverPage = lazy(() => import('./pages/HandoverPage'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const ReportViewPage = lazy(() => import('./pages/ReportViewPage'));
const AuditPage = lazy(() => import('./pages/AuditPage'));
const NotificationsPage = lazy(() => import('./pages/NotificationsPage'));
const AccountPage = lazy(() => import('./pages/AccountPage'));
const UsersPage = lazy(() => import('./pages/admin/UsersPage'));
const RolesPage = lazy(() => import('./pages/admin/RolesPage'));
const LocationsPage = lazy(() => import('./pages/admin/LocationsPage'));
const SettingsPage = lazy(() => import('./pages/admin/SettingsPage'));
const SystemPage = lazy(() => import('./pages/admin/SystemPage'));
const GateApp = lazy(() => import('./gate/GateApp'));

function NotAuthorized() {
  return (
    <EmptyState
      icon={<ShieldOff className="size-6" />}
      title="You are not authorized to view this page"
      description="Your role does not include access to this area. Contact your administrator if you believe this is wrong."
      action={<ButtonLink to="/">Go to your home page</ButtonLink>}
    />
  );
}

function Guard({ perms, children }: { perms: Permission[]; children: ReactNode }) {
  const { can } = useAuth();
  return can(...perms) ? <>{children}</> : <NotAuthorized />;
}

export function homeFor(perms: (p: Permission) => boolean): string {
  if (perms('dashboard.view')) return '/dashboard';
  if (perms('gate.operate')) return '/gate';
  if (perms('visitors.approve') || perms('visitors.create')) return '/visitors';
  if (perms('deliveries.acknowledge')) return '/deliveries';
  return '/account';
}

function Home() {
  const { can } = useAuth();
  return <Navigate to={homeFor((p) => can(p))} replace />;
}

function RequireSession({ children }: { children: ReactNode }) {
  const { me, loading, signedOut } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner label="Loading SecureGate…" />;
  // After a deliberate sign-out the next person should start at their own home page, not the previous user's.
  if (!me) return <Navigate to={signedOut ? '/login' : `/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <>{children}</>;
}

const page = (perms: Permission[], el: ReactNode) => <Guard perms={perms}>{el}</Guard>;

export default function App() {
  const navigate = useNavigate();
  useEffect(() => {
    window.__sgNavigate = (to: string) => navigate(to);
  }, [navigate]);

  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/gate/*"
          element={
            <RequireSession>
              <LocationProvider>{page(['gate.operate'], <GateApp />)}</LocationProvider>
            </RequireSession>
          }
        />
        <Route
          element={
            <RequireSession>
              <LocationProvider>
                <AppShell />
              </LocationProvider>
            </RequireSession>
          }
        >
          <Route index element={<Home />} />
          <Route path="dashboard" element={page(['dashboard.view'], <DashboardPage />)} />
          <Route path="presence" element={page(['presence.view'], <PresencePage />)} />
          <Route path="register" element={page(['events.view'], <RegisterPage />)} />
          <Route path="events/:id" element={page(['events.view'], <EventDetailPage />)} />
          <Route path="waiting-list" element={page(['visitors.view', 'visitors.view_all'], <WaitingListPage />)} />
          <Route path="visitors" element={page(['visitors.view', 'visitors.view_all'], <VisitorsPage />)} />
          <Route path="visitors/new" element={page(['visitors.create'], <VisitorNewPage />)} />
          <Route path="visitors/:id" element={page(['visitors.view', 'visitors.view_all'], <VisitorDetailPage />)} />
          <Route path="approvals" element={page(['visitors.approve'], <ApprovalsPage />)} />
          <Route path="personnel" element={page(['personnel.view'], <PersonnelPage />)} />
          <Route path="personnel/new" element={page(['personnel.manage'], <PersonnelFormPage />)} />
          <Route path="personnel/:id" element={page(['personnel.view'], <PersonnelDetailPage />)} />
          <Route path="personnel/:id/edit" element={page(['personnel.manage'], <PersonnelFormPage />)} />
          <Route path="credentials" element={page(['credentials.view'], <CredentialsPage />)} />
          <Route path="credentials/:id" element={page(['credentials.view'], <CredentialDetailPage />)} />
          <Route path="contractors" element={page(['contractors.view'], <ContractorsPage />)} />
          <Route path="contractors/new" element={page(['contractors.manage'], <ContractorFormPage />)} />
          <Route path="contractors/people/:id" element={page(['contractors.view'], <ContractorDetailPage />)} />
          <Route path="contractors/people/:id/edit" element={page(['contractors.manage'], <ContractorFormPage />)} />
          <Route path="temporary-access" element={page(['temp_access.view'], <TempAccessPage />)} />
          <Route path="temporary-access/new" element={page(['temp_access.manage'], <TempAccessNewPage />)} />
          <Route path="temporary-access/:id" element={page(['temp_access.view'], <TempAccessDetailPage />)} />
          <Route path="vehicles" element={page(['vehicles.view'], <VehiclesPage />)} />
          <Route path="vehicles/new" element={page(['vehicles.manage'], <VehicleFormPage />)} />
          <Route path="vehicles/:id" element={page(['vehicles.view'], <VehicleDetailPage />)} />
          <Route path="vehicles/:id/edit" element={page(['vehicles.manage'], <VehicleFormPage />)} />
          <Route path="deliveries" element={page(['deliveries.view', 'deliveries.manage', 'deliveries.acknowledge'], <DeliveriesPage />)} />
          <Route path="deliveries/new" element={page(['deliveries.manage'], <DeliveryNewPage />)} />
          <Route path="deliveries/:id" element={page(['deliveries.view', 'deliveries.manage', 'deliveries.acknowledge'], <DeliveryDetailPage />)} />
          <Route path="alerts" element={page(['alerts.view'], <AlertsPage />)} />
          <Route path="alerts/:id" element={page(['alerts.view'], <AlertDetailPage />)} />
          <Route path="manual-reviews" element={page(['gate.manual_review'], <ManualReviewsPage />)} />
          <Route path="exceptions" element={page(['exceptions.view'], <ExceptionsPage />)} />
          <Route path="exceptions/new" element={page(['exceptions.manage'], <ExceptionNewPage />)} />
          <Route path="exceptions/:id" element={page(['exceptions.view'], <ExceptionDetailPage />)} />
          <Route path="handover" element={page(['handover.manage', 'exceptions.view'], <HandoverPage />)} />
          <Route path="reports" element={page(['reports.view'], <ReportsPage />)} />
          <Route path="reports/:key" element={page(['reports.view'], <ReportViewPage />)} />
          <Route path="audit" element={page(['audit.view'], <AuditPage />)} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="account" element={<AccountPage />} />
          <Route path="admin/users" element={page(['users.manage'], <UsersPage />)} />
          <Route path="admin/roles" element={page(['roles.manage', 'users.manage'], <RolesPage />)} />
          <Route path="admin/locations" element={page(['locations.manage'], <LocationsPage />)} />
          <Route path="admin/settings" element={page(['settings.manage'], <SettingsPage />)} />
          <Route path="admin/system" element={page(['settings.manage', 'demo.reset'], <SystemPage />)} />
          <Route path="*" element={<EmptyState title="Page not found" description="The page you requested does not exist." action={<ButtonLink to="/">Go home</ButtonLink>} />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
