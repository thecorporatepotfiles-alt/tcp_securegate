import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { setTimezone } from './format';
import type { AppConfigInfo, Me } from './types';
import type { Permission } from '../../../shared/constants';

interface AuthState {
  config: AppConfigInfo | undefined;
  me: Me | null | undefined;
  loading: boolean;
  can: (...perms: Permission[]) => boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  expiredReason: string | null;
  /** True after an explicit sign-out, until a session is present again. */
  signedOut: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [expiredReason, setExpiredReason] = useState<string | null>(null);
  // Time of the last explicit sign-out: session data fetched before it belongs to the previous user and is hidden
  // in the same render as the navigation to sign-in. Data fetched afterwards (e.g. a sign-in in another tab) shows.
  const [signedOutAt, setSignedOutAt] = useState<number | null>(null);
  const configQ = useQuery({ queryKey: ['config'], queryFn: () => api.get<AppConfigInfo>('/config'), staleTime: 60_000 });
  const meQ = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<Me>('/auth/me');
      } catch {
        return null;
      }
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (configQ.data?.timezone) setTimezone(configQ.data.timezone);
  }, [configQ.data?.timezone]);

  useEffect(() => {
    const onUnauthorized = (e: Event) => {
      const code = (e as CustomEvent).detail as string;
      setExpiredReason(code === 'SESSION_EXPIRED' ? 'Your session expired. Please sign in again.' : code === 'ACCOUNT_DISABLED' ? 'This account has been disabled.' : null);
      qc.setQueryData(['me'], null);
    };
    window.addEventListener('sg:unauthorized', onUnauthorized);
    return () => window.removeEventListener('sg:unauthorized', onUnauthorized);
  }, [qc]);

  const refresh = useCallback(async () => {
    setExpiredReason(null);
    setSignedOutAt(null);
    await qc.invalidateQueries({ queryKey: ['me'] });
    await qc.refetchQueries({ queryKey: ['me'] });
  }, [qc]);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      // Clearing the cache alone left this provider's observers on the removed queries, so the old user stayed
      // visible and the sign-in page redirected straight back home. The state change also re-attaches them.
      setSignedOutAt(Date.now());
      qc.clear();
      qc.setQueryData(['me'], null);
      qc.invalidateQueries({ queryKey: ['config'] });
    }
  }, [qc]);

  const value = useMemo<AuthState>(() => {
    const me = signedOutAt !== null && meQ.dataUpdatedAt <= signedOutAt ? null : meQ.data;
    const perms = new Set(me?.permissions ?? []);
    return {
      config: configQ.data,
      me,
      loading: meQ.isLoading || configQ.isLoading,
      can: (...p: Permission[]) => p.some((x) => perms.has(x)),
      refresh,
      logout,
      expiredReason,
      signedOut: signedOutAt !== null && !me,
    };
  }, [configQ.data, meQ.data, meQ.dataUpdatedAt, meQ.isLoading, configQ.isLoading, refresh, logout, expiredReason, signedOutAt]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

/** Narrowed hook for pages rendered inside the authenticated shell. */
export function useMe(): Me {
  const { me } = useAuth();
  if (!me) throw new Error('useMe used without a session');
  return me;
}
