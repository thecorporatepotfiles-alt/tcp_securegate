import { z } from 'zod';
import type { Ctx } from '../auth/context.js';
import { requirePerm, scopeIds, sqlIn } from '../auth/context.js';
import { clock } from '../clock.js';
import { addDays, dateRangeToUtc, localDate, zonedToUtc } from '../lib/time.js';
import { parse, zDate } from '../lib/http.js';
import { REGISTER_SELECT } from './movement.js';
import { subjectLink } from './subjects.js';
import { DELIVERY_AWAITING_COMPLETION, REGISTER_CATEGORIES, VISIT_AWAITING_AUTHORIZATION, type SubjectType } from '../../../shared/constants.js';

const dashQuery = z.object({
  locationId: z.coerce.number().int().positive().optional(),
  gateId: z.coerce.number().int().positive().optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  category: z.enum(REGISTER_CATEGORIES).optional(),
});

const list = (xs: readonly string[]) => xs.map((s) => `'${s}'`).join(',');

function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  return entries.length ? `?${entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}` : '';
}

export function dashboardSummary(ctx: Ctx, raw: unknown) {
  requirePerm(ctx.actor, 'dashboard.view');
  const q = parse(dashQuery, raw);
  const { db, config } = ctx;
  const tz = config.timezone;
  const ids = scopeIds(ctx.actor, q.locationId);
  const today = localDate(clock.now(), tz);
  const from = q.from ?? today;
  const to = q.to ?? from;
  const [start, end] = dateRangeToUtc(from <= to ? from : to, to >= from ? to : from, tz);
  const loc = (col: string) => sqlIn(col, ids);
  const count = (sql: string, params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;
  const orgId = ctx.actor.orgId;
  const L = q.locationId;

  const presenceCount = (categories: string[]) => {
    const s = loc('location_id');
    return count(
      `SELECT COUNT(*) AS n FROM presence WHERE organization_id = ? AND state = 'INSIDE' AND ${s.sql} AND category IN (${list(categories)})${q.gateId ? ' AND gate_id = ?' : ''}`,
      [orgId, ...s.params, ...(q.gateId ? [q.gateId] : [])],
    );
  };
  const pLoc = loc('p.primary_location_id');
  const totalPersonnel = count(`SELECT COUNT(*) AS n FROM personnel p WHERE p.organization_id = ? AND ${pLoc.sql}`, [orgId, ...pLoc.params]);
  const activePersonnel = count(`SELECT COUNT(*) AS n FROM personnel p WHERE p.organization_id = ? AND p.status = 'ACTIVE' AND ${pLoc.sql}`, [orgId, ...pLoc.params]);
  const personnelOutside = count(
    `SELECT COUNT(*) AS n FROM personnel p WHERE p.organization_id = ? AND p.status = 'ACTIVE' AND ${pLoc.sql}
     AND NOT EXISTS (SELECT 1 FROM presence pr WHERE pr.subject_type = 'PERSONNEL' AND pr.subject_id = p.id AND pr.state = 'INSIDE')`,
    [orgId, ...pLoc.params],
  );
  const vLoc = loc('location_id');
  const visitsWhere = (cond: string) => count(`SELECT COUNT(*) AS n FROM visits WHERE organization_id = ? AND ${vLoc.sql} AND ${cond}`, [orgId, ...vLoc.params]);
  const failedLoc = loc('location_id');
  const failed = count(
    `SELECT COUNT(*) AS n FROM verification_attempts WHERE organization_id = ? AND ${failedLoc.sql} AND result_code <> 'VERIFIED' AND created_at >= ? AND created_at < ?${q.gateId ? ' AND gate_id = ?' : ''}`,
    [orgId, ...failedLoc.params, start, end, ...(q.gateId ? [q.gateId] : [])],
  );
  const exLoc = loc('location_id');
  const unresolvedExceptions = count(`SELECT COUNT(*) AS n FROM admin_exceptions WHERE organization_id = ? AND ${exLoc.sql} AND status <> 'RESOLVED'`, [orgId, ...exLoc.params]);
  const openAlerts = count(`SELECT COUNT(*) AS n FROM alerts WHERE organization_id = ? AND ${exLoc.sql} AND status = 'OPEN'`, [orgId, ...exLoc.params]);
  const pendingReviews = count(`SELECT COUNT(*) AS n FROM manual_reviews WHERE organization_id = ? AND ${exLoc.sql} AND status = 'PENDING'`, [orgId, ...exLoc.params]);
  const deliveriesOpen = count(
    `SELECT COUNT(*) AS n FROM deliveries WHERE organization_id = ? AND ${exLoc.sql} AND status IN (${list(DELIVERY_AWAITING_COMPLETION)})`,
    [orgId, ...exLoc.params],
  );

  const metric = (key: string, label: string, value: number, link: string, tone: string = 'neutral', hint?: string) => ({ key, label, value, link, tone, hint });
  const metrics = [
    metric('totalPersonnel', 'Total personnel records', totalPersonnel, `/personnel${qs({ locationId: L })}`, 'neutral', `${activePersonnel} active`),
    metric('personnelInside', 'Personnel inside', presenceCount(['PERSONNEL']), `/presence${qs({ category: 'PERSONNEL', locationId: L })}`, 'success'),
    metric('personnelOutside', 'Personnel outside', personnelOutside, `/presence${qs({ state: 'OUTSIDE', category: 'PERSONNEL', locationId: L })}`, 'neutral', 'Active, not recorded inside'),
    metric('visitorsInside', 'Visitors inside', presenceCount(['VISITOR']), `/presence${qs({ category: 'VISITOR', locationId: L })}`, 'success'),
    metric('contractorsInside', 'Contractors inside', presenceCount(['CONTRACTOR']), `/presence${qs({ category: 'CONTRACTOR', locationId: L })}`, 'success'),
    metric('vendorsInside', 'Vendors inside', presenceCount(['VENDOR']), `/presence${qs({ category: 'VENDOR', locationId: L })}`, 'success'),
    metric('serviceInside', 'Service personnel inside', presenceCount(['SERVICE']), `/presence${qs({ category: 'SERVICE', locationId: L })}`, 'success'),
    metric('temporaryInside', 'Temporary access holders inside', presenceCount(['TEMPORARY']), `/presence${qs({ category: 'TEMPORARY', locationId: L })}`, 'success'),
    metric('deliveryPersonnelInside', 'Delivery personnel inside', presenceCount(['DELIVERY']), `/presence${qs({ category: 'DELIVERY', locationId: L })}`, 'success'),
    metric('vehiclesInside', 'Vehicles inside', presenceCount(['VEHICLE']), `/presence${qs({ category: 'VEHICLE', locationId: L })}`, 'success'),
    metric(
      'visitorsAwaitingAuthorization',
      'Visitors awaiting authorization',
      visitsWhere(`status IN (${list(VISIT_AWAITING_AUTHORIZATION)})`),
      `/visitors${qs({ statusGroup: 'AWAITING_AUTHORIZATION', locationId: L })}`,
      'warning',
    ),
    metric('visitorsAwaitingHostAck', 'Awaiting host acknowledgement', visitsWhere("status = 'HOST_NOTIFIED'"), `/visitors${qs({ status: 'HOST_NOTIFIED', locationId: L })}`, 'warning'),
    metric('deliveriesAwaitingCompletion', 'Deliveries awaiting completion', deliveriesOpen, `/deliveries${qs({ statusGroup: 'AWAITING_COMPLETION', locationId: L })}`, 'warning'),
    metric('overdueVisits', 'Overdue visits', visitsWhere("status = 'OVERDUE'"), `/visitors${qs({ status: 'OVERDUE', locationId: L })}`, 'danger'),
    metric('failedVerifications', 'Failed verifications', failed, `/reports/denied-verifications${qs({ from, to, locationId: L, gateId: q.gateId })}`, 'danger', from === to ? from : `${from} – ${to}`),
    metric('unresolvedExceptions', 'Unresolved exceptions', unresolvedExceptions, `/exceptions${qs({ statusGroup: 'UNRESOLVED', locationId: L })}`, 'warning'),
    metric('openAlerts', 'Open alerts', openAlerts, `/alerts${qs({ status: 'OPEN', locationId: L })}`, 'danger'),
    metric('pendingManualReviews', 'Pending manual reviews', pendingReviews, `/manual-reviews${qs({ status: 'PENDING', locationId: L })}`, 'warning'),
  ];

  // ---- charts --------------------------------------------------------------
  const VALID = 'NOT EXISTS (SELECT 1 FROM event_corrections c WHERE c.voided_event_id = e.id)';
  // Conditions on events independent of location scope (used inside LEFT JOINs).
  const joinConds = ['e.recorded_at >= ?', 'e.recorded_at < ?', VALID];
  const joinParams: unknown[] = [start, end];
  if (q.gateId) {
    joinConds.push('e.gate_id = ?');
    joinParams.push(q.gateId);
  }
  if (q.category) {
    joinConds.push('e.category = ?');
    joinParams.push(q.category);
  }
  const joinSql = joinConds.join(' AND ');
  const evLoc = loc('e.location_id');
  const ew = `e.organization_id = ? AND ${evLoc.sql} AND ${joinSql}`;
  const evParams: unknown[] = [orgId, ...evLoc.params, ...joinParams];
  const offsetMinutes = Math.round((zonedToUtc(from, '12:00', tz).getTime() - Date.parse(`${from}T12:00:00Z`)) / -60000);
  const modifier = `${offsetMinutes >= 0 ? '+' : ''}${offsetMinutes} minutes`;
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000);
  const hourly = days <= 2;
  const bucketExpr = hourly ? `strftime('%Y-%m-%d %H:00', e.recorded_at, '${modifier}')` : `strftime('%Y-%m-%d', e.recorded_at, '${modifier}')`;
  const rawBuckets = db
    .prepare(
      `SELECT ${bucketExpr} AS bucket, SUM(CASE WHEN e.event_type = 'ENTRY' THEN 1 ELSE 0 END) AS entries,
              SUM(CASE WHEN e.event_type = 'EXIT' THEN 1 ELSE 0 END) AS exits
       FROM movement_events e WHERE ${ew} GROUP BY bucket ORDER BY bucket`,
    )
    .all(...evParams) as { bucket: string; entries: number; exits: number }[];
  const byBucket = new Map(rawBuckets.map((b) => [b.bucket, b]));
  const activity: { bucket: string; label: string; entries: number; exits: number }[] = [];
  if (hourly) {
    for (let d = from; d <= to; d = addDays(d, 1)) {
      for (let h = 0; h < 24; h++) {
        const key = `${d} ${String(h).padStart(2, '0')}:00`;
        const b = byBucket.get(key);
        activity.push({ bucket: key, label: from === to ? `${String(h).padStart(2, '0')}:00` : `${d.slice(5)} ${String(h).padStart(2, '0')}h`, entries: b?.entries ?? 0, exits: b?.exits ?? 0 });
      }
    }
  } else {
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const b = byBucket.get(d);
      activity.push({ bucket: d, label: d.slice(5), entries: b?.entries ?? 0, exits: b?.exits ?? 0 });
    }
  }

  const idScope = sqlIn('l.id', ids);
  const locationActivity = db
    .prepare(
      `SELECT l.id AS locationId, l.name AS name, l.code,
              COALESCE(SUM(CASE WHEN e.event_type = 'ENTRY' THEN 1 ELSE 0 END), 0) AS entries,
              COALESCE(SUM(CASE WHEN e.event_type = 'EXIT' THEN 1 ELSE 0 END), 0) AS exits
       FROM locations l LEFT JOIN movement_events e ON e.location_id = l.id AND ${joinSql}
       WHERE l.organization_id = ? AND ${idScope.sql}
       GROUP BY l.id ORDER BY CASE l.kind WHEN 'HQ' THEN 0 ELSE 1 END, l.name`,
    )
    .all(...joinParams, orgId, ...idScope.params) as Record<string, unknown>[];

  const gateScope = sqlIn('g.location_id', ids);
  const gateActivity = db
    .prepare(
      `SELECT g.id AS gateId, g.name AS name, l.name AS locationName,
              COALESCE(SUM(CASE WHEN e.event_type = 'ENTRY' THEN 1 ELSE 0 END), 0) AS entries,
              COALESCE(SUM(CASE WHEN e.event_type = 'EXIT' THEN 1 ELSE 0 END), 0) AS exits,
              (SELECT COUNT(*) FROM verification_attempts va WHERE va.gate_id = g.id AND va.result_code <> 'VERIFIED' AND va.created_at >= ? AND va.created_at < ?) AS failures
       FROM gates g JOIN locations l ON l.id = g.location_id
       LEFT JOIN movement_events e ON e.gate_id = g.id AND ${joinSql}
       WHERE l.organization_id = ? AND ${gateScope.sql}${q.gateId ? ' AND g.id = ?' : ''}
       GROUP BY g.id ORDER BY COUNT(e.id) DESC, g.name LIMIT 30`,
    )
    .all(start, end, ...joinParams, orgId, ...gateScope.params, ...(q.gateId ? [q.gateId] : [])) as Record<string, unknown>[];

  const visitStatus = db
    .prepare(`SELECT status, COUNT(*) AS count FROM visits WHERE organization_id = ? AND ${vLoc.sql} AND visit_date >= ? AND visit_date <= ? GROUP BY status ORDER BY count DESC`)
    .all(orgId, ...vLoc.params, from, to);
  const deliveryActivity = db
    .prepare(
      `SELECT status, COUNT(*) AS count FROM deliveries WHERE organization_id = ? AND ${exLoc.sql}
       AND COALESCE(arrived_at, expected_at, created_at) >= ? AND COALESCE(arrived_at, expected_at, created_at) < ? GROUP BY status ORDER BY count DESC`,
    )
    .all(orgId, ...exLoc.params, start, end);
  const verificationOutcomes = db
    .prepare(
      `SELECT result_code AS result, COUNT(*) AS count FROM verification_attempts WHERE organization_id = ? AND ${failedLoc.sql} AND created_at >= ? AND created_at < ?${q.gateId ? ' AND gate_id = ?' : ''}
       GROUP BY result_code ORDER BY count DESC`,
    )
    .all(orgId, ...failedLoc.params, start, end, ...(q.gateId ? [q.gateId] : []));

  const recentEvents = (db
    .prepare(`${REGISTER_SELECT} WHERE e.organization_id = ? AND ${evLoc.sql}${q.gateId ? ' AND e.gate_id = ?' : ''}${q.category ? ' AND e.category = ?' : ''} ORDER BY e.id DESC LIMIT 12`)
    .all(orgId, ...evLoc.params, ...(q.gateId ? [q.gateId] : []), ...(q.category ? [q.category] : [])) as Record<string, any>[]).map((r) => ({ ...r, link: subjectLink(r.subjectType as SubjectType, r.subjectId) }));

  const totals = activity.reduce((acc, b) => ({ entries: acc.entries + b.entries, exits: acc.exits + b.exits }), { entries: 0, exits: 0 });
  return {
    filters: { from, to, locationId: q.locationId ?? null, gateId: q.gateId ?? null, category: q.category ?? null },
    generatedAt: clock.nowIso(),
    timezone: tz,
    metrics,
    totals,
    charts: { activity, hourly, locationActivity, gateActivity, visitStatus, deliveryActivity, verificationOutcomes },
    recentEvents,
  };
}
