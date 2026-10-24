import { z } from 'zod';
import type { DB } from '../db/connection.js';
import type { Actor, Ctx } from '../auth/context.js';
import { assertInScope, requirePerm, scopeIds, sqlIn } from '../auth/context.js';
import { clock } from '../clock.js';
import { conflict, notFound, unprocessable } from '../lib/errors.js';
import { likeParam, listQuery, orderBy, parse, type Page } from '../lib/http.js';
import { nextRef, REF } from '../lib/refs.js';
import { getSettings } from './settings.js';
import { writeAudit, audit } from './audit.js';
import { notify, usersWithPermissionAt } from './notifications.js';
import { ALERT_SEVERITIES, ALERT_STATUSES, ALERT_TYPE_INFO, ALERT_TYPES, type AlertType } from '../../../shared/constants.js';

export interface RaiseAlertInput {
  orgId: number;
  locationId: number | null;
  gateId?: number | null;
  type: AlertType;
  description: string;
  title?: string;
  relatedType?: string | null;
  relatedId?: number | null;
  relatedReference?: string | null;
  attemptId?: number | null;
  eventId?: number | null;
  /** Alerts sharing a key while unresolved are merged (occurrence count increases). */
  dedupeKey?: string | null;
  /**
   * When false, an unresolved alert with the same key is left untouched (used by
   * time-based rules that re-evaluate the same ongoing condition every run).
   */
  repeatWhileOpen?: boolean;
}

/** Raise (or merge into) an alert, honouring the configurable alert rules. Must run inside a transaction. */
export function raiseAlert(db: DB, actor: Actor | null, input: RaiseAlertInput): { id: number; reference: string; merged: boolean } | null {
  const settings = getSettings(db, input.orgId);
  const rule = settings['alerts.rules'][input.type] ?? { enabled: true, severity: ALERT_TYPE_INFO[input.type].defaultSeverity };
  if (!rule.enabled) return null;
  const now = clock.nowIso();
  if (input.dedupeKey) {
    const existing = db
      .prepare("SELECT id, reference FROM alerts WHERE dedupe_key = ? AND status <> 'RESOLVED'")
      .get(input.dedupeKey) as { id: number; reference: string } | undefined;
    if (existing && input.repeatWhileOpen === false) return { ...existing, merged: true };
    if (existing) {
      db.prepare('UPDATE alerts SET occurrence_count = occurrence_count + 1, last_seen_at = ?, updated_at = ?, description = ? WHERE id = ?').run(
        now,
        now,
        input.description,
        existing.id,
      );
      db.prepare("INSERT INTO alert_history (alert_id, action, note, actor_user_id, created_at) VALUES (?, 'REPEATED', ?, NULL, ?)").run(
        existing.id,
        input.description,
        now,
      );
      return { ...existing, merged: true };
    }
  }
  const reference = nextRef(db, input.orgId, REF.ALERT);
  const title = input.title ?? ALERT_TYPE_INFO[input.type].label;
  const info = db
    .prepare(
      `INSERT INTO alerts (organization_id, reference, location_id, gate_id, alert_type, severity, status, title, description,
         related_type, related_id, related_reference, verification_attempt_id, event_id, dedupe_key, first_seen_at, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.orgId,
      reference,
      input.locationId,
      input.gateId ?? null,
      input.type,
      rule.severity,
      title,
      input.description,
      input.relatedType ?? null,
      input.relatedId ?? null,
      input.relatedReference ?? null,
      input.attemptId ?? null,
      input.eventId ?? null,
      input.dedupeKey ?? null,
      now,
      now,
      now,
      now,
    );
  const id = Number(info.lastInsertRowid);
  db.prepare("INSERT INTO alert_history (alert_id, action, note, actor_user_id, created_at) VALUES (?, 'RAISED', ?, ?, ?)").run(
    id,
    input.description,
    actor?.userId ?? null,
    now,
  );
  writeAudit(db, actor, {
    action: 'alert.raise',
    entityType: 'alert',
    entityId: id,
    entityRef: reference,
    locationId: input.locationId,
    metadata: { type: input.type, severity: rule.severity, related: input.relatedReference ?? null },
  }, null, input.orgId);
  if ((rule.severity === 'HIGH' || rule.severity === 'CRITICAL') && input.locationId) {
    notify(db, {
      orgId: input.orgId,
      userIds: usersWithPermissionAt(db, input.orgId, 'alerts.resolve', input.locationId),
      locationId: input.locationId,
      type: 'ALERT',
      title: `${rule.severity} alert: ${title}`,
      body: input.description,
      link: `/alerts/${id}`,
      relatedType: 'alert',
      relatedId: id,
    });
  }
  return { id, reference, merged: false };
}

const alertListQuery = listQuery.extend({
  status: z.enum(ALERT_STATUSES).optional(),
  statusGroup: z.enum(['UNRESOLVED']).optional(),
  severity: z.enum(ALERT_SEVERITIES).optional(),
  type: z.enum(ALERT_TYPES).optional(),
  gateId: z.coerce.number().int().positive().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

const ALERT_SELECT = `SELECT a.id, a.reference, a.location_id AS locationId, l.name AS locationName, a.gate_id AS gateId, g.name AS gateName,
    a.alert_type AS type, a.severity, a.status, a.title, a.description, a.related_type AS relatedType, a.related_id AS relatedId,
    a.related_reference AS relatedReference, a.occurrence_count AS occurrenceCount, a.first_seen_at AS firstSeenAt,
    a.last_seen_at AS lastSeenAt, a.acknowledged_at AS acknowledgedAt, ua.display_name AS acknowledgedBy, a.acknowledgement_note AS acknowledgementNote,
    a.resolved_at AS resolvedAt, ur.display_name AS resolvedBy, a.resolution_note AS resolutionNote, a.created_at AS createdAt,
    a.verification_attempt_id AS attemptId, a.event_id AS eventId
  FROM alerts a
  LEFT JOIN locations l ON l.id = a.location_id
  LEFT JOIN gates g ON g.id = a.gate_id
  LEFT JOIN users ua ON ua.id = a.acknowledged_by
  LEFT JOIN users ur ON ur.id = a.resolved_by`;

export function listAlerts(ctx: Ctx, raw: unknown): Page<Record<string, unknown>> {
  requirePerm(ctx.actor, 'alerts.view');
  const q = parse(alertListQuery, raw);
  const scope = sqlIn('a.location_id', scopeIds(ctx.actor, q.locationId));
  const where = [scope.sql, 'a.organization_id = ?'];
  const params: unknown[] = [...scope.params, ctx.actor.orgId];
  if (q.status) {
    where.push('a.status = ?');
    params.push(q.status);
  }
  if (q.statusGroup === 'UNRESOLVED') where.push("a.status <> 'RESOLVED'");
  if (q.severity) {
    where.push('a.severity = ?');
    params.push(q.severity);
  }
  if (q.type) {
    where.push('a.alert_type = ?');
    params.push(q.type);
  }
  if (q.gateId) {
    where.push('a.gate_id = ?');
    params.push(q.gateId);
  }
  if (q.from) {
    where.push('a.last_seen_at >= ?');
    params.push(q.from);
  }
  if (q.to) {
    where.push('a.first_seen_at < ?');
    params.push(q.to);
  }
  if (q.q) {
    where.push("(a.reference LIKE ? ESCAPE '\\' OR a.title LIKE ? ESCAPE '\\' OR a.description LIKE ? ESCAPE '\\' OR a.related_reference LIKE ? ESCAPE '\\')");
    const like = likeParam(q.q);
    params.push(like, like, like, like);
  }
  const order = orderBy(
    q.sort,
    q.dir,
    { lastSeenAt: 'a.last_seen_at', severity: "CASE a.severity WHEN 'CRITICAL' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END", status: 'a.status', type: 'a.alert_type' },
    "CASE a.status WHEN 'OPEN' THEN 0 WHEN 'ACKNOWLEDGED' THEN 1 ELSE 2 END, a.last_seen_at DESC",
  );
  const whereSql = where.join(' AND ');
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM alerts a WHERE ${whereSql}`).get(...params) as { n: number }).n;
  const items = ctx.db
    .prepare(`${ALERT_SELECT} WHERE ${whereSql} ORDER BY ${order}, a.id DESC LIMIT ? OFFSET ?`)
    .all(...params, q.pageSize, (q.page - 1) * q.pageSize) as Record<string, unknown>[];
  return { items, total, page: q.page, pageSize: q.pageSize };
}

function loadAlert(ctx: Ctx, id: number) {
  const alert = ctx.db.prepare(`${ALERT_SELECT} WHERE a.id = ? AND a.organization_id = ?`).get(id, ctx.actor.orgId) as
    | Record<string, any>
    | undefined;
  if (!alert) throw notFound('Alert');
  assertInScope(ctx.actor, alert.locationId, 'Alert');
  return alert;
}

export function getAlert(ctx: Ctx, id: number) {
  requirePerm(ctx.actor, 'alerts.view');
  const alert = loadAlert(ctx, id);
  const history = ctx.db
    .prepare(
      `SELECT h.id, h.action, h.note, h.created_at AS createdAt, COALESCE(u.display_name, 'System') AS actor
       FROM alert_history h LEFT JOIN users u ON u.id = h.actor_user_id WHERE h.alert_id = ? ORDER BY h.id`,
    )
    .all(id);
  let attempt = null;
  if (alert.attemptId) {
    attempt = ctx.db
      .prepare(
        `SELECT va.id, va.mode, va.method, va.input_display AS inputDisplay, va.result_code AS resultCode, va.created_at AS createdAt,
                u.display_name AS operatorName
         FROM verification_attempts va LEFT JOIN users u ON u.id = va.operator_user_id WHERE va.id = ?`,
      )
      .get(alert.attemptId);
  }
  return { ...alert, history, attempt };
}

const noteSchema = z.object({ note: z.string().trim().max(1000).optional() });
const resolveSchema = z.object({ note: z.string().trim().min(3, 'A resolution note is required').max(1000) });

export function acknowledgeAlert(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'alerts.acknowledge');
  const { note } = parse(noteSchema, body);
  return ctx.db.transaction(() => {
    const alert = loadAlert(ctx, id);
    if (alert.status !== 'OPEN') throw conflict(`Alert is already ${String(alert.status).toLowerCase()}`, 'ALERT_STATE');
    const now = clock.nowIso();
    ctx.db
      .prepare("UPDATE alerts SET status = 'ACKNOWLEDGED', acknowledged_by = ?, acknowledged_at = ?, acknowledgement_note = ?, updated_at = ? WHERE id = ?")
      .run(ctx.actor.userId, now, note ?? null, now, id);
    ctx.db.prepare("INSERT INTO alert_history (alert_id, action, note, actor_user_id, created_at) VALUES (?, 'ACKNOWLEDGED', ?, ?, ?)").run(id, note ?? null, ctx.actor.userId, now);
    audit(ctx, { action: 'alert.acknowledge', entityType: 'alert', entityId: id, entityRef: alert.reference, locationId: alert.locationId, metadata: { note } });
    return getAlert(ctx, id);
  })();
}

export function resolveAlert(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'alerts.resolve');
  const { note } = parse(resolveSchema, body);
  return ctx.db.transaction(() => {
    const alert = loadAlert(ctx, id);
    if (alert.status === 'RESOLVED') throw conflict('Alert is already resolved', 'ALERT_STATE');
    const now = clock.nowIso();
    ctx.db
      .prepare(
        `UPDATE alerts SET status = 'RESOLVED', resolved_by = ?, resolved_at = ?, resolution_note = ?, updated_at = ?,
           acknowledged_by = COALESCE(acknowledged_by, ?), acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?`,
      )
      .run(ctx.actor.userId, now, note, now, ctx.actor.userId, now, id);
    ctx.db.prepare("INSERT INTO alert_history (alert_id, action, note, actor_user_id, created_at) VALUES (?, 'RESOLVED', ?, ?, ?)").run(id, note, ctx.actor.userId, now);
    audit(ctx, { action: 'alert.resolve', entityType: 'alert', entityId: id, entityRef: alert.reference, locationId: alert.locationId, metadata: { note } });
    return getAlert(ctx, id);
  })();
}

export function assertUnreachable(x: never): never {
  throw unprocessable(`Unexpected value ${String(x)}`);
}
