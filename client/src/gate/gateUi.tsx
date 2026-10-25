import { forwardRef, useEffect, useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronLeft, Loader2 } from 'lucide-react';
import { cx } from '../components/ui';

/**
 * Dark, touch-first primitives for the gate interface. Targets are at least
 * 48px (size md; lg and xl are 56px and 64px) so they can be operated with
 * gloves or on a wall-mounted tablet.
 */

type Variant = 'gold' | 'solid' | 'ghost' | 'success' | 'danger' | 'info';

const VARIANT: Record<Variant, string> = {
  gold: 'bg-gold-400 text-forest-950 hover:bg-gold-300 active:bg-gold-500',
  solid: 'bg-white/[0.07] text-white border border-white/10 hover:bg-white/[0.12] active:bg-white/[0.16]',
  ghost: 'text-forest-200 hover:bg-white/[0.06] hover:text-white',
  success: 'bg-[#1f8a5f] text-white hover:bg-[#23a06e] active:bg-[#1b7a4b]',
  danger: 'bg-[#b02a2a] text-white hover:bg-[#c43333] active:bg-[#962222]',
  info: 'bg-[#2a5698] text-white hover:bg-[#3466b0] active:bg-[#244b85]',
};

export interface GateButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'md' | 'lg' | 'xl';
  loading?: boolean;
  icon?: ReactNode;
}

export const GateButton = forwardRef<HTMLButtonElement, GateButtonProps>(function GateButton(
  { variant = 'solid', size = 'lg', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2.5 rounded-xl font-semibold whitespace-nowrap transition-colors select-none disabled:cursor-not-allowed disabled:opacity-45',
        size === 'md' && 'min-h-12 px-4 text-[15px]',
        size === 'lg' && 'min-h-14 px-5 text-base',
        size === 'xl' && 'min-h-16 px-6 text-lg',
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-5 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export function GateCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-2xl border border-white/[0.08] bg-forest-900/80 p-4 sm:p-5', className)}>{children}</div>;
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-[13px] font-semibold tracking-[0.12em] text-forest-200/70 uppercase">{children}</h2>
      {action}
    </div>
  );
}

const FIELD = 'w-full rounded-xl border border-white/15 bg-forest-950/70 px-4 text-white placeholder:text-forest-200/60 focus:border-gold-400 focus:outline-none focus:ring-2 focus:ring-gold-400/30 disabled:opacity-50';

export function GateLabel({ htmlFor, children, required }: { htmlFor?: string; children: ReactNode; required?: boolean }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-forest-200">
      {children}
      {required && <span className="ml-0.5 text-gold-400">*</span>}
    </label>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string; big?: boolean };
export const GateInput = forwardRef<HTMLInputElement, InputProps>(function GateInput({ label, hint, big, className, id, required, ...rest }, ref) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <div>
      {label && (
        <GateLabel htmlFor={fid} required={required}>
          {label}
        </GateLabel>
      )}
      <input ref={ref} id={fid} required={required} className={cx(FIELD, big ? 'h-16 text-2xl font-semibold tracking-wide' : 'h-14 text-base', className)} {...rest} />
      {hint && <p className="mt-1 text-xs text-forest-200/60">{hint}</p>}
    </div>
  );
});

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { label?: string; options: { value: string | number; label: string }[]; placeholder?: string };
export function GateSelect({ label, options, placeholder, className, id, required, ...rest }: SelectProps) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <div>
      {label && (
        <GateLabel htmlFor={fid} required={required}>
          {label}
        </GateLabel>
      )}
      <select id={fid} required={required} className={cx(FIELD, 'h-14 text-base', className)} {...rest}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-forest-900">
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; hint?: string };
export function GateTextarea({ label, hint, className, id, required, rows = 3, ...rest }: TextareaProps) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <div>
      {label && (
        <GateLabel htmlFor={fid} required={required}>
          {label}
        </GateLabel>
      )}
      <textarea id={fid} rows={rows} required={required} className={cx(FIELD, 'py-3 text-base', className)} {...rest} />
      {hint && <p className="mt-1 text-xs text-forest-200/60">{hint}</p>}
    </div>
  );
}

export function GateError({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl border border-[#e66767]/40 bg-[#b02a2a]/20 px-4 py-3 text-[15px] text-white">
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-[#ff8a8a]" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function GateNote({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'gold' }) {
  return (
    <div className={cx('rounded-xl px-4 py-3 text-sm', tone === 'gold' ? 'border border-gold-400/30 bg-gold-400/10 text-gold-200' : 'border border-white/10 bg-white/[0.04] text-forest-200/80')}>
      {children}
    </div>
  );
}

/** Title bar with a large back button, used by every gate sub-screen. */
export function ScreenHeader({ title, subtitle, back = '/gate', backLabel = 'Home', right }: { title: ReactNode; subtitle?: ReactNode; back?: string; backLabel?: string; right?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-3">
      <Link
        to={back}
        className="inline-flex min-h-12 items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.05] pr-4 pl-3 text-[15px] font-semibold text-white hover:bg-white/[0.1]"
      >
        <ChevronLeft className="size-5" aria-hidden />
        {backLabel}
      </Link>
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">{title}</h1>
        {subtitle && <p className="text-sm text-forest-200/70">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

/** Seconds remaining until an ISO instant; re-renders every second. */
export function useSecondsLeft(iso: string | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [iso]);
  if (!iso) return null;
  return Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));
}

export function fmtCountdown(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function GateSpinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-forest-200/70" role="status">
      <Loader2 className="size-5 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function EmptyGate({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/15 px-5 py-10 text-center">
      <div className="text-base font-semibold text-white">{title}</div>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-forest-200/70">{children}</div>}
    </div>
  );
}
