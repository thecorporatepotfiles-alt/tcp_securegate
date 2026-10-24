import { z } from 'zod';
import QRCode from 'qrcode';
import type { DB } from '../db/connection.js';
import type { Actor, Ctx } from '../auth/context.js';
import { assertInScope, can, inScope, requirePerm, scopeIds, sqlIn } from '../auth/context.js';
import { clock } from '../clock.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors.js';
import { makeAccessToken, newNonce } from '../lib/crypto.js';
import { addDays, dateRangeToUtc, localDate, zonedToUtc } from '../lib/time.js';
import { likeParam, listQuery, orderBy, parse, zDate, zEmail, zOptText, zPhone, zText, zTime, type Page } from '../lib/http.js';
import { nextRef, REF } from '../lib/refs.js';
import { audit } from './audit.js';
import { notify } from './notifications.js';
import { getSettings } from './settings.js';
import { setVisitStatus, type VisitRow } from './visitStatus.js';
import { subjectHistory } from './movement.js';
import { loadGate } from './verification.js';
import { findOrCreateVehicle } from './vehicles.js';
import {
  VISIT_AWAITING_AUTHORIZATION,
  VISIT_STATUSES,
  VISIT_STATUS_INFO,
  type VisitStatus,
} from '../../../shared/constants.js';

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const VISIT_SELECT = `SELECT v.id, v.reference, v.location_id AS locationId, l.name AS locationName, v.source, v.status,
    v.visitor_id AS visitorId, vr.full_name AS visitorName, vr.company AS visitorCompany, vr.phone AS visitorPhone, vr.email AS visitorEmail,
    v.host_user_id AS hostUserId, h.display_name AS hostName, v.host_department AS hostDepartment,
    v.approving_officer_id AS approvingOfficerId, ao.display_name AS approvingOfficerName,
    v.purpose, v.destination, v.visit_date AS visitDate, v.expected_arrival AS expectedArrival, v.expected_departure AS expectedDeparture,
    v.vehicle_id AS vehicleId, ve.display_registration AS vehicleRegistration, v.notes,
    v.requires_security_check AS requiresSecurityCheck, v.security_checked_at AS securityCheckedAt, sc.display_name AS securityCheckedBy,
    v.security_check_note AS securityCheckNote, v.host_acknowledged_at AS hostAcknowledgedAt, v.arrived_at AS arrivedAt,
    v.entered_at AS enteredAt, v.exited_at AS exitedAt, v.cancelled_reason AS cancelledReason,
    v.created_by AS createdById, cb.display_name AS createdByName, v.created_at AS createdAt, v.updated_at AS updatedAt
  FROM visits v
  JOIN visitors vr ON vr.id = v.visitor_id
  JOIN locations l ON l.id = v.location_id
  JOIN users h ON h.id = v.host_user_id
  JOIN users ao ON ao.id = v.approving_officer_id
  JOIN users cb ON cb.id = v.created_by
  LEFT JOIN users sc ON sc.id = v.security_checked_by
  LEFT JOIN vehicles ve ON ve.id = v.vehicle_id`;

/** Users without visitors.view_all only see visits they host, requested or must approve. */
function visibilityFilter(actor: Actor): { sql: string; params: unknown[] } {
  if (can(actor, 'visitors.view_all')) return { sql: '1', params: [] };
  return { sql: '(v.host_user_id = ? OR v.created_by = ? OR v.approving_officer_id = ?)', params: [actor.userId, actor.userId, actor.userId] };
}

const visitListQuery = listQuery.extend({
  status: z.enum(VISIT_STATUSES).optional(),
  statusGroup: z.enum(['AWAITING_AUTHORIZATION', 'ACTIVE', 'CLOSED']).optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  approvalQueue: z.coerce.boolean().optional(),
  mine: z.coerce.boolean().optional(),
  source: z.enum(['PRE_REGISTERED', 'WALK_IN']).optional(),
});

export function listVisits(ctx: Ctx, raw: unknown): Page<Record<string, unknown>> {
  requirePerm(ctx.actor, 'visitors.view', 'visitors.view_all');
  const q = parse(visitListQuery, raw);
  const scope = sqlIn('v.location_id', scopeIds(ctx.actor, q.locationId));
  const vis = visibilityFilter(ctx.actor);
  const where = [scope.sql, vis.sql, 'v.organization_id = ?'];
  const params: unknown[] = [...scope.params, ...vis.params, ctx.actor.orgId];
  if (q.status) {
    where.push('v.status = ?');
    params.push(q.status);
  }
  if (q.statusGroup === 'AWAITING_AUTHORIZATION') where.push(`v.status IN (${VISIT_AWAITING_AUTHORIZATION.map((s) => `'${s}'`).join(',')})`);
  if (q.statusGroup === 'ACTIVE') where.push("v.status IN ('APPROVED','INSIDE','OVERDUE')");
  if (q.statusGroup === 'CLOSED') where.push("v.status IN ('EXITED','REJECTED','CANCELLED','EXPIRED')");
  if (q.from) {
    where.push('v.visit_date >= ?');
    params.push(q.from);
  }
  if (q.to) {
    where.push('v.visit_date <= ?');
    params.push(q.to);
  }
  if (q.source) {
    where.push('v.source = ?');
    params.push(q.source);
  }
  if (q.approvalQueue) {
    where.push(`v.approving_officer_id = ? AND v.status IN (${VISIT_AWAITING_AUTHORIZATION.map((s) => `'${s}'`).join(',')})`);
    params.push(ctx.actor.userId);
  }
  if (q.mine) {
    where.push('(v.host_user_id = ? OR v.created_by = ?)');
    params.push(ctx.actor.userId, ctx.actor.userId);
  }
  if (q.q) {
    const like = likeParam(q.q);
    where.push("(v.reference LIKE ? ESCAPE '\\' OR vr.full_name LIKE ? ESCAPE '\\' OR vr.company LIKE ? ESCAPE '\\' OR v.destination LIKE ? ESCAPE '\\' OR h.display_name LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like, like);
  }
  const whereSql = where.join(' AND ');
  const order = orderBy(
    q.sort,
    q.dir,
    { expectedArrival: 'v.expected_arrival', visitorName: 'vr.full_name', status: 'v.status', reference: 'v.reference', createdAt: 'v.created_at' },
    'v.expected_arrival DESC',
  );
  const total = (
    ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM visits v JOIN visitors vr ON vr.id = v.visitor_id JOIN users h ON h.id = v.host_user_id WHERE ${whereSql}`)
      .get(...params) as { n: number }
  ).n;
  const items = ctx.db
    .prepare(`${VISIT_SELECT} WHERE ${whereSql} ORDER BY ${order}, v.id DESC LIMIT ? OFFSET ?`)
    .all(...params, q.pageSize, (q.page - 1) * q.pageSize) as Record<string, unknown>[];
  return { items, total, page: q.page, pageSize: q.pageSize };
}

function loadVisitRow(ctx: Ctx, id: number): VisitRow {
  const v = ctx.db.prepare('SELECT * FROM visits WHERE id = ? AND organization_id = ?').get(id, ctx.actor.orgId) as VisitRow | undefined;
  if (!v) throw notFound('Visit');
  assertInScope(ctx.actor, v.location_id, 'Visit');
  if (!can(ctx.actor, 'visitors.view_all') && ![v.host_user_id, v.created_by, v.approving_officer_id].includes(ctx.actor.userId!)) {
    // Gate operators may act on visits at their gates without directory visibility.
    if (!can(ctx.actor, 'gate.operate')) throw notFound('Visit');
  }
  return v;
}

function canSeePassToken(actor: Actor, v: VisitRow): boolean {
  return can(actor, 'visitors.manage') || [v.host_user_id, v.created_by, v.approving_officer_id].includes(actor.userId!);
}

export function getVisit(ctx: Ctx, id: number) {
  requirePerm(ctx.actor, 'visitors.view', 'visitors.view_all');
  const row = loadVisitRow(ctx, id);
  const visit = ctx.db.prepare(`${VISIT_SELECT} WHERE v.id = ?`).get(id) as Record<string, any>;
  const history = ctx.db
    .prepare(
      `SELECT h.from_status AS fromStatus, h.to_status AS toStatus, h.reason, h.created_at AS createdAt, COALESCE(u.display_name, 'System') AS actor
       FROM visit_status_history h LEFT JOIN users u ON u.id = h.actor_user_id WHERE h.visit_id = ? ORDER BY h.id`,
    )
    .all(id);
  const approval = ctx.db
    .prepare(
      `SELECT a.decision, a.reason, a.created_at AS createdAt, u.display_name AS reviewer
       FROM visit_approvals a JOIN users u ON u.id = a.reviewer_user_id WHERE a.visit_id = ?`,
    )
    .get(id);
  const passes = ctx.db
    .prepare(
      `SELECT p.id, p.pass_number AS passNumber, p.status, p.single_use AS singleUse, p.valid_from AS validFrom, p.valid_until AS validUntil,
              p.issued_at AS issuedAt, u.display_name AS issuedBy, p.revoked_at AS revokedAt, p.revoked_reason AS revokedReason,
              p.entry_used_at AS entryUsedAt, p.exit_used_at AS exitUsedAt
       FROM visit_passes p LEFT JOIN users u ON u.id = p.issued_by WHERE p.visit_id = ? ORDER BY p.id DESC`,
    )
    .all(id);
  const events = subjectHistory(ctx, 'VISITOR', id);
  return { ...visit, history, approval: approval ?? null, passes, events, permissions: visitPermissions(ctx, row) };
}

function visitPermissions(ctx: Ctx, v: VisitRow) {
  const { actor, db } = ctx;
  const settings = getSettings(db, v.organization_id);
  const transitions = settings['visit.transitions'];
  const awaiting = VISIT_AWAITING_AUTHORIZATION.includes(v.status);
  const selfBlocked = !settings['visit.allowSelfApproval'] && v.created_by === actor.userId;
  const isOwner = v.host_user_id === actor.userId || v.created_by === actor.userId;
  return {
    canApprove:
      awaiting && can(actor, 'visitors.approve') && v.approving_officer_id === actor.userId && !selfBlocked && (transitions[v.status] ?? []).includes('APPROVED'),
    selfApprovalBlocked: awaiting && v.approving_officer_id === actor.userId && selfBlocked,
    canAcknowledge: v.status === 'HOST_NOTIFIED' && (v.host_user_id === actor.userId || can(actor, 'visitors.manage')),
    canSecurityCheck: v.status === 'APPROVED' && v.requires_security_check === 1 && !v.security_checked_at && can(actor, 'visitors.security_check'),
    canCancel: (transitions[v.status] ?? []).includes('CANCELLED') && (isOwner || can(actor, 'visitors.manage')),
    canViewPass: canSeePassToken(actor, v),
  };
}

export async function getPassView(ctx: Ctx, visitId: number) {
  requirePerm(ctx.actor, 'visitors.view', 'visitors.view_all');
  const v = loadVisitRow(ctx, visitId);
  if (!canSeePassToken(ctx.actor, v)) throw forbidden('Only the host, requester, approving officer or a visitor administrator can display this pass.');
  const pass = ctx.db
    .prepare("SELECT * FROM visit_passes WHERE visit_id = ? AND status IN ('ACTIVE','USED','EXPIRED') ORDER BY id DESC LIMIT 1")
    .get(visitId) as Record<string, any> | undefined;
  if (!pass) throw notFound('Pass');
  const visit = ctx.db.prepare(`${VISIT_SELECT} WHERE v.id = ?`).get(visitId) as Record<string, any>;
  const token = makeAccessToken('VISIT_PASS', pass.token_nonce, ctx.config.tokenSecret);
  const qrSvg = await QRCode.toString(token, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', width: 240 });
  return {
    passNumber: pass.pass_number,
    status: pass.status,
    singleUse: pass.single_use === 1,
    validFrom: pass.valid_from,
    validUntil: pass.valid_until,
    visitReference: visit.reference,
    visitorName: visit.visitorName,
    visitorCompany: visit.visitorCompany,
    hostName: visit.hostName,
    locationName: visit.locationName,
    destination: visit.destination,
    visitStatus: visit.status,
    token,
    qrSvg,
    simulated: true,
  };
}

// ---------------------------------------------------------------------------
// Create request
// ---------------------------------------------------------------------------

const visitorInput = z.object({
  fullName: zText(120),
  company: zOptText(120),
  phone: zPhone,
  email: zEmail,
});

const vehicleInput = z
  .object({
    registration: z.string().trim().min(4).max(20),
    category: z.string().trim().max(40).optional(),
    makeModel: z.string().trim().max(80).optional(),
  })
  .optional()
  .nullable();

const createSchema = z.object({
  locationId: z.coerce.number().int().positive(),
  visitorId: z.coerce.number().int().positive().optional(),
  visitor: visitorInput.optional(),
  hostUserId: z.coerce.number().int().positive().optional(),
  hostDepartment: zOptText(120),
  approvingOfficerId: z.coerce.number().int().positive(),
  purpose: zText(200),
  destination: zText(120),
  visitDate: zDate,
  arrivalTime: zTime,
  departureTime: zTime,
  vehicle: vehicleInput,
  notes: zOptText(1000),
  requiresSecurityCheck: z.boolean().optional(),
});

export function resolveVisitor(db: DB, actor: Actor, visitorId: number | undefined, visitor: z.infer<typeof visitorInput> | undefined): number {
  const now = clock.nowIso();
  if (visitorId) {
    const vis = visibilityFilter(actor);
    const known = db
      .prepare(
        `SELECT vr.id FROM visitors vr WHERE vr.id = ? AND vr.organization_id = ?
         AND EXISTS (SELECT 1 FROM visits v WHERE v.visitor_id = vr.id AND v.location_id IN (${actor.locationIds.map(() => '?').join(',') || 'NULL'}) AND ${vis.sql})`,
      )
      .get(visitorId, actor.orgId, ...actor.locationIds, ...vis.params);
    if (!known) throw notFound('Visitor');
    if (visitor) {
      // Visitor administrators may correct details; other requesters may only fill in missing ones.
      const sql = can(actor, 'visitors.manage')
        ? 'UPDATE visitors SET company = COALESCE(?, company), phone = COALESCE(?, phone), email = COALESCE(?, email), updated_at = ? WHERE id = ?'
        : 'UPDATE visitors SET company = COALESCE(company, ?), phone = COALESCE(phone, ?), email = COALESCE(email, ?), updated_at = ? WHERE id = ?';
      db.prepare(sql).run(visitor.company, visitor.phone, visitor.email, now, visitorId);
    }
    return visitorId;
  }
  if (!visitor) throw badRequest('Visitor details are required');
  if (visitor.phone) {
    const match = db
      .prepare('SELECT id FROM visitors WHERE organization_id = ? AND phone = ? AND lower(full_name) = lower(?)')
      .get(actor.orgId, visitor.phone, visitor.fullName) as { id: number } | undefined;
    if (match) return match.id;
  }
  const info = db
    .prepare('INSERT INTO visitors (organization_id, full_name, company, phone, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(actor.orgId, visitor.fullName, visitor.company, visitor.phone, visitor.email, now, now);
  return Number(info.lastInsertRowid);
}

function assertUserAtLocation(db: DB, orgId: number, userId: number, locationId: number, perm: string, label: string) {
  const u = db
    .prepare(
      `SELECT u.id FROM users u JOIN role_permissions rp ON rp.role_code = u.role_code AND rp.permission_code = ?
       WHERE u.id = ? AND u.organization_id = ? AND u.is_active = 1
       AND (u.all_locations = 1 OR u.role_code IN ('SYSTEM_ADMIN','HQ_ADMIN','AUDITOR') OR EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = u.id AND ul.location_id = ?))`,
    )
    .get(perm, userId, orgId, locationId);
  if (!u) throw badRequest(`${label} must be an active user authorized for this location`);
}

export function createVisit(ctx: Ctx, body: unknown) {
  requirePerm(ctx.actor, 'visitors.create');
  const input = parse(createSchema, body);
  const { db, actor, config } = ctx;
  assertInScope(actor, input.locationId, 'Location');
  const tz = config.timezone;
  const today = localDate(clock.now(), tz);
  if (input.visitDate < today) throw badRequest('Visit date cannot be in the past');
  if (input.visitDate > addDays(today, 90)) throw badRequest('Visits can be requested up to 90 days ahead');
  const arrival = zonedToUtc(input.visitDate, input.arrivalTime, tz).toISOString();
  const departure = zonedToUtc(input.visitDate, input.departureTime, tz).toISOString();
  if (departure <= arrival) throw badRequest('Expected departure must be after expected arrival');
  if (departure <= clock.nowIso()) throw badRequest('Expected departure has already passed');
  const hostUserId = input.hostUserId ?? actor.userId!;
  assertUserAtLocation(db, actor.orgId, hostUserId, input.locationId, 'visitors.view', 'Host');
  assertUserAtLocation(db, actor.orgId, input.approvingOfficerId, input.locationId, 'visitors.approve', 'Approving officer');
  const settings = getSettings(db, actor.orgId);
  if (!settings['visit.allowSelfApproval'] && input.approvingOfficerId === actor.userId) {
    throw badRequest('You cannot be the approving officer for your own request. Select another approving officer.');
  }

  return db.transaction(() => {
    const visitorId = resolveVisitor(db, actor, input.visitorId, input.visitor);
    const vehicleId = input.vehicle
      ? findOrCreateVehicle(ctx, {
          registration: input.vehicle.registration,
          category: input.vehicle.category,
          makeModel: input.vehicle.makeModel,
          ownerType: 'VISITOR',
          visitorId,
          locationId: input.locationId,
        })
      : null;
    const reference = nextRef(db, actor.orgId, REF.VISIT);
    const now = clock.nowIso();
    // A requester may add the security-verification step but never waive the organization-wide requirement.
    const requiresCheck = settings['visit.requireSecurityCheck'] || input.requiresSecurityCheck === true;
    const info = db
      .prepare(
        `INSERT INTO visits (organization_id, reference, location_id, visitor_id, source, host_user_id, host_department, approving_officer_id,
           purpose, destination, visit_date, expected_arrival, expected_departure, vehicle_id, notes, status, requires_security_check,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'PRE_REGISTERED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EXPECTED', ?, ?, ?, ?)`,
      )
      .run(
        actor.orgId,
        reference,
        input.locationId,
        visitorId,
        hostUserId,
        input.hostDepartment,
        input.approvingOfficerId,
        input.purpose,
        input.destination,
        input.visitDate,
        arrival,
        departure,
        vehicleId,
        input.notes,
        requiresCheck ? 1 : 0,
        actor.userId,
        now,
        now,
      );
    const id = Number(info.lastInsertRowid);
    db.prepare("INSERT INTO visit_status_history (visit_id, from_status, to_status, reason, actor_user_id, created_at) VALUES (?, NULL, 'EXPECTED', 'Visitor request created', ?, ?)").run(
      id,
      actor.userId,
      now,
    );
    const visitorName = (db.prepare('SELECT full_name FROM visitors WHERE id = ?').get(visitorId) as { full_name: string }).full_name;
    notify(db, {
      orgId: actor.orgId,
      userIds: [input.approvingOfficerId],
      locationId: input.locationId,
      type: 'VISIT_APPROVAL_REQUESTED',
      title: 'Visitor request awaiting your authorization',
      body: `${visitorName} on ${input.visitDate} (${input.arrivalTime}–${input.departureTime}) · ${input.purpose}. Ref ${reference}.`,
      link: `/visitors/${id}`,
      relatedType: 'visit',
      relatedId: id,
    });
    if (hostUserId !== actor.userId) {
      notify(db, {
        orgId: actor.orgId,
        userIds: [hostUserId],
        locationId: input.locationId,
        type: 'VISIT_CREATED_FOR_HOST',
        title: 'A visitor request names you as host',
        body: `${visitorName} on ${input.visitDate}. Ref ${reference}.`,
        link: `/visitors/${id}`,
        relatedType: 'visit',
        relatedId: id,
      });
    }
    audit(ctx, {
      action: 'visit.request.create',
      entityType: 'visit',
      entityId: id,
      entityRef: reference,
      locationId: input.locationId,
      metadata: { visitDate: input.visitDate, approvingOfficerId: input.approvingOfficerId, requiresSecurityCheck: requiresCheck, vehicle: vehicleId != null },
    });
    return getVisit(ctx, id);
  })();
}

// ---------------------------------------------------------------------------
// Pass issuance
// ---------------------------------------------------------------------------

export function issuePass(db: DB, actor: Actor | null, v: VisitRow): { id: number; passNumber: string } {
  const settings = getSettings(db, v.organization_id);
  const existing = db.prepare("SELECT id FROM visit_passes WHERE visit_id = ? AND status = 'ACTIVE'").get(v.id);
  if (existing) throw conflict('An active pass already exists for this visit.', 'PASS_EXISTS');
  if (!['APPROVED'].includes(v.status)) throw unprocessable('Passes are only generated for approved visits.', 'NOT_APPROVED');
  const passCount = (db.prepare('SELECT COUNT(*) AS n FROM visit_passes WHERE visit_id = ?').get(v.id) as { n: number }).n;
  const passNumber = `${v.reference.replace('VR-', 'VP-')}${passCount ? `-${passCount + 1}` : ''}`;
  const validFrom = new Date(new Date(v.expected_arrival).getTime() - settings['visit.passEarlyMinutes'] * 60_000).toISOString();
  const validUntil = new Date(new Date(v.expected_departure).getTime() + settings['visit.passGraceMinutes'] * 60_000).toISOString();
  const now = clock.nowIso();
  const info = db
    .prepare(
      `INSERT INTO visit_passes (visit_id, pass_number, token_nonce, status, single_use, valid_from, valid_until, issued_by, issued_at)
       VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?)`,
    )
    .run(v.id, passNumber, newNonce(), settings['visit.passSingleUse'] ? 1 : 0, validFrom, validUntil, actor?.userId ?? null, now);
  const id = Number(info.lastInsertRowid);
  db.prepare("INSERT INTO visit_status_history (visit_id, from_status, to_status, reason, actor_user_id, created_at) VALUES (?, 'APPROVED', 'APPROVED', ?, ?, ?)").run(
    v.id,
    `Digital pass ${passNumber} generated`,
    actor?.userId ?? null,
    now,
  );
  return { id, passNumber };
}

function revokeActivePass(db: DB, actor: Actor | null, visitId: number, reason: string): string | null {
  const pass = db.prepare("SELECT id, pass_number FROM visit_passes WHERE visit_id = ? AND status = 'ACTIVE'").get(visitId) as
    | { id: number; pass_number: string }
    | undefined;
  if (!pass) return null;
  db.prepare("UPDATE visit_passes SET status = 'REVOKED', revoked_at = ?, revoked_by = ?, revoked_reason = ? WHERE id = ?").run(
    clock.nowIso(),
    actor?.userId ?? null,
    reason,
    pass.id,
  );
  return pass.pass_number;
}

// ---------------------------------------------------------------------------
// Approval workflow
// ---------------------------------------------------------------------------

const decisionSchema = z.object({ reason: z.string().trim().max(1000).optional() });
const rejectSchema = z.object({ reason: z.string().trim().min(3, 'A rejection reason is required').max(1000) });

function assertCanDecide(ctx: Ctx, v: VisitRow) {
  requirePerm(ctx.actor, 'visitors.approve');
  const settings = getSettings(ctx.db, v.organization_id);
  if (v.approving_officer_id !== ctx.actor.userId) throw forbidden('This request is assigned to another approving officer.');
  if (!settings['visit.allowSelfApproval'] && v.created_by === ctx.actor.userId) {
    throw forbidden('You cannot approve or reject a request you created.');
  }
  if (ctx.db.prepare('SELECT 1 FROM visit_approvals WHERE visit_id = ?').get(v.id)) {
    throw conflict('A decision has already been recorded for this request.', 'ALREADY_DECIDED');
  }
  if (!VISIT_AWAITING_AUTHORIZATION.includes(v.status)) {
    throw unprocessable(`Request is ${VISIT_STATUS_INFO[v.status].label.toLowerCase()} and cannot be decided.`, 'INVALID_TRANSITION');
  }
}

export function approveVisit(ctx: Ctx, id: number, body: unknown) {
  const { reason } = parse(decisionSchema, body);
  const { db, actor } = ctx;
  return db.transaction(() => {
    const v = loadVisitRow(ctx, id);
    assertCanDecide(ctx, v);
    if (new Date(v.expected_departure).getTime() <= clock.nowMs()) {
      throw unprocessable('The requested visit window has already passed.', 'WINDOW_PASSED');
    }
    const now = clock.nowIso();
    db.prepare("INSERT INTO visit_approvals (visit_id, decision, reason, reviewer_user_id, created_at) VALUES (?, 'APPROVED', ?, ?, ?)").run(
      id,
      reason ?? null,
      actor.userId,
      now,
    );
    setVisitStatus(db, actor, v, 'APPROVED', reason ? `Approved: ${reason}` : 'Approved');
    let pass: { passNumber: string } | null = null;
    if (v.requires_security_check !== 1) pass = issuePass(db, actor, v);
    notify(db, {
      orgId: actor.orgId,
      userIds: [v.host_user_id, v.created_by].filter((u) => u !== actor.userId),
      locationId: v.location_id,
      type: 'VISIT_APPROVED',
      title: `Visit ${v.reference} approved`,
      body: pass ? `Digital pass ${pass.passNumber} is ready to share with the visitor.` : 'Approved. Pass will be generated after the required security verification step.',
      link: `/visitors/${id}`,
      relatedType: 'visit',
      relatedId: id,
    });
    audit(ctx, { action: 'visit.approve', entityType: 'visit', entityId: id, entityRef: v.reference, locationId: v.location_id, metadata: { reason } });
    if (pass) audit(ctx, { action: 'visit.pass.issue', entityType: 'visit', entityId: id, entityRef: pass.passNumber, locationId: v.location_id });
    return getVisit(ctx, id);
  })();
}

export function rejectVisit(ctx: Ctx, id: number, body: unknown) {
  const { reason } = parse(rejectSchema, body);
  const { db, actor } = ctx;
  return db.transaction(() => {
    const v = loadVisitRow(ctx, id);
    assertCanDecide(ctx, v);
    db.prepare("INSERT INTO visit_approvals (visit_id, decision, reason, reviewer_user_id, created_at) VALUES (?, 'REJECTED', ?, ?, ?)").run(
      id,
      reason,
      actor.userId,
      clock.nowIso(),
    );
    setVisitStatus(db, actor, v, 'REJECTED', `Rejected: ${reason}`);
    notify(db, {
      orgId: actor.orgId,
      userIds: [v.host_user_id, v.created_by].filter((u) => u !== actor.userId),
      locationId: v.location_id,
      type: 'VISIT_REJECTED',
      title: `Visit ${v.reference} rejected`,
      body: reason,
      link: `/visitors/${id}`,
      relatedType: 'visit',
      relatedId: id,
    });
    audit(ctx, { action: 'visit.reject', entityType: 'visit', entityId: id, entityRef: v.reference, locationId: v.location_id, metadata: { reason } });
    return getVisit(ctx, id);
  })();
}

const noteSchema = z.object({ note: z.string().trim().min(3, 'A note is required').max(1000) });

export function completeSecurityCheck(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'visitors.security_check');
  const { note } = parse(noteSchema, body);
  const { db, actor } = ctx;
  return db.transaction(() => {
    const v = loadVisitRow(ctx, id);
    if (v.status !== 'APPROVED' || v.requires_security_check !== 1) throw unprocessable('No security verification step is pending for this visit.', 'NOT_PENDING');
    if (v.security_checked_at) throw conflict('The security verification step is already recorded.', 'ALREADY_DONE');
    const now = clock.nowIso();
    db.prepare('UPDATE visits SET security_checked_by = ?, security_checked_at = ?, security_check_note = ?, updated_at = ? WHERE id = ?').run(
      actor.userId,
      now,
      note,
      now,
      id,
    );
    const pass = issuePass(db, actor, v);
    notify(db, {
      orgId: actor.orgId,
      userIds: [v.host_user_id, v.created_by],
      locationId: v.location_id,
      type: 'VISIT_PASS_READY',
      title: `Pass ready for ${v.reference}`,
      body: `Security verification step recorded. Digital pass ${pass.passNumber} generated.`,
      link: `/visitors/${id}`,
      relatedType: 'visit',
      relatedId: id,
    });
    audit(ctx, { action: 'visit.security_check', entityType: 'visit', entityId: id, entityRef: v.reference, locationId: v.location_id, metadata: { note } });
    audit(ctx, { action: 'visit.pass.issue', entityType: 'visit', entityId: id, entityRef: pass.passNumber, locationId: v.location_id });
    return getVisit(ctx, id);
  })();
}

const cancelSchema = z.object({ reason: z.string().trim().min(3, 'A cancellation reason is required').max(1000) });

export function cancelVisit(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'visitors.create', 'visitors.manage');
  const { reason } = parse(cancelSchema, body);
  const { db, actor } = ctx;
  return db.transaction(() => {
    const v = loadVisitRow(ctx, id);
    const isOwner = v.host_user_id === actor.userId || v.created_by === actor.userId;
    if (!isOwner && !can(actor, 'visitors.manage')) throw forbidden('Only the host, requester or a visitor administrator can cancel this visit.');
    setVisitStatus(db, actor, v, 'CANCELLED', `Cancelled: ${reason}`, { cancelled_reason: reason });
    const revoked = revokeActivePass(db, actor, id, `Visit cancelled: ${reason}`);
    audit(ctx, { action: 'visit.cancel', entityType: 'visit', entityId: id, entityRef: v.reference, locationId: v.location_id, metadata: { reason } });
    if (revoked) audit(ctx, { action: 'visit.pass.revoke', entityType: 'visit', entityId: id, entityRef: revoked, locationId: v.location_id, metadata: { reason } });
    if (v.approving_officer_id !== actor.userId) {
      notify(db, {
        orgId: actor.orgId,
        userIds: [v.approving_officer_id, v.host_user_id].filter((u) => u !== actor.userId),
        locationId: v.location_id,
        type: 'VISIT_CANCELLED',
        title: `Visit ${v.reference} cancelled`,
        body: reason,
        link: `/visitors/${id}`,
        relatedType: 'visit',
        relatedId: id,
      });
    }
    return getVisit(ctx, id);
  })();
}

export function acknowledgeArrival(ctx: Ctx, id: number) {
  requirePerm(ctx.actor, 'visitors.view', 'visitors.view_all');
  const { db, actor } = ctx;
  return db.transaction(() => {
    const v = loadVisitRow(ctx, id);
    if (v.host_user_id !== actor.userId && !can(actor, 'visitors.manage')) throw forbidden('Only the host can acknowledge this arrival.');
    if (v.status !== 'HOST_NOTIFIED') throw unprocessable('There is no arrival awaiting acknowledgement.', 'INVALID_TRANSITION');
    const now = clock.nowIso();
    setVisitStatus(db, actor, v, 'WAITING', 'Host acknowledged arrival', { host_acknowledged_by: actor.userId, host_acknowledged_at: now });
    if (v.approving_officer_id !== actor.userId) {
      notify(db, {
        orgId: actor.orgId,
        userIds: [v.approving_officer_id],
        locationId: v.location_id,
        type: 'VISIT_APPROVAL_REQUESTED',
        title: 'Waiting visitor needs your authorization',
        body: `Host acknowledged visitor for ${v.reference}. The visitor is waiting at the gate.`,
        link: `/visitors/${id}`,
        relatedType: 'visit',
        relatedId: id,
      });
    }
    audit(ctx, { action: 'visit.host_acknowledge', entityType: 'visit', entityId: id, entityRef: v.reference, locationId: v.location_id });
    return getVisit(ctx, id);
  })();
}

// ---------------------------------------------------------------------------
// Gate-side visitor actions
// ---------------------------------------------------------------------------

function notifyHostOfArrival(db: DB, actor: Actor, v: VisitRow, gateName: string) {
  const name = (db.prepare('SELECT full_name FROM visitors WHERE id = ?').get(v.visitor_id) as { full_name: string }).full_name;
  notify(db, {
    orgId: actor.orgId,
    userIds: [v.host_user_id],
    locationId: v.location_id,
    type: 'VISITOR_ARRIVED',
    title: `${name} has arrived at ${gateName}`,
    body: `Please acknowledge visit ${v.reference}. The visitor is waiting at the gate.`,
    link: `/visitors/${v.id}`,
    relatedType: 'visit',
    relatedId: v.id,
  });
}

export function markArrived(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'gate.operate');
  const { gateId } = parse(z.object({ gateId: z.coerce.number().int().positive() }), body);
  const { db, actor } = ctx;
  return db.transaction(() => {
    const gate = loadGate(ctx, gateId);
    const v = db.prepare('SELECT * FROM visits WHERE id = ? AND organization_id = ?').get(id, actor.orgId) as VisitRow | undefined;
    if (!v || v.location_id !== gate.location_id) throw notFound('Visit');
    const now = clock.nowIso();
    if (v.status === 'EXPECTED') {
      setVisitStatus(db, actor, v, 'ARRIVED', `Arrived at ${gate.name}`, { arrived_at: now, arrived_gate_id: gate.id });
      setVisitStatus(db, actor, v, 'HOST_NOTIFIED', 'Host notified in-app');
      notifyHostOfArrival(db, actor, v, gate.name);
    } else if (v.status === 'APPROVED') {
      db.prepare('UPDATE visits SET arrived_at = COALESCE(arrived_at, ?), arrived_gate_id = COALESCE(arrived_gate_id, ?), updated_at = ? WHERE id = ?').run(now, gate.id, now, id);
      notifyHostOfArrival(db, actor, v, gate.name);
    } else {
      throw unprocessable(`Visit is ${VISIT_STATUS_INFO[v.status].label.toLowerCase()}; arrival cannot be recorded.`, 'INVALID_TRANSITION');
    }
    audit(ctx, { action: 'visit.arrival', entityType: 'visit', entityId: id, entityRef: v.reference, locationId: v.location_id, metadata: { gate: gate.code } });
    return gateVisitSummary(db, id);
  })();
}

const walkInSchema = z.object({
  gateId: z.coerce.number().int().positive(),
  visitor: visitorInput,
  hostUserId: z.coerce.number().int().positive(),
  purpose: zText(200),
  destination: zText(120),
  departureTime: zTime,
  vehicle: vehicleInput,
  notes: zOptText(500),
});

/** Register a visitor who arrived without pre-registration. Entry still requires authorization. */
export function registerWalkIn(ctx: Ctx, body: unknown) {
  requirePerm(ctx.actor, 'gate.operate');
  const input = parse(walkInSchema, body);
  const { db, actor, config } = ctx;
  const gate = loadGate(ctx, input.gateId);
  assertUserAtLocation(db, actor.orgId, input.hostUserId, gate.location_id, 'visitors.approve', 'Host / approving officer');
  const tz = config.timezone;
  const now = clock.now();
  const today = localDate(now, tz);
  const departure = zonedToUtc(today, input.departureTime, tz).toISOString();
  if (departure <= now.toISOString()) throw badRequest('Expected departure must be later today');
  return db.transaction(() => {
    const visitorId = resolveVisitor(db, { ...actor, locationIds: [gate.location_id] }, undefined, input.visitor);
    const vehicleId = input.vehicle
      ? findOrCreateVehicle(ctx, { registration: input.vehicle.registration, category: input.vehicle.category, makeModel: input.vehicle.makeModel, ownerType: 'VISITOR', visitorId, locationId: gate.location_id })
      : null;
    const reference = nextRef(db, actor.orgId, REF.VISIT);
    const nowIso = now.toISOString();
    const settings = getSettings(db, actor.orgId);
    const info = db
      .prepare(
        `INSERT INTO visits (organization_id, reference, location_id, visitor_id, source, host_user_id, approving_officer_id, purpose, destination,
           visit_date, expected_arrival, expected_departure, vehicle_id, notes, status, requires_security_check, arrived_at, arrived_gate_id,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'WALK_IN', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ARRIVED', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        actor.orgId,
        reference,
        gate.location_id,
        visitorId,
        input.hostUserId,
        input.hostUserId,
        input.purpose,
        input.destination,
        today,
        nowIso,
        departure,
        vehicleId,
        input.notes,
        settings['visit.requireSecurityCheck'] ? 1 : 0,
        nowIso,
        gate.id,
        actor.userId,
        nowIso,
        nowIso,
      );
    const id = Number(info.lastInsertRowid);
    db.prepare("INSERT INTO visit_status_history (visit_id, from_status, to_status, reason, actor_user_id, created_at) VALUES (?, NULL, 'ARRIVED', ?, ?, ?)").run(
      id,
      `Walk-in registered at ${gate.name}`,
      actor.userId,
      nowIso,
    );
    const v = db.prepare('SELECT * FROM visits WHERE id = ?').get(id) as VisitRow;
    setVisitStatus(db, actor, v, 'HOST_NOTIFIED', 'Host notified in-app');
    notifyHostOfArrival(db, actor, v, gate.name);
    audit(ctx, { action: 'visit.walk_in.register', entityType: 'visit', entityId: id, entityRef: reference, locationId: gate.location_id, metadata: { gate: gate.code } });
    return gateVisitSummary(db, id);
  })();
}

export function gateVisitSummary(db: DB, id: number) {
  return db
    .prepare(
      `SELECT v.id, v.reference, v.status, v.source, vr.full_name AS visitorName, vr.company AS visitorCompany, h.display_name AS hostName,
              v.destination, v.purpose, v.expected_arrival AS expectedArrival, v.expected_departure AS expectedDeparture, v.arrived_at AS arrivedAt,
              ve.display_registration AS vehicleRegistration
       FROM visits v JOIN visitors vr ON vr.id = v.visitor_id JOIN users h ON h.id = v.host_user_id LEFT JOIN vehicles ve ON ve.id = v.vehicle_id
       WHERE v.id = ?`,
    )
    .get(id) as Record<string, unknown>;
}

/** Today's visitor queue for a gate (minimal fields for guards). */
export function gateVisitorQueue(ctx: Ctx, gateId: number) {
  requirePerm(ctx.actor, 'gate.operate');
  const gate = loadGate(ctx, gateId);
  const today = localDate(clock.now(), ctx.config.timezone);
  return ctx.db
    .prepare(
      `SELECT v.id, v.reference, v.status, v.source, vr.full_name AS visitorName, vr.company AS visitorCompany, h.display_name AS hostName,
              v.destination, v.expected_arrival AS expectedArrival, v.expected_departure AS expectedDeparture, v.arrived_at AS arrivedAt
       FROM visits v JOIN visitors vr ON vr.id = v.visitor_id JOIN users h ON h.id = v.host_user_id
       WHERE v.location_id = ? AND v.organization_id = ?
         AND (v.status IN ('ARRIVED','HOST_NOTIFIED','WAITING','INSIDE','OVERDUE') OR (v.visit_date = ? AND v.status IN ('EXPECTED','APPROVED')))
       ORDER BY CASE v.status WHEN 'OVERDUE' THEN 0 WHEN 'HOST_NOTIFIED' THEN 1 WHEN 'WAITING' THEN 2 WHEN 'ARRIVED' THEN 3 WHEN 'APPROVED' THEN 4 WHEN 'EXPECTED' THEN 5 ELSE 6 END,
                v.expected_arrival LIMIT 100`,
    )
    .all(gate.location_id, ctx.actor.orgId, today);
}

// ---------------------------------------------------------------------------
// Waiting list
// ---------------------------------------------------------------------------

const waitingQuery = z.object({ locationId: z.coerce.number().int().positive().optional(), date: zDate.optional() });

export function waitingList(ctx: Ctx, raw: unknown) {
  requirePerm(ctx.actor, 'visitors.view', 'visitors.view_all');
  const q = parse(waitingQuery, raw);
  const scope = sqlIn('v.location_id', scopeIds(ctx.actor, q.locationId));
  const vis = visibilityFilter(ctx.actor);
  const tz = ctx.config.timezone;
  const date = q.date ?? localDate(clock.now(), tz);
  const [dayStart, dayEnd] = dateRangeToUtc(date, date, tz);
  const base = `${VISIT_SELECT} WHERE ${scope.sql} AND ${vis.sql} AND v.organization_id = ?`;
  const params = [...scope.params, ...vis.params, ctx.actor.orgId];
  const group = (cond: string, extra: unknown[] = []) =>
    ctx.db.prepare(`${base} AND ${cond} ORDER BY v.expected_arrival LIMIT 100`).all(...params, ...extra) as Record<string, unknown>[];
  const groups = {
    expected: group("v.status = 'EXPECTED' AND v.visit_date = ?", [date]),
    arrived: group("v.status = 'ARRIVED'"),
    awaitingAuthorization: group(`v.status IN (${VISIT_AWAITING_AUTHORIZATION.map((s) => `'${s}'`).join(',')}) AND (v.visit_date = ? OR v.status <> 'EXPECTED')`, [date]),
    awaitingHostAcknowledgement: group("v.status = 'HOST_NOTIFIED'"),
    approvedNotInside: group("v.status = 'APPROVED' AND v.visit_date = ?", [date]),
    inside: group("v.status = 'INSIDE'"),
    overdue: group("v.status = 'OVERDUE'"),
    completed: group("v.status = 'EXITED' AND v.exited_at >= ? AND v.exited_at < ?", [dayStart, dayEnd]),
  };
  return {
    date,
    generatedAt: clock.nowIso(),
    counts: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])),
    groups,
  };
}

export function eligibleApprovers(ctx: Ctx, locationId: number) {
  if (!inScope(ctx.actor, locationId)) throw notFound('Location');
  return ctx.db
    .prepare(
      `SELECT u.id, u.display_name AS name, u.designation, u.department FROM users u
       JOIN role_permissions rp ON rp.role_code = u.role_code AND rp.permission_code = 'visitors.approve'
       WHERE u.organization_id = ? AND u.is_active = 1
         AND EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = u.id AND ul.location_id = ?)
       ORDER BY u.display_name`,
    )
    .all(ctx.actor.orgId, locationId);
}

export function eligibleHosts(ctx: Ctx, locationId: number) {
  if (!inScope(ctx.actor, locationId)) throw notFound('Location');
  return ctx.db
    .prepare(
      `SELECT u.id, u.display_name AS name, u.designation, u.department FROM users u
       JOIN role_permissions rp ON rp.role_code = u.role_code AND rp.permission_code = 'visitors.view'
       WHERE u.organization_id = ? AND u.is_active = 1 AND u.role_code IN ('HOST','LOCATION_ADMIN')
         AND EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = u.id AND ul.location_id = ?)
       ORDER BY u.display_name`,
    )
    .all(ctx.actor.orgId, locationId);
}

export function searchVisitors(ctx: Ctx, q: string) {
  requirePerm(ctx.actor, 'visitors.create');
  if (q.trim().length < 2) return [];
  const like = likeParam(q.trim());
  const ids = ctx.actor.locationIds;
  if (!ids.length) return [];
  // Only visitors reachable through visits this user may open are searchable.
  const vis = visibilityFilter(ctx.actor);
  const inScope = `v.visitor_id = vr.id AND v.location_id IN (${ids.map(() => '?').join(',')}) AND ${vis.sql}`;
  return ctx.db
    .prepare(
      `SELECT vr.id, vr.full_name AS fullName, vr.company, vr.phone, vr.email,
              (SELECT MAX(v.visit_date) FROM visits v WHERE ${inScope}) AS lastVisit,
              (SELECT COUNT(*) FROM visits v WHERE ${inScope}) AS visitCount
       FROM visitors vr WHERE vr.organization_id = ?
         AND (vr.full_name LIKE ? ESCAPE '\\' OR vr.phone LIKE ? ESCAPE '\\' OR vr.company LIKE ? ESCAPE '\\')
         AND EXISTS (SELECT 1 FROM visits v WHERE ${inScope})
       ORDER BY vr.full_name LIMIT 10`,
    )
    .all(...ids, ...vis.params, ...ids, ...vis.params, ctx.actor.orgId, like, like, like, ...ids, ...vis.params);
}

export type { VisitStatus };
