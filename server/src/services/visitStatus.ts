import type { DB } from '../db/connection.js';
import type { Actor } from '../auth/context.js';
import { clock } from '../clock.js';
import { unprocessable } from '../lib/errors.js';
import { canTransition, getSettings } from './settings.js';
import { VISIT_STATUS_INFO, type VisitStatus, type DeliveryStatus, DELIVERY_STATUS_INFO } from '../../../shared/constants.js';

export interface VisitRow {
  id: number;
  organization_id: number;
  reference: string;
  location_id: number;
  visitor_id: number;
  source: 'PRE_REGISTERED' | 'WALK_IN';
  host_user_id: number;
  approving_officer_id: number;
  created_by: number;
  purpose: string;
  destination: string;
  visit_date: string;
  expected_arrival: string;
  expected_departure: string;
  vehicle_id: number | null;
  status: VisitStatus;
  requires_security_check: number;
  security_checked_at: string | null;
  host_acknowledged_at: string | null;
  entered_at: string | null;
  exited_at: string | null;
}

/** Apply a server-validated visit status transition and record it in the status history. */
export function setVisitStatus(
  db: DB,
  actor: Actor | null,
  visit: VisitRow,
  to: VisitStatus,
  reason: string | null,
  extra: Record<string, string | number | null> = {},
): void {
  if (visit.status === to && Object.keys(extra).length === 0) return;
  if (visit.status !== to) {
    const transitions = getSettings(db, visit.organization_id)['visit.transitions'];
    if (!canTransition(transitions, visit.status, to)) {
      throw unprocessable(
        `A visit cannot move from ${VISIT_STATUS_INFO[visit.status].label} to ${VISIT_STATUS_INFO[to].label}`,
        'INVALID_TRANSITION',
        { from: visit.status, to },
      );
    }
  }
  const now = clock.nowIso();
  const cols = Object.keys(extra);
  const sets = ['status = ?', 'updated_at = ?', ...cols.map((c) => `${c} = ?`)];
  db.prepare(`UPDATE visits SET ${sets.join(', ')} WHERE id = ?`).run(to, now, ...cols.map((c) => extra[c]), visit.id);
  if (visit.status !== to) {
    db.prepare(
      'INSERT INTO visit_status_history (visit_id, from_status, to_status, reason, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(visit.id, visit.status, to, reason, actor?.userId ?? null, now);
  }
  visit.status = to;
}

export interface DeliveryRow {
  id: number;
  organization_id: number;
  reference: string;
  location_id: number;
  status: DeliveryStatus;
  recipient_user_id: number | null;
  sponsor_user_id: number | null;
  requires_authorization: number;
  courier_name: string;
  company: string;
  vehicle_id: number | null;
  arrived_at: string | null;
  authorized_at: string | null;
  received_at: string | null;
  departed_at: string | null;
}

export function setDeliveryStatus(
  db: DB,
  actor: Actor | null,
  d: DeliveryRow,
  to: DeliveryStatus,
  reason: string | null,
  extra: Record<string, string | number | null> = {},
): void {
  if (d.status !== to) {
    const transitions = getSettings(db, d.organization_id)['delivery.transitions'];
    if (!canTransition(transitions, d.status, to)) {
      throw unprocessable(
        `A delivery cannot move from ${DELIVERY_STATUS_INFO[d.status].label} to ${DELIVERY_STATUS_INFO[to].label}`,
        'INVALID_TRANSITION',
        { from: d.status, to },
      );
    }
  }
  const now = clock.nowIso();
  const cols = Object.keys(extra);
  db.prepare(`UPDATE deliveries SET ${['status = ?', 'updated_at = ?', ...cols.map((c) => `${c} = ?`)].join(', ')} WHERE id = ?`).run(
    to,
    now,
    ...cols.map((c) => extra[c]),
    d.id,
  );
  if (d.status !== to) {
    db.prepare(
      'INSERT INTO delivery_status_history (delivery_id, from_status, to_status, reason, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(d.id, d.status, to, reason, actor?.userId ?? null, now);
  }
  d.status = to;
}
