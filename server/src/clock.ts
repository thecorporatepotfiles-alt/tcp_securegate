/**
 * Single source of server time. All authoritative timestamps come from here so
 * tests can move time forward deterministically (e.g. to expire passes).
 */
let override: (() => Date) | null = null;

export const clock = {
  now(): Date {
    return override ? override() : new Date();
  },
  nowIso(): string {
    return clock.now().toISOString();
  },
  nowMs(): number {
    return clock.now().getTime();
  },
  /** Test helper: freeze or drive the clock. */
  set(fn: (() => Date) | null): void {
    override = fn;
  },
  freeze(at: Date | string): void {
    const d = new Date(at);
    override = () => new Date(d.getTime());
  },
  advance(ms: number): void {
    const current = clock.now().getTime() + ms;
    override = () => new Date(current);
  },
};

export function addMinutes(iso: string | Date, minutes: number): string {
  const base = typeof iso === 'string' ? new Date(iso) : iso;
  return new Date(base.getTime() + minutes * 60_000).toISOString();
}
