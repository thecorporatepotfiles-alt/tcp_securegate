export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function daysLabel(mask?: string | null): string {
  if (!mask) return '—';
  if (mask === '1111111') return 'Every day';
  if (mask === '1111100') return 'Mon–Fri';
  if (mask === '1111110') return 'Mon–Sat';
  const d = WEEKDAYS.filter((_, i) => mask[i] === '1');
  return d.length ? d.join(', ') : 'No days';
}

export function hoursLabel(start?: string | null, end?: string | null, mask?: string | null): string {
  if (!start || !end) return '—';
  const window = start === '00:00' && end === '23:59' ? 'Any time' : `${start}–${end}`;
  return `${window} · ${daysLabel(mask)}`;
}

/** Split a datetime-local value ("YYYY-MM-DDTHH:MM") into date and time. */
export function splitLocal(v: string): [string, string] {
  const [d, t] = v.split('T');
  return [d, (t ?? '00:00').slice(0, 5)];
}

export function fieldErrors(err: unknown): Record<string, string> {
  const details = (err as { details?: { fields?: { path: string; message: string }[] } })?.details;
  if (!details?.fields) return {};
  return Object.fromEntries(details.fields.map((f) => [f.path, f.message]));
}
