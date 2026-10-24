import { z } from 'zod';
import type { Ctx } from '../auth/context.js';
import { assertInScope, can, requirePerm, scopeIds, sqlIn } from '../auth/context.js';
import { clock } from '../clock.js';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors.js';
import { likeParam, listQuery, orderBy, parse, zOptText, zText, type Page } from '../lib/http.js';
import { nextRef, REF } from '../lib/refs.js';
import { audit } from './audit.js';
import { notify } from './notifications.js';
import { loadGate } from './verification.js';
import { userAtLocation } from './userScope.js';
import {
  DELIVERY_AWAITING_COMPLETION,
  EXCEPTION_CATEGORIES,
  EXCEPTION_STATUSES,
  EXCEPTION_TRANSITIONS,
  ROLES,
  VISIT_AWAITING_AUTHORIZATION,
  type ExceptionStatus,
} from '../../../shared/constants.js';

const EX_SELECT = `SELECT x.id, x.reference, x.location_id AS locationId, l.name AS locationName, x.category, x.related_type AS relatedType,
    x.related_id AS relatedId, x.related_reference AS relatedReference, x.title, x.description, x.responsible_role AS responsibleRole,
    x.responsible_user_id AS responsibleUserId, ru.display_name AS responsibleUserName, x.status, x.created_at AS createdAt,
    cu.display_name AS createdBy, x.updated_at AS updatedAt, x.resolution_note AS resolutionNote, x.resolved_at AS resolvedAt,
    rs.display_name AS resolvedBy
  FROM admin_exceptions x
  JOIN locations l ON l.id = x.location_id
  LEFT JOIN users ru ON ru.id = x.responsible_user_id
  LEFT JOIN users cu ON cu.id = x.created_by
  LEFT JOIN users rs ON rs.id = x.resolved_by`;

const exListQuery = listQuery.extend({
  status: z.enum(EXCEPTION_STATUSES).optional(),
  statusGroup: z.enum(['UNRESOLVED']).optional(),
  category: z.enum(EXCEPTION_CATEGORIES).optional(),
  mine: z.coerce.boolean().optional(),
});

export function listExceptions(ctx: Ctx, raw: unknown): Page<Record<string, unknown>> {
  requirePerm(ctx.actor, 'exceptions.view');
  const q = parse(exListQuery, raw);
  const scope = sqlIn('x.location_id', scopeIds(ctx.actor, q.locationId));
  const where = [scope.sql, 'x.organization_id = ?'];
  const params: unknown[] = [...scope.params, ctx.actor.orgId];
  if (q.status) {
    where.push('x.status = ?');
    params.push(q.status);
  }
  if (q.statusGroup === 'UNRESOLVED') where.push("x.status <> 'RESOLVED'");
  if (q.category) {
    where.push('x.category = ?');
    params.push(q.category);
  }
  if (q.mine) {
    where.push('(x.responsible_user_id = ? OR x.responsible_role = ?)');
    params.push(ctx.actor.userId, ctx.actor.role);
  }
  if (q.q) {
    const like = likeParam(q.q);
    where.push("(x.reference LIKE ? ESCAPE '\\' OR x.title LIKE ? ESCAPE '\\' OR x.description LIKE ? ESCAPE '\\' OR x.related_reference LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  const whereSql = where.join(' AND ');
  const order = orderBy(q.sort, q.dir, { createdAt: 'x.created_at', status: 'x.status', category: 'x.category' }, "CASE x.status WHEN 'OPEN' THEN 0 WHEN 'UNDER_REVIEW' THEN 1 ELSE 2 END, x.created_at DESC");
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM admin_exceptions x WHERE ${whereSql}`).get(...params) as { n: number }).n;
  const items = ctx.db
    .prepare(`${EX_SELECT} WHERE ${whereSql} ORDER BY ${order}, x.id DESC LIMIT ? OFFSET ?`)
    .all(...params, q.pageSize, (q.page - 1) * q.pageSize) as Record<string, unknown>[];
  return { items, total, page: q.page, pageSize: q.pageSize };
}

function loadException(ctx: Ctx, id: number) {
  const x = ctx.db.prepare(`${EX_SELECT} WHERE x.id = ? AND x.organization_id = ?`).get(id, ctx.actor.orgId) as Record<string, any> | undefined;
  if (!x) throw notFound('Exception');
  assertInScope(ctx.actor, x.locationId, 'Exception');
  return x;
}

export function getException(ctx: Ctx, id: number) {
  requirePerm(ctx.actor, 'exceptions.view');
  const x = loadException(ctx, id);
  const history = ctx.db
    .prepare(
      `SELECT h.from_status AS fromStatus, h.to_status AS toStatus, h.note, h.created_at AS createdAt, COALESCE(u.display_name, 'System') AS actor
       FROM admin_exception_history h LEFT JOIN users u ON u.id = h.actor_user_id WHERE h.exception_id = ? ORDER BY h.id`,
    )
    .all(id);
  return { ...x, history, canManage: can(ctx.actor, 'exceptions.manage') };
}

const createSchema = z.object({
  locationId: z.coerce.number().int().positive(),
  category: z.enum(EXCEPTION_CATEGORIES),
  title: zText(160),
  description: zText(2000),
  relatedType: zOptText(40),
  relatedId: z.coerce.number().int().positive().optional().nullable(),
  relatedReference: zOptText(60),
  responsibleRole: z.enum(ROLES).optional().nullable(),
  responsibleUserId: z.coerce.number().int().positive().optional().nullable(),
});

export function createException(ctx: Ctx, body: unknown) {
  requirePerm(ctx.actor, 'exceptions.manage');
  const input = parse(createSchema, body);
  assertInScope(ctx.actor, input.locationId, 'Location');
  if (input.responsibleUserId && !userAtLocation(ctx.db, ctx.actor.orgId, input.responsibleUserId, input.locationId)) {
    throw badRequest('Responsible user must be an active user at this location');
  }
  return ctx.db.transaction(() => {
    const reference = nextRef(ctx.db, ctx.actor.orgId, REF.EXCEPTION);
    const now = clock.nowIso();
    const info = ctx.db
      .prepare(
        `INSERT INTO admin_exceptions (organization_id, reference, location_id, category, related_type, related_id, related_reference, title, description,
           responsible_role, responsible_user_id, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)`,
      )
      .run(
        ctx.actor.orgId,
        reference,
        input.locationId,
        input.category,
        input.relatedType,
        input.relatedId ?? null,
        input.relatedReference,
        input.title,
        input.description,
        input.responsibleRole ?? null,
        input.responsibleUserId ?? null,
        ctx.actor.userId,
        now,
        now,
      );
    const id = Number(info.lastInsertRowid);
    ctx.db.prepare("INSERT INTO admin_exception_history (exception_id, from_status, to_status, note, actor_user_id, created_at) VALUES (?, NULL, 'OPEN', 'Created', ?, ?)").run(id, ctx.actor.userId, now);
    if (input.responsibleUserId && input.responsibleUserId !== ctx.actor.userId) {
      notify(ctx.db, {
        orgId: ctx.actor.orgId,
        userIds: [input.responsibleUserId],
        locationId: input.locationId,
        type: 'EXCEPTION_ASSIGNED',
        title: `Administrative exception ${reference} assigned to you`,
        body: input.title,
        link: `/exceptions/${id}`,
        relatedType: 'exception',
        relatedId: id,
      });
    }
    audit(ctx, { action: 'exception.create', entityType: 'admin_exception', entityId: id, entityRef: reference, locationId: input.locationId, metadata: { category: input.category } });
    return getException(ctx, id);
  })();
}

const statusSchema = z.object({
  status: z.enum(EXCEPTION_STATUSES),
  note: z.string().trim().max(2000).optional(),
});

export function changeExceptionStatus(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'exceptions.manage');
  const input = parse(statusSchema, body);
  return ctx.db.transaction(() => {
    const x = loadException(ctx, id);
    const from = x.status as ExceptionStatus;
    if (!EXCEPTION_TRANSITIONS[from].includes(input.status)) throw unprocessable(`Cannot move from ${from} to ${input.status}.`, 'INVALID_TRANSITION');
    if (input.status === 'RESOLVED' && (!input.note || input.note.length < 5)) throw badRequest('A resolution note (min 5 characters) is required');
    const now = clock.nowIso();
    if (input.status === 'RESOLVED') {
      ctx.db
        .prepare("UPDATE admin_exceptions SET status = 'RESOLVED', resolution_note = ?, resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?")
        .run(input.note, ctx.actor.userId, now, now, id);
    } else {
      ctx.db.prepare('UPDATE admin_exceptions SET status = ?, updated_at = ? WHERE id = ?').run(input.status, now, id);
    }
    ctx.db.prepare('INSERT INTO admin_exception_history (exception_id, from_status, to_status, note, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      from,
      input.status,
      input.note ?? null,
      ctx.actor.userId,
      now,
    );
    audit(ctx, {
      action: input.status === 'RESOLVED' ? 'exception.resolve' : 'exception.status',
      entityType: 'admin_exception',
      entityId: id,
      entityRef: x.reference,
      locationId: x.locationId,
      metadata: { from, to: input.status, note: input.note },
    });
    return getException(ctx, id);
  })();
}

const assignSchema = z.object({
  responsibleRole: z.enum(ROLES).optional().nullable(),
  responsibleUserId: z.coerce.number().int().positive().optional().nullable(),
});

export function assignException(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'exceptions.manage');
  const input = parse(assignSchema, body);
  return ctx.db.transaction(() => {
    const x = loadException(ctx, id);
    if (x.status === 'RESOLVED') throw conflict('Resolved exceptions cannot be reassigned.', 'RESOLVED');
    if (input.responsibleUserId && !userAtLocation(ctx.db, ctx.actor.orgId, input.responsibleUserId, x.locationId)) {
      throw badRequest('Responsible user must be an active user at this location');
    }
    ctx.db.prepare('UPDATE admin_exceptions SET responsible_role = ?, responsible_user_id = ?, updated_at = ? WHERE id = ?').run(
      input.responsibleRole ?? null,
      input.responsibleUserId ?? null,
      clock.nowIso(),
      id,
    );
    audit(ctx, { action: 'exception.assign', entityType: 'admin_exception', entityId: id, entityRef: x.reference, locationId: x.locationId, metadata: input });
    return getException(ctx, id);
  })();
}

// ---------------------------------------------------------------------------
// Shift handover
// ---------------------------------------------------------------------------

export function handoverSummary(ctx: Ctx, locationId: number) {
  requirePerm(ctx.actor, 'handover.manage', 'exceptions.view');
  assertInScope(ctx.actor, locationId, 'Location');
  const db = ctx.db;
  const count = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
  const visitsAwaiting = VISIT_AWAITING_AUTHORIZATION.map((s) => `'${s}'`).join(',');
  const deliveriesOpen = DELIVERY_AWAITING_COMPLETION.map((s) => `'${s}'`).join(',');
  const summary = {
    openExceptions: count("SELECT COUNT(*) AS n FROM admin_exceptions WHERE location_id = ? AND status <> 'RESOLVED'", locationId),
    pendingApprovals: count(`SELECT COUNT(*) AS n FROM visits WHERE location_id = ? AND status IN (${visitsAwaiting})`, locationId),
    visitorsAwaitingAction: count("SELECT COUNT(*) AS n FROM visits WHERE location_id = ? AND status IN ('ARRIVED','HOST_NOTIFIED','WAITING')", locationId),
    visitorsInside: count("SELECT COUNT(*) AS n FROM visits WHERE location_id = ? AND status IN ('INSIDE','OVERDUE')", locationId),
    overdueVisitors: count("SELECT COUNT(*) AS n FROM visits WHERE location_id = ? AND status = 'OVERDUE'", locationId),
    incompleteDeliveries: count(`SELECT COUNT(*) AS n FROM deliveries WHERE location_id = ? AND status IN (${deliveriesOpen})`, locationId),
    unresolvedDiscrepancies: count("SELECT COUNT(*) AS n FROM admin_exceptions WHERE location_id = ? AND status <> 'RESOLVED' AND category IN ('RECORD_DISCREPANCY','MISSING_EXIT','EVENT_CORRECTION')", locationId),
    openAlerts: count("SELECT COUNT(*) AS n FROM alerts WHERE location_id = ? AND status = 'OPEN'", locationId),
    pendingManualReviews: count("SELECT COUNT(*) AS n FROM manual_reviews WHERE location_id = ? AND status = 'PENDING'", locationId),
  };
  const items = {
    exceptions: db
      .prepare("SELECT id, reference, title, status, created_at AS createdAt FROM admin_exceptions WHERE location_id = ? AND status <> 'RESOLVED' ORDER BY id DESC LIMIT 10")
      .all(locationId),
    visitors: db
      .prepare(
        `SELECT v.id, v.reference, v.status, vr.full_name AS visitorName FROM visits v JOIN visitors vr ON vr.id = v.visitor_id
         WHERE v.location_id = ? AND v.status IN ('ARRIVED','HOST_NOTIFIED','WAITING','OVERDUE') ORDER BY v.id DESC LIMIT 10`,
      )
      .all(locationId),
    deliveries: db
      .prepare(`SELECT id, reference, status, company FROM deliveries WHERE location_id = ? AND status IN (${deliveriesOpen}) ORDER BY id DESC LIMIT 10`)
      .all(locationId),
  };
  return { locationId, generatedAt: clock.nowIso(), summary, items };
}

const handoverSchema = z.object({
  locationId: z.coerce.number().int().positive(),
  gateId: z.coerce.number().int().positive().optional().nullable(),
  shiftLabel: zText(60),
  handedOverTo: z.coerce.number().int().positive().optional().nullable(),
  notes: zOptText(2000),
});

export function recordHandover(ctx: Ctx, body: unknown) {
  requirePerm(ctx.actor, 'handover.manage');
  const input = parse(handoverSchema, body);
  assertInScope(ctx.actor, input.locationId, 'Location');
  if (input.gateId) {
    const gate = loadGate(ctx, input.gateId);
    if (gate.location_id !== input.locationId) throw badRequest('Gate does not belong to the selected location');
  }
  if (input.handedOverTo === ctx.actor.userId) throw badRequest('Select the incoming user, not yourself');
  if (input.handedOverTo && !userAtLocation(ctx.db, ctx.actor.orgId, input.handedOverTo, input.locationId)) {
    throw badRequest('The incoming user must be an active user at this location');
  }
  return ctx.db.transaction(() => {
    const summary = handoverSummary(ctx, input.locationId);
    const reference = nextRef(ctx.db, ctx.actor.orgId, REF.HANDOVER);
    const now = clock.nowIso();
    const info = ctx.db
      .prepare(
        `INSERT INTO handovers (organization_id, reference, location_id, gate_id, shift_label, handed_over_by, handed_over_to, summary_json, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ctx.actor.orgId, reference, input.locationId, input.gateId ?? null, input.shiftLabel, ctx.actor.userId, input.handedOverTo ?? null, JSON.stringify(summary.summary), input.notes, now);
    const id = Number(info.lastInsertRowid);
    if (input.handedOverTo) {
      notify(ctx.db, {
        orgId: ctx.actor.orgId,
        userIds: [input.handedOverTo],
        locationId: input.locationId,
        type: 'HANDOVER',
        title: `Shift handover ${reference} from ${ctx.actor.displayName}`,
        body: `${input.shiftLabel}: please review and acknowledge.`,
        link: `/handover`,
        relatedType: 'handover',
        relatedId: id,
      });
    }
    audit(ctx, { action: 'handover.record', entityType: 'handover', entityId: id, entityRef: reference, locationId: input.locationId, metadata: { shift: input.shiftLabel, to: input.handedOverTo } });
    return { id, reference };
  })();
}

export function acknowledgeHandover(ctx: Ctx, id: number) {
  requirePerm(ctx.actor, 'handover.manage');
  return ctx.db.transaction(() => {
    const h = ctx.db.prepare('SELECT * FROM handovers WHERE id = ? AND organization_id = ?').get(id, ctx.actor.orgId) as Record<string, any> | undefined;
    if (!h) throw notFound('Handover');
    assertInScope(ctx.actor, h.location_id, 'Handover');
    if (h.acknowledged_at) throw conflict('Handover already acknowledged.', 'ALREADY_ACKNOWLEDGED');
    if (h.handed_over_by === ctx.actor.userId) throw unprocessable('The outgoing user cannot acknowledge their own handover.', 'SELF_ACK');
    if (h.handed_over_to && h.handed_over_to !== ctx.actor.userId) throw unprocessable('This handover is addressed to another user.', 'NOT_RECIPIENT');
    ctx.db.prepare('UPDATE handovers SET acknowledged_by = ?, acknowledged_at = ? WHERE id = ?').run(ctx.actor.userId, clock.nowIso(), id);
    audit(ctx, { action: 'handover.acknowledge', entityType: 'handover', entityId: id, entityRef: h.reference, locationId: h.location_id });
    return { ok: true };
  })();
}

export function listHandovers(ctx: Ctx, raw: unknown): Page<Record<string, unknown>> {
  requirePerm(ctx.actor, 'handover.manage', 'exceptions.view');
  const q = parse(listQuery, raw);
  const scope = sqlIn('h.location_id', scopeIds(ctx.actor, q.locationId));
  const params = [...scope.params, ctx.actor.orgId];
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM handovers h WHERE ${scope.sql} AND h.organization_id = ?`).get(...params) as { n: number }).n;
  const items = (ctx.db
    .prepare(
      `SELECT h.id, h.reference, h.location_id AS locationId, l.name AS locationName, g.name AS gateName, h.shift_label AS shiftLabel,
              fu.display_name AS handedOverBy, h.handed_over_by AS handedOverById, tu.display_name AS handedOverTo, h.handed_over_to AS handedOverToId,
              h.summary_json AS summaryJson, h.notes, h.created_at AS createdAt, au.display_name AS acknowledgedBy, h.acknowledged_at AS acknowledgedAt
       FROM handovers h JOIN locations l ON l.id = h.location_id LEFT JOIN gates g ON g.id = h.gate_id
       JOIN users fu ON fu.id = h.handed_over_by LEFT JOIN users tu ON tu.id = h.handed_over_to LEFT JOIN users au ON au.id = h.acknowledged_by
       WHERE ${scope.sql} AND h.organization_id = ? ORDER BY h.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, q.pageSize, (q.page - 1) * q.pageSize) as Record<string, any>[]).map(({ summaryJson, ...r }) => ({
    ...r,
    summary: JSON.parse(summaryJson),
    canAcknowledge: !r.acknowledgedAt && r.handedOverById !== ctx.actor.userId && (!r.handedOverToId || r.handedOverToId === ctx.actor.userId),
  }));
  return { items, total, page: q.page, pageSize: q.pageSize };
}
