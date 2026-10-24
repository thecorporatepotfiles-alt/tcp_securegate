import { z } from 'zod';
import type { Ctx } from '../auth/context.js';
import { assertInScope, can, requirePerm, sqlIn } from '../auth/context.js';
import { clock } from '../clock.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { hashPassword } from '../lib/crypto.js';
import { likeParam, listQuery, parse, parsePatch, zOptText, zText, type Page } from '../lib/http.js';
import { audit } from './audit.js';
import { invalidatePermissionCache } from '../auth/permissions.js';
import { revokeUserSessions } from '../auth/sessions.js';
import {
  ALL_PERMISSIONS,
  ASSIGNABLE_ROLES,
  GATE_TYPES,
  LOCKED_ADMIN_PERMISSIONS,
  PERMISSIONS,
  ROLES,
  ROLE_INFO,
  type Permission,
  type RoleCode,
} from '../../../shared/constants.js';

export const PASSWORD_RULE = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Password must contain letters and digits');

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const USER_SELECT = `SELECT u.id, u.username, u.display_name AS displayName, u.designation, u.department, u.role_code AS role,
    u.all_locations AS allLocations, u.primary_location_id AS primaryLocationId, pl.name AS primaryLocationName,
    u.assigned_gate_id AS assignedGateId, g.name AS assignedGateName, u.is_active AS isActive, u.is_demo AS isDemo,
    u.last_login_at AS lastLoginAt, u.locked_until AS lockedUntil, u.created_at AS createdAt, u.updated_at AS updatedAt,
    (SELECT GROUP_CONCAT(ul.location_id) FROM user_locations ul WHERE ul.user_id = u.id) AS locationIdsCsv
  FROM users u LEFT JOIN locations pl ON pl.id = u.primary_location_id LEFT JOIN gates g ON g.id = u.assigned_gate_id`;

function shapeUser(r: Record<string, any>): Record<string, any> {
  const { locationIdsCsv, ...rest } = r;
  return { ...rest, locationIds: locationIdsCsv ? String(locationIdsCsv).split(',').map(Number) : [] };
}

/** Non-system administrators only see/manage users entirely within their own locations. */
function managedScope(ctx: Ctx) {
  if (ctx.actor.role === 'SYSTEM_ADMIN') return { sql: '1', params: [] as unknown[] };
  const s = sqlIn('ul.location_id', ctx.actor.locationIds);
  return {
    sql: `(u.all_locations = 0 AND u.role_code IN (${ASSIGNABLE_ROLES[ctx.actor.role!].map(() => '?').join(',') || "''"})
           AND EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = u.id AND ${s.sql})
           AND NOT EXISTS (SELECT 1 FROM user_locations ul2 WHERE ul2.user_id = u.id AND ul2.location_id NOT IN (${ctx.actor.locationIds.map(() => '?').join(',') || 'NULL'})))`,
    params: [...ASSIGNABLE_ROLES[ctx.actor.role!], ...s.params, ...ctx.actor.locationIds] as unknown[],
  };
}

export function listUsers(ctx: Ctx, raw: unknown): Page<Record<string, unknown>> {
  requirePerm(ctx.actor, 'users.manage');
  const q = parse(listQuery.extend({ role: z.enum(ROLES).optional(), active: z.enum(['true', 'false']).optional() }), raw);
  const scope = managedScope(ctx);
  const where = ['u.organization_id = ?', scope.sql];
  const params: unknown[] = [ctx.actor.orgId, ...scope.params];
  if (q.role) {
    where.push('u.role_code = ?');
    params.push(q.role);
  }
  if (q.active) {
    where.push('u.is_active = ?');
    params.push(q.active === 'true' ? 1 : 0);
  }
  if (q.locationId) {
    where.push('(u.all_locations = 1 OR EXISTS (SELECT 1 FROM user_locations x WHERE x.user_id = u.id AND x.location_id = ?))');
    params.push(q.locationId);
  }
  if (q.q) {
    const like = likeParam(q.q);
    where.push("(u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' OR u.department LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  const whereSql = where.join(' AND ');
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM users u WHERE ${whereSql}`).get(...params) as { n: number }).n;
  const items = (ctx.db.prepare(`${USER_SELECT} WHERE ${whereSql} ORDER BY u.role_code, u.display_name LIMIT ? OFFSET ?`).all(...params, q.pageSize, (q.page - 1) * q.pageSize) as Record<string, any>[]).map(shapeUser);
  return { items, total, page: q.page, pageSize: q.pageSize };
}

function loadManagedUser(ctx: Ctx, id: number): Record<string, any> {
  const scope = managedScope(ctx);
  const u = ctx.db.prepare(`${USER_SELECT} WHERE u.id = ? AND u.organization_id = ? AND ${scope.sql}`).get(id, ctx.actor.orgId, ...scope.params) as Record<string, any> | undefined;
  if (!u) throw notFound('User');
  return shapeUser(u);
}

const userSchema = z.object({
  username: z.string().trim().min(3).max(40).regex(/^[a-z0-9._-]+$/i, 'Letters, digits, dot, dash and underscore only'),
  displayName: zText(120),
  designation: zOptText(80),
  department: zOptText(120),
  role: z.enum(ROLES),
  locationIds: z.array(z.coerce.number().int().positive()).max(10).default([]),
  primaryLocationId: z.coerce.number().int().positive().optional().nullable(),
  assignedGateId: z.coerce.number().int().positive().optional().nullable(),
  password: PASSWORD_RULE,
});

function validateAssignment(ctx: Ctx, role: RoleCode, locationIds: number[], gateId: number | null | undefined, primary: number | null | undefined) {
  if (!ASSIGNABLE_ROLES[ctx.actor.role!].includes(role)) throw forbidden(`You cannot assign the ${ROLE_INFO[role].name} role.`);
  const allLoc = ROLE_INFO[role].allLocations;
  if (!allLoc && locationIds.length === 0) throw badRequest('Assign at least one location');
  for (const l of locationIds) {
    if (!ctx.db.prepare('SELECT 1 FROM locations WHERE id = ? AND organization_id = ?').get(l, ctx.actor.orgId)) throw badRequest('Unknown location');
    assertInScope(ctx.actor, l, 'Location');
  }
  if (primary && !allLoc && !locationIds.includes(primary)) throw badRequest('Primary location must be one of the assigned locations');
  if (gateId) {
    const g = ctx.db.prepare('SELECT location_id FROM gates WHERE id = ?').get(gateId) as { location_id: number } | undefined;
    if (!g || (!allLoc && !locationIds.includes(g.location_id))) throw badRequest('Assigned gate must belong to an assigned location');
  }
}

export function createUser(ctx: Ctx, body: unknown) {
  requirePerm(ctx.actor, 'users.manage');
  const input = parse(userSchema, body);
  validateAssignment(ctx, input.role, input.locationIds, input.assignedGateId, input.primaryLocationId);
  return ctx.db.transaction(() => {
    if (ctx.db.prepare('SELECT 1 FROM users WHERE username = ?').get(input.username)) throw conflict('Username already exists.', 'DUPLICATE_USERNAME');
    const now = clock.nowIso();
    const info = ctx.db
      .prepare(
        `INSERT INTO users (organization_id, username, display_name, designation, department, role_code, password_hash, all_locations,
           primary_location_id, assigned_gate_id, is_active, password_changed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        ctx.actor.orgId,
        input.username.toLowerCase(),
        input.displayName,
        input.designation,
        input.department,
        input.role,
        hashPassword(input.password),
        ROLE_INFO[input.role].allLocations ? 1 : 0,
        input.primaryLocationId ?? input.locationIds[0] ?? null,
        input.assignedGateId ?? null,
        now,
        now,
        now,
      );
    const id = Number(info.lastInsertRowid);
    const ins = ctx.db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (?, ?)');
    for (const l of new Set(input.locationIds)) ins.run(id, l);
    audit(ctx, { action: 'user.create', entityType: 'user', entityId: id, entityRef: input.username, locationId: input.primaryLocationId ?? input.locationIds[0] ?? null, metadata: { role: input.role, locations: input.locationIds } });
    return loadManagedUser(ctx, id);
  })();
}

const updateUserSchema = userSchema.omit({ username: true, password: true }).partial().extend({ isActive: z.boolean().optional() });

export function updateUser(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'users.manage');
  const input = parsePatch(updateUserSchema, body);
  return ctx.db.transaction(() => {
    const u = loadManagedUser(ctx, id);
    if (id === ctx.actor.userId && (input.isActive === false || (input.role && input.role !== u.role))) {
      throw forbidden('You cannot deactivate yourself or change your own role.');
    }
    const role = input.role ?? u.role;
    const locationIds = input.locationIds ?? u.locationIds;
    if (input.role || input.locationIds || input.assignedGateId !== undefined || input.primaryLocationId !== undefined) {
      validateAssignment(ctx, role, locationIds, input.assignedGateId === undefined ? u.assignedGateId : input.assignedGateId, input.primaryLocationId ?? u.primaryLocationId);
    }
    const map: Record<string, unknown> = {
      display_name: input.displayName,
      designation: input.designation,
      department: input.department,
      role_code: input.role,
      all_locations: input.role ? (ROLE_INFO[input.role].allLocations ? 1 : 0) : undefined,
      primary_location_id: input.primaryLocationId,
      assigned_gate_id: input.assignedGateId,
      is_active: input.isActive === undefined ? undefined : input.isActive ? 1 : 0,
    };
    const set = Object.entries(map).filter(([, v]) => v !== undefined);
    if (set.length) ctx.db.prepare(`UPDATE users SET ${set.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...set.map(([, v]) => v), clock.nowIso(), id);
    if (input.locationIds) {
      ctx.db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(id);
      const ins = ctx.db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (?, ?)');
      for (const l of new Set(input.locationIds)) ins.run(id, l);
    }
    if (input.isActive === false) revokeUserSessions(ctx.db, id);
    const action =
      input.isActive === false ? 'user.deactivate' : input.isActive === true && !u.isActive ? 'user.activate' : input.role && input.role !== u.role ? 'user.role.change' : 'user.update';
    audit(ctx, {
      action,
      entityType: 'user',
      entityId: id,
      entityRef: u.username,
      locationId: u.primaryLocationId,
      metadata: { changed: set.map(([k]) => k), fromRole: u.role, toRole: input.role, locations: input.locationIds },
    });
    return loadManagedUser(ctx, id);
  })();
}

export function resetUserPassword(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'users.manage');
  const { password } = parse(z.object({ password: PASSWORD_RULE }), body);
  return ctx.db.transaction(() => {
    const u = loadManagedUser(ctx, id);
    ctx.db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ?, failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?').run(
      hashPassword(password),
      clock.nowIso(),
      clock.nowIso(),
      id,
    );
    revokeUserSessions(ctx.db, id);
    audit(ctx, { action: 'user.password.reset', entityType: 'user', entityId: id, entityRef: u.username, locationId: u.primaryLocationId });
    return { ok: true };
  })();
}

// ---------------------------------------------------------------------------
// Roles & permissions
// ---------------------------------------------------------------------------

export function listRoles(ctx: Ctx) {
  requirePerm(ctx.actor, 'roles.manage', 'users.manage');
  const rows = ctx.db.prepare('SELECT role_code, permission_code FROM role_permissions').all() as { role_code: RoleCode; permission_code: Permission }[];
  const counts = ctx.db.prepare('SELECT role_code, COUNT(*) AS n FROM users WHERE organization_id = ? AND is_active = 1 GROUP BY role_code').all(ctx.actor.orgId) as {
    role_code: RoleCode;
    n: number;
  }[];
  return {
    roles: ROLES.map((r) => ({
      code: r,
      ...ROLE_INFO[r],
      permissions: rows.filter((x) => x.role_code === r).map((x) => x.permission_code),
      activeUsers: counts.find((c) => c.role_code === r)?.n ?? 0,
      assignable: ASSIGNABLE_ROLES[ctx.actor.role!]?.includes(r) ?? false,
    })),
    permissions: ALL_PERMISSIONS.map((p) => ({ code: p, ...PERMISSIONS[p] })),
    lockedAdminPermissions: LOCKED_ADMIN_PERMISSIONS,
    canEdit: can(ctx.actor, 'roles.manage'),
  };
}

export function updateRolePermissions(ctx: Ctx, role: string, body: unknown) {
  requirePerm(ctx.actor, 'roles.manage');
  if (!ROLES.includes(role as RoleCode)) throw notFound('Role');
  const { permissions } = parse(z.object({ permissions: z.array(z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]])).max(ALL_PERMISSIONS.length) }), body);
  const wanted = new Set(permissions);
  if (role === 'SYSTEM_ADMIN') for (const p of LOCKED_ADMIN_PERMISSIONS) wanted.add(p);
  if (role === 'AUDITOR') {
    const mutating = [...wanted].filter((p) => !p.endsWith('.view') && p !== 'reports.export');
    if (mutating.length) throw badRequest(`The Auditor role is read-only; remove: ${mutating.join(', ')}`);
  }
  return ctx.db.transaction(() => {
    const current = new Set(
      (ctx.db.prepare('SELECT permission_code FROM role_permissions WHERE role_code = ?').all(role) as { permission_code: Permission }[]).map((r) => r.permission_code),
    );
    const added = [...wanted].filter((p) => !current.has(p));
    const removed = [...current].filter((p) => !wanted.has(p));
    const del = ctx.db.prepare('DELETE FROM role_permissions WHERE role_code = ? AND permission_code = ?');
    const ins = ctx.db.prepare('INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES (?, ?)');
    for (const p of removed) del.run(role, p);
    for (const p of added) ins.run(role, p);
    audit(ctx, { action: 'role.permissions.update', entityType: 'role', entityId: role, entityRef: role, metadata: { added, removed } });
    invalidatePermissionCache(ctx.db);
    return { role, added, removed, permissions: [...wanted] };
  })();
}

// ---------------------------------------------------------------------------
// Locations & gates
// ---------------------------------------------------------------------------

export function listLocations(ctx: Ctx) {
  const scope = sqlIn('l.id', ctx.actor.locationIds);
  const locations = ctx.db
    .prepare(
      `SELECT l.id, l.code, l.name, l.kind, l.address_note AS addressNote, l.is_active AS isActive,
              (SELECT COUNT(*) FROM personnel p WHERE p.primary_location_id = l.id) AS personnelCount,
              (SELECT COUNT(*) FROM users u JOIN user_locations ul ON ul.user_id = u.id WHERE ul.location_id = l.id AND u.is_active = 1) AS userCount
       FROM locations l WHERE l.organization_id = ? AND ${scope.sql} ORDER BY CASE l.kind WHEN 'HQ' THEN 0 ELSE 1 END, l.name`,
    )
    .all(ctx.actor.orgId, ...scope.params) as Record<string, any>[];
  const gates = ctx.db
    .prepare(`SELECT g.id, g.location_id AS locationId, g.code, g.name, g.gate_type AS gateType, g.is_active AS isActive FROM gates g WHERE ${sqlIn('g.location_id', ctx.actor.locationIds).sql} ORDER BY g.name`)
    .all(...ctx.actor.locationIds) as Record<string, any>[];
  return locations.map((l) => ({ ...l, gates: gates.filter((g) => g.locationId === l.id) }));
}

const locationSchema = z.object({
  code: z.string().trim().min(2).max(12).regex(/^[A-Z0-9-]+$/, 'Upper-case letters, digits and dashes'),
  name: zText(120),
  kind: z.enum(['HQ', 'LOCATION']).default('LOCATION'),
  addressNote: zOptText(200),
  isActive: z.boolean().default(true),
});

export function createLocation(ctx: Ctx, body: unknown) {
  requirePerm(ctx.actor, 'locations.manage');
  if (ctx.actor.role !== 'SYSTEM_ADMIN') throw forbidden('Only a System Administrator can create locations.');
  const input = parse(locationSchema, body);
  return ctx.db.transaction(() => {
    if (ctx.db.prepare('SELECT 1 FROM locations WHERE organization_id = ? AND code = ?').get(ctx.actor.orgId, input.code)) throw conflict('Location code already exists.', 'DUPLICATE_LOCATION');
    const now = clock.nowIso();
    const info = ctx.db
      .prepare('INSERT INTO locations (organization_id, code, name, kind, address_note, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ctx.actor.orgId, input.code, input.name, input.kind, input.addressNote, input.isActive ? 1 : 0, now, now);
    const id = Number(info.lastInsertRowid);
    audit(ctx, { action: 'location.create', entityType: 'location', entityId: id, entityRef: input.code, locationId: id });
    return { id, ...input };
  })();
}

export function updateLocation(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'locations.manage');
  if (ctx.actor.role !== 'SYSTEM_ADMIN') throw forbidden('Only a System Administrator can edit locations.');
  const input = parsePatch(locationSchema.omit({ code: true }).partial(), body);
  return ctx.db.transaction(() => {
    const l = ctx.db.prepare('SELECT * FROM locations WHERE id = ? AND organization_id = ?').get(id, ctx.actor.orgId) as Record<string, any> | undefined;
    if (!l) throw notFound('Location');
    const map: Record<string, unknown> = { name: input.name, kind: input.kind, address_note: input.addressNote, is_active: input.isActive === undefined ? undefined : input.isActive ? 1 : 0 };
    const set = Object.entries(map).filter(([, v]) => v !== undefined);
    if (set.length) ctx.db.prepare(`UPDATE locations SET ${set.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...set.map(([, v]) => v), clock.nowIso(), id);
    audit(ctx, { action: 'location.update', entityType: 'location', entityId: id, entityRef: l.code, locationId: id, metadata: { changed: set.map(([k]) => k) } });
    return { ok: true };
  })();
}

const gateSchema = z.object({
  locationId: z.coerce.number().int().positive(),
  code: z.string().trim().min(2).max(12).regex(/^[A-Z0-9-]+$/, 'Upper-case letters, digits and dashes'),
  name: zText(80),
  gateType: z.enum(GATE_TYPES),
  isActive: z.boolean().default(true),
});

export function createGate(ctx: Ctx, body: unknown) {
  requirePerm(ctx.actor, 'locations.manage');
  const input = parse(gateSchema, body);
  assertInScope(ctx.actor, input.locationId, 'Location');
  return ctx.db.transaction(() => {
    if (ctx.db.prepare('SELECT 1 FROM gates WHERE location_id = ? AND code = ?').get(input.locationId, input.code)) throw conflict('Gate code already exists at this location.', 'DUPLICATE_GATE');
    const now = clock.nowIso();
    const info = ctx.db
      .prepare('INSERT INTO gates (location_id, code, name, gate_type, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.locationId, input.code, input.name, input.gateType, input.isActive ? 1 : 0, now, now);
    const id = Number(info.lastInsertRowid);
    audit(ctx, { action: 'gate.create', entityType: 'gate', entityId: id, entityRef: input.code, locationId: input.locationId });
    return { id, ...input };
  })();
}

export function updateGate(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'locations.manage');
  const input = parsePatch(gateSchema.omit({ code: true, locationId: true }).partial(), body);
  return ctx.db.transaction(() => {
    const g = ctx.db.prepare('SELECT g.*, l.organization_id FROM gates g JOIN locations l ON l.id = g.location_id WHERE g.id = ?').get(id) as Record<string, any> | undefined;
    if (!g || g.organization_id !== ctx.actor.orgId) throw notFound('Gate');
    assertInScope(ctx.actor, g.location_id, 'Gate');
    const map: Record<string, unknown> = { name: input.name, gate_type: input.gateType, is_active: input.isActive === undefined ? undefined : input.isActive ? 1 : 0 };
    const set = Object.entries(map).filter(([, v]) => v !== undefined);
    if (set.length) ctx.db.prepare(`UPDATE gates SET ${set.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...set.map(([, v]) => v), clock.nowIso(), id);
    audit(ctx, { action: input.isActive === false ? 'gate.deactivate' : 'gate.update', entityType: 'gate', entityId: id, entityRef: g.code, locationId: g.location_id, metadata: { changed: set.map(([k]) => k) } });
    return { ok: true };
  })();
}
