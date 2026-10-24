import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LayoutDashboard, LogOut, Repeat2 } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { fmtTime, todayLocal, fmtDate } from '../lib/format';
import { LogoMark } from '../components/Logo';
import { SimulatedTag } from '../components/status';
import { useGate } from './GateContext';

function Clock() {
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date().toISOString()), 15_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="text-right leading-tight" aria-label="Current time">
      <div className="text-xl font-semibold text-white tabular-nums">{fmtTime(now)}</div>
      <div className="text-[11px] text-forest-200/60">{fmtDate(todayLocal())}</div>
    </div>
  );
}

export function GateHeader() {
  const { me, can, logout } = useAuth();
  const { gateId, setGateId, locations } = useGate();
  const navigate = useNavigate();
  return (
    <header className="relative z-30 border-b sm:sticky sm:top-0 border-white/10 bg-forest-950/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <Link to="/gate" className="flex items-center gap-2.5" aria-label="Gate home">
          <LogoMark size={36} />
          <div className="leading-tight">
            <div className="text-[10px] font-semibold tracking-[0.16em] text-gold-400 uppercase">SecureGate</div>
            <div className="text-[15px] font-semibold text-white">Gate interface</div>
          </div>
        </Link>
        <label className="order-3 flex w-full items-center gap-2 sm:order-none sm:w-auto">
          <span className="sr-only">Gate</span>
          <select
            value={gateId ?? ''}
            onChange={(e) => setGateId(Number(e.target.value))}
            className="h-12 w-full min-w-0 rounded-xl border border-gold-400/40 bg-forest-900 px-3 text-[15px] font-semibold text-white focus:border-gold-400 focus:outline-none sm:w-auto sm:max-w-[320px]"
          >
            {locations.map((l) => (
              <optgroup key={l.id} label={l.name}>
                {l.gates.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <div className="hidden md:block">
          <SimulatedTag>Simulated verification</SimulatedTag>
        </div>
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <Clock />
          <div className="hidden text-right leading-tight lg:block">
            <div className="text-sm font-semibold text-white">{me?.user.displayName}</div>
            <div className="text-[11px] text-forest-200/60">{me?.user.roleName}</div>
          </div>
          {can('handover.manage') && (
            <Link to="/handover" className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-white/10 px-3 text-sm font-medium text-forest-200 hover:bg-white/[0.06] hover:text-white" title="Shift handover">
              <Repeat2 className="size-4" aria-hidden />
              <span className="hidden sm:inline">Handover</span>
            </Link>
          )}
          {can('dashboard.view') && (
            <Link to="/dashboard" className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-white/10 px-3 text-sm font-medium text-forest-200 hover:bg-white/[0.06] hover:text-white" title="Management">
              <LayoutDashboard className="size-4" aria-hidden />
              <span className="hidden sm:inline">Management</span>
            </Link>
          )}
          <button
            type="button"
            onClick={async () => {
              await logout();
              navigate('/login');
            }}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-white/10 px-3 text-sm font-medium text-forest-200 hover:bg-[#b02a2a]/30 hover:text-white"
          >
            <LogOut className="size-4" aria-hidden />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </div>
      <div className="px-4 pb-2 md:hidden">
        <SimulatedTag>Simulated verification</SimulatedTag>
      </div>
    </header>
  );
}
