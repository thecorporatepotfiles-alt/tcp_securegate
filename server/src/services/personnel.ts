import { z } from 'zod';
import type { DB } from '../db/connection.js';
import type { Ctx } from '../auth/context.js';
import { assertInScope, can, requirePerm, scopeIds, sqlIn } from '../auth/context.js';
import { clock } from '../clock.js';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors.js';
import { likeParam, listQuery, orderBy, parse, zOptDate, zOptText, zText, type Page } from '../lib/http.js';
import { maskIdentifier } from '../lib/sanitize.js';
import { audit } from './audit.js';
import { getPresence, subjectHistory } from './movement.js';
import { CREDENTIAL_STATUSES, CREDENTIAL_TYPES, type CredentialStatus } from '../../../shared/constants.js';

// ---------------------------------------------------------------------------
// Personnel directory
// ---------------------------------------------------------------------------

const PERSONNEL_SELECT = `SELECT p.id, p.service_number AS serviceNumber, p.full_name AS fullName, p.rank, p.designation, p.unit, p.department,
    p.primary_location_id AS locationId, l.name AS locationName, p.status, p.status_reason AS statusReason,
    p.access_valid_from AS accessValidFrom, p.access_valid_until AS accessValidUntil, p.notes, p.created_at AS createdAt, p.updated_at AS updatedAt,
    (SELECT c.credential_number FROM credentials c WHERE c.personnel_id = p.id AND c.status = 'ACTIVE' AND c.is_temporary = 0) AS activeCredential,
    pr.state AS presenceState, pr.since AS presenceSince, pl.name AS presenceLocation
  FROM personnel p
  JOIN locations l ON l.id = p.primary_location_id
  LEFT JOIN presence pr ON pr.subject_type = 'PERSONNEL' AND pr.subject_id = p.id
  LEFT JOIN locations pl ON pl.id = pr.location_id`;

/** Personnel are visible when assigned to, or authorized for, a location in the actor's scope. */
function visibleClause(ids: number[]) {
  const a = sqlIn('p.primary_location_id', ids);
  const b = sqlIn('pl2.location_id', ids);
  return {
    sql: `(${a.sql} OR EXISTS (SELECT 1 FROM personnel_locations pl2 WHERE pl2.personnel_id = p.id AND ${b.sql}))`,
    params: [...a.params, ...b.params],
  };
}

const personnelListQuery = listQuery.extend({
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  presence: z.enum(['INSIDE', 'OUTSIDE']).optional(),
  unit: z.string().max(120).optional(),
  credential: z.enum(['ASSIGNED', 'NONE']).optional(),
});

export function listPersonnel(ctx: Ctx, raw: unknown): Page<Record<string, unknown>> {
  requirePerm(ctx.actor, 'personnel.view');
  const q = parse(personnelListQuery, raw);
  const vis = visibleClause(scopeIds(ctx.actor, q.locationId));
  const where = [vis.sql, 'p.organization_id = ?'];
  const params: unknown[] = [...vis.params, ctx.actor.orgId];
  if (q.status) {
    where.push('p.status = ?');
    params.push(q.status);
  }
  if (q.unit) {
    where.push('p.unit = ?');
    params.push(q.unit);
  }
  if (q.presence === 'INSIDE') where.push("pr.state = 'INSIDE'");
  if (q.presence === 'OUTSIDE') where.push("(pr.state IS NULL OR pr.state = 'OUTSIDE')");
  if (q.credential === 'ASSIGNED') where.push("EXISTS (SELECT 1 FROM credentials c WHERE c.personnel_id = p.id AND c.status = 'ACTIVE')");
  if (q.credential === 'NONE') where.push("NOT EXISTS (SELECT 1 FROM credentials c WHERE c.personnel_id = p.id AND c.status = 'ACTIVE')");
  if (q.q) {
    const like = likeParam(q.q);
    where.push(
      "(p.full_name LIKE ? ESCAPE '\\' OR p.service_number LIKE ? ESCAPE '\\' OR p.unit LIKE ? ESCAPE '\\' OR p.department LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM credentials c WHERE c.personnel_id = p.id AND c.credential_number = ?))",
    );
    params.push(like, like, like, like, q.q);
  }
  const whereSql = where.join(' AND ');
  const order = orderBy(
    q.sort,
    q.dir,
    { name: 'p.full_name', serviceNumber: 'p.service_number', unit: 'p.unit', status: 'p.status', updatedAt: 'p.updated_at', location: 'l.name' },
    'p.full_name ASC',
  );
  const total = (
    ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM personnel p LEFT JOIN presence pr ON pr.subject_type = 'PERSONNEL' AND pr.subject_id = p.id WHERE ${whereSql}`)
      .get(...params) as { n: number }
  ).n;
  const items = (ctx.db
    .prepare(`${PERSONNEL_SELECT} WHERE ${whereSql} ORDER BY ${order}, p.id LIMIT ? OFFSET ?`)
    .all(...params, q.pageSize, (q.page - 1) * q.pageSize) as Record<string, any>[]).map((r) => ({
    ...r,
    activeCredential: r.activeCredential ? maskIdentifier(r.activeCredential) : null,
  }));
  return { items, total, page: q.page, pageSize: q.pageSize };
}

function loadPersonnel(ctx: Ctx, id: number): Record<string, any> {
  const p = ctx.db.prepare(`${PERSONNEL_SELECT} WHERE p.id = ? AND p.organization_id = ?`).get(id, ctx.actor.orgId) as Record<string, any> | undefined;
  if (!p) throw notFound('Personnel record');
  const authorized = ctx.db
    .prepare('SELECT l.id, l.name, l.code FROM personnel_locations pl JOIN locations l ON l.id = pl.location_id WHERE pl.personnel_id = ? ORDER BY l.name')
    .all(id) as { id: number; name: string; code: string }[];
  const visible = ctx.actor.locationIds.includes(p.locationId) || authorized.some((l) => ctx.actor.locationIds.includes(l.id));
  if (!visible) throw notFound('Personnel record');
  return { ...p, authorizedLocations: authorized };
}

export function getPersonnel(ctx: Ctx, id: number) {
  requirePerm(ctx.actor, 'personnel.view');
  const p = loadPersonnel(ctx, id);
  const credentials = can(ctx.actor, 'credentials.view') ? listCredentialsFor(ctx.db, 'PERSONNEL', id) : [];
  return {
    ...p,
    activeCredential: p.activeCredential ? maskIdentifier(p.activeCredential) : null,
    credentials,
    events: subjectHistory(ctx, 'PERSONNEL', id, 100),
    canManage: can(ctx.actor, 'personnel.manage') && ctx.actor.locationIds.includes(p.locationId),
  };
}

const personnelSchema = z.object({
  serviceNumber: z.string().trim().min(3).max(30).regex(/^[A-Za-z0-9-/]+$/, 'Letters, digits, - and / only'),
  fullName: zText(120),
  rank: zOptText(40),
  designation: zOptText(80),
  unit: zOptText(120),
  department: zOptText(120),
  locationId: z.coerce.number().int().positive(),
  authorizedLocationIds: z.array(z.coerce.number().int().positive()).max(10).default([]),
  accessValidFrom: zOptDate,
  accessValidUntil: zOptDate,
  notes: zOptText(1000),
});

function validateDates(from?: string | null, until?: string | null) {
  if (from && until && until < from) throw badRequest('Access valid-until must be on or after valid-from');
}

function setAuthorizedLocations(db: DB, personnelId: number, primary: number, ids: number[]) {
  db.prepare('DELETE FROM personnel_locations WHERE personnel_id = ?').run(personnelId);
  const ins = db.prepare('INSERT OR IGNORE INTO personnel_locations (personnel_id, location_id) VALUES (?, ?)');
  for (const id of new Set([primary, ...ids])) ins.run(personnelId, id);
}

export function createPersonnel(ctx: Ctx, body: unknown) {
  requirePerm(ctx.actor, 'personnel.manage');
  const input = parse(personnelSchema, body);
  assertInScope(ctx.actor, input.locationId, 'Location');
  for (const l of input.authorizedLocationIds) {
    if (!ctx.db.prepare('SELECT 1 FROM locations WHERE id = ? AND organization_id = ?').get(l, ctx.actor.orgId)) throw badRequest('Unknown authorized location');
  }
  validateDates(input.accessValidFrom, input.accessValidUntil);
  return ctx.db.transaction(() => {
    const dup = ctx.db.prepare('SELECT id FROM personnel WHERE organization_id = ? AND service_number = ?').get(ctx.actor.orgId, input.serviceNumber);
    if (dup) throw conflict(`Personnel ID ${input.serviceNumber} already exists.`, 'DUPLICATE_PERSONNEL_ID');
    const now = clock.nowIso();
    const info = ctx.db
      .prepare(
        `INSERT INTO personnel (organization_id, service_number, full_name, rank, designation, unit, department, primary_location_id, status,
           access_valid_from, access_valid_until, notes, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.actor.orgId,
        input.serviceNumber.toUpperCase(),
        input.fullName,
        input.rank,
        input.designation,
        input.unit,
        input.department,
        input.locationId,
        input.accessValidFrom ?? null,
        input.accessValidUntil ?? null,
        input.notes,
        ctx.actor.userId,
        ctx.actor.userId,
        now,
        now,
      );
    const id = Number(info.lastInsertRowid);
    setAuthorizedLocations(ctx.db, id, input.locationId, input.authorizedLocationIds);
    audit(ctx, {
      action: 'personnel.create',
      entityType: 'personnel',
      entityId: id,
      entityRef: input.serviceNumber.toUpperCase(),
      locationId: input.locationId,
      metadata: { unit: input.unit, authorizedLocations: input.authorizedLocationIds },
    });
    return getPersonnel(ctx, id);
  })();
}

const updateSchema = personnelSchema.omit({ serviceNumber: true }).partial();

export function updatePersonnel(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'personnel.manage');
  const input = parse(updateSchema, body);
  return ctx.db.transaction(() => {
    const existing = loadPersonnel(ctx, id);
    assertInScope(ctx.actor, existing.locationId, 'Personnel record');
    if (input.locationId) assertInScope(ctx.actor, input.locationId, 'Location');
    validateDates(input.accessValidFrom ?? existing.accessValidFrom, input.accessValidUntil ?? existing.accessValidUntil);
    const map: Record<string, unknown> = {
      full_name: input.fullName,
      rank: input.rank,
      designation: input.designation,
      unit: input.unit,
      department: input.department,
      primary_location_id: input.locationId,
      access_valid_from: input.accessValidFrom,
      access_valid_until: input.accessValidUntil,
      notes: input.notes,
    };
    const set = Object.entries(map).filter(([, v]) => v !== undefined);
    const changed = set.filter(([k, v]) => {
      const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()).replace('primaryLocationId', 'locationId');
      return existing[camel] !== v;
    });
    if (set.length) {
      ctx.db
        .prepare(`UPDATE personnel SET ${set.map(([k]) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`)
        .run(...set.map(([, v]) => v), ctx.actor.userId, clock.nowIso(), id);
    }
    if (input.authorizedLocationIds || input.locationId) {
      const ids = input.authorizedLocationIds ?? existing.authorizedLocations.map((l: { id: number }) => l.id);
      setAuthorizedLocations(ctx.db, id, input.locationId ?? existing.locationId, ids);
    }
    audit(ctx, {
      action: 'personnel.update',
      entityType: 'personnel',
      entityId: id,
      entityRef: existing.serviceNumber,
      locationId: existing.locationId,
      metadata: { changedFields: changed.map(([k]) => k), authorizedLocationsChanged: !!input.authorizedLocationIds },
    });
    return getPersonnel(ctx, id);
  })();
}

const statusSchema = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE']),
  reason: z.string().trim().min(3, 'A reason is required').max(500),
});

export function setPersonnelStatus(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'personnel.manage');
  const input = parse(statusSchema, body);
  return ctx.db.transaction(() => {
    const p = loadPersonnel(ctx, id);
    assertInScope(ctx.actor, p.locationId, 'Personnel record');
    if (p.status === input.status) throw conflict(`Record is already ${input.status.toLowerCase()}.`, 'NO_CHANGE');
    ctx.db.prepare('UPDATE personnel SET status = ?, status_reason = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(
      input.status,
      input.reason,
      ctx.actor.userId,
      clock.nowIso(),
      id,
    );
    audit(ctx, {
      action: input.status === 'ACTIVE' ? 'personnel.activate' : 'personnel.deactivate',
      entityType: 'personnel',
      entityId: id,
      entityRef: p.serviceNumber,
      locationId: p.locationId,
      metadata: { reason: input.reason, presence: getPresence(ctx.db, 'PERSONNEL', id)?.state ?? 'NONE' },
    });
    return getPersonnel(ctx, id);
  })();
}

export function listUnits(ctx: Ctx) {
  requirePerm(ctx.actor, 'personnel.view');
  const scope = sqlIn('primary_location_id', ctx.actor.locationIds);
  return (ctx.db
    .prepare(`SELECT DISTINCT unit FROM personnel WHERE organization_id = ? AND unit IS NOT NULL AND ${scope.sql} ORDER BY unit`)
    .all(ctx.actor.orgId, ...scope.params) as { unit: string }[]).map((r) => r.unit);
}

export function lookupPersonnel(ctx: Ctx, q: string) {
  if (!can(ctx.actor, 'personnel.view') && !can(ctx.actor, 'vehicles.manage') && !can(ctx.actor, 'temp_access.manage')) return [];
  if (q.trim().length < 2) return [];
  const vis = visibleClause(ctx.actor.locationIds);
  const like = likeParam(q.trim());
  return ctx.db
    .prepare(
      `SELECT p.id, p.service_number AS serviceNumber, TRIM(COALESCE(p.rank || ' ', '') || p.full_name) AS name, p.unit, p.status
       FROM personnel p WHERE p.organization_id = ? AND ${vis.sql} AND (p.full_name LIKE ? ESCAPE '\\' OR p.service_number LIKE ? ESCAPE '\\')
       ORDER BY p.full_name LIMIT 10`,
    )
    .all(ctx.actor.orgId, ...vis.params, like, like);
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

const CRED_SELECT = `SELECT c.id, c.credential_number AS credentialNumber, c.credential_type AS credentialType, c.holder_type AS holderType,
    c.personnel_id AS personnelId, c.contractor_id AS contractorId,
    COALESCE((SELECT TRIM(COALESCE(p.rank || ' ', '') || p.full_name) FROM personnel p WHERE p.id = c.personnel_id),
             (SELECT k.full_name FROM contractors k WHERE k.id = c.contractor_id)) AS holderName,
    COALESCE((SELECT p.service_number FROM personnel p WHERE p.id = c.personnel_id),
             (SELECT k.reference FROM contractors k WHERE k.id = c.contractor_id)) AS holderReference,
    COALESCE((SELECT p.primary_location_id FROM personnel p WHERE p.id = c.personnel_id),
             (SELECT k.location_id FROM contractors k WHERE k.id = c.contractor_id)) AS locationId,
    c.status, c.is_temporary AS isTemporary, c.valid_from AS validFrom, c.valid_until AS validUntil, c.status_reason AS statusReason,
    c.replaces_id AS replacesId, c.replaced_by_id AS replacedById, c.issued_at AS issuedAt, u.display_name AS issuedBy, c.updated_at AS updatedAt
  FROM credentials c LEFT JOIN users u ON u.id = c.issued_by`;

export function listCredentialsFor(db: DB, holderType: 'PERSONNEL' | 'CONTRACTOR', holderId: number) {
  const col = holderType === 'PERSONNEL' ? 'personnel_id' : 'contractor_id';
  return db.prepare(`${CRED_SELECT} WHERE c.${col} = ? ORDER BY c.id DESC`).all(holderId) as Record<string, unknown>[];
}

const credListQuery = listQuery.extend({
  status: z.enum(CREDENTIAL_STATUSES).optional(),
  type: z.enum(CREDENTIAL_TYPES).optional(),
  holderType: z.enum(['PERSONNEL', 'CONTRACTOR']).optional(),
  temporary: z.coerce.boolean().optional(),
});

export function listCredentials(ctx: Ctx, raw: unknown): Page<Record<string, unknown>> {
  requirePerm(ctx.actor, 'credentials.view');
  const q = parse(credListQuery, raw);
  const scope = sqlIn('x.locationId', scopeIds(ctx.actor, q.locationId));
  const where = ['x.orgId = ?', scope.sql];
  const params: unknown[] = [ctx.actor.orgId, ...scope.params];
  if (q.status) {
    where.push('x.status = ?');
    params.push(q.status);
  }
  if (q.type) {
    where.push('x.credentialType = ?');
    params.push(q.type);
  }
  if (q.holderType) {
    where.push('x.holderType = ?');
    params.push(q.holderType);
  }
  if (q.temporary !== undefined) {
    where.push('x.isTemporary = ?');
    params.push(q.temporary ? 1 : 0);
  }
  if (q.q) {
    const like = likeParam(q.q);
    where.push("(x.credentialNumber LIKE ? ESCAPE '\\' OR x.holderName LIKE ? ESCAPE '\\' OR x.holderReference LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  const base = `SELECT * FROM (${CRED_SELECT.replace('FROM credentials c', ', c.organization_id AS orgId FROM credentials c')}) x WHERE ${where.join(' AND ')}`;
  const order = orderBy(q.sort, q.dir, { issuedAt: 'x.issuedAt', status: 'x.status', holder: 'x.holderName', number: 'x.credentialNumber' }, 'x.updatedAt DESC');
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM (${base})`).get(...params) as { n: number }).n;
  const items = ctx.db.prepare(`${base} ORDER BY ${order}, x.id DESC LIMIT ? OFFSET ?`).all(...params, q.pageSize, (q.page - 1) * q.pageSize) as Record<string, unknown>[];
  return { items, total, page: q.page, pageSize: q.pageSize };
}

function loadCredential(ctx: Ctx, id: number) {
  const c = ctx.db.prepare(`${CRED_SELECT} WHERE c.id = ? AND c.organization_id = ?`).get(id, ctx.actor.orgId) as Record<string, any> | undefined;
  if (!c) throw notFound('Credential');
  assertInScope(ctx.actor, c.locationId, 'Credential');
  return c;
}

export function getCredential(ctx: Ctx, id: number) {
  requirePerm(ctx.actor, 'credentials.view');
  const c = loadCredential(ctx, id);
  const history = ctx.db
    .prepare(
      `SELECT h.id, h.action, h.from_status AS fromStatus, h.to_status AS toStatus, h.reason, h.created_at AS createdAt,
              COALESCE(u.display_name, 'System') AS actor
       FROM credential_history h LEFT JOIN users u ON u.id = h.actor_user_id WHERE h.credential_id = ? ORDER BY h.id`,
    )
    .all(id);
  const recentUse = ctx.db
    .prepare(
      `SELECT va.result_code AS resultCode, va.created_at AS createdAt, g.name AS gateName FROM verification_attempts va JOIN gates g ON g.id = va.gate_id
       WHERE va.credential_id = ? ORDER BY va.id DESC LIMIT 20`,
    )
    .all(id);
  return { ...c, history, recentUse, canManage: can(ctx.actor, 'credentials.manage') };
}

function historyEntry(db: DB, credentialId: number, action: string, from: string | null, to: string | null, reason: string | null, actorId: number | null) {
  db.prepare('INSERT INTO credential_history (credential_id, action, from_status, to_status, reason, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    credentialId,
    action,
    from,
    to,
    reason,
    actorId,
    clock.nowIso(),
  );
}

const assignSchema = z.object({
  holderType: z.enum(['PERSONNEL', 'CONTRACTOR']),
  holderId: z.coerce.number().int().positive(),
  credentialNumber: z
    .string()
    .trim()
    .min(6, 'Credential number must be at least 6 characters')
    .max(40)
    .regex(/^[A-Za-z0-9-]+$/, 'Letters, digits and hyphens only'),
  credentialType: z.enum(CREDENTIAL_TYPES),
  validFrom: z.string().optional(),
  validUntil: z.string().optional().nullable(),
  temporary: z.boolean().default(false),
  reason: zOptText(500),
});

function assertHolder(ctx: Ctx, holderType: 'PERSONNEL' | 'CONTRACTOR', holderId: number) {
  const row =
    holderType === 'PERSONNEL'
      ? (ctx.db.prepare('SELECT primary_location_id AS locationId, status, service_number AS ref FROM personnel WHERE id = ? AND organization_id = ?').get(holderId, ctx.actor.orgId) as
          | { locationId: number; status: string; ref: string }
          | undefined)
      : (ctx.db.prepare('SELECT location_id AS locationId, status, reference AS ref FROM contractors WHERE id = ? AND organization_id = ?').get(holderId, ctx.actor.orgId) as
          | { locationId: number; status: string; ref: string }
          | undefined);
  if (!row) throw notFound(holderType === 'PERSONNEL' ? 'Personnel record' : 'Contractor');
  assertInScope(ctx.actor, row.locationId, 'Holder');
  if (row.status !== 'ACTIVE') throw unprocessable('Credentials can only be assigned to active records.', 'HOLDER_INACTIVE');
  return row;
}

function insertCredential(ctx: Ctx, input: z.infer<typeof assignSchema>, replacesId: number | null) {
  const now = clock.nowIso();
  const validFrom = input.validFrom ? new Date(input.validFrom).toISOString() : now;
  const validUntil = input.validUntil ? new Date(input.validUntil).toISOString() : null;
  if (input.temporary && !validUntil) throw badRequest('Temporary credentials require an expiry (valid until).');
  if (validUntil && validUntil <= validFrom) throw badRequest('Valid until must be after valid from');
  const number = input.credentialNumber.toUpperCase();
  if (ctx.db.prepare('SELECT 1 FROM credentials WHERE organization_id = ? AND credential_number = ?').get(ctx.actor.orgId, number)) {
    throw conflict('This credential number is already registered. Each physical credential can be assigned only once.', 'DUPLICATE_CREDENTIAL');
  }
  const col = input.holderType === 'PERSONNEL' ? 'personnel_id' : 'contractor_id';
  const activeSame = ctx.db
    .prepare(`SELECT id, credential_number FROM credentials WHERE ${col} = ? AND status = 'ACTIVE' AND is_temporary = ?`)
    .get(input.holderId, input.temporary ? 1 : 0) as { id: number; credential_number: string } | undefined;
  if (activeSame && activeSame.id !== replacesId) {
    throw conflict(
      `This holder already has an active ${input.temporary ? 'temporary' : 'permanent'} credential (${maskIdentifier(activeSame.credential_number)}). Block or replace it first.`,
      'ACTIVE_CREDENTIAL_EXISTS',
    );
  }
  const info = ctx.db
    .prepare(
      `INSERT INTO credentials (organization_id, credential_number, credential_type, holder_type, personnel_id, contractor_id, status, is_temporary,
         valid_from, valid_until, replaces_id, issued_by, issued_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ctx.actor.orgId,
      number,
      input.temporary ? 'TEMPORARY_CARD' : input.credentialType,
      input.holderType,
      input.holderType === 'PERSONNEL' ? input.holderId : null,
      input.holderType === 'CONTRACTOR' ? input.holderId : null,
      input.temporary ? 1 : 0,
      validFrom,
      validUntil,
      replacesId,
      ctx.actor.userId,
      now,
      now,
    );
  return Number(info.lastInsertRowid);
}

export function assignCredential(ctx: Ctx, body: unknown) {
  requirePerm(ctx.actor, 'credentials.manage');
  const input = parse(assignSchema, body);
  return ctx.db.transaction(() => {
    const holder = assertHolder(ctx, input.holderType, input.holderId);
    const id = insertCredential(ctx, input, null);
    historyEntry(ctx.db, id, 'ISSUED', null, 'ACTIVE', input.reason ?? null, ctx.actor.userId);
    audit(ctx, {
      action: 'credential.assign',
      entityType: 'credential',
      entityId: id,
      entityRef: maskIdentifier(input.credentialNumber),
      locationId: holder.locationId,
      metadata: { holderType: input.holderType, holder: holder.ref, temporary: input.temporary, type: input.credentialType },
    });
    return getCredential(ctx, id);
  })();
}

const statusChangeSchema = z.object({
  action: z.enum(['BLOCK', 'REPORT_LOST', 'DEACTIVATE', 'REACTIVATE']),
  reason: z.string().trim().min(3, 'A reason is required').max(500),
});

const ACTION_TARGET: Record<string, { to: CredentialStatus; from: CredentialStatus[]; audit: string; history: string }> = {
  BLOCK: { to: 'BLOCKED', from: ['ACTIVE', 'INACTIVE'], audit: 'credential.block', history: 'BLOCKED' },
  REPORT_LOST: { to: 'LOST', from: ['ACTIVE', 'INACTIVE', 'BLOCKED'], audit: 'credential.lost', history: 'REPORTED_LOST' },
  DEACTIVATE: { to: 'INACTIVE', from: ['ACTIVE'], audit: 'credential.deactivate', history: 'DEACTIVATED' },
  REACTIVATE: { to: 'ACTIVE', from: ['INACTIVE', 'BLOCKED'], audit: 'credential.reactivate', history: 'REACTIVATED' },
};

export function changeCredentialStatus(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'credentials.manage');
  const input = parse(statusChangeSchema, body);
  return ctx.db.transaction(() => {
    const c = loadCredential(ctx, id);
    const rule = ACTION_TARGET[input.action];
    if (!rule.from.includes(c.status)) {
      throw unprocessable(`A ${String(c.status).toLowerCase()} credential cannot be changed this way.`, 'INVALID_TRANSITION');
    }
    if (input.action === 'REACTIVATE') {
      if (c.validUntil && new Date(c.validUntil).getTime() <= clock.nowMs()) throw unprocessable('This credential has expired and cannot be reactivated.', 'EXPIRED');
      const col = c.holderType === 'PERSONNEL' ? 'personnel_id' : 'contractor_id';
      const other = ctx.db
        .prepare(`SELECT 1 FROM credentials WHERE ${col} = ? AND status = 'ACTIVE' AND is_temporary = ? AND id <> ?`)
        .get(c.personnelId ?? c.contractorId, c.isTemporary, id);
      if (other) throw conflict('The holder already has another active credential of this kind.', 'ACTIVE_CREDENTIAL_EXISTS');
    }
    ctx.db.prepare('UPDATE credentials SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?').run(rule.to, input.reason, clock.nowIso(), id);
    historyEntry(ctx.db, id, rule.history, c.status, rule.to, input.reason, ctx.actor.userId);
    audit(ctx, {
      action: rule.audit,
      entityType: 'credential',
      entityId: id,
      entityRef: maskIdentifier(c.credentialNumber),
      locationId: c.locationId,
      metadata: { from: c.status, to: rule.to, reason: input.reason, holder: c.holderReference },
    });
    return getCredential(ctx, id);
  })();
}

const replaceSchema = z.object({
  newCredentialNumber: assignSchema.shape.credentialNumber,
  credentialType: z.enum(CREDENTIAL_TYPES),
  reason: z.string().trim().min(3, 'A reason is required').max(500),
  markOldAs: z.enum(['REPLACED', 'LOST', 'BLOCKED']).default('REPLACED'),
  validUntil: z.string().optional().nullable(),
});

export function replaceCredential(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'credentials.manage');
  const input = parse(replaceSchema, body);
  return ctx.db.transaction(() => {
    const old = loadCredential(ctx, id);
    if (['REPLACED', 'EXPIRED'].includes(old.status)) throw unprocessable('This credential has already been replaced or expired.', 'INVALID_TRANSITION');
    const holderId = old.personnelId ?? old.contractorId;
    assertHolder(ctx, old.holderType, holderId);
    // Retire the old credential first so the one-active-credential constraint holds.
    ctx.db.prepare('UPDATE credentials SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?').run(input.markOldAs, input.reason, clock.nowIso(), id);
    const newId = insertCredential(
      ctx,
      {
        holderType: old.holderType,
        holderId,
        credentialNumber: input.newCredentialNumber,
        credentialType: input.credentialType,
        validUntil: input.validUntil ?? null,
        temporary: old.isTemporary === 1,
        reason: input.reason,
      },
      id,
    );
    ctx.db.prepare('UPDATE credentials SET replaced_by_id = ? WHERE id = ?').run(newId, id);
    historyEntry(ctx.db, id, 'REPLACED', old.status, input.markOldAs, input.reason, ctx.actor.userId);
    historyEntry(ctx.db, newId, 'ISSUED_AS_REPLACEMENT', null, 'ACTIVE', input.reason, ctx.actor.userId);
    audit(ctx, {
      action: 'credential.replace',
      entityType: 'credential',
      entityId: newId,
      entityRef: maskIdentifier(input.newCredentialNumber),
      locationId: old.locationId,
      metadata: { replaced: maskIdentifier(old.credentialNumber), oldStatus: input.markOldAs, reason: input.reason, holder: old.holderReference },
    });
    return getCredential(ctx, newId);
  })();
}
