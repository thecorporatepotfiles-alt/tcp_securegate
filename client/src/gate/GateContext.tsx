import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import type { GateInfo, LocationInfo } from '../lib/types';

interface GateState {
  gateId: number | null;
  gate: (GateInfo & { locationName: string }) | null;
  setGateId: (id: number) => void;
  /** All gates the operator may work at, grouped by location. */
  locations: LocationInfo[];
}

const Ctx = createContext<GateState | null>(null);
const KEY = 'sg.gate';

function stored(): number | null {
  try {
    const v = localStorage.getItem(KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

export function GateProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const locations = useMemo(() => (me?.locations ?? []).filter((l) => l.gates.length > 0), [me]);
  const allGates = useMemo(() => locations.flatMap((l) => l.gates.map((g) => ({ ...g, locationName: l.name }))), [locations]);
  const [gateId, setGateIdState] = useState<number | null>(() => stored());

  useEffect(() => {
    if (!me) return;
    if (gateId != null && allGates.some((g) => g.id === gateId)) return;
    const assigned = me.user.assignedGateId;
    const fallback = allGates.find((g) => g.id === assigned)?.id ?? allGates[0]?.id ?? null;
    if (fallback !== gateId) setGateIdState(fallback);
  }, [me, allGates, gateId]);

  const value = useMemo<GateState>(
    () => ({
      gateId,
      gate: allGates.find((g) => g.id === gateId) ?? null,
      locations,
      setGateId: (id) => {
        setGateIdState(id);
        try {
          localStorage.setItem(KEY, String(id));
        } catch {
          /* storage unavailable — selection lasts for this page only */
        }
      },
    }),
    [gateId, allGates, locations],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useGate(): GateState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useGate outside GateProvider');
  return v;
}

/** Gate id that is guaranteed to be set (screens render only once a gate is selected). */
export function useGateId(): number {
  const { gateId } = useGate();
  if (gateId == null) throw new Error('No gate selected');
  return gateId;
}
