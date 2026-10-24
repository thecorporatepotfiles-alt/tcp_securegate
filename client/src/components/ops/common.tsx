import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cx } from '../ui';

/** Link that does not trigger the surrounding table-row navigation. */
export function InlineLink({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <Link to={to} onClick={(e) => e.stopPropagation()} className={cx('font-medium text-ink hover:text-forest-700 hover:underline', className)}>
      {children}
    </Link>
  );
}

export function holderLink(holderType: string, personnelId?: number | null, contractorId?: number | null): string | null {
  if (holderType === 'PERSONNEL' && personnelId) return `/personnel/${personnelId}`;
  if (holderType === 'CONTRACTOR' && contractorId) return `/contractors/people/${contractorId}`;
  return null;
}

/** Map server field errors (zod issues) into a { path: message } record. */
export function fieldErrors(err: unknown): Record<string, string> {
  const details = (err as { details?: { fields?: { path: string; message: string }[] } })?.details;
  if (!details?.fields) return {};
  return Object.fromEntries(details.fields.map((f) => [f.path, f.message]));
}

/** Convert an ISO instant into the value format of <input type="datetime-local"> in the browser's zone. */
export function toLocalInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SectionNote({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-ink-3">{children}</p>;
}

/** Client-side route for a related record referenced by an alert or exception. */
export function relatedLink(type?: string | null, id?: number | null): string | null {
  if (!type || !id) return null;
  switch (type.toUpperCase()) {
    case 'PERSONNEL':
      return `/personnel/${id}`;
    case 'VISITOR':
    case 'VISIT':
      return `/visitors/${id}`;
    case 'CONTRACTOR':
      return `/contractors/people/${id}`;
    case 'TEMPORARY':
      return `/temporary-access/${id}`;
    case 'DELIVERY':
      return `/deliveries/${id}`;
    case 'VEHICLE':
      return `/vehicles/${id}`;
    case 'ADMIN_EXCEPTION':
      return `/exceptions/${id}`;
    case 'EVENT':
      return `/events/${id}`;
    default:
      return null;
  }
}
