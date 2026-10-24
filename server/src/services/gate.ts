import type { Ctx } from '../auth/context.js';
import { can, requirePerm } from '../auth/context.js';
import { clock } from '../clock.js';
import { dateRangeToUtc, localDate } from '../lib/time.js';
import { REGISTER_SELECT } from './movement.js';
import { loadGate } from './verification.js';
import { subjectNameSql } from './subjects.js';

/** Counts and queues for the gate home screen. */
export function gateHome(ctx: Ctx, gateId: number) {
  requirePerm(ctx.actor, 'gate.operate');
  const gate = loadGate(ctx, gateId);
  const db = ctx.db;
  const tz = ctx.config.timezone;
  const today = localDate(clock.now(), tz);
  const [start, end] = dateRangeToUtc(today, today, tz);
  const n = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
  const inside = db
    .prepare("SELECT category, COUNT(*) AS n FROM presence WHERE location_id = ? AND state = 'INSIDE' GROUP BY category")
    .all(gate.location_id) as { category: string; n: number }[];
  return {
    gate: { id: gate.id, code: gate.code, name: gate.name, gateType: gate.gate_type, locationId: gate.location_id, locationName: gate.location_name },
    generatedAt: clock.nowIso(),
    insideByCategory: Object.fromEntries(inside.map((r) => [r.category, r.n])),
    counts: {
      eventsToday: n('SELECT COUNT(*) AS n FROM movement_events WHERE gate_id = ? AND recorded_at >= ? AND recorded_at < ?', gate.id, start, end),
      failuresToday: n("SELECT COUNT(*) AS n FROM verification_attempts WHERE gate_id = ? AND result_code <> 'VERIFIED' AND created_at >= ? AND created_at < ?", gate.id, start, end),
      visitorsWaiting: n("SELECT COUNT(*) AS n FROM visits WHERE location_id = ? AND status IN ('ARRIVED','HOST_NOTIFIED','WAITING')", gate.location_id),
      visitorsExpectedToday: n("SELECT COUNT(*) AS n FROM visits WHERE location_id = ? AND visit_date = ? AND status IN ('EXPECTED','APPROVED')", gate.location_id, today),
      deliveriesOpen: n("SELECT COUNT(*) AS n FROM deliveries WHERE location_id = ? AND status IN ('ARRIVED','AWAITING_AUTHORIZATION','AUTHORIZED','RECEIVED')", gate.location_id),
      openAlerts: can(ctx.actor, 'alerts.view') ? n("SELECT COUNT(*) AS n FROM alerts WHERE location_id = ? AND status = 'OPEN'", gate.location_id) : null,
      myPendingReviews: n("SELECT COUNT(*) AS n FROM manual_reviews WHERE requested_by = ? AND status = 'PENDING'", ctx.actor.userId),
      myApprovedReviews: n("SELECT COUNT(*) AS n FROM manual_reviews WHERE requested_by = ? AND status = 'APPROVED'", ctx.actor.userId),
    },
  };
}

export function gateRecent(ctx: Ctx, gateId: number) {
  requirePerm(ctx.actor, 'gate.operate');
  const gate = loadGate(ctx, gateId);
  const events = ctx.db.prepare(`${REGISTER_SELECT} WHERE e.gate_id = ? ORDER BY e.id DESC LIMIT 40`).all(gate.id);
  const attempts = ctx.db
    .prepare(
      `SELECT va.id, va.created_at AS createdAt, va.mode, va.method, va.result_code AS result, va.input_display AS inputDisplay,
              ${subjectNameSql('va')} AS subjectName, u.display_name AS operatorName,
              (SELECT reference FROM movement_events e WHERE e.verification_attempt_id = va.id) AS eventReference
       FROM verification_attempts va LEFT JOIN users u ON u.id = va.operator_user_id
       WHERE va.gate_id = ? ORDER BY va.id DESC LIMIT 40`,
    )
    .all(gate.id);
  return { events, attempts };
}
