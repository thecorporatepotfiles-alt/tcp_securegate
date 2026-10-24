let zone = 'Asia/Kolkata';
export function setTimezone(tz: string) {
  zone = tz;
}
export function timezone() {
  return zone;
}

const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(key: string, opts: Intl.DateTimeFormatOptions) {
  const k = `${zone}|${key}`;
  let f = cache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat('en-IN', { timeZone: zone, ...opts });
    cache.set(k, f);
  }
  return f;
}

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return fmt('dt', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

export function fmtTime(iso?: string | null): string {
  if (!iso) return '—';
  return fmt('t', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

export function fmtDate(value?: string | null): string {
  if (!value) return '—';
  // Plain calendar dates (YYYY-MM-DD) are shown without time-zone shifting.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
  }
  return fmt('d', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value));
}

export function fmtRelative(iso?: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const m = Math.round(abs / 60000);
  const suffix = diff >= 0 ? 'ago' : 'from now';
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ${suffix}`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ${suffix}`;
  const d = Math.round(h / 24);
  return `${d} d ${suffix}`;
}

/** Today's date (YYYY-MM-DD) in the establishment time zone. */
export function todayLocal(): string {
  const parts = fmt('ymd', { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Current HH:MM in the establishment time zone. */
export function nowLocalTime(offsetMinutes = 0): string {
  const parts = fmt('hm', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Date.now() + offsetMinutes * 60000));
  return `${parts.find((p) => p.type === 'hour')?.value}:${parts.find((p) => p.type === 'minute')?.value}`;
}

export function addDaysStr(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Convert a local date + HH:MM in the establishment zone to an ISO instant. */
export function zonedIso(date: string, time: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offset = (t: number) => {
    const p = fmt('off', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t));
    const g = (k: string) => Number(p.find((x) => x.type === k)?.value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - Math.floor(t / 60000) * 60000;
  };
  let t = guess - offset(guess);
  t = guess - offset(t);
  return new Date(t).toISOString();
}

export function compact(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}K`;
  return n.toLocaleString('en-IN');
}

export function titleCase(code?: string | null): string {
  if (!code) return '—';
  return code
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function initials(name?: string | null): string {
  if (!name) return '?';
  const parts = name
    .replace(/^(Sep|L\/Nk|Nk|Hav|Nb Sub|Sub|Lt Col|Lt|Capt|Maj|Col)\s+/i, '')
    .split(/\s+/)
    .filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}
