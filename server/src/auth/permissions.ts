import type { DB } from '../db/connection.js';
import type { Permission, RoleCode } from '../../../shared/constants.js';

const cache = new WeakMap<DB, Map<string, Set<Permission>>>();

/** Role permissions are read from the database so changes apply on the next request. */
export function rolePermissions(db: DB, role: RoleCode): Set<Permission> {
  let perDb = cache.get(db);
  if (!perDb) {
    perDb = new Map();
    cache.set(db, perDb);
  }
  let perms = perDb.get(role);
  if (!perms) {
    const rows = db.prepare('SELECT permission_code FROM role_permissions WHERE role_code = ?').all(role) as {
      permission_code: Permission;
    }[];
    perms = new Set(rows.map((r) => r.permission_code));
    perDb.set(role, perms);
  }
  return perms;
}

export function invalidatePermissionCache(db: DB): void {
  cache.delete(db);
}
