import type { DB } from '../db/connection.js';
import type { AppConfig } from '../config.js';
import type { Permission, RoleCode } from '../../../shared/constants.js';
import { forbidden, notFound } from '../lib/errors.js';

export interface Actor {
  kind: 'user' | 'system';
  userId: number | null;
  username: string;
  displayName: string;
  role: RoleCode | null;
  orgId: number;
  permissions: Set<Permission>;
  allLocations: boolean;
  /** Every location this actor may access (already resolved for all-location users). */
  locationIds: number[];
  primaryLocationId: number | null;
  assignedGateId: number | null;
  sessionId: number | null;
}

export interface Ctx {
  db: DB;
  config: AppConfig;
  actor: Actor;
  ip: string | null;
}

export function systemActor(db: DB, orgId: number): Actor {
  const ids = (db.prepare('SELECT id FROM locations WHERE organization_id = ?').all(orgId) as { id: number }[]).map(
    (r) => r.id,
  );
  return {
    kind: 'system',
    userId: null,
    username: 'system',
    displayName: 'System',
    role: null,
    orgId,
    permissions: new Set(),
    allLocations: true,
    locationIds: ids,
    primaryLocationId: null,
    assignedGateId: null,
    sessionId: null,
  };
}

export function can(actor: Actor, perm: Permission): boolean {
  return actor.kind === 'system' || actor.permissions.has(perm);
}

export function canAny(actor: Actor, ...perms: Permission[]): boolean {
  return perms.some((p) => can(actor, p));
}

/** Throws 403 unless the actor holds at least one of the permissions. */
export function requirePerm(actor: Actor, ...perms: Permission[]): void {
  if (!canAny(actor, ...perms)) throw forbidden();
}

export function inScope(actor: Actor, locationId: number | null | undefined): boolean {
  return locationId != null && actor.locationIds.includes(locationId);
}

/**
 * Records outside the actor's locations are reported as "not found" so the API
 * never confirms that an out-of-scope record exists.
 */
export function assertInScope(actor: Actor, locationId: number | null | undefined, what = 'Record'): void {
  if (!inScope(actor, locationId)) throw notFound(what);
}

/** Resolve the location ids a query may read, optionally narrowed to one requested location. */
export function scopeIds(actor: Actor, requested?: number | null): number[] {
  if (requested) {
    if (!inScope(actor, requested)) throw forbidden('You are not authorized for the selected location');
    return [requested];
  }
  return actor.locationIds;
}

export function sqlIn(column: string, ids: number[]): { sql: string; params: number[] } {
  if (ids.length === 0) return { sql: '0', params: [] };
  return { sql: `${column} IN (${ids.map(() => '?').join(',')})`, params: ids };
}
