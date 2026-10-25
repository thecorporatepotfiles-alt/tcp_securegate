import { useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Lock, ShieldCheck } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { clearLastPath } from '../lib/browserRouting';
import { BROWSER_EDITION, serverCopy, useBrowserHost } from '../lib/edition';
import { Wordmark, LogoMark } from '../components/Logo';
import { DemoBanner } from '../components/layout/AppShell';
import { Avatar, Button, Input, Modal, Notice, cx } from '../components/ui';
import { homeFor } from '../App';
import type { RoleCode } from '../../../shared/constants';

const HIGHLIGHTS = [
  serverCopy('Role- and location-based access, enforced on the server', "Role- and location-based access rules, applied by SecureGate's server code running in this page"),
  serverCopy('Signed QR visitor passes with server-side verification', 'Signed QR visitor passes, verified by the same rules'),
  serverCopy('Append-only movement records and audit trail', 'Append-only movement records and audit trail (a demonstration: data in this browser is not protected)'),
];

/** Browser edition: the restore notice belongs to one dataset, so a dismissal is remembered per dataset for this tab. */
const RESTORE_DISMISSED_KEY = 'sg-restore-notice-dismissed';
function readRestoreDismissed(): string | null {
  try {
    return sessionStorage.getItem(RESTORE_DISMISSED_KEY);
  } catch {
    return null;
  }
}

const ROLE_BLURB: Record<RoleCode, string> = {
  SYSTEM_ADMIN: 'Configure locations, gates, users, roles and workflow rules',
  HQ_ADMIN: 'Consolidated view across all locations',
  LOCATION_ADMIN: 'Run one location: personnel, credentials, reviews',
  HOST: 'Request, approve and receive visitors',
  GUARD: 'Simplified, touch-friendly gate interface',
  AUDITOR: 'Read-only records, reports and audit trail',
};

export default function LoginPage() {
  const { me, config, refresh, expiredReason, can } = useAuth();
  const [sp] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [startOverOpen, setStartOverOpen] = useState(false);
  const [startingOver, setStartingOver] = useState(false);
  const [startOverError, setStartOverError] = useState<string | null>(null);
  // Live: re-renders when the in-page server's storage state changes.
  const host = useBrowserHost();
  const [restoreDismissed, setRestoreDismissed] = useState(readRestoreDismissed);
  const restoreNotice = BROWSER_EDITION && host?.restoreNotice && restoreDismissed !== host.dataCreatedAt ? host.restoreNotice : null;
  const dismissRestoreNotice = () => {
    if (!host) return;
    setRestoreDismissed(host.dataCreatedAt);
    try {
      sessionStorage.setItem(RESTORE_DISMISSED_KEY, host.dataCreatedAt);
    } catch {
      /* storage blocked: the notice stays dismissed until this screen is left */
    }
  };

  // Browser edition: after a failed restore, ?next is the page of a session in the discarded data and may
  // belong to another role, so whoever signs in starts at their own home page.
  const next = BROWSER_EDITION && host?.restoreNotice ? null : sp.get('next');
  if (me) return <Navigate to={next ?? homeFor((p) => can(p))} replace />;

  // Once the session loads, the redirect above takes over. A second navigate() here raced with it and
  // could leave the app on '/' with the home redirect already spent (always so with the in-memory router).
  const finish = () => refresh();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy('form');
    try {
      await api.post('/auth/login', { username, password });
      await finish();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const demoLogin = async (u: string) => {
    setError(null);
    setBusy(u);
    try {
      await api.post('/auth/demo-login', { username: u });
      await finish();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  /** Browser edition: erase this device's saved demo data and reload into a freshly generated dataset. */
  const startOver = async () => {
    if (!host) return;
    setStartingOver(true);
    setStartOverError(null);
    try {
      clearLastPath();
      await host.resetLocalData();
      window.location.reload();
    } catch (err) {
      setStartOverError(errorMessage(err));
      setStartingOver(false);
    }
  };

  const primaryDemo = ['admin', 'hq.admin', 'alpha.admin', 'alpha.officer', 'alpha.host', 'alpha.guard', 'bravo.guard', 'auditor'];
  const accounts = (config?.demoAccounts ?? []).slice().sort((a, b) => {
    const ia = primaryDemo.indexOf(a.username);
    const ib = primaryDemo.indexOf(b.username);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const visible = showAll ? accounts : accounts.filter((a) => primaryDemo.includes(a.username));

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <DemoBanner />
      <main className="grid flex-1 lg:grid-cols-[minmax(380px,0.9fr)_1.1fr]">
        <section className="relative hidden overflow-hidden bg-forest-900 p-12 text-white lg:flex lg:flex-col">
          <div className="pointer-events-none absolute -right-40 -bottom-40 opacity-[0.07]">
            <LogoMark size={620} />
          </div>
          <Wordmark />
          <div className="mt-auto max-w-md">
            <div className="mb-4 h-px w-16 bg-gold-400" />
            {/* Not the page heading: this panel is hidden below lg, and the h1 must be there at every width. */}
            <p className="text-[34px] leading-tight font-semibold tracking-tight">Secure gate, visitor and entry–exit management.</p>
            <p className="mt-4 text-[15px] leading-relaxed text-forest-200/80">
              One accountable record of who is inside — personnel, visitors, contractors, vehicles and deliveries — across headquarters and every location.
            </p>
            <ul className="mt-8 space-y-3 text-sm text-forest-200/90">
              {HIGHLIGHTS.map((t) => (
                <li key={t} className="flex items-start gap-2.5">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-gold-400" aria-hidden />
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <p className="mt-10 text-xs text-forest-200/70">Prototype for client demonstration. Not approved for operational use.</p>
        </section>

        <section className="flex flex-col items-center justify-center px-4 py-10 sm:px-8">
          <h1 className="sr-only">Sign in to TCP SecureGate</h1>
          <div className="mb-8 lg:hidden">
            <Wordmark light={false} />
          </div>
          <div className="w-full max-w-[560px]">
            {restoreNotice && (
              <Notice tone="warning" className="mb-5" title="Saved demo data was not restored">
                {restoreNotice}
                <div className="mt-2">
                  <Button size="sm" onClick={dismissRestoreNotice}>
                    Dismiss
                  </Button>
                </div>
              </Notice>
            )}
            {expiredReason && (
              <Notice tone="warning" className="mb-5" title="Signed out">
                {expiredReason}
              </Notice>
            )}
            {config?.demo && accounts.length > 0 && (
              <div className="mb-8">
                <h2 className="text-xl font-semibold tracking-tight">Choose a demonstration role</h2>
                <p className="mt-1 text-sm text-ink-2">One-click sign-in with synthetic demo accounts. Each role sees only what it is permitted to.</p>
                <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
                  {visible.map((a) => (
                    <button
                      key={a.username}
                      type="button"
                      disabled={!!busy}
                      onClick={() => demoLogin(a.username)}
                      className={cx(
                        'group flex items-start gap-3 rounded-xl border border-line bg-white p-3.5 text-left shadow-[var(--shadow-card)] transition-colors hover:border-forest-500 hover:bg-forest-50/50 disabled:opacity-60',
                        busy === a.username && 'border-forest-500',
                      )}
                    >
                      <Avatar name={a.displayName} size={38} tone={a.role === 'GUARD' ? 'gold' : 'forest'} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13.5px] font-semibold text-ink">{a.roleName}</span>
                        <span className="block text-xs text-ink-2">{a.displayName}</span>
                        {/* Own line, never truncated: the location is what tells same-role demo accounts apart. */}
                        {a.locationName && <span className="block text-xs font-medium text-forest-700">{a.locationName}</span>}
                        <span className="mt-1 block text-[11.5px] leading-snug text-ink-3">{ROLE_BLURB[a.role]}</span>
                      </span>
                      <ArrowRight className="mt-1 size-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-forest-700" aria-hidden />
                    </button>
                  ))}
                </div>
                {accounts.length > visible.length || showAll ? (
                  <button type="button" className="-mx-3 mt-1 inline-flex min-h-11 items-center rounded-lg px-3 text-[13px] font-medium text-forest-700 hover:text-forest-900" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? 'Show fewer demo accounts' : `Show all ${accounts.length} demo accounts (other locations)`}
                  </button>
                ) : null}
              </div>
            )}

            <form onSubmit={submit} className="rounded-2xl border border-line bg-white p-6 shadow-[var(--shadow-card)]">
              <div className="mb-5 flex items-center gap-2">
                <Lock className="size-4 text-gold-600" aria-hidden />
                <h2 className="text-base font-semibold">{config?.demo ? 'Or sign in with a username' : 'Sign in'}</h2>
              </div>
              <div className="grid gap-4">
                <Input label="Username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
                <Input label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                {error && <Notice tone="danger">{error}</Notice>}
                <Button type="submit" variant="primary" size="lg" loading={busy === 'form'}>
                  Sign in
                </Button>
              </div>
              {config?.demo && (
                <p className="mt-4 text-xs text-ink-3">
                  Demo accounts share the synthetic password <code className="rounded bg-canvas px-1 py-0.5 text-ink-2">SecureGate-Demo-2026</code>. Never use real credentials in this environment.
                </p>
              )}
            </form>
            {BROWSER_EDITION && host && (
              <div className="mt-4 text-center">
                <button
                  type="button"
                  className="inline-flex min-h-11 items-center rounded-lg px-3 text-[13px] font-medium text-forest-700 underline-offset-2 hover:text-forest-900 hover:underline"
                  onClick={() => {
                    setStartOverError(null);
                    setStartOverOpen(true);
                  }}
                >
                  Start over with fresh demo data
                </button>
              </div>
            )}
          </div>
        </section>
      </main>
      <Modal
        open={startOverOpen}
        onClose={() => !startingOver && setStartOverOpen(false)}
        size="sm"
        title="Start over with fresh demo data?"
        footer={
          <>
            <Button data-autofocus disabled={startingOver} onClick={() => setStartOverOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={startingOver} onClick={startOver}>
              Erase and start over
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">
          This erases the demo data saved in this browser, including anything you added or changed, and reloads the page with a freshly generated synthetic dataset.
        </p>
        {startOverError && (
          <Notice tone="danger" className="mt-3">
            {startOverError}
          </Notice>
        )}
      </Modal>
    </div>
  );
}
