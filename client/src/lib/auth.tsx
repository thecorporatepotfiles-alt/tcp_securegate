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
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [expiredReason, setExpiredReason] = useState<string | null>(null);
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
    await qc.invalidateQueries({ queryKey: ['me'] });
    await qc.refetchQueries({ queryKey: ['me'] });
  }, [qc]);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      qc.clear();
      qc.setQueryData(['me'], null);
      qc.invalidateQueries({ queryKey: ['config'] });
    }
  }, [qc]);

  const value = useMemo<AuthState>(() => {
    const perms = new Set(meQ.data?.permissions ?? []);
    return {
      config: configQ.data,
      me: meQ.data,
      loading: meQ.isLoading || configQ.isLoading,
      can: (...p: Permission[]) => p.some((x) => perms.has(x)),
      refresh,
      logout,
      expiredReason,
    };
  }, [configQ.data, meQ.data, meQ.isLoading, configQ.isLoading, refresh, logout, expiredReason]);

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
