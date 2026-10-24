import { z } from 'zod';
import type { Ctx } from '../auth/context.js';
import { assertInScope, can, requirePerm, scopeIds, sqlIn } from '../auth/context.js';
import { clock } from '../clock.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { likeParam, listQuery, orderBy, parse, zOptDate, zOptText, type Page } from '../lib/http.js';
import { audit } from './audit.js';
import { getPresence, subjectHistory } from './movement.js';
import { getSettings } from './settings.js';
import { loadGate } from './verification.js';
import { VEHICLE_AUTH_STATUSES, VEHICLE_OWNER_TYPES, normalizePlate, type VehicleOwnerType } from '../../../shared/constants.js';

const VEHICLE_SELECT = `SELECT v.id, v.registration_number AS registrationNumber, v.display_registration AS registration, v.category,
    v.make_model AS makeModel, v.colour, v.owner_type AS ownerType, v.personnel_id AS personnelId, v.contractor_id AS contractorId,
    v.visitor_id AS visitorId, v.owner_name AS ownerName,
    COALESCE(
      (SELECT TRIM(COALESCE(p.rank || ' ', '') || p.full_name) FROM personnel p WHERE p.id = v.personnel_id),
      (SELECT c.full_name FROM contractors c WHERE c.id = v.contractor_id),
      (SELECT vr.full_name FROM visitors vr WHERE vr.id = v.visitor_id),
      v.owner_name
    ) AS ownerDisplay,
    v.registered_location_id AS locationId, l.name AS locationName, v.authorization_status AS authorizationStatus,
    v.authorized_until AS authorizedUntil, v.notes, v.created_at AS createdAt, v.updated_at AS updatedAt,
    pr.state AS presenceState, pr.since AS presenceSince, pl.name AS presenceLocation
  FROM vehicles v
  JOIN locations l ON l.id = v.registered_location_id
  LEFT JOIN presence pr ON pr.subject_type = 'VEHICLE' AND pr.subject_id = v.id
  LEFT JOIN locations pl ON pl.id = pr.location_id`;

function visibleClause(ids: number[]) {
  const a = sqlIn('v.registered_location_id', ids);
  const b = sqlIn('vl.location_id', ids);
  return {
    sql: `(${a.sql} OR EXISTS (SELECT 1 FROM vehicle_locations vl WHERE vl.vehicle_id = v.id AND ${b.sql}))`,
    params: [...a.params, ...b.params],
  };
}

const vehicleListQuery = listQuery.extend({
  category: z.string().max(40).optional(),
  authorizationStatus: z.enum(VEHICLE_AUTH_STATUSES).optional(),
  presence: z.enum(['INSIDE', 'OUTSIDE']).optional(),
  ownerType: z.enum(VEHICLE_OWNER_TYPES).optional(),
});

export function listVehicles(ctx: Ctx, raw: unknown): Page<Record<string, unknown>> {
  requirePerm(ctx.actor, 'vehicles.view');
  const q = parse(vehicleListQuery, raw);
  const vis = visibleClause(scopeIds(ctx.actor, q.locationId));
  const where = [vis.sql, 'v.organization_id = ?'];
  const params: unknown[] = [...vis.params, ctx.actor.orgId];
  if (q.category) {
    where.push('v.category = ?');
    params.push(q.category);
  }
  if (q.authorizationStatus) {
    where.push('v.authorization_status = ?');
    params.push(q.authorizationStatus);
  }
  if (q.ownerType) {
    where.push('v.owner_type = ?');
    params.push(q.ownerType);
  }
  if (q.presence === 'INSIDE') where.push("pr.state = 'INSIDE'");
  if (q.presence === 'OUTSIDE') where.push("(pr.state IS NULL OR pr.state = 'OUTSIDE')");
  if (q.q) {
    const like = likeParam(q.q);
    const plate = likeParam(normalizePlate(q.q));
    where.push("(v.registration_number LIKE ? ESCAPE '\\' OR v.make_model LIKE ? ESCAPE '\\' OR v.owner_name LIKE ? ESCAPE '\\')");
    params.push(plate, like, like);
  }
  const whereSql = where.join(' AND ');
  const order = orderBy(q.sort, q.dir, { registration: 'v.registration_number', category: 'v.category', updatedAt: 'v.updated_at', presenceSince: 'pr.since' }, 'v.updated_at DESC');
  const total = (
    ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM vehicles v LEFT JOIN presence pr ON pr.subject_type = 'VEHICLE' AND pr.subject_id = v.id WHERE ${whereSql}`)
      .get(...params) as { n: number }
  ).n;
  const items = ctx.db
    .prepare(`${VEHICLE_SELECT} WHERE ${whereSql} ORDER BY ${order}, v.id DESC LIMIT ? OFFSET ?`)
    .all(...params, q.pageSize, (q.page - 1) * q.pageSize) as Record<string, unknown>[];
  return { items, total, page: q.page, pageSize: q.pageSize };
}

function loadVehicle(ctx: Ctx, id: number): Record<string, any> {
  const v = ctx.db.prepare(`${VEHICLE_SELECT} WHERE v.id = ? AND v.organization_id = ?`).get(id, ctx.actor.orgId) as Record<string, any> | undefined;
  if (!v) throw notFound('Vehicle');
  const authorizedLocations = ctx.db
    .prepare('SELECT l.id, l.name FROM vehicle_locations vl JOIN locations l ON l.id = vl.location_id WHERE vl.vehicle_id = ?')
    .all(id) as { id: number; name: string }[];
  const visible = ctx.actor.locationIds.includes(v.locationId) || authorizedLocations.some((l) => ctx.actor.locationIds.includes(l.id));
  if (!visible) throw notFound('Vehicle');
  return { ...v, authorizedLocations };
}

export function getVehicle(ctx: Ctx, id: number) {
  requirePerm(ctx.actor, 'vehicles.view');
  const v = loadVehicle(ctx, id);
  const linkedVisits = ctx.db
    .prepare(
      `SELECT v.id, v.reference, v.status, v.visit_date AS visitDate, vr.full_name AS visitorName FROM visits v JOIN visitors vr ON vr.id = v.visitor_id
       WHERE v.vehicle_id = ? AND v.location_id IN (${ctx.actor.locationIds.map(() => '?').join(',') || 'NULL'}) ORDER BY v.id DESC LIMIT 10`,
    )
    .all(id, ...ctx.actor.locationIds);
  const linkedDeliveries = ctx.db
    .prepare(
      `SELECT d.id, d.reference, d.status, d.company, d.arrived_at AS arrivedAt FROM deliveries d
       WHERE d.vehicle_id = ? AND d.location_id IN (${ctx.actor.locationIds.map(() => '?').join(',') || 'NULL'}) ORDER BY d.id DESC LIMIT 10`,
    )
    .all(id, ...ctx.actor.locationIds);
  return { ...v, events: subjectHistory(ctx, 'VEHICLE', id), linkedVisits, linkedDeliveries, canManage: can(ctx.actor, 'vehicles.manage') };
}

const vehicleSchema = z.object({
  registration: z.string().trim().min(4, 'Registration number is too short').max(20),
  category: z.string().trim().min(1).max(40),
  makeModel: zOptText(80),
  colour: zOptText(30),
  ownerType: z.enum(VEHICLE_OWNER_TYPES),
  personnelId: z.coerce.number().int().positive().optional().nullable(),
  contractorId: z.coerce.number().int().positive().optional().nullable(),
  ownerName: zOptText(120),
  locationId: z.coerce.number().int().positive(),
  authorizationStatus: z.enum(VEHICLE_AUTH_STATUSES).default('PENDING'),
  authorizedUntil: zOptDate,
  authorizedLocationIds: z.array(z.coerce.number().int().positive()).max(10).default([]),
  notes: zOptText(500),
});

function validateCategory(ctx: Ctx, category: string) {
  const cats = getSettings(ctx.db, ctx.actor.orgId)['vehicle.categories'];
  if (!cats.some((c) => c.code === category)) throw badRequest(`Unknown vehicle category: ${category}`);
}

function validateOwner(ctx: Ctx, input: { ownerType: VehicleOwnerType; personnelId?: number | null; contractorId?: number | null }) {
  if (input.ownerType === 'PERSONNEL') {
    if (!input.personnelId) throw badRequest('Select the associated personnel record');
    if (!ctx.db.prepare('SELECT 1 FROM personnel WHERE id = ? AND organization_id = ?').get(input.personnelId, ctx.actor.orgId)) throw notFound('Personnel');
  }
  if (input.ownerType === 'CONTRACTOR') {
    if (!input.contractorId) throw badRequest('Select the associated contractor record');
    if (!ctx.db.prepare('SELECT 1 FROM contractors WHERE id = ? AND organization_id = ?').get(input.contractorId, ctx.actor.orgId)) throw notFound('Contractor');
  }
}

export function createVehicle(ctx: Ctx, body: unknown) {
  requirePerm(ctx.actor, 'vehicles.manage');
  const input = parse(vehicleSchema, body);
  assertInScope(ctx.actor, input.locationId, 'Location');
  for (const l of input.authorizedLocationIds) assertInScope(ctx.actor, l, 'Location');
  validateCategory(ctx, input.category);
  validateOwner(ctx, input);
  const plate = normalizePlate(input.registration);
  return ctx.db.transaction(() => {
    if (ctx.db.prepare('SELECT 1 FROM vehicles WHERE organization_id = ? AND registration_number = ?').get(ctx.actor.orgId, plate)) {
      throw conflict(`Vehicle ${input.registration.toUpperCase()} is already registered.`, 'DUPLICATE_VEHICLE');
    }
    const now = clock.nowIso();
    const info = ctx.db
      .prepare(
        `INSERT INTO vehicles (organization_id, registration_number, display_registration, category, make_model, colour, owner_type, personnel_id,
           contractor_id, owner_name, registered_location_id, authorization_status, authorized_until, notes, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.actor.orgId,
        plate,
        input.registration.toUpperCase().replace(/\s+/g, ' '),
        input.category,
        input.makeModel,
        input.colour,
        input.ownerType,
        input.ownerType === 'PERSONNEL' ? input.personnelId : null,
        input.ownerType === 'CONTRACTOR' ? input.contractorId : null,
        input.ownerName,
        input.locationId,
        input.authorizationStatus,
        input.authorizedUntil ?? null,
        input.notes,
        ctx.actor.userId,
        now,
        now,
      );
    const id = Number(info.lastInsertRowid);
    const ins = ctx.db.prepare('INSERT OR IGNORE INTO vehicle_locations (vehicle_id, location_id) VALUES (?, ?)');
    for (const l of input.authorizedLocationIds) ins.run(id, l);
    audit(ctx, { action: 'vehicle.register', entityType: 'vehicle', entityId: id, entityRef: plate, locationId: input.locationId, metadata: { category: input.category, authorizationStatus: input.authorizationStatus } });
    return getVehicle(ctx, id);
  })();
}

const updateSchema = vehicleSchema.partial().extend({ reason: zOptText(500) });

export function updateVehicle(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'vehicles.manage');
  const input = parse(updateSchema, body);
  return ctx.db.transaction(() => {
    const existing = loadVehicle(ctx, id);
    assertInScope(ctx.actor, existing.locationId, 'Vehicle');
    if (input.category) validateCategory(ctx, input.category);
    if (input.locationId) assertInScope(ctx.actor, input.locationId, 'Location');
    const ownerType = input.ownerType ?? existing.ownerType;
    if (input.ownerType) validateOwner(ctx, { ownerType, personnelId: input.personnelId, contractorId: input.contractorId });
    const fields: Record<string, unknown> = {
      category: input.category,
      make_model: input.makeModel,
      colour: input.colour,
      owner_type: input.ownerType,
      personnel_id: input.ownerType ? (ownerType === 'PERSONNEL' ? input.personnelId : null) : undefined,
      contractor_id: input.ownerType ? (ownerType === 'CONTRACTOR' ? input.contractorId : null) : undefined,
      owner_name: input.ownerName,
      registered_location_id: input.locationId,
      authorization_status: input.authorizationStatus,
      authorized_until: input.authorizedUntil,
      notes: input.notes,
    };
    const set = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (set.length) {
      ctx.db
        .prepare(`UPDATE vehicles SET ${set.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...set.map(([, v]) => v), clock.nowIso(), id);
    }
    if (input.authorizedLocationIds) {
      for (const l of input.authorizedLocationIds) assertInScope(ctx.actor, l, 'Location');
      ctx.db.prepare('DELETE FROM vehicle_locations WHERE vehicle_id = ?').run(id);
      const ins = ctx.db.prepare('INSERT OR IGNORE INTO vehicle_locations (vehicle_id, location_id) VALUES (?, ?)');
      for (const l of input.authorizedLocationIds) ins.run(id, l);
    }
    audit(ctx, {
      action: input.authorizationStatus && input.authorizationStatus !== existing.authorizationStatus ? 'vehicle.authorization.change' : 'vehicle.update',
      entityType: 'vehicle',
      entityId: id,
      entityRef: existing.registrationNumber,
      locationId: existing.locationId,
      metadata: { changed: set.map(([k]) => k), from: existing.authorizationStatus, to: input.authorizationStatus, reason: input.reason },
    });
    return getVehicle(ctx, id);
  })();
}

/** Used by visit/delivery/gate flows: reuse the registered vehicle or create a pending record. */
export function findOrCreateVehicle(
  ctx: Ctx,
  input: { registration: string; category?: string; makeModel?: string; ownerType: VehicleOwnerType; visitorId?: number; ownerName?: string; locationId: number },
): number {
  const plate = normalizePlate(input.registration);
  if (plate.length < 4) throw badRequest('Vehicle registration number is too short');
  const existing = ctx.db.prepare('SELECT id, authorization_status FROM vehicles WHERE organization_id = ? AND registration_number = ?').get(ctx.actor.orgId, plate) as
    | { id: number; authorization_status: string }
    | undefined;
  if (existing) return existing.id;
  const cats = getSettings(ctx.db, ctx.actor.orgId)['vehicle.categories'];
  const category = input.category && cats.some((c) => c.code === input.category) ? input.category : input.ownerType === 'DELIVERY' ? 'DELIVERY_VEHICLE' : 'CAR';
  const now = clock.nowIso();
  const info = ctx.db
    .prepare(
      `INSERT INTO vehicles (organization_id, registration_number, display_registration, category, make_model, owner_type, visitor_id, owner_name,
         registered_location_id, authorization_status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
    )
    .run(
      ctx.actor.orgId,
      plate,
      input.registration.toUpperCase().trim().replace(/\s+/g, ' '),
      category,
      input.makeModel ?? null,
      input.ownerType,
      input.visitorId ?? null,
      input.ownerName ?? null,
      input.locationId,
      ctx.actor.userId,
      now,
      now,
    );
  const id = Number(info.lastInsertRowid);
  audit(ctx, { action: 'vehicle.register', entityType: 'vehicle', entityId: id, entityRef: plate, locationId: input.locationId, metadata: { via: input.ownerType, authorizationStatus: 'PENDING' } });
  return id;
}

const gateRegisterSchema = z.object({
  gateId: z.coerce.number().int().positive(),
  registration: z.string().trim().min(4).max(20),
  category: z.string().trim().min(1).max(40),
  makeModel: zOptText(80),
  colour: zOptText(30),
  ownerType: z.enum(['VISITOR', 'CONTRACTOR', 'DELIVERY', 'OTHER']).default('OTHER'),
  ownerName: zOptText(120),
  notes: zOptText(300),
});

/** Guards may add an unregistered vehicle; it starts as PENDING and needs authorization or manual review. */
export function gateRegisterVehicle(ctx: Ctx, body: unknown) {
  requirePerm(ctx.actor, 'gate.operate');
  const input = parse(gateRegisterSchema, body);
  const gate = loadGate(ctx, input.gateId);
  validateCategory(ctx, input.category);
  const plate = normalizePlate(input.registration);
  return ctx.db.transaction(() => {
    if (ctx.db.prepare('SELECT 1 FROM vehicles WHERE organization_id = ? AND registration_number = ?').get(ctx.actor.orgId, plate)) {
      throw conflict('This vehicle is already registered. Verify it instead.', 'DUPLICATE_VEHICLE');
    }
    const now = clock.nowIso();
    const info = ctx.db
      .prepare(
        `INSERT INTO vehicles (organization_id, registration_number, display_registration, category, make_model, colour, owner_type, owner_name,
           registered_location_id, authorization_status, notes, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`,
      )
      .run(ctx.actor.orgId, plate, input.registration.toUpperCase().trim().replace(/\s+/g, ' '), input.category, input.makeModel, input.colour, input.ownerType, input.ownerName, gate.location_id, input.notes, ctx.actor.userId, now, now);
    const id = Number(info.lastInsertRowid);
    audit(ctx, { action: 'vehicle.register', entityType: 'vehicle', entityId: id, entityRef: plate, locationId: gate.location_id, metadata: { via: 'gate', gate: gate.code } });
    return { id, registration: plate, authorizationStatus: 'PENDING', presence: getPresence(ctx.db, 'VEHICLE', id) };
  })();
}
