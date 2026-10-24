import type { DB } from '../db/connection.js';
import type { Ctx } from '../auth/context.js';
import { clock } from '../clock.js';
import { notFound } from '../lib/errors.js';
import { ROLE_INFO, ROLES, type Permission } from '../../../shared/constants.js';

export interface NewNotification {
  orgId: number;
  userIds: number[];
  locationId?: number | null;
  type: string;
  title: string;
  body: string;
  link?: string | null;
  relatedType?: string | null;
  relatedId?: number | null;
}

/** In-app notifications only. Delivery is "created"; "read" is recorded only when the user opens it in the app. */
export function notify(db: DB, n: NewNotification): void {
  const unique = [...new Set(n.userIds.filter((id) => Number.isInteger(id)))];
  if (unique.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO notifications (organization_id, user_id, location_id, type, title, body, link, related_type, related_id, channel, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'IN_APP', ?)`,
  );
  const now = clock.nowIso();
  for (const userId of unique) {
    stmt.run(n.orgId, userId, n.locationId ?? null, n.type, n.title, n.body, n.link ?? null, n.relatedType ?? null, n.relatedId ?? null, now);
  }
}

/**
 * Active users holding a permission who are explicitly assigned to the
 * location. Falls back to all-location users (e.g. System Administrator) when
 * nobody is assigned, so notifications are never silently dropped.
 */
export function usersWithPermissionAt(db: DB, orgId: number, perm: Permission, locationId: number): number[] {
  const local = db
    .prepare(
      `SELECT DISTINCT u.id FROM users u
       JOIN role_permissions rp ON rp.role_code = u.role_code AND rp.permission_code = ?
       JOIN user_locations ul ON ul.user_id = u.id AND ul.location_id = ?
       WHERE u.organization_id = ? AND u.is_active = 1`,
    )
    .all(perm, locationId, orgId) as { id: number }[];
  if (local.length) return local.map((r) => r.id);
  const allLocRoles = ROLES.filter((r) => ROLE_INFO[r].allLocations);
  const global = db
    .prepare(
      `SELECT DISTINCT u.id FROM users u
       JOIN role_permissions rp ON rp.role_code = u.role_code AND rp.permission_code = ?
       WHERE u.organization_id = ? AND u.is_active = 1 AND (u.all_locations = 1 OR u.role_code IN (${allLocRoles.map(() => '?').join(',')}))`,
    )
    .all(perm, orgId, ...allLocRoles) as { id: number }[];
  return global.map((r) => r.id);
}

export function listNotifications(ctx: Ctx, opts: { unreadOnly?: boolean; limit?: number }) {
  const rows = ctx.db
    .prepare(
      `SELECT id, type, title, body, link, related_type AS relatedType, related_id AS relatedId, channel,
              created_at AS createdAt, read_at AS readAt
       FROM notifications WHERE user_id = ? ${opts.unreadOnly ? 'AND read_at IS NULL' : ''}
       ORDER BY id DESC LIMIT ?`,
    )
    .all(ctx.actor.userId, Math.min(opts.limit ?? 30, 200));
  const unread = (
    ctx.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(ctx.actor.userId) as {
      n: number;
    }
  ).n;
  return { items: rows, unread };
}

export function markNotificationRead(ctx: Ctx, id: number): void {
  const r = ctx.db
    .prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?')
    .run(clock.nowIso(), id, ctx.actor.userId);
  if (r.changes === 0) throw notFound('Notification');
}

export function markAllNotificationsRead(ctx: Ctx): number {
  return ctx.db
    .prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
    .run(clock.nowIso(), ctx.actor.userId).changes;
}
