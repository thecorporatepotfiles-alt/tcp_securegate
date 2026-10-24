import { z } from 'zod';
import QRCode from 'qrcode';
import type { Ctx } from '../auth/context.js';
import { assertInScope, can, requirePerm, scopeIds, sqlIn } from '../auth/context.js';
import { clock } from '../clock.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors.js';
import { makeAccessToken, newNonce } from '../lib/crypto.js';
import { localDate } from '../lib/time.js';
import { likeParam, listQuery, orderBy, parse, parsePatch, zDate, zEmail, zIso, zOptText, zPhone, zText, zTime, type Page } from '../lib/http.js';
import { nextRef, REF } from '../lib/refs.js';
import { audit } from './audit.js';
import { subjectHistory } from './movement.js';
import { listCredentialsFor } from './personnel.js';
import { CONTRACTOR_CATEGORIES } from '../../../shared/constants.js';

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

const companySchema = z.object({
  name: zText(120),
  category: z.enum(CONTRACTOR_CATEGORIES),
  contactName: zOptText(120),
  contactPhone: zPhone,
  contactEmail: zEmail,
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
  notes: zOptText(500),
});

export function listCompanies(ctx: Ctx, raw: unknown) {
  requirePerm(ctx.actor, 'contractors.view', 'contractors.manage');
  const q = parse(listQuery.extend({ category: z.enum(CONTRACTOR_CATEGORIES).optional() }), raw);
  const scope = sqlIn('c.location_id', ctx.actor.locationIds);
  const where = ['cc.organization_id = ?'];
  const params: unknown[] = [ctx.actor.orgId];
  if (q.category) {
    where.push('cc.category = ?');
    params.push(q.category);
  }
  if (q.q) {
    where.push("cc.name LIKE ? ESCAPE '\\'");
    params.push(likeParam(q.q));
  }
  return ctx.db
    .prepare(
      `SELECT cc.id, cc.name, cc.category, cc.contact_name AS contactName, cc.contact_phone AS contactPhone, cc.contact_email AS contactEmail,
              cc.status, cc.notes, cc.created_at AS createdAt,
              (SELECT COUNT(*) FROM contractors c WHERE c.company_id = cc.id AND ${scope.sql}) AS peopleInScope,
              (SELECT COUNT(*) FROM contractors c JOIN presence pr ON pr.subject_type = 'CONTRACTOR' AND pr.subject_id = c.id AND pr.state = 'INSIDE'
                 WHERE c.company_id = cc.id AND ${scope.sql}) AS insideNow
       FROM contractor_companies cc WHERE ${where.join(' AND ')} ORDER BY cc.name`,
    )
    .all(...scope.params, ...scope.params, ...params);
}

export function createCompany(ctx: Ctx, body: unknown) {
  requirePerm(ctx.actor, 'contractors.manage');
  const input = parse(companySchema, body);
  return ctx.db.transaction(() => {
    if (ctx.db.prepare('SELECT 1 FROM contractor_companies WHERE organization_id = ? AND lower(name) = lower(?)').get(ctx.actor.orgId, input.name)) {
      throw conflict('An organization with this name already exists.', 'DUPLICATE_COMPANY');
    }
    const now = clock.nowIso();
    const info = ctx.db
      .prepare(
        `INSERT INTO contractor_companies (organization_id, name, category, contact_name, contact_phone, contact_email, status, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ctx.actor.orgId, input.name, input.category, input.contactName, input.contactPhone, input.contactEmail, input.status, input.notes, now, now);
    const id = Number(info.lastInsertRowid);
    audit(ctx, { action: 'contractor.company.create', entityType: 'contractor_company', entityId: id, entityRef: input.name, metadata: { category: input.category } });
    return { id, ...input };
  })();
}

export function updateCompany(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'contractors.manage');
  const input = parsePatch(companySchema.partial(), body);
  return ctx.db.transaction(() => {
    const existing = ctx.db.prepare('SELECT * FROM contractor_companies WHERE id = ? AND organization_id = ?').get(id, ctx.actor.orgId) as Record<string, any> | undefined;
    if (!existing) throw notFound('Organization');
    // Organizations are shared; a location-scoped administrator may not change one used at other locations.
    if (!ctx.actor.allLocations) {
      const elsewhere = ctx.db
        .prepare(`SELECT 1 FROM contractors WHERE company_id = ? AND location_id NOT IN (${ctx.actor.locationIds.map(() => '?').join(',') || 'NULL'}) LIMIT 1`)
        .get(id, ...ctx.actor.locationIds);
      if (elsewhere) throw forbidden('This organization also has contractors at other locations. Ask an HQ or System Administrator to change it.');
    }
    const map: Record<string, unknown> = {
      name: input.name,
      category: input.category,
      contact_name: input.contactName,
      contact_phone: input.contactPhone,
      contact_email: input.contactEmail,
      status: input.status,
      notes: input.notes,
    };
    const set = Object.entries(map).filter(([, v]) => v !== undefined);
    if (set.length) ctx.db.prepare(`UPDATE contractor_companies SET ${set.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...set.map(([, v]) => v), clock.nowIso(), id);
    audit(ctx, {
      action: input.status && input.status !== existing.status ? `contractor.company.${input.status === 'ACTIVE' ? 'activate' : 'deactivate'}` : 'contractor.company.update',
      entityType: 'contractor_company',
      entityId: id,
      entityRef: existing.name,
      metadata: { changed: set.map(([k]) => k) },
    });
    return ctx.db.prepare('SELECT * FROM contractor_companies WHERE id = ?').get(id);
  })();
}

// ---------------------------------------------------------------------------
// Contractor individuals
// ---------------------------------------------------------------------------

const CONTRACTOR_SELECT = `SELECT c.id, c.reference, c.full_name AS fullName, c.category, c.phone, c.company_id AS companyId, cc.name AS companyName,
    cc.status AS companyStatus, c.sponsoring_department AS sponsoringDepartment, c.sponsor_user_id AS sponsorUserId, su.display_name AS sponsorName,
    c.purpose, c.location_id AS locationId, l.name AS locationName, c.valid_from AS validFrom, c.valid_until AS validUntil,
    c.window_start AS windowStart, c.window_end AS windowEnd, c.allowed_days AS allowedDays, c.status, c.status_reason AS statusReason,
    c.notes, c.created_at AS createdAt, c.updated_at AS updatedAt,
    pr.state AS presenceState, pr.since AS presenceSince,
    (SELECT MAX(e.recorded_at) FROM movement_events e WHERE e.subject_type = 'CONTRACTOR' AND e.subject_id = c.id) AS lastMovementAt
  FROM contractors c
  JOIN contractor_companies cc ON cc.id = c.company_id
  JOIN locations l ON l.id = c.location_id
  LEFT JOIN users su ON su.id = c.sponsor_user_id
  LEFT JOIN presence pr ON pr.subject_type = 'CONTRACTOR' AND pr.subject_id = c.id`;

const contractorListQuery = listQuery.extend({
  category: z.enum(CONTRACTOR_CATEGORIES).optional(),
  companyId: z.coerce.number().int().positive().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'CANCELLED']).optional(),
  validity: z.enum(['CURRENT', 'EXPIRED', 'UPCOMING']).optional(),
  presence: z.enum(['INSIDE', 'OUTSIDE']).optional(),
});

export function listContractors(ctx: Ctx, raw: unknown): Page<Record<string, unknown>> {
  requirePerm(ctx.actor, 'contractors.view');
  const q = parse(contractorListQuery, raw);
  const scope = sqlIn('c.location_id', scopeIds(ctx.actor, q.locationId));
  const where = [scope.sql, 'c.organization_id = ?'];
  const params: unknown[] = [...scope.params, ctx.actor.orgId];
  const today = localDate(clock.now(), ctx.config.timezone);
  if (q.category) {
    where.push('c.category = ?');
    params.push(q.category);
  }
  if (q.companyId) {
    where.push('c.company_id = ?');
    params.push(q.companyId);
  }
  if (q.status) {
    where.push('c.status = ?');
    params.push(q.status);
  }
  if (q.validity === 'CURRENT') {
    where.push('c.valid_from <= ? AND c.valid_until >= ?');
    params.push(today, today);
  }
  if (q.validity === 'EXPIRED') {
    where.push('c.valid_until < ?');
    params.push(today);
  }
  if (q.validity === 'UPCOMING') {
    where.push('c.valid_from > ?');
    params.push(today);
  }
  if (q.presence === 'INSIDE') where.push("pr.state = 'INSIDE'");
  if (q.presence === 'OUTSIDE') where.push("(pr.state IS NULL OR pr.state = 'OUTSIDE')");
  if (q.q) {
    const like = likeParam(q.q);
    where.push("(c.full_name LIKE ? ESCAPE '\\' OR c.reference LIKE ? ESCAPE '\\' OR cc.name LIKE ? ESCAPE '\\' OR c.purpose LIKE ? ESCAPE '\\' OR c.sponsoring_department LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like, like);
  }
  const whereSql = where.join(' AND ');
  const order = orderBy(q.sort, q.dir, { name: 'c.full_name', company: 'cc.name', validUntil: 'c.valid_until', reference: 'c.reference' }, 'c.full_name');
  const from = `FROM contractors c JOIN contractor_companies cc ON cc.id = c.company_id LEFT JOIN presence pr ON pr.subject_type = 'CONTRACTOR' AND pr.subject_id = c.id`;
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n ${from} WHERE ${whereSql}`).get(...params) as { n: number }).n;
  const items = ctx.db
    .prepare(`${CONTRACTOR_SELECT} WHERE ${whereSql} ORDER BY ${order}, c.id LIMIT ? OFFSET ?`)
    .all(...params, q.pageSize, (q.page - 1) * q.pageSize) as Record<string, unknown>[];
  return { items, total, page: q.page, pageSize: q.pageSize };
}

function loadContractor(ctx: Ctx, id: number) {
  const c = ctx.db.prepare(`${CONTRACTOR_SELECT} WHERE c.id = ? AND c.organization_id = ?`).get(id, ctx.actor.orgId) as Record<string, any> | undefined;
  if (!c) throw notFound('Contractor');
  assertInScope(ctx.actor, c.locationId, 'Contractor');
  return c;
}

export function getContractor(ctx: Ctx, id: number) {
  requirePerm(ctx.actor, 'contractors.view');
  const c = loadContractor(ctx, id);
  const tempAccess = ctx.db
    .prepare('SELECT id, reference, valid_from AS validFrom, valid_until AS validUntil, status, reason FROM temporary_access WHERE contractor_id = ? ORDER BY id DESC LIMIT 10')
    .all(id);
  return {
    ...c,
    credentials: can(ctx.actor, 'credentials.view') ? listCredentialsFor(ctx.db, 'CONTRACTOR', id) : [],
    events: subjectHistory(ctx, 'CONTRACTOR', id, 100),
    temporaryAccess: tempAccess,
    canManage: can(ctx.actor, 'contractors.manage'),
  };
}

const contractorSchema = z.object({
  companyId: z.coerce.number().int().positive(),
  fullName: zText(120),
  category: z.enum(CONTRACTOR_CATEGORIES).optional(),
  phone: zPhone,
  sponsoringDepartment: zText(120),
  sponsorUserId: z.coerce.number().int().positive().optional().nullable(),
  purpose: zText(200),
  locationId: z.coerce.number().int().positive(),
  validFrom: zDate,
  validUntil: zDate,
  windowStart: zTime.default('08:00'),
  windowEnd: zTime.default('18:00'),
  allowedDays: z.string().regex(/^[01]{7}$/, 'Seven 0/1 flags, Monday first').default('1111100'),
  notes: zOptText(500),
});

export function createContractor(ctx: Ctx, body: unknown) {
  requirePerm(ctx.actor, 'contractors.manage');
  const input = parse(contractorSchema, body);
  assertInScope(ctx.actor, input.locationId, 'Location');
  if (input.validUntil < input.validFrom) throw badRequest('Valid until must be on or after valid from');
  if (input.windowEnd <= input.windowStart) throw badRequest('Permitted hours end must be after start');
  return ctx.db.transaction(() => {
    const company = ctx.db.prepare('SELECT id, category, status FROM contractor_companies WHERE id = ? AND organization_id = ?').get(input.companyId, ctx.actor.orgId) as
      | { id: number; category: string; status: string }
      | undefined;
    if (!company) throw notFound('Organization');
    if (company.status !== 'ACTIVE') throw unprocessable('The organization is inactive.', 'COMPANY_INACTIVE');
    const reference = nextRef(ctx.db, ctx.actor.orgId, REF.CONTRACTOR);
    const now = clock.nowIso();
    const info = ctx.db
      .prepare(
        `INSERT INTO contractors (organization_id, company_id, reference, full_name, category, phone, sponsoring_department, sponsor_user_id, purpose,
           location_id, valid_from, valid_until, window_start, window_end, allowed_days, access_nonce, status, notes, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)`,
      )
      .run(
        ctx.actor.orgId,
        input.companyId,
        reference,
        input.fullName,
        input.category ?? company.category,
        input.phone,
        input.sponsoringDepartment,
        input.sponsorUserId ?? null,
        input.purpose,
        input.locationId,
        input.validFrom,
        input.validUntil,
        input.windowStart,
        input.windowEnd,
        input.allowedDays,
        newNonce(),
        input.notes,
        ctx.actor.userId,
        now,
        now,
      );
    const id = Number(info.lastInsertRowid);
    audit(ctx, { action: 'contractor.create', entityType: 'contractor', entityId: id, entityRef: reference, locationId: input.locationId, metadata: { company: input.companyId, validUntil: input.validUntil } });
    return getContractor(ctx, id);
  })();
}

export function updateContractor(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'contractors.manage');
  const input = parsePatch(contractorSchema.partial().extend({ status: z.enum(['ACTIVE', 'INACTIVE', 'CANCELLED']).optional(), statusReason: zOptText(500) }), body);
  return ctx.db.transaction(() => {
    const c = loadContractor(ctx, id);
    if (input.locationId) assertInScope(ctx.actor, input.locationId, 'Location');
    const from = input.validFrom ?? c.validFrom;
    const until = input.validUntil ?? c.validUntil;
    if (until < from) throw badRequest('Valid until must be on or after valid from');
    if (input.status && input.status !== c.status && !input.statusReason) throw badRequest('A reason is required to change status');
    if (c.status === 'CANCELLED' && input.status && input.status !== 'CANCELLED') throw unprocessable('Cancelled records cannot be reactivated. Create a new record.', 'INVALID_TRANSITION');
    const map: Record<string, unknown> = {
      company_id: input.companyId,
      full_name: input.fullName,
      category: input.category,
      phone: input.phone,
      sponsoring_department: input.sponsoringDepartment,
      sponsor_user_id: input.sponsorUserId,
      purpose: input.purpose,
      location_id: input.locationId,
      valid_from: input.validFrom,
      valid_until: input.validUntil,
      window_start: input.windowStart,
      window_end: input.windowEnd,
      allowed_days: input.allowedDays,
      status: input.status,
      status_reason: input.statusReason,
      notes: input.notes,
    };
    const set = Object.entries(map).filter(([, v]) => v !== undefined);
    if (set.length) ctx.db.prepare(`UPDATE contractors SET ${set.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...set.map(([, v]) => v), clock.nowIso(), id);
    audit(ctx, {
      action: input.status && input.status !== c.status ? `contractor.status.${input.status.toLowerCase()}` : 'contractor.update',
      entityType: 'contractor',
      entityId: id,
      entityRef: c.reference,
      locationId: c.locationId,
      metadata: { changed: set.map(([k]) => k), reason: input.statusReason },
    });
    return getContractor(ctx, id);
  })();
}

export async function contractorPass(ctx: Ctx, id: number) {
  requirePerm(ctx.actor, 'contractors.manage');
  const c = loadContractor(ctx, id);
  const row = ctx.db.prepare('SELECT access_nonce FROM contractors WHERE id = ?').get(id) as { access_nonce: string };
  const token = makeAccessToken('CONTRACTOR', row.access_nonce, ctx.config.tokenSecret);
  return { reference: c.reference, fullName: c.fullName, companyName: c.companyName, locationName: c.locationName, validFrom: c.validFrom, validUntil: c.validUntil, token, qrSvg: await QRCode.toString(token, { type: 'svg', margin: 1, width: 220 }), simulated: true };
}

/** Re-issue a contractor QR (invalidates the previous code). */
export function rotateContractorPass(ctx: Ctx, id: number) {
  requirePerm(ctx.actor, 'contractors.manage');
  const c = loadContractor(ctx, id);
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE contractors SET access_nonce = ?, updated_at = ? WHERE id = ?').run(newNonce(), clock.nowIso(), id);
    audit(ctx, { action: 'contractor.pass.reissue', entityType: 'contractor', entityId: id, entityRef: c.reference, locationId: c.locationId });
  })();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Temporary access
// ---------------------------------------------------------------------------

const TA_SELECT = `SELECT t.id, t.reference, t.location_id AS locationId, l.name AS locationName, t.holder_type AS holderType,
    t.personnel_id AS personnelId, t.contractor_id AS contractorId, t.holder_name AS holderName, t.holder_organization AS holderOrganization,
    t.holder_phone AS holderPhone, t.reason, t.sponsoring_department AS sponsoringDepartment, t.valid_from AS validFrom, t.valid_until AS validUntil,
    t.status, CASE WHEN t.status = 'REVOKED' THEN 'REVOKED' WHEN t.valid_until <= ? THEN 'EXPIRED' WHEN t.valid_from > ? THEN 'UPCOMING' ELSE 'ACTIVE' END AS effectiveStatus,
    t.revoked_reason AS revokedReason, t.revoked_at AS revokedAt, ru.display_name AS revokedBy, iu.display_name AS issuedBy, t.created_at AS createdAt
  FROM temporary_access t
  JOIN locations l ON l.id = t.location_id
  LEFT JOIN users ru ON ru.id = t.revoked_by
  LEFT JOIN users iu ON iu.id = t.issued_by`;

const taListQuery = listQuery.extend({
  effectiveStatus: z.enum(['ACTIVE', 'EXPIRED', 'REVOKED', 'UPCOMING']).optional(),
  holderType: z.enum(['PERSONNEL', 'CONTRACTOR', 'INDIVIDUAL']).optional(),
});

export function listTemporaryAccess(ctx: Ctx, raw: unknown): Page<Record<string, unknown>> {
  requirePerm(ctx.actor, 'temp_access.view');
  const q = parse(taListQuery, raw);
  const now = clock.nowIso();
  const scope = sqlIn('x.locationId', scopeIds(ctx.actor, q.locationId));
  const where = [scope.sql];
  const params: unknown[] = [now, now, ctx.actor.orgId, ...scope.params];
  if (q.effectiveStatus) {
    where.push('x.effectiveStatus = ?');
    params.push(q.effectiveStatus);
  }
  if (q.holderType) {
    where.push('x.holderType = ?');
    params.push(q.holderType);
  }
  if (q.q) {
    const like = likeParam(q.q);
    where.push("(x.reference LIKE ? ESCAPE '\\' OR x.holderName LIKE ? ESCAPE '\\' OR x.holderOrganization LIKE ? ESCAPE '\\' OR x.reason LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  const base = `SELECT * FROM (${TA_SELECT} WHERE t.organization_id = ?) x WHERE ${where.join(' AND ')}`;
  const order = orderBy(q.sort, q.dir, { validUntil: 'x.validUntil', holder: 'x.holderName', createdAt: 'x.createdAt' }, 'x.createdAt DESC');
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM (${base})`).get(...params) as { n: number }).n;
  const items = ctx.db.prepare(`${base} ORDER BY ${order}, x.id DESC LIMIT ? OFFSET ?`).all(...params, q.pageSize, (q.page - 1) * q.pageSize) as Record<string, unknown>[];
  return { items, total, page: q.page, pageSize: q.pageSize };
}

function loadTA(ctx: Ctx, id: number) {
  const now = clock.nowIso();
  const t = ctx.db.prepare(`${TA_SELECT} WHERE t.id = ? AND t.organization_id = ?`).get(now, now, id, ctx.actor.orgId) as Record<string, any> | undefined;
  if (!t) throw notFound('Temporary access');
  assertInScope(ctx.actor, t.locationId, 'Temporary access');
  return t;
}

export function getTemporaryAccess(ctx: Ctx, id: number) {
  requirePerm(ctx.actor, 'temp_access.view');
  const t = loadTA(ctx, id);
  const events = ctx.db
    .prepare(
      `SELECT e.id, e.reference, e.event_type AS eventType, e.recorded_at AS recordedAt, g.name AS gateName, l.name AS locationName
       FROM movement_events e JOIN gates g ON g.id = e.gate_id JOIN locations l ON l.id = e.location_id WHERE e.temporary_access_id = ? ORDER BY e.id DESC`,
    )
    .all(id);
  return { ...t, events, canManage: can(ctx.actor, 'temp_access.manage') };
}

const taSchema = z.object({
  locationId: z.coerce.number().int().positive(),
  holderType: z.enum(['PERSONNEL', 'CONTRACTOR', 'INDIVIDUAL']),
  personnelId: z.coerce.number().int().positive().optional().nullable(),
  contractorId: z.coerce.number().int().positive().optional().nullable(),
  holderName: zOptText(120),
  holderOrganization: zOptText(120),
  holderPhone: zPhone,
  reason: zText(300),
  sponsoringDepartment: zOptText(120),
  validFrom: zIso,
  validUntil: zIso,
});

export function createTemporaryAccess(ctx: Ctx, body: unknown) {
  requirePerm(ctx.actor, 'temp_access.manage');
  const input = parse(taSchema, body);
  assertInScope(ctx.actor, input.locationId, 'Location');
  const from = new Date(input.validFrom).toISOString();
  const until = new Date(input.validUntil).toISOString();
  if (until <= from) throw badRequest('Valid until must be after valid from');
  if (new Date(until).getTime() - new Date(from).getTime() > 31 * 86_400_000) throw badRequest('Temporary access may not exceed 31 days');
  if (until <= clock.nowIso()) throw badRequest('Valid until must be in the future');
  let holderName = input.holderName;
  let holderOrg = input.holderOrganization;
  if (input.holderType === 'PERSONNEL') {
    const scope = ctx.actor.locationIds.map(() => '?').join(',') || 'NULL';
    const p = ctx.db
      .prepare(
        `SELECT TRIM(COALESCE(rank || ' ', '') || full_name) AS name, unit, status FROM personnel p WHERE id = ? AND organization_id = ?
         AND (primary_location_id IN (${scope}) OR EXISTS (SELECT 1 FROM personnel_locations pl WHERE pl.personnel_id = p.id AND pl.location_id IN (${scope})))`,
      )
      .get(input.personnelId, ctx.actor.orgId, ...ctx.actor.locationIds, ...ctx.actor.locationIds) as
      | { name: string; unit: string; status: string }
      | undefined;
    if (!p) throw notFound('Personnel record');
    if (p.status !== 'ACTIVE') throw unprocessable('Temporary access can only be issued to active personnel.', 'HOLDER_INACTIVE');
    holderName = p.name;
    holderOrg = holderOrg ?? p.unit;
  } else if (input.holderType === 'CONTRACTOR') {
    const c = ctx.db
      .prepare(
        `SELECT c.full_name AS name, cc.name AS company, c.status FROM contractors c JOIN contractor_companies cc ON cc.id = c.company_id
         WHERE c.id = ? AND c.organization_id = ? AND c.location_id IN (${ctx.actor.locationIds.map(() => '?').join(',') || 'NULL'})`,
      )
      .get(input.contractorId, ctx.actor.orgId, ...ctx.actor.locationIds) as { name: string; company: string; status: string } | undefined;
    if (!c) throw notFound('Contractor');
    if (c.status !== 'ACTIVE') throw unprocessable('Temporary access can only be issued to active contractor records.', 'HOLDER_INACTIVE');
    holderName = c.name;
    holderOrg = holderOrg ?? c.company;
  } else if (!holderName) {
    throw badRequest('Holder name is required');
  }
  return ctx.db.transaction(() => {
    const reference = nextRef(ctx.db, ctx.actor.orgId, REF.TEMP);
    const now = clock.nowIso();
    const info = ctx.db
      .prepare(
        `INSERT INTO temporary_access (organization_id, reference, location_id, holder_type, personnel_id, contractor_id, holder_name, holder_organization,
           holder_phone, reason, sponsoring_department, valid_from, valid_until, access_nonce, status, issued_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
      )
      .run(
        ctx.actor.orgId,
        reference,
        input.locationId,
        input.holderType,
        input.holderType === 'PERSONNEL' ? input.personnelId : null,
        input.holderType === 'CONTRACTOR' ? input.contractorId : null,
        holderName,
        holderOrg,
        input.holderPhone,
        input.reason,
        input.sponsoringDepartment,
        from,
        until,
        newNonce(),
        ctx.actor.userId,
        now,
        now,
      );
    const id = Number(info.lastInsertRowid);
    audit(ctx, { action: 'temporary_access.issue', entityType: 'temporary_access', entityId: id, entityRef: reference, locationId: input.locationId, metadata: { holderType: input.holderType, validUntil: until } });
    return getTemporaryAccess(ctx, id);
  })();
}

export function revokeTemporaryAccess(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'temp_access.manage');
  const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'A reason is required').max(500) }), body);
  return ctx.db.transaction(() => {
    const t = loadTA(ctx, id);
    if (t.status === 'REVOKED') throw conflict('Already revoked.', 'ALREADY_REVOKED');
    const now = clock.nowIso();
    ctx.db.prepare("UPDATE temporary_access SET status = 'REVOKED', revoked_reason = ?, revoked_by = ?, revoked_at = ?, updated_at = ? WHERE id = ?").run(reason, ctx.actor.userId, now, now, id);
    audit(ctx, { action: 'temporary_access.revoke', entityType: 'temporary_access', entityId: id, entityRef: t.reference, locationId: t.locationId, metadata: { reason } });
    return getTemporaryAccess(ctx, id);
  })();
}

export async function temporaryAccessPass(ctx: Ctx, id: number) {
  requirePerm(ctx.actor, 'temp_access.manage');
  const t = loadTA(ctx, id);
  const row = ctx.db.prepare('SELECT access_nonce FROM temporary_access WHERE id = ?').get(id) as { access_nonce: string };
  const token = makeAccessToken('TEMPORARY_ACCESS', row.access_nonce, ctx.config.tokenSecret);
  return {
    reference: t.reference,
    holderName: t.holderName,
    holderOrganization: t.holderOrganization,
    locationName: t.locationName,
    validFrom: t.validFrom,
    validUntil: t.validUntil,
    effectiveStatus: t.effectiveStatus,
    token,
    qrSvg: await QRCode.toString(token, { type: 'svg', margin: 1, width: 220 }),
    simulated: true,
  };
}
