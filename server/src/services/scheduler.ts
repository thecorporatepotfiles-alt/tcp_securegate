import type { DB } from '../db/connection.js';
import type { AppConfig } from '../config.js';
import { clock } from '../clock.js';
import { localDate } from '../lib/time.js';
import { systemActor } from '../auth/context.js';
import { writeAudit } from './audit.js';
import { raiseAlert } from './alerts.js';
import { getSettings } from './settings.js';
import { setVisitStatus, type VisitRow } from './visitStatus.js';
import { notify } from './notifications.js';

export interface CheckResult {
  expiredVisits: number;
  overdueVisits: number;
  unclosedVisitAlerts: number;
  deliveryAckAlerts: number;
  unresolvedExceptionAlerts: number;
  expiredCredentials: number;
  expiredReviews: number;
}

/**
 * Time-based rules. Runs periodically and on demand. Every change is recorded
 * as a system action in the relevant history and audit trail.
 */
export function runScheduledChecks(db: DB, config: AppConfig): CheckResult {
  const result: CheckResult = {
    expiredVisits: 0,
    overdueVisits: 0,
    unclosedVisitAlerts: 0,
    deliveryAckAlerts: 0,
    unresolvedExceptionAlerts: 0,
    expiredCredentials: 0,
    expiredReviews: 0,
  };
  const orgs = db.prepare('SELECT id FROM organizations').all() as { id: number }[];
  for (const { id: orgId } of orgs) {
    db.transaction(() => {
      const actor = systemActor(db, orgId);
      const settings = getSettings(db, orgId);
      const now = clock.now();
      const nowIso = now.toISOString();
      const today = localDate(now, config.timezone);

      // 1. Visits whose window passed without entry → EXPIRED; their passes expire.
      const graceMs = settings['visit.passGraceMinutes'] * 60_000;
      const stale = db
        .prepare(
          `SELECT * FROM visits WHERE organization_id = ? AND status IN ('EXPECTED','ARRIVED','HOST_NOTIFIED','WAITING','APPROVED')
           AND expected_departure < ?`,
        )
        .all(orgId, new Date(now.getTime() - graceMs).toISOString()) as VisitRow[];
      for (const v of stale) {
        setVisitStatus(db, actor, v, 'EXPIRED', 'Validity window passed without a recorded entry');
        db.prepare("UPDATE visit_passes SET status = 'EXPIRED' WHERE visit_id = ? AND status = 'ACTIVE'").run(v.id);
        writeAudit(db, actor, { action: 'visit.expire', entityType: 'visit', entityId: v.id, entityRef: v.reference, locationId: v.location_id });
        result.expiredVisits++;
      }

      // 2. Visitors inside beyond expected departure + grace → OVERDUE + alert.
      const overdueBefore = new Date(now.getTime() - settings['visit.overstayGraceMinutes'] * 60_000).toISOString();
      const overdue = db
        .prepare("SELECT v.*, vr.full_name AS visitor_name FROM visits v JOIN visitors vr ON vr.id = v.visitor_id WHERE v.organization_id = ? AND v.status = 'INSIDE' AND v.expected_departure < ?")
        .all(orgId, overdueBefore) as (VisitRow & { visitor_name: string })[];
      for (const v of overdue) {
        setVisitStatus(db, actor, v, 'OVERDUE', 'Inside beyond expected departure');
        raiseAlert(db, actor, {
          orgId,
          locationId: v.location_id,
          type: 'VISITOR_OVERSTAY',
          description: `${v.visitor_name} (${v.reference}) is recorded inside beyond the expected departure.`,
          relatedType: 'VISITOR',
          relatedId: v.id,
          relatedReference: v.reference,
          dedupeKey: `OVERSTAY:${v.id}`,
          repeatWhileOpen: false,
        });
        notify(db, {
          orgId,
          userIds: [v.host_user_id],
          locationId: v.location_id,
          type: 'VISITOR_OVERDUE',
          title: `${v.visitor_name} is overdue`,
          body: `Visit ${v.reference} has passed its expected departure. Please follow up.`,
          link: `/visitors/${v.id}`,
          relatedType: 'visit',
          relatedId: v.id,
        });
        result.overdueVisits++;
      }

      // 3. Visits still open after their visit date → unclosed visit alert.
      const unclosed = db
        .prepare("SELECT v.id, v.reference, v.location_id FROM visits v WHERE v.organization_id = ? AND v.status IN ('INSIDE','OVERDUE') AND v.visit_date < ?")
        .all(orgId, today) as { id: number; reference: string; location_id: number }[];
      for (const v of unclosed) {
        const r = raiseAlert(db, actor, {
          orgId,
          locationId: v.location_id,
          type: 'UNCLOSED_VISIT',
          description: `Visit ${v.reference} remains open after its visit date; no exit has been recorded.`,
          relatedType: 'VISITOR',
          relatedId: v.id,
          relatedReference: v.reference,
          dedupeKey: `UNCLOSED:${v.id}`,
          repeatWhileOpen: false,
        });
        if (r && !r.merged) result.unclosedVisitAlerts++;
      }

      // 4. Authorized deliveries without receipt acknowledgement.
      const ackBefore = new Date(now.getTime() - settings['delivery.ackOverdueHours'] * 3_600_000).toISOString();
      const pendingAck = db
        .prepare("SELECT id, reference, location_id, company FROM deliveries WHERE organization_id = ? AND status = 'AUTHORIZED' AND COALESCE(authorized_at, arrived_at) < ?")
        .all(orgId, ackBefore) as { id: number; reference: string; location_id: number; company: string }[];
      for (const d of pendingAck) {
        const r = raiseAlert(db, actor, {
          orgId,
          locationId: d.location_id,
          type: 'INCOMPLETE_DELIVERY_ACK',
          description: `Delivery ${d.reference} (${d.company}) was authorized more than ${settings['delivery.ackOverdueHours']}h ago without receipt acknowledgement.`,
          relatedType: 'DELIVERY',
          relatedId: d.id,
          relatedReference: d.reference,
          dedupeKey: `DELIVERYACK:${d.id}`,
          repeatWhileOpen: false,
        });
        if (r && !r.merged) result.deliveryAckAlerts++;
      }

      // 5. Administrative exceptions unresolved beyond the configured time.
      const exBefore = new Date(now.getTime() - settings['exceptions.unresolvedHours'] * 3_600_000).toISOString();
      const oldEx = db
        .prepare("SELECT id, reference, location_id, title FROM admin_exceptions WHERE organization_id = ? AND status <> 'RESOLVED' AND created_at < ?")
        .all(orgId, exBefore) as { id: number; reference: string; location_id: number; title: string }[];
      for (const x of oldEx) {
        const r = raiseAlert(db, actor, {
          orgId,
          locationId: x.location_id,
          type: 'UNRESOLVED_ADMIN_RECORD',
          description: `Administrative exception ${x.reference} ("${x.title}") has been unresolved for over ${settings['exceptions.unresolvedHours']}h.`,
          relatedType: 'admin_exception',
          relatedId: x.id,
          relatedReference: x.reference,
          dedupeKey: `UNRESOLVED:${x.id}`,
          repeatWhileOpen: false,
        });
        if (r && !r.merged) result.unresolvedExceptionAlerts++;
      }

      // 6. Credentials past their validity → EXPIRED with history.
      const expiredCreds = db
        .prepare("SELECT id, status FROM credentials WHERE organization_id = ? AND status = 'ACTIVE' AND valid_until IS NOT NULL AND valid_until <= ?")
        .all(orgId, nowIso) as { id: number; status: string }[];
      for (const c of expiredCreds) {
        db.prepare("UPDATE credentials SET status = 'EXPIRED', status_reason = 'Validity period ended', updated_at = ? WHERE id = ?").run(nowIso, c.id);
        db.prepare("INSERT INTO credential_history (credential_id, action, from_status, to_status, reason, actor_user_id, created_at) VALUES (?, 'EXPIRED', 'ACTIVE', 'EXPIRED', 'Validity period ended', NULL, ?)").run(c.id, nowIso);
        result.expiredCredentials++;
      }
      if (expiredCreds.length) writeAudit(db, actor, { action: 'credential.expire', entityType: 'credential', metadata: { count: expiredCreds.length } });

      // 7. Approved manual reviews not used within their validity.
      const reviewBefore = new Date(now.getTime() - settings['gate.manualReviewValidityMinutes'] * 60_000).toISOString();
      result.expiredReviews += db
        .prepare("UPDATE manual_reviews SET status = 'EXPIRED', updated_at = ? WHERE organization_id = ? AND status = 'APPROVED' AND decided_at < ?")
        .run(nowIso, orgId, reviewBefore).changes;
    })();
  }
  return result;
}

export function startScheduler(db: DB, config: AppConfig): () => void {
  const tick = () => {
    try {
      runScheduledChecks(db, config);
    } catch (err) {
      console.error('[scheduler] check failed', err);
    }
  };
  tick();
  const handle = setInterval(tick, config.schedulerIntervalSeconds * 1000);
  handle.unref();
  return () => clearInterval(handle);
}
