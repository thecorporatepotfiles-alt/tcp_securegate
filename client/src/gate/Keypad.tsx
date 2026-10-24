import { Delete } from 'lucide-react';
import { cx } from '../components/ui';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', '0', 'B', 'C', 'D', 'E', 'F', '-'];
const PREFIXES = ['RF-', 'NF-', 'TC-', 'CT-'];

/** On-screen keypad for credential numbers (hex UID style), sized for touch. */
export function Keypad({ value, onChange, onSubmit, disabled }: { value: string; onChange: (v: string) => void; onSubmit: () => void; disabled?: boolean }) {
  const key = 'flex min-h-14 items-center justify-center rounded-xl border border-white/10 bg-white/[0.06] text-xl font-semibold text-white transition-colors hover:bg-white/[0.12] active:bg-white/[0.18] disabled:opacity-40';
  return (
    <div className="space-y-2" aria-label="Credential keypad">
      <div className="grid grid-cols-4 gap-2">
        {PREFIXES.map((p) => (
          <button key={p} type="button" disabled={disabled} className={cx(key, 'min-h-12 text-base text-gold-300')} onClick={() => onChange(p)}>
            {p}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {KEYS.map((k) => (
          <button key={k} type="button" disabled={disabled} className={key} onClick={() => onChange((value + k).slice(0, 40))}>
            {k}
          </button>
        ))}
        <button type="button" disabled={disabled} className={key} onClick={() => onChange(value.slice(0, -1))} aria-label="Backspace">
          <Delete className="size-6" />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" disabled={disabled} className={cx(key, 'text-base')} onClick={() => onChange('')}>
          Clear
        </button>
        <button type="button" disabled={disabled || value.trim().length < 3} className={cx(key, 'border-gold-400 bg-gold-400 text-base text-forest-950 hover:bg-gold-300')} onClick={onSubmit}>
          Verify
        </button>
      </div>
    </div>
  );
}
