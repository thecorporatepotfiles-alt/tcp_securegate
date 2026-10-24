import type { DB } from '../db/connection.js';
import { ROLE_INFO, ROLES } from '../../../shared/constants.js';

/** True when the user is active in the organization and authorized for the location. */
export function userAtLocation(db: DB, orgId: number, userId: number, locationId: number): boolean {
  const allLocRoles = ROLES.filter((r) => ROLE_INFO[r].allLocations);
  return !!db
    .prepare(
      `SELECT 1 FROM users u WHERE u.id = ? AND u.organization_id = ? AND u.is_active = 1
       AND (u.all_locations = 1 OR u.role_code IN (${allLocRoles.map(() => '?').join(',')})
            OR EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = u.id AND ul.location_id = ?))`,
    )
    .get(userId, orgId, ...allLocRoles, locationId);
}
