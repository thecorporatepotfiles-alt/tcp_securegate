import type { DB } from '../db/connection.js';
import type { AppConfig } from '../config.js';
import { clock, addMinutes } from '../clock.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import type { Actor } from './context.js';
import { rolePermissions } from './permissions.js';
import { ROLE_INFO, type RoleCode } from '../../../shared/constants.js';

export const SESSION_COOKIE = 'sg_session';

export function createSession(db: DB, config: AppConfig, userId: number, ip: string | null, ua: string | null): string {
  const token = randomToken(32);
  const now = clock.nowIso();
  const expires = addMinutes(now, config.sessionAbsoluteHours * 60);
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(sha256(token), userId, now, now, expires, ip, ua?.slice(0, 200) ?? null);
  return token;
}

export function revokeSessionToken(db: DB, token: string): void {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(
    clock.nowIso(),
    sha256(token),
  );
}

export function revokeUserSessions(db: DB, userId: number): void {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(clock.nowIso(), userId);
}

interface UserRow {
  id: number;
  organization_id: number;
  username: string;
  display_name: string;
  role_code: RoleCode;
  all_locations: number;
  primary_location_id: number | null;
  assigned_gate_id: number | null;
  is_active: number;
}

export function buildActor(db: DB, user: UserRow, sessionId: number | null): Actor {
  const allLocations = user.all_locations === 1 || ROLE_INFO[user.role_code].allLocations;
  const locationIds = allLocations
    ? (db.prepare('SELECT id FROM locations WHERE organization_id = ? AND is_active = 1').all(user.organization_id) as {
        id: number;
      }[]).map((r) => r.id)
    : (db
        .prepare(
          `SELECT ul.location_id AS id FROM user_locations ul JOIN locations l ON l.id = ul.location_id
           WHERE ul.user_id = ? AND l.is_active = 1 AND l.organization_id = ?`,
        )
        .all(user.id, user.organization_id) as { id: number }[]).map((r) => r.id);
  return {
    kind: 'user',
    userId: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role_code,
    orgId: user.organization_id,
    permissions: rolePermissions(db, user.role_code),
    allLocations,
    locationIds,
    primaryLocationId: user.primary_location_id,
    assignedGateId: user.assigned_gate_id,
    sessionId,
  };
}

export type SessionResult =
  | { ok: true; actor: Actor }
  | { ok: false; code: 'NO_SESSION' | 'SESSION_EXPIRED' | 'ACCOUNT_DISABLED' };

export function resolveSession(db: DB, config: AppConfig, token: string | undefined): SessionResult {
  if (!token) return { ok: false, code: 'NO_SESSION' };
  const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token)) as
    | { id: number; user_id: number; last_seen_at: string; expires_at: string; revoked_at: string | null }
    | undefined;
  if (!session) return { ok: false, code: 'NO_SESSION' };
  const now = clock.now();
  const idleLimit = new Date(session.last_seen_at).getTime() + config.sessionIdleMinutes * 60_000;
  if (session.revoked_at || new Date(session.expires_at) <= now || idleLimit <= now.getTime()) {
    if (!session.revoked_at) db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(now.toISOString(), session.id);
    return { ok: false, code: 'SESSION_EXPIRED' };
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id) as UserRow | undefined;
  if (!user || user.is_active !== 1) return { ok: false, code: 'ACCOUNT_DISABLED' };
  // Throttle last-seen writes to once a minute.
  if (now.getTime() - new Date(session.last_seen_at).getTime() > 60_000) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), session.id);
  }
  return { ok: true, actor: buildActor(db, user, session.id) };
}
