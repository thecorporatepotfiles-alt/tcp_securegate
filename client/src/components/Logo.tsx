export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden>
      <rect width="64" height="64" rx="14" fill="#173226" />
      <path d="M32 10 50 17v14c0 11.5-7.6 19.6-18 23-10.4-3.4-18-11.5-18-23V17z" fill="none" stroke="#cba35a" strokeWidth="3.5" strokeLinejoin="round" />
      <path d="M24 44V30h16v14" fill="none" stroke="#cba35a" strokeWidth="3.5" strokeLinejoin="round" />
      <path d="M32 30v14" stroke="#cba35a" strokeWidth="2.5" />
    </svg>
  );
}

export function Wordmark({ light = true }: { light?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <LogoMark size={34} />
      <div className="leading-tight">
        <div className={light ? 'text-[11px] font-semibold tracking-[0.16em] text-gold-400 uppercase' : 'text-[11px] font-semibold tracking-[0.16em] text-gold-600 uppercase'}>The Corporate Pot</div>
        <div className={light ? 'text-[17px] font-semibold tracking-tight text-white' : 'text-[17px] font-semibold tracking-tight text-ink'}>SecureGate</div>
      </div>
    </div>
  );
}
