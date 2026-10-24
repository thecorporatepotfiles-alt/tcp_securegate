import { z } from 'zod';
import type { Actor, Ctx } from '../auth/context.js';
import { assertInScope, can, canAny, requirePerm, scopeIds, sqlIn } from '../auth/context.js';
import { clock } from '../clock.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors.js';
import { dateRangeToUtc } from '../lib/time.js';
import { likeParam, listQuery, orderBy, parse, zDate, zIso, zOptText, zPhone, zText, type Page } from '../lib/http.js';
import { nextRef, REF } from '../lib/refs.js';
import { audit } from './audit.js';
import { notify, usersWithPermissionAt } from './notifications.js';
import { getSettings } from './settings.js';
import { setDeliveryStatus, type DeliveryRow } from './visitStatus.js';
import { getPresence, recordMovement, subjectHistory } from './movement.js';
import { loadGate, verify } from './verification.js';
import { findOrCreateVehicle } from './vehicles.js';
import { DELIVERY_AWAITING_COMPLETION, DELIVERY_STATUSES, DELIVERY_STATUS_INFO } from '../../../shared/constants.js';

const DELIVERY_SELECT = `SELECT d.id, d.reference, d.location_id AS locationId, l.name AS locationName, d.gate_id AS gateId, g.name AS gateName,
    d.category, d.company, d.courier_name AS courierName, d.courier_phone AS courierPhone, d.vehicle_id AS vehicleId,
    ve.display_registration AS vehicleRegistration, d.recipient_user_id AS recipientUserId, ru.display_name AS recipientUserName,
    d.recipient_name AS recipientName, d.recipient_department AS recipientDepartment, d.sponsor_user_id AS sponsorUserId,
    su.display_name AS sponsorName, d.description, d.item_count AS itemCount, d.status, d.requires_authorization AS requiresAuthorization,
    d.expected_at AS expectedAt, d.arrived_at AS arrivedAt, d.authorized_at AS authorizedAt, au.display_name AS authorizedBy,
    d.authorization_note AS authorizationNote, d.received_at AS receivedAt, rcu.display_name AS receivedByUser, d.received_by_name AS receivedByName,
    d.receipt_note AS receiptNote, d.departed_at AS departedAt, d.status_reason AS statusReason, d.notes,
    d.created_at AS createdAt, cb.display_name AS createdBy, d.updated_at AS updatedAt,
    pr.state AS presenceState
  FROM deliveries d
  JOIN locations l ON l.id = d.location_id
  LEFT JOIN gates g ON g.id = d.gate_id
  LEFT JOIN vehicles ve ON ve.id = d.vehicle_id
  LEFT JOIN users ru ON ru.id = d.recipient_user_id
  LEFT JOIN users su ON su.id = d.sponsor_user_id
  LEFT JOIN users au ON au.id = d.authorized_by
  LEFT JOIN users rcu ON rcu.id = d.received_by_user_id
  LEFT JOIN users cb ON cb.id = d.created_by
  LEFT JOIN presence pr ON pr.subject_type = 'DELIVERY' AND pr.subject_id = d.id`;

function visibility(actor: Actor) {
  if (canAny(actor, 'deliveries.view', 'deliveries.manage')) return { sql: '1', params: [] as unknown[] };
  return { sql: '(d.recipient_user_id = ? OR d.sponsor_user_id = ?)', params: [actor.userId, actor.userId] as unknown[] };
}

const deliveryListQuery = listQuery.extend({
  status: z.enum(DELIVERY_STATUSES).optional(),
  statusGroup: z.enum(['AWAITING_COMPLETION', 'OPEN', 'CLOSED']).optional(),
  category: z.string().max(40).optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  mine: z.coerce.boolean().optional(),
});

export function listDeliveries(ctx: Ctx, raw: unknown): Page<Record<string, unknown>> {
  requirePerm(ctx.actor, 'deliveries.view', 'deliveries.manage', 'deliveries.acknowledge');
  const q = parse(deliveryListQuery, raw);
  const scope = sqlIn('d.location_id', scopeIds(ctx.actor, q.locationId));
  const vis = visibility(ctx.actor);
  const where = [scope.sql, vis.sql, 'd.organization_id = ?'];
  const params: unknown[] = [...scope.params, ...vis.params, ctx.actor.orgId];
  if (q.status) {
    where.push('d.status = ?');
    params.push(q.status);
  }
  if (q.statusGroup === 'AWAITING_COMPLETION') where.push(`d.status IN (${DELIVERY_AWAITING_COMPLETION.map((s) => `'${s}'`).join(',')})`);
  if (q.statusGroup === 'OPEN') where.push("d.status IN ('EXPECTED','ARRIVED','AWAITING_AUTHORIZATION','AUTHORIZED','RECEIVED')");
  if (q.statusGroup === 'CLOSED') where.push("d.status IN ('DEPARTED','REJECTED','CANCELLED','RETURNED')");
  if (q.category) {
    where.push('d.category = ?');
    params.push(q.category);
  }
  if (q.mine) {
    where.push('(d.recipient_user_id = ? OR d.sponsor_user_id = ?)');
    params.push(ctx.actor.userId, ctx.actor.userId);
  }
  if (q.from || q.to) {
    const [start, end] = dateRangeToUtc(q.from ?? '2000-01-01', q.to ?? '2999-12-31', ctx.config.timezone);
    where.push('COALESCE(d.arrived_at, d.expected_at, d.created_at) >= ? AND COALESCE(d.arrived_at, d.expected_at, d.created_at) < ?');
    params.push(start, end);
  }
  if (q.q) {
    const like = likeParam(q.q);
    where.push("(d.reference LIKE ? ESCAPE '\\' OR d.company LIKE ? ESCAPE '\\' OR d.courier_name LIKE ? ESCAPE '\\' OR d.recipient_name LIKE ? ESCAPE '\\' OR d.recipient_department LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like, like);
  }
  const whereSql = where.join(' AND ');
  const order = orderBy(q.sort, q.dir, { arrivedAt: 'd.arrived_at', status: 'd.status', company: 'd.company', reference: 'd.reference' }, 'COALESCE(d.arrived_at, d.expected_at, d.created_at) DESC');
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM deliveries d WHERE ${whereSql}`).get(...params) as { n: number }).n;
  const items = ctx.db
    .prepare(`${DELIVERY_SELECT} WHERE ${whereSql} ORDER BY ${order}, d.id DESC LIMIT ? OFFSET ?`)
    .all(...params, q.pageSize, (q.page - 1) * q.pageSize) as Record<string, unknown>[];
  return { items, total, page: q.page, pageSize: q.pageSize };
}

function loadRow(ctx: Ctx, id: number): DeliveryRow {
  const d = ctx.db.prepare('SELECT * FROM deliveries WHERE id = ? AND organization_id = ?').get(id, ctx.actor.orgId) as DeliveryRow | undefined;
  if (!d) throw notFound('Delivery');
  assertInScope(ctx.actor, d.location_id, 'Delivery');
  const isParty = d.recipient_user_id === ctx.actor.userId || d.sponsor_user_id === ctx.actor.userId;
  if (!canAny(ctx.actor, 'deliveries.view', 'deliveries.manage', 'gate.operate') && !isParty) throw notFound('Delivery');
  return d;
}

function permissionsFor(ctx: Ctx, d: DeliveryRow) {
  const settings = getSettings(ctx.db, d.organization_id);
  const tr = settings['delivery.transitions'];
  const isParty = d.recipient_user_id === ctx.actor.userId || d.sponsor_user_id === ctx.actor.userId;
  return {
    canAuthorize: ['ARRIVED', 'AWAITING_AUTHORIZATION'].includes(d.status) && (tr[d.status] ?? []).includes('AUTHORIZED') && canAuthorize(ctx, d),
    canReject: (tr[d.status] ?? []).includes('REJECTED') && canAuthorize(ctx, d),
    canAcknowledge: d.status === 'AUTHORIZED' && (isParty && can(ctx.actor, 'deliveries.acknowledge') || can(ctx.actor, 'deliveries.manage')),
    canCancel: (tr[d.status] ?? []).includes('CANCELLED') && can(ctx.actor, 'deliveries.manage'),
  };
}

function canAuthorize(ctx: Ctx, d: DeliveryRow): boolean {
  if (can(ctx.actor, 'deliveries.authorize')) return true;
  const isParty = d.recipient_user_id === ctx.actor.userId || d.sponsor_user_id === ctx.actor.userId;
  if (isParty && can(ctx.actor, 'deliveries.acknowledge')) return true;
  return can(ctx.actor, 'gate.operate') && getSettings(ctx.db, d.organization_id)['gate.guardCanAuthorizeDelivery'];
}

export function getDelivery(ctx: Ctx, id: number) {
  const row = loadRow(ctx, id);
  const d = ctx.db.prepare(`${DELIVERY_SELECT} WHERE d.id = ?`).get(id) as Record<string, unknown>;
  const history = ctx.db
    .prepare(
      `SELECT h.from_status AS fromStatus, h.to_status AS toStatus, h.reason, h.created_at AS createdAt, COALESCE(u.display_name, 'System') AS actor
       FROM delivery_status_history h LEFT JOIN users u ON u.id = h.actor_user_id WHERE h.delivery_id = ? ORDER BY h.id`,
    )
    .all(id);
  return { ...d, history, events: subjectHistory(ctx, 'DELIVERY', id), permissions: permissionsFor(ctx, row) };
}

const createSchema = z.object({
  locationId: z.coerce.number().int().positive().optional(),
  gateId: z.coerce.number().int().positive().optional(),
  arrivedNow: z.boolean().default(false),
  category: z.string().trim().min(1).max(40),
  company: zText(120),
  courierName: zText(120),
  courierPhone: zPhone,
  vehicleRegistration: z.string().trim().max(20).optional().nullable(),
  recipientUserId: z.coerce.number().int().positive().optional().nullable(),
  recipientName: zOptText(120),
  recipientDepartment: zText(120),
  sponsorUserId: z.coerce.number().int().positive().optional().nullable(),
  description: zText(300),
  itemCount: z.coerce.number().int().min(0).max(10000),
  expectedAt: zIso.optional().nullable(),
  notes: zOptText(1000),
});

export function createDelivery(ctx: Ctx, body: unknown) {
  requirePerm(ctx.actor, 'deliveries.manage', 'gate.operate');
  const input = parse(createSchema, body);
  const { db, actor } = ctx;
  const gate = input.gateId ? loadGate(ctx, input.gateId) : null;
  const locationId = gate?.location_id ?? input.locationId;
  if (!locationId) throw badRequest('Select a location or gate');
  assertInScope(actor, locationId, 'Location');
  if (!can(actor, 'deliveries.manage') && !input.arrivedNow) throw forbidden('Gate operators register deliveries on arrival.');
  if (input.arrivedNow && !gate) throw badRequest('Arrival must be recorded at a gate');
  const settings = getSettings(db, actor.orgId);
  if (!settings['delivery.categories'].some((c) => c.code === input.category)) throw badRequest(`Unknown delivery category: ${input.category}`);
  for (const uid of [input.recipientUserId, input.sponsorUserId]) {
    if (uid && !db.prepare('SELECT 1 FROM users WHERE id = ? AND organization_id = ? AND is_active = 1').get(uid, actor.orgId)) throw badRequest('Recipient or sponsor is not an active user');
  }
  return db.transaction(() => {
    const vehicleId = input.vehicleRegistration
      ? findOrCreateVehicle(ctx, { registration: input.vehicleRegistration, ownerType: 'DELIVERY', ownerName: input.company, locationId })
      : null;
    const reference = nextRef(db, actor.orgId, REF.DELIVERY);
    const now = clock.nowIso();
    const info = db
      .prepare(
        `INSERT INTO deliveries (organization_id, reference, location_id, gate_id, category, company, courier_name, courier_phone, vehicle_id,
           recipient_user_id, recipient_name, recipient_department, sponsor_user_id, description, item_count, status, requires_authorization,
           expected_at, notes, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EXPECTED', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        actor.orgId,
        reference,
        locationId,
        gate?.id ?? null,
        input.category,
        input.company,
        input.courierName,
        input.courierPhone,
        vehicleId,
        input.recipientUserId ?? null,
        input.recipientName,
        input.recipientDepartment,
        input.sponsorUserId ?? null,
        input.description,
        input.itemCount,
        settings['delivery.requireAuthorization'] ? 1 : 0,
        input.expectedAt ?? null,
        input.notes,
        actor.userId,
        now,
        now,
      );
    const id = Number(info.lastInsertRowid);
    db.prepare("INSERT INTO delivery_status_history (delivery_id, from_status, to_status, reason, actor_user_id, created_at) VALUES (?, NULL, 'EXPECTED', 'Delivery registered', ?, ?)").run(
      id,
      actor.userId,
      now,
    );
    audit(ctx, { action: 'delivery.register', entityType: 'delivery', entityId: id, entityRef: reference, locationId, metadata: { category: input.category, items: input.itemCount, arrivedNow: input.arrivedNow } });
    if (input.arrivedNow && gate) arrive(ctx, id, gate.id);
    return getDelivery(ctx, id);
  })();
}

function arrive(ctx: Ctx, id: number, gateId: number) {
  const { db, actor } = ctx;
  const d = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) as DeliveryRow;
  const gate = loadGate(ctx, gateId);
  if (d.location_id !== gate.location_id) throw notFound('Delivery');
  const now = clock.nowIso();
  setDeliveryStatus(db, actor, d, 'ARRIVED', `Arrival recorded at ${gate.name}`, { arrived_at: now, gate_id: gate.id });
  if (d.requires_authorization === 1) {
    setDeliveryStatus(db, actor, d, 'AWAITING_AUTHORIZATION', 'Awaiting authorization');
    const recipients = [d.recipient_user_id, d.sponsor_user_id].filter((x): x is number => !!x);
    notify(db, {
      orgId: actor.orgId,
      userIds: [...recipients, ...usersWithPermissionAt(db, actor.orgId, 'deliveries.authorize', d.location_id)],
      locationId: d.location_id,
      type: 'DELIVERY_ARRIVED',
      title: `Delivery ${d.reference} at ${gate.name}`,
      body: `${d.company} (${d.courier_name}) has arrived and is awaiting authorization.`,
      link: `/deliveries/${id}`,
      relatedType: 'delivery',
      relatedId: id,
    });
  } else {
    setDeliveryStatus(db, actor, d, 'AUTHORIZED', 'Authorization not required by configuration', { authorized_at: now, authorization_note: 'Not required by configuration' });
    const recipients = [d.recipient_user_id, d.sponsor_user_id].filter((x): x is number => !!x);
    notify(db, {
      orgId: actor.orgId,
      userIds: recipients,
      locationId: d.location_id,
      type: 'DELIVERY_ARRIVED',
      title: `Delivery ${d.reference} arrived`,
      body: `${d.company} delivery has arrived. Please acknowledge receipt when received.`,
      link: `/deliveries/${id}`,
      relatedType: 'delivery',
      relatedId: id,
    });
  }
  audit(ctx, { action: 'delivery.arrival', entityType: 'delivery', entityId: id, entityRef: d.reference, locationId: d.location_id, metadata: { gate: gate.code } });
}

export function recordDeliveryArrival(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'gate.operate');
  const { gateId } = parse(z.object({ gateId: z.coerce.number().int().positive() }), body);
  return ctx.db.transaction(() => {
    const d = loadRow(ctx, id);
    if (d.status !== 'EXPECTED') throw unprocessable(`Delivery is ${DELIVERY_STATUS_INFO[d.status].label.toLowerCase()}.`, 'INVALID_TRANSITION');
    arrive(ctx, id, gateId);
    return getDelivery(ctx, id);
  })();
}

const noteSchema = z.object({ note: z.string().trim().max(1000).optional() });
const reasonSchema = z.object({ reason: z.string().trim().min(3, 'A reason is required').max(1000) });

export function authorizeDelivery(ctx: Ctx, id: number, body: unknown) {
  const { note } = parse(noteSchema, body);
  const { db, actor } = ctx;
  return db.transaction(() => {
    const d = loadRow(ctx, id);
    if (!canAuthorize(ctx, d)) throw forbidden('You are not permitted to authorize this delivery.');
    if (!['ARRIVED', 'AWAITING_AUTHORIZATION'].includes(d.status)) throw unprocessable(`Delivery is ${DELIVERY_STATUS_INFO[d.status].label.toLowerCase()}.`, 'INVALID_TRANSITION');
    const now = clock.nowIso();
    setDeliveryStatus(db, actor, d, 'AUTHORIZED', note ? `Authorized: ${note}` : 'Authorized to proceed under applicable procedures', {
      authorized_by: actor.userId,
      authorized_at: now,
      authorization_note: note ?? null,
    });
    const recipients = [d.recipient_user_id, d.sponsor_user_id].filter((x): x is number => !!x && x !== actor.userId);
    notify(db, {
      orgId: actor.orgId,
      userIds: recipients,
      locationId: d.location_id,
      type: 'DELIVERY_AUTHORIZED',
      title: `Delivery ${d.reference} authorized`,
      body: 'Please acknowledge receipt once the delivery is received.',
      link: `/deliveries/${id}`,
      relatedType: 'delivery',
      relatedId: id,
    });
    audit(ctx, { action: 'delivery.authorize', entityType: 'delivery', entityId: id, entityRef: d.reference, locationId: d.location_id, metadata: { note } });
    return getDelivery(ctx, id);
  })();
}

export function rejectDelivery(ctx: Ctx, id: number, body: unknown) {
  const { reason } = parse(reasonSchema, body);
  const { db, actor } = ctx;
  return db.transaction(() => {
    const d = loadRow(ctx, id);
    if (!canAuthorize(ctx, d)) throw forbidden('You are not permitted to reject this delivery.');
    setDeliveryStatus(db, actor, d, 'REJECTED', `Rejected: ${reason}`, { status_reason: reason });
    audit(ctx, { action: 'delivery.reject', entityType: 'delivery', entityId: id, entityRef: d.reference, locationId: d.location_id, metadata: { reason } });
    return getDelivery(ctx, id);
  })();
}

export function cancelDelivery(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'deliveries.manage');
  const { reason } = parse(reasonSchema, body);
  return ctx.db.transaction(() => {
    const d = loadRow(ctx, id);
    setDeliveryStatus(ctx.db, ctx.actor, d, 'CANCELLED', `Cancelled: ${reason}`, { status_reason: reason });
    audit(ctx, { action: 'delivery.cancel', entityType: 'delivery', entityId: id, entityRef: d.reference, locationId: d.location_id, metadata: { reason } });
    return getDelivery(ctx, id);
  })();
}

const ackSchema = z.object({
  receivedByName: zOptText(120),
  note: zOptText(1000),
});

/** Record who acknowledged receipt and when. Authorization is not proof of inspection or acceptance. */
export function acknowledgeReceipt(ctx: Ctx, id: number, body: unknown) {
  const input = parse(ackSchema, body);
  const { db, actor } = ctx;
  return db.transaction(() => {
    const d = loadRow(ctx, id);
    const isParty = d.recipient_user_id === actor.userId || d.sponsor_user_id === actor.userId;
    if (!(isParty && can(actor, 'deliveries.acknowledge')) && !can(actor, 'deliveries.manage')) {
      throw forbidden('Only the recipient, sponsor or a delivery administrator can acknowledge receipt.');
    }
    if (d.status !== 'AUTHORIZED') throw unprocessable('Receipt can only be acknowledged for an authorized delivery.', 'INVALID_TRANSITION');
    const now = clock.nowIso();
    setDeliveryStatus(db, actor, d, 'RECEIVED', 'Receipt acknowledged', {
      received_by_user_id: actor.userId,
      received_by_name: input.receivedByName ?? actor.displayName,
      received_at: now,
      receipt_note: input.note,
    });
    audit(ctx, {
      action: 'delivery.receipt.acknowledge',
      entityType: 'delivery',
      entityId: id,
      entityRef: d.reference,
      locationId: d.location_id,
      metadata: { receivedByName: input.receivedByName ?? actor.displayName, note: input.note },
    });
    return getDelivery(ctx, id);
  })();
}

const departSchema = z.object({
  gateId: z.coerce.number().int().positive(),
  reason: zOptText(500),
});

/**
 * Record the courier's departure. If the delivery person was recorded inside,
 * an EXIT event is recorded through the standard verification pipeline.
 */
export function recordDeliveryDeparture(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'gate.operate');
  const input = parse(departSchema, body);
  const { db, actor } = ctx;
  return db.transaction(() => {
    const d = loadRow(ctx, id);
    const gate = loadGate(ctx, input.gateId);
    if (d.location_id !== gate.location_id) throw notFound('Delivery');
    if (d.departed_at || d.status === 'DEPARTED') throw conflict('Departure has already been recorded.', 'ALREADY_DEPARTED');
    if (d.status === 'EXPECTED') throw unprocessable('Arrival has not been recorded for this delivery.', 'INVALID_TRANSITION');
    const presence = getPresence(db, 'DELIVERY', id);
    if (presence?.state === 'INSIDE') {
      const v = verify(ctx, { gateId: gate.id, mode: 'DELIVERY', input: d.reference, method: 'REFERENCE' });
      recordMovement(ctx, { attemptId: v.attemptId, eventType: 'EXIT', notes: 'Courier departure' });
    }
    const now = clock.nowIso();
    if (d.status === 'RECEIVED') {
      setDeliveryStatus(db, actor, d, 'DEPARTED', `Departed via ${gate.name}`, { departed_at: now, departed_gate_id: gate.id });
    } else if (['ARRIVED', 'AWAITING_AUTHORIZATION', 'AUTHORIZED'].includes(d.status)) {
      if (!input.reason) throw badRequest('The delivery was not received. Record a reason for the courier leaving.');
      setDeliveryStatus(db, actor, d, 'RETURNED', `Courier departed without completed receipt: ${input.reason}`, {
        departed_at: now,
        departed_gate_id: gate.id,
        status_reason: input.reason,
      });
    } else {
      db.prepare('UPDATE deliveries SET departed_at = ?, departed_gate_id = ?, updated_at = ? WHERE id = ?').run(now, gate.id, now, id);
      db.prepare('INSERT INTO delivery_status_history (delivery_id, from_status, to_status, reason, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        id,
        d.status,
        d.status,
        `Courier departed via ${gate.name}`,
        actor.userId,
        now,
      );
    }
    audit(ctx, { action: 'delivery.departure', entityType: 'delivery', entityId: id, entityRef: d.reference, locationId: d.location_id, metadata: { gate: gate.code, reason: input.reason } });
    return getDelivery(ctx, id);
  })();
}

/** Open deliveries at a gate's location for the gate interface. */
export function gateDeliveryQueue(ctx: Ctx, gateId: number) {
  requirePerm(ctx.actor, 'gate.operate');
  const gate = loadGate(ctx, gateId);
  return ctx.db
    .prepare(
      `${DELIVERY_SELECT} WHERE d.location_id = ? AND d.organization_id = ?
         AND (d.status IN ('EXPECTED','ARRIVED','AWAITING_AUTHORIZATION','AUTHORIZED','RECEIVED') OR (d.status IN ('REJECTED','RETURNED') AND d.departed_at IS NULL AND d.arrived_at IS NOT NULL))
       ORDER BY CASE d.status WHEN 'AWAITING_AUTHORIZATION' THEN 0 WHEN 'AUTHORIZED' THEN 1 WHEN 'RECEIVED' THEN 2 WHEN 'ARRIVED' THEN 3 ELSE 4 END, d.id DESC LIMIT 100`,
    )
    .all(gate.location_id, ctx.actor.orgId);
}

export function deliveryRecipients(ctx: Ctx, locationId: number) {
  assertInScope(ctx.actor, locationId, 'Location');
  return ctx.db
    .prepare(
      `SELECT u.id, u.display_name AS name, u.department FROM users u
       JOIN role_permissions rp ON rp.role_code = u.role_code AND rp.permission_code = 'deliveries.acknowledge'
       WHERE u.organization_id = ? AND u.is_active = 1 AND EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = u.id AND ul.location_id = ?)
       ORDER BY u.display_name`,
    )
    .all(ctx.actor.orgId, locationId);
}
