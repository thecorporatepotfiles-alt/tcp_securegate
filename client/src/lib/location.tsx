import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from './auth';
import type { GateInfo, LocationInfo } from './types';

interface LocationState {
  /** Selected location filter; null means all authorized locations. */
  locationId: number | null;
  setLocationId: (id: number | null) => void;
  locations: LocationInfo[];
  location: LocationInfo | null;
  allowAll: boolean;
  gates: GateInfo[];
  locationName: (id?: number | null) => string;
}

const Ctx = createContext<LocationState | null>(null);
const KEY = 'sg.location';

function readStored(): number | null {
  try {
    const v = localStorage.getItem(KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

export function LocationProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const locations = useMemo(() => me?.locations ?? [], [me]);
  const allowAll = locations.length > 1;
  const [locationId, setLocationIdState] = useState<number | null>(() => readStored());

  useEffect(() => {
    if (!me) return;
    const valid = locationId != null && locations.some((l) => l.id === locationId);
    if (!valid) {
      const fallback = allowAll ? null : (locations[0]?.id ?? null);
      if (fallback !== locationId) setLocationIdState(fallback);
    }
  }, [me, locations, locationId, allowAll]);

  const value = useMemo<LocationState>(() => {
    const location = locations.find((l) => l.id === locationId) ?? null;
    return {
      locationId,
      setLocationId: (id) => {
        setLocationIdState(id);
        try {
          if (id == null) localStorage.removeItem(KEY);
          else localStorage.setItem(KEY, String(id));
        } catch {
          /* storage unavailable */
        }
      },
      locations,
      location,
      allowAll,
      gates: location ? location.gates : locations.flatMap((l) => l.gates),
      locationName: (id) => locations.find((l) => l.id === id)?.name ?? '—',
    };
  }, [locationId, locations, allowAll]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLocationScope(): LocationState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLocationScope outside LocationProvider');
  return v;
}
