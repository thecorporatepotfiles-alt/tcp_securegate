import type { DB } from '../db/connection.js';
import { clock } from '../clock.js';

/**
 * Human-readable, sequential reference numbers per organization, prefix and
 * year, e.g. VR-2026-00042. Must be called inside the caller's transaction.
 */
export function nextRef(db: DB, orgId: number, prefix: string): string {
  const year = clock.now().getUTCFullYear();
  const row = db
    .prepare(
      `INSERT INTO ref_sequences (organization_id, prefix, year, last_value) VALUES (?, ?, ?, 1)
       ON CONFLICT (organization_id, prefix, year) DO UPDATE SET last_value = last_value + 1
       RETURNING last_value`,
    )
    .get(orgId, prefix, year) as { last_value: number };
  const width = prefix === 'EV' || prefix === 'VA' ? 7 : 5;
  return `${prefix}-${year}-${String(row.last_value).padStart(width, '0')}`;
}

export const REF = {
  VISIT: 'VR',
  PASS: 'VP',
  DELIVERY: 'DL',
  CONTRACTOR: 'CW',
  TEMP: 'TA',
  EVENT: 'EV',
  CORRECTION: 'EC',
  ALERT: 'AL',
  EXCEPTION: 'EX',
  HANDOVER: 'HO',
  REVIEW: 'MR',
} as const;
